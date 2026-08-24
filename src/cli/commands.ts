import { applicationError } from "../application/errors.ts";
import { OrchestratorService } from "../application/service.ts";
import type { PlannedTransitionCommand } from "../domain/model.ts";
import { flag, noUnknownFlags, parseHistoryLimit, parseObservedState, parsePlannedState, parseSince, type ParsedCommand } from "./contract.ts";
import { success } from "./format.ts";

export function executeCommand(service: OrchestratorService, parsed: ParsedCommand) {
  const { command, positionals } = parsed;
  switch (command) {
    case "project add": {
      noUnknownFlags(parsed, ["--name", "--root"]); rejectPositionals(positionals);
      return success(command, { project: service.addProject(requiredFlag(parsed, "--name"), requiredFlag(parsed, "--root")) });
    }
    case "project list": noUnknownFlags(parsed, []); rejectPositionals(positionals); return success(command, { projects: service.listProjects() });
    case "project show": noUnknownFlags(parsed, []); return success(command, { project: service.showProject(one(positionals, "project-id-or-name")) });
    case "task add": {
      noUnknownFlags(parsed, ["--project", "--title", "--description", "--planned-state"]); rejectPositionals(positionals);
      const state = flag(parsed, "--planned-state") ?? "planned";
      if (state !== "planned" && state !== "ready") throw applicationError("VALIDATION_ERROR", "Initial planned state must be planned or ready.", { field: "planned-state", reason: "invalid_initial_state" });
      return success(command, { task: service.addTask(requiredFlag(parsed, "--project"), requiredFlag(parsed, "--title"), flag(parsed, "--description") ?? null, state) });
    }
    case "task list": {
      noUnknownFlags(parsed, ["--project", "--planned-state", "--observed-state"]); rejectPositionals(positionals);
      const project = flag(parsed, "--project");
      const plannedState = parsePlannedState(flag(parsed, "--planned-state"));
      const observedState = parseObservedState(flag(parsed, "--observed-state"));
      return success(command, { tasks: service.listTasks({
        ...(project === undefined ? {} : { project }),
        ...(plannedState === undefined ? {} : { plannedState }),
        ...(observedState === undefined ? {} : { observedState }),
      }) });
    }
    case "task show": noUnknownFlags(parsed, []); return success(command, { task: service.showTask(one(positionals, "task-id")) });
    case "task start": case "task pause": case "task resume": case "task complete": case "task cancel": {
      noUnknownFlags(parsed, []); const type = command.slice(5) as Exclude<PlannedTransitionCommand["type"], "block">;
      return success(command, { task: service.transitionTask(one(positionals, "task-id"), { type }) });
    }
    case "task block": {
      noUnknownFlags(parsed, ["--reason"]); return success(command, { task: service.transitionTask(one(positionals, "task-id"), { type: "block", reason: requiredFlag(parsed, "--reason") }) });
    }
    case "status": { noUnknownFlags(parsed, ["--project"]); rejectPositionals(positionals); return success(command, { projects: service.status(flag(parsed, "--project")) }); }
    case "history": {
      noUnknownFlags(parsed, ["--project", "--task", "--limit", "--since"]); rejectPositionals(positionals);
      const project = flag(parsed, "--project"), task = flag(parsed, "--task");
      if ((project === undefined) === (task === undefined)) throw applicationError("USAGE_ERROR", "Specify exactly one history scope.", { argument: null });
      const since = parseSince(flag(parsed, "--since")), limit = parseHistoryLimit(flag(parsed, "--limit"));
      return success(command, project === undefined ? service.historyTask(task!, since, limit) : service.historyProject(project, since, limit));
    }
    default: throw applicationError("USAGE_ERROR", "Unknown command.", { argument: command || null });
  }
}
function requiredFlag(parsed: ParsedCommand, name: string): string { const value = flag(parsed, name); if (value === undefined) throw applicationError("USAGE_ERROR", `Option ${name} is required.`, { argument: name }); return value; }
function one(values: string[], label: string): string { if (values.length !== 1) throw applicationError("USAGE_ERROR", `Expected ${label}.`, { argument: label }); return values[0]!; }
function rejectPositionals(values: string[]): void { if (values.length) throw applicationError("USAGE_ERROR", "Unexpected argument.", { argument: values[0]! }); }
