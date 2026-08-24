import { ApplicationError } from "../application/errors.ts";
import { OrchestratorService } from "../application/service.ts";
import { openSqliteDatabase } from "../adapters/sqlite/database.ts";
import { SystemPathCanonicalizer } from "../adapters/system/path.ts";
import { executeCommand } from "./commands.ts";
import { CLI_VERSION, parseCommand } from "./contract.ts";
import { formattedError, humanSuccess, json } from "./format.ts";

const HELP = `Usage: orchestrator [--db <path>] [--json] [--verbose] <command>

Commands:
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
`;

export interface CliStreams { stdout: { write(value: string): unknown }; stderr: { write(value: string): unknown }; }
export function run(argv = process.argv.slice(2), streams: CliStreams = process): number {
  let command = commandIntent(argv);
  let jsonOutput = argv.includes("--json");
  let database: ReturnType<typeof openSqliteDatabase> | undefined;
  const started = Date.now();
  try {
    const parsed = parseCommand(argv);
    command = parsed.command;
    jsonOutput = parsed.options.json;
    if (parsed.options.help) { streams.stdout.write(HELP); return 0; }
    if (parsed.options.version) { streams.stdout.write(`${CLI_VERSION}\n`); return 0; }
    database = openSqliteDatabase(parsed.options.db);
    const service = new OrchestratorService({ projects: database.projects, tasks: database.tasks, history: database.history, unitOfWork: database, paths: new SystemPathCanonicalizer() });
    const result = executeCommand(service, parsed);
    database.close();
    database = undefined;
    streams.stdout.write(jsonOutput ? json(result) : humanSuccess(command, result.data as Record<string, unknown>) + "\n");
    verbose(streams, parsed.options.verbose, command, "success", Date.now() - started);
    return 0;
  } catch (error) {
    const appError = asApplicationError(error);
    streams.stderr.write(formattedError(command, appError, jsonOutput));
    verbose(streams, argv.includes("--verbose"), command, appError.code, Date.now() - started);
    return appError.exitCode;
  } finally {
    if (database) try { database.close(); } catch { /* the command error remains authoritative */ }
  }
}
function commandIntent(argv: string[]): string {
  const argumentsOnly: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!;
    if (value === "--db") { index++; continue; }
    if (value === "--json" || value === "--verbose" || value === "--help" || value === "-h" || value === "--version") continue;
    argumentsOnly.push(value);
  }
  if (argumentsOnly[0] === "project" || argumentsOnly[0] === "task") return argumentsOnly.slice(0, 2).join(" ");
  if (argumentsOnly[0] === "status" || argumentsOnly[0] === "history") return argumentsOnly[0];
  return "";
}
function asApplicationError(error: unknown): ApplicationError<any> {
  if (error instanceof ApplicationError) return error;
  return new ApplicationError("STORAGE_ERROR", "Database operation failed.", { operation: "read" });
}
function verbose(streams: CliStreams, enabled: boolean, command: string, result: string, durationMs: number): void {
  if (enabled) streams.stderr.write(`${JSON.stringify({ command, durationMs, result })}\n`);
}
if (import.meta.main) process.exitCode = run();
