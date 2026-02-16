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
import { DbCommand } from "./cli/cmd/db"
import path from "path"
import { Global } from "./global"
import { JsonMigration } from "./storage/json-migration"
import { Database } from "./storage/db"

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

    // It runs once as a yargs middleware
    // (before any command executes) and migrates legacy JSON data into SQLite:
    const marker = path.join(Global.Path.data, "opencode.db")
    if (!(await Bun.file(marker).exists())) {
      // Detects if stderr is a TTY (interactive terminal)
      // and prints a heads-up message.
      const tty = process.stderr.isTTY
      process.stderr.write("Performing one time database migration, may take a few minutes..." + EOL)

      // Sets up styling constants for a colored progress bar
      // — an orange (\x1b[38;5;214m) filled bar using ■ and ･ characters, 36 characters wide.
      const width = 36
      const orange = "\x1b[38;5;214m"
      const muted = "\x1b[0;2m"
      const reset = "\x1b[0m"
      let last = -1
      // Hides the terminal cursor so the progress bar looks clean while it updates in place.
      if (tty) process.stderr.write("\x1b[?25l")
      try {
        // Runs JsonMigration.run(...) with a progress callback:
        await JsonMigration.run(Database.Client().$client, {
          progress: (event) => {
            // Calculates completion percentage.
            const percent = Math.floor((event.current / event.total) * 100)
            if (percent === last && event.current !== event.total) return
            last = percent
            if (tty) {
              // In a TTY: Renders an animated progress bar using carriage
              // return (\r) to overwrite the same line. e.g.:
              // ■■■■■■■■■■■■･････････････････ 33% sessions    120/360
              const fill = Math.round((percent / 100) * width)
              const bar = `${"■".repeat(fill)}${"･".repeat(width - fill)}`
              process.stderr.write(
                `\r${orange}${bar} ${percent.toString().padStart(3)}%${reset} ${muted}${event.label.padEnd(12)} ${event.current}/${event.total}${reset}`,
              )
              if (event.current === event.total) process.stderr.write("\n")
            } else {
              // Not a TTY (e.g., piped output):
              // Writes simple sqlite-migration:33 lines for machine parsing.
              process.stderr.write(`sqlite-migration:${percent}${EOL}`)
            }
          },
        })
      } finally {
        // Restores the cursor (\x1b[?25h) in TTY mode, or writes sqlite-migration:done in non-TTY
        if (tty) process.stderr.write("\x1b[?25h")
        else {
          process.stderr.write(`sqlite-migration:done${EOL}`)
        }
      }
      process.stderr.write("Database migration complete." + EOL)
    }
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
  // This registers DbCommand (imported on line 29) as a new CLI subcommand.
  // This means users can now run something like opencode db ...
  // to interact with the database directly (e.g., for debugging, inspection, or manual operations).
  .command(DbCommand)
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
    process.stderr.write((e instanceof Error ? e.message : String(e)) + EOL)
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
