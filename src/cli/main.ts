import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { ApplicationError } from "../application/errors.ts";
import { LaunchdAgent } from "../adapters/launchd/agent.ts";
import { DaemonAdmin } from "../daemon/admin.ts";
import { DaemonClient } from "../client/daemon-client.ts";
import { prepareInstallEndpoint, resolveEndpoint } from "../client/endpoint.ts";
import { executeCommand } from "./commands.ts";
import { CLI_VERSION, parseCommand } from "./contract.ts";
import { formattedError, humanSuccess, json, success } from "./format.ts";

const HELP = `Usage: orchestrator [--config <absolute-path>] [--socket <absolute-path>] [--idempotency-key <uuid>] [--json] [--verbose] <command>

Commands:
  daemon install [--db <absolute-path>]
  daemon uninstall|start|stop|status|logs
  project add --name <name> --root <path>
  project list
  project show <project-id-or-name>
  task add --project <ref> --title <text> [--description <text>] [--planned-state planned|ready]
  task list [--project <ref>] [--planned-state <state>] [--observed-state <state>]
  task show <task-id>
  task start|pause|resume|complete|cancel <task-id>
  task block <task-id> --reason <text>
  status [--project <ref>]
  history (--project <ref> | --task <task-id>) [--limit <n>] [--since <RFC3339>]
  process-definition add --task <task-id> --executable <path> [--arg <value>] [--cwd <path>] [--env-inherit <name>] [--env <name=value>]
  process-definition list [--task <task-id>]
  process-definition show <definition-id>
  process-definition version <definition-id> --expected-version <n> --executable <path> [--arg <value>] [--cwd <path>] [--env-inherit <name>] [--env <name=value>]
  schedule add --task <task-id> --definition <definition-id> --definition-version <n> --kind one-shot|interval --run-at <RFC3339> [--interval-seconds <n>] [--disabled]
  schedule list [--task <task-id>]
  schedule show|disable <schedule-id>
  process start --task <task-id> --definition <definition-id> [--definition-version <n>]
  process list [--task <task-id>]
  process show|status|stop|resume <attempt-id>
`;

export interface CliStreams { stdout: { write(value: string): unknown }; stderr: { write(value: string): unknown }; }
export async function run(argv = process.argv.slice(2), streams: CliStreams = process): Promise<number> {
  let command = commandIntent(argv), jsonOutput = argv.includes("--json");
  const started = Date.now();
  try {
    const parsed = parseCommand(argv);
    command = parsed.command;
    jsonOutput = parsed.options.json;
    if (parsed.options.help) { streams.stdout.write(HELP); return 0; }
    if (parsed.options.version) { streams.stdout.write(`${CLI_VERSION}\n`); return 0; }
    const installDatabase = command === "daemon install" ? parsed.flags.get("--db") : undefined;
    const validInstallDatabase = typeof installDatabase === "string" && isAbsolute(installDatabase);
    const allowedAdminFlags = command === "daemon install" && parsed.flags.size === 1 && validInstallDatabase;
    if (command.startsWith("daemon ") && (parsed.positionals.length || (parsed.flags.size > 0 && !allowedAdminFlags))) throw new ApplicationError("USAGE_ERROR", parsed.positionals.length ? "Unexpected argument." : "Unknown option.", { argument: parsed.positionals[0] ?? [...parsed.flags.keys()][0]! });
    const endpointOptions = {
      ...(parsed.options.config === undefined ? {} : { config: parsed.options.config }),
      ...(parsed.options.socket === undefined ? {} : { socket: parsed.options.socket }),
    };
    const result = command.startsWith("daemon ") ? await executeAdmin(parsed.command.slice(7), parsed.options.config, parsed.options.socket, validInstallDatabase ? installDatabase : undefined) : await executeCommand(new DaemonClient({ endpoint: await resolveEndpoint(endpointOptions) }), parsed);
    streams.stdout.write(jsonOutput ? json(result) : humanSuccess(command, result.data as Record<string, unknown>) + "\n");
    verbose(streams, parsed.options.verbose, command, "success", Date.now() - started);
    return "exitCode" in result ? validatedExitCode(result.exitCode) : 0;
  } catch (error) {
    const appError = asApplicationError(error);
    streams.stderr.write(formattedError(command, appError, jsonOutput));
    verbose(streams, argv.includes("--verbose"), command, appError.code, Date.now() - started);
    return appError.exitCode;
  }
}
async function executeAdmin(operation: string, config: string | undefined, socket: string | undefined, databaseOverride: string | undefined) {
  const endpoint = await (operation === "install" ? prepareInstallEndpoint : resolveEndpoint)({
    ...(config === undefined ? {} : { config }),
    ...(socket === undefined ? {} : { socket }),
  });
  const root = resolve(import.meta.dir, "..");
  const logDirectory = resolve(homedir(), "Library/Logs/Orchestrator");
  const databasePath = databaseOverride ?? endpoint.databasePath;
  const admin = new DaemonAdmin(new LaunchdAgent(), {
    label: "dev.gjc.orchestrator",
    programArguments: [process.execPath, resolve(root, "daemon/main.ts"), "--config", endpoint.configPath, "--socket", endpoint.socketPath, "--database", databasePath],
    socketPath: endpoint.socketPath,
    configPath: endpoint.configPath,
    databasePath,
    stdoutPath: resolve(logDirectory, "daemon.stdout.log"),
    stderrPath: resolve(logDirectory, "daemon.stderr.log"),
  });
  let result;
  switch (operation) {
    case "install": result = await admin.install(); break;
    case "uninstall": result = await admin.uninstall(); break;
    case "start": result = await admin.start(); break;
    case "stop": result = await admin.stop(); break;
    case "status": result = await admin.status(); break;
    case "logs": result = await admin.logs(); break;
    default: throw new ApplicationError("USAGE_ERROR", "Unknown command.", { argument: `daemon ${operation}` });
  }
  return { ...success(`daemon ${operation}`, result), exitCode: validatedExitCode(result.exitCode) };
}
function commandIntent(argv: string[]): string {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!;
    if (["--config", "--socket", "--idempotency-key"].includes(value)) { index++; continue; }
    if (["--json", "--verbose", "--help", "-h", "--version"].includes(value)) continue;
    values.push(value);
  }
  return ["daemon", "project", "task", "process-definition", "schedule", "process"].includes(values[0] ?? "") ? values.slice(0, 2).join(" ") : ["status", "history"].includes(values[0] ?? "") ? values[0]! : "";
}
function asApplicationError(error: unknown): ApplicationError<any> {
  if (error instanceof ApplicationError) return error;
  if (error instanceof Error && "code" in error && "exitCode" in error) return error as ApplicationError<any>;
  return new ApplicationError("STORAGE_ERROR", "Unexpected command failure.", { operation: "read" });
}
function validatedExitCode(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 255) {
    throw new ApplicationError("STORAGE_ERROR", "Daemon admin returned an invalid exit code.", { operation: "read" });
  }
  return value;
}
function verbose(streams: CliStreams, enabled: boolean, command: string, result: string, durationMs: number): void { if (enabled) streams.stderr.write(`${JSON.stringify({ command, durationMs, result })}\n`); }
if (import.meta.main) process.exitCode = await run();
