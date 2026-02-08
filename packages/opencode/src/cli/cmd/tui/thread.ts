import { cmd } from "@/cli/cmd/cmd"
import { tui } from "./app"
import { Rpc } from "@/util/rpc"
import { type rpc } from "./worker"
import path from "path"
import { UI } from "@/cli/ui"
import { iife } from "@/util/iife"
import { Log } from "@/util/log"
import { withNetworkOptions, resolveNetworkOptions } from "@/cli/network"
import type { Event } from "@opencode-ai/sdk/v2"
import type { EventSource } from "./context/sdk"

// Declares that OPENCODE_WORKER_PATH may be injected at build time (for production builds).
declare global {
  const OPENCODE_WORKER_PATH: string
}

type RpcClient = ReturnType<typeof Rpc.client<typeof rpc>>

// Creates a custom fetch function that proxies HTTP requests through the RPC channel to the worker.
// Instead of making real HTTP calls, it serializes the request, sends it via RPC, and reconstructs the response.
function createWorkerFetch(client: RpcClient): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const body = request.body ? await request.text() : undefined
    const result = await client.call("fetch", {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    })
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    })
  }
  return fn as typeof fetch
}

// Creates an event subscription mechanism that listens to events from the worker via RPC.
function createEventSource(client: RpcClient): EventSource {
  return {
    on: (handler) => client.on<Event>("event", handler),
  }
}

/**
 * ┌─────────────────────┐          RPC           ┌─────────────────────┐
 * │   Main Process      │ ◄───────────────────►  │   Worker Process    │
 * │   (thread.ts)       │                        │   (worker.ts)       │
 * │                     │                        │                     │
 * │   - TUI rendering   │                        │   - SDK/API calls   │
 * │   - User input      │                        │   - AI inference    │
 * │   - Display         │                        │   - File operations │
 * └─────────────────────┘                        └─────────────────────┘
 *
 * The architecture splits the TUI (frontend) from the backend logic (worker), communicating via RPC.
 * This keeps the UI responsive while heavy operations run in the background.
 */

// Main command definition for the TUI (Text User Interface).
export const TuiThreadCommand = cmd({
  // $0 = default command, [project] = optional positional argument
  command: "$0 [project]",
  describe: "start opencode tui",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      // Positional argument for the project path
      // Optional path to start opencode in.
      .positional("project", {
        type: "string",
        describe: "path to start opencode in",
      })
      // Model to use in the format of provider/model.
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      // Continue the last session.
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      // Session id to continue.
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      // Initial prompt to use.
      .option("prompt", {
        type: "string",
        describe: "prompt to use",
      })
      // Agent to use.
      .option("agent", {
        type: "string",
        describe: "agent to use",
      }),
  handler: async (args) => {
    // Resolve relative paths against PWD to preserve behavior when using --cwd flag
    const baseCwd = process.env.PWD ?? process.cwd()
    const cwd = args.project ? path.resolve(baseCwd, args.project) : process.cwd()
    // Build-time inject
    const localWorker = new URL("./worker.ts", import.meta.url)
    const distWorker = new URL("./cli/cmd/tui/worker.js", import.meta.url)
    const workerPath = await iife(async () => {
      // Build-time inject
      if (typeof OPENCODE_WORKER_PATH !== "undefined") return OPENCODE_WORKER_PATH
      // Check if the worker is in the distributed package: Production build
      if (await Bun.file(distWorker).exists()) return distWorker
      // Development: use the local worker
      return localWorker
    })
    try {
      process.chdir(cwd)
    } catch (e) {
      UI.error("Failed to change directory to " + cwd)
      return
    }

    // Spawn Worker
    // Creates a Bun Worker (background thread) and wraps it with an RPC client for communication.
    const worker = new Worker(workerPath, {
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
    })
    worker.onerror = (e) => {
      Log.Default.error(e)
    }
    const client = Rpc.client<typeof rpc>(worker)

    // Set up Signal Handlers
    process.on("uncaughtException", (e) => {
      Log.Default.error(e)
    })
    process.on("unhandledRejection", (e) => {
      Log.Default.error(e)
    })
    process.on("SIGUSR2", async () => {
      // Hot reload on SIGUSR2
      await client.call("reload", undefined)
    })

    // Handle Piped Input
    // If input is piped to the CLI (e.g., `cat file.txt | opencode`), read it and prepend it to the prompt.
    const prompt = await iife(async () => {
      const piped = !process.stdin.isTTY ? await Bun.stdin.text() : undefined
      if (!args.prompt) return piped
      return piped ? piped + "\n" + args.prompt : args.prompt
    })

    // Check if server should be started (port or hostname explicitly set in CLI or config)
    // Two modes:
    // - HTTP Server mode: For remote access or when port/hostname is specified
    //   - Use case: When you want to expose the opencode backend for external access
    //   - Triggered by: --port, --hostname, --mdns flags, or config settings
    //   - How it works: The worker starts an actual HTTP server, and the TUI (or other clients) communicate via real HTTP requests
    // - Direct RPC mode: Default, faster local communication
    //   - Use case: Normal local usage when you just run opencode
    //   - How it works: The TUI communicates with the worker directly through Bun's Worker message passing (in-process RPC)
    //   - The "fake" URL: http://opencode.internal is a placeholder — it's never actually used for HTTP.
    //     The customFetch intercepts all SDK calls and routes them through RPC instead
    //   - Pros: Faster (no HTTP overhead), simpler, no port binding needed

    /**
     * Remote Server Usage:
     *
     * 1. Remote TUI Attachment
     * # Machine A: Start opencode with server
     * opencode --port 4096
     *
     * # Machine B: Attach to remote instance
     * opencode attach http://machine-a:4096
     *
     * 2. Headless / Scripted Usage
     * # Start server-only mode
     * opencode serve --port 4096
     *
     * # Use from scripts
     * opencode run --attach http://localhost:4096 "do something"
     *
     * 3. mDNS discovery
     * # Advertise on local network
     * # Other devices can discover and connect to the opencode instance.
     * opencode --mdns
     *
     * Visual Summary
     * 
     *  ┌────────────────────────────────────────────────────────────────────┐
     *  │                        DIRECT RPC MODE                             │
     *  │                         (default)                                  │
     *  │                                                                    │
     *  │   ┌─────────────┐      Worker Messages      ┌─────────────────┐    │
     *  │   │    TUI      │ ◄──────────────────────►  │     Worker      │    │
     *  │   │  (thread)   │      (in-process RPC)     │   (backend)     │    │
     *  │   └─────────────┘                           └─────────────────┘    │
     *  │                                                                    │
     *  └────────────────────────────────────────────────────────────────────┘

     *  ┌────────────────────────────────────────────────────────────────────┐
     *  │                      HTTP SERVER MODE                              │
     *  │                    (--port, --hostname)                            │
     *  │                                                                    │
     *  │   ┌─────────────┐                           ┌─────────────────┐    │
     *  │   │    TUI      │         HTTP/REST         │     Worker      │    │
     *  │   │  (thread)   │ ◄───────────────────────► │   + HTTP Server │    │
     *  │   └─────────────┘     localhost:4096        └─────────────────┘    │
     *  │                              ▲                                     │
     *  │                              │                                     │
     *  │   ┌─────────────┐            │                                     │
     *  │   │  Remote TUI │ ───────────┘                                     │
     *  │   │  (attach)   │                                                  │
     *  │   └─────────────┘                                                  │
     *  │                                                                    │
     *  │   ┌─────────────┐            │                                     │
     *  │   │   Scripts   │ ───────────┘                                     │
     *  │   │  (run --)   │                                                  │
     *  │   └─────────────┘                                                  │
     *  └────────────────────────────────────────────────────────────────────┘
     * 
     */

    const networkOpts = await resolveNetworkOptions(args)
    const shouldStartServer =
      process.argv.includes("--port") ||
      process.argv.includes("--hostname") ||
      process.argv.includes("--mdns") ||
      networkOpts.mdns ||
      networkOpts.port !== 0 ||
      networkOpts.hostname !== "127.0.0.1"

    let url: string
    let customFetch: typeof fetch | undefined
    let events: EventSource | undefined

    if (shouldStartServer) {
      // Start HTTP server for external access
      const server = await client.call("server", networkOpts)
      url = server.url
    } else {
      // Use direct RPC communication (no HTTP)
      url = "http://opencode.internal"
      customFetch = createWorkerFetch(client)
      events = createEventSource(client)
    }

    // Launches the interactive terminal UI.
    const tuiPromise = tui({
      url,
      fetch: customFetch,
      events,
      args: {
        continue: args.continue,
        sessionID: args.session,
        agent: args.agent,
        model: args.model,
        prompt,
      },
      onExit: async () => {
        await client.call("shutdown", undefined)
      },
    })

    // Asynchronously checks if a new version is available after 1 second.
    setTimeout(() => {
      client.call("checkUpgrade", { directory: cwd }).catch(() => {})
    }, 1000)

    await tuiPromise
  },
})
