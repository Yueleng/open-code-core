import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { RunCommand } from "./cli/cmd/run"
import { GenerateCommand } from "./cli/cmd/generate"
import { Log } from "./util/log"
import { AuthCommand } from "./cli/cmd/auth"
import { AgentCommand } from "./cli/cmd/agent"
import { UpgradeCommand } from "./cli/cmd/upgrade"
import { UninstallCommand } from "./cli/cmd/uninstall"
import { ModelsCommand } from "./cli/cmd/models"
import { UI } from "./cli/ui"
import { Installation } from "./installation"
import { NamedError } from "@opencode-ai/util/error"
import { FormatError } from "./cli/error"
import { ServeCommand } from "./cli/cmd/serve"
import { DebugCommand } from "./cli/cmd/debug"
import { StatsCommand } from "./cli/cmd/stats"
import { McpCommand } from "./cli/cmd/mcp"
import { GithubCommand } from "./cli/cmd/github"
import { ExportCommand } from "./cli/cmd/export"
import { ImportCommand } from "./cli/cmd/import"
import { AttachCommand } from "./cli/cmd/tui/attach"
import { TuiThreadCommand } from "./cli/cmd/tui/thread"
import { AcpCommand } from "./cli/cmd/acp"
import { EOL } from "os"
import { WebCommand } from "./cli/cmd/web"
import { PrCommand } from "./cli/cmd/pr"
import { SessionCommand } from "./cli/cmd/session"

/**
 * This ensures that even if something goes wrong unexpectedly
 * (like a network timeout or a code bug that isn't caught elsewhere),
 * the error is logged to the system's log file before the process crashes.
 */
process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
  })
})

/**
 * Think of this file as the Dispatcher.
 * It doesn't perform the actual work of "generating code" or "running agents" itself;
 * instead, it sets up the environment (logging, error handling),
 * identifies which command the user wants to run, and hands off execution to the appropriate module.
 */

const cli = yargs(hideBin(process.argv))
  .parserConfiguration({ "populate--": true })
  // Sets the CLI name to opencode.
  .scriptName("opencode")
  // Sets the width of the help message to 100 characters.
  .wrap(100)
  // Adds a help option.
  .help("help", "show help")
  // Adds an alias for help.
  .alias("help", "h")
  // Adds a version option.
  // show the version defined in the Installation utility.
  .version("version", "show version number", Installation.VERSION)
  // Adds an alias for version.
  .alias("version", "v")
  // Adds a print-logs option.
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  // Adds a log-level option.
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })

  .middleware(async (opts) => {
    // Logger Setup: It initializes the Log system.
    // If you pass --print-logs, logs are printed to stderr.
    // It also automatically sets the log level to DEBUG if it detects it's running in a local/dev environment.
    await Log.init({
      print: process.argv.includes("--print-logs"),
      dev: Installation.isLocal(),
      level: (() => {
        if (opts.logLevel) return opts.logLevel as Log.Level
        if (Installation.isLocal()) return "DEBUG"
        return "INFO"
      })(),
    })

    // Environment Variables: It sets process.env.AGENT = "1" and OPENCODE = "1",
    // which other parts of the codebase use to know they are running within this CLI context.
    process.env.AGENT = "1"
    process.env.OPENCODE = "1"

    // Boot Log: It logs the version and the arguments passed to the CLI.
    Log.Default.info("opencode", {
      version: Installation.VERSION,
      args: process.argv.slice(2),
    })
  })
  // Sets a custom usage header that includes a cool ANSI-art logo (UI.logo()).
  .usage("\n" + UI.logo())
  // Adds a completion option.
  .completion("completion", "generate shell completion script")
  /**
   * This is where all the "meat" of the CLI is attached.
   * Every major feature of OpenCode is a separate command module imported and registered here:
   *
   * Core Commands: RunCommand, GenerateCommand, DebugCommand.
   * System Commands: AuthCommand, UpgradeCommand, UninstallCommand.
   * Infrastructure: McpCommand (Model Context Protocol), ServeCommand, WebCommand.
   * VCS/Tools: GithubCommand, PrCommand, SessionCommand.
   * TUI (Terminal UI): AttachCommand, TuiThreadCommand.
   */
  .command(AcpCommand)
  .command(McpCommand)
  .command(TuiThreadCommand)
  .command(AttachCommand)
  .command(RunCommand)
  .command(GenerateCommand)
  .command(DebugCommand)
  .command(AuthCommand)
  .command(AgentCommand)
  .command(UpgradeCommand)
  .command(UninstallCommand)
  .command(ServeCommand)
  .command(WebCommand)
  .command(ModelsCommand)
  .command(StatsCommand)
  .command(ExportCommand)
  .command(ImportCommand)
  .command(GithubCommand)
  .command(PrCommand)
  .command(SessionCommand)
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp("log")
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

/**
 * This is the main entry point of the CLI.
 * It parses the arguments and executes the corresponding command inside a try-catch-finally block:
 *
 * Parsing: await cli.parse() triggers the matched command.
 *
 * Error Formatting: If a command fails, the catch block attempts to gracefully handle the error:
 *  It extracts specific details if it's a NamedError or a standard Error.
 *  It prints a user-friendly error message using FormatError(e).
 *  If the error is unknown, it points the user to the log file location (Log.file()).
 */
try {
  await cli.parse()
} catch (e) {
  let data: Record<string, any> = {}
  if (e instanceof NamedError) {
    const obj = e.toObject()
    Object.assign(data, {
      ...obj.data,
    })
  }

  if (e instanceof Error) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      cause: e.cause?.toString(),
      stack: e.stack,
    })
  }

  if (e instanceof ResolveMessage) {
    Object.assign(data, {
      name: e.name,
      message: e.message,
      code: e.code,
      specifier: e.specifier,
      referrer: e.referrer,
      position: e.position,
      importKind: e.importKind,
    })
  }
  Log.Default.error("fatal", data)
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error, check log file at " + Log.file() + " for more details" + EOL)
    console.error(e instanceof Error ? e.message : String(e))
  }
  process.exitCode = 1
} finally {
  // Clean Exit: The finally block explicitly calls process.exit()

  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Most notably, some docker-container-based MCP servers don't handle such signals unless
  // run using `docker run --init`.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
