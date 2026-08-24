import { realpath } from "node:fs/promises";
import { applicationError } from "../application/errors.ts";
import type { DaemonClient } from "../client/daemon-client.ts";
import type { HistoryPageData } from "../api/v1/contract.ts";
import { boolFlag, flag, flags, noUnknownFlags, parseHistoryLimit, parseObservedState, parsePlannedState, parsePositive, parseSince, query, type ParsedCommand } from "./contract.ts";
import { success } from "./format.ts";

type Client = Pick<DaemonClient, "request" | "status">;
export async function executeCommand(client: Client, parsed: ParsedCommand) {
  const { command, positionals } = parsed;
  const key = parsed.options.idempotencyKey;
  switch (command) {
    case "project add": {
      noUnknownFlags(parsed, ["--name", "--root"]); rejectPositionals(positionals);
      const root = await realpath(resolveInvocationPath(requiredFlag(parsed, "--root"), parsed.cwd));
      return record(client, command, "project", "POST", "/v1/projects", { name: requiredFlag(parsed, "--name"), root }, undefined, key);
    }
    case "project list": noUnknownFlags(parsed, []); rejectPositionals(positionals); return success(command, { projects: await pages(client, "/v1/projects") });
    case "project show": noUnknownFlags(parsed, []); return record(client, command, "project", "GET", `/v1/projects/${encodeURIComponent(one(positionals, "project-id-or-name"))}`);
    case "task add": return mutation(client, parsed, "/v1/tasks", ["--project", "--title", "--description", "--planned-state"], () => {
      const plannedState = flag(parsed, "--planned-state") ?? "planned";
      if (plannedState !== "planned" && plannedState !== "ready") throw applicationError("VALIDATION_ERROR", "Initial planned state must be planned or ready.", { field: "planned-state", reason: "invalid_initial_state" });
      return { project: requiredFlag(parsed, "--project"), title: requiredFlag(parsed, "--title"), description: flag(parsed, "--description") ?? null, plannedState };
    });
    case "task list": {
      noUnknownFlags(parsed, ["--project", "--planned-state", "--observed-state"]); rejectPositionals(positionals);
      return success(command, { tasks: await pages(client, "/v1/tasks", query({ project: flag(parsed, "--project"), plannedState: parsePlannedState(flag(parsed, "--planned-state")), observedState: parseObservedState(flag(parsed, "--observed-state")) })) });
    }
    case "task show": noUnknownFlags(parsed, []); return record(client, command, "task", "GET", `/v1/tasks/${encodeURIComponent(one(positionals, "task-id"))}`);
    case "task start": case "task pause": case "task resume": case "task complete": case "task cancel":
      noUnknownFlags(parsed, []); return record(client, command, "task", "POST", `/v1/tasks/${encodeURIComponent(one(positionals, "task-id"))}/transitions`, { type: command.slice(5) }, undefined, key);
    case "task block": noUnknownFlags(parsed, ["--reason"]); return record(client, command, "task", "POST", `/v1/tasks/${encodeURIComponent(one(positionals, "task-id"))}/transitions`, { type: "block", reason: requiredFlag(parsed, "--reason") }, undefined, key);
    case "status": noUnknownFlags(parsed, ["--project"]); rejectPositionals(positionals); return client.status(query({ project: flag(parsed, "--project") }));
    case "history": {
      noUnknownFlags(parsed, ["--project", "--task", "--limit", "--since"]); rejectPositionals(positionals);
      const project = flag(parsed, "--project"), task = flag(parsed, "--task");
      if ((project === undefined) === (task === undefined)) throw applicationError("USAGE_ERROR", "Specify exactly one history scope.", { argument: null });
      const params = query({ since: parseSince(flag(parsed, "--since")), limit: parseHistoryLimit(flag(parsed, "--limit")) });
      const path = project === undefined ? `/v1/tasks/${encodeURIComponent(task!)}/history` : `/v1/projects/${encodeURIComponent(project)}/history`;
      const publicLimit = parseHistoryLimit(flag(parsed, "--limit")) ?? 1000;
      const result = await historyPages(client, path, params, publicLimit);
      return success(command, result);
    }
    case "process-definition add": return definitionMutation(client, parsed, "/v1/process-definitions", undefined);
    case "process-definition list": {
      noUnknownFlags(parsed, ["--task"]); rejectPositionals(positionals);
      return success(command, { processDefinitions: await pages(client, "/v1/process-definitions", query({ taskId: flag(parsed, "--task") })) });
    }
    case "process-definition show": noUnknownFlags(parsed, []); return record(client, command, "processDefinition", "GET", `/v1/process-definitions/${encodeURIComponent(one(positionals, "definition-id"))}`);
    case "process-definition version": return definitionMutation(client, parsed, `/v1/process-definitions/${encodeURIComponent(one(positionals, "definition-id"))}/versions`, requiredFlag(parsed, "--expected-version"));
    case "schedule add": return scheduleAdd(client, parsed);
    case "schedule list": { noUnknownFlags(parsed, ["--task"]); rejectPositionals(positionals); return success(command, { schedules: await pages(client, "/v1/schedules", query({ taskId: flag(parsed, "--task") })) }); }
    case "schedule show": noUnknownFlags(parsed, []); return record(client, command, "schedule", "GET", `/v1/schedules/${encodeURIComponent(one(positionals, "schedule-id"))}`);
    case "schedule disable": noUnknownFlags(parsed, []); return record(client, command, "schedule", "POST", `/v1/schedules/${encodeURIComponent(one(positionals, "schedule-id"))}/disable`, {}, undefined, key);
    case "process start": return mutation(client, parsed, "/v1/execution-attempts", ["--task", "--definition", "--definition-version"], () => ({ taskId: requiredFlag(parsed, "--task"), definitionId: requiredFlag(parsed, "--definition"), definitionVersion: parsePositive(flag(parsed, "--definition-version"), "definition-version") }));
    case "process list": { noUnknownFlags(parsed, ["--task"]); rejectPositionals(positionals); return success(command, { attempts: await pages(client, "/v1/execution-attempts", query({ taskId: flag(parsed, "--task") })) }); }
    case "process show": case "process status": noUnknownFlags(parsed, []); return record(client, command, "attempt", "GET", `/v1/execution-attempts/${encodeURIComponent(one(positionals, "attempt-id"))}`);
    case "process stop": {
      noUnknownFlags(parsed, ["--grace-ms"]);
      return record(client, command, "attempt", "POST", `/v1/execution-attempts/${encodeURIComponent(one(positionals, "attempt-id"))}/stop`, { ...(parsePositive(flag(parsed, "--grace-ms"), "grace-ms") === undefined ? {} : { graceMs: parsePositive(flag(parsed, "--grace-ms"), "grace-ms") }) }, undefined, key);
    }
    case "process resume": noUnknownFlags(parsed, []); return record(client, command, "attempt", "POST", `/v1/execution-attempts/${encodeURIComponent(one(positionals, "attempt-id"))}/resume`, {}, undefined, key);
    default: throw applicationError("USAGE_ERROR", "Unknown command.", { argument: command || null });
  }
}
async function mutation(client: Client, parsed: ParsedCommand, path: string, allowed: string[], data: () => unknown) { noUnknownFlags(parsed, allowed); rejectPositionals(parsed.positionals); return record(client, parsed.command, path === "/v1/projects" ? "project" : path === "/v1/tasks" ? "task" : path === "/v1/execution-attempts" ? "attempt" : "result", "POST", path, data(), undefined, parsed.options.idempotencyKey); }
async function definitionMutation(client: Client, parsed: ParsedCommand, path: string, expectedVersion?: string) {
  noUnknownFlags(parsed, ["--task", "--expected-version", "--executable", "--arg", "--cwd", "--env-inherit", "--env"]);
  if (expectedVersion === undefined) rejectPositionals(parsed.positionals);
  const inherited = flags(parsed, "--env-inherit"), entries = flags(parsed, "--env"), values: Record<string, string> = {};
  if (inherited.length && entries.length) throw applicationError("USAGE_ERROR", "Options --env-inherit and --env cannot be used together.", { argument: "--env" });
  for (const entry of entries) { const index = entry.indexOf("="); if (index < 1 || !entry.slice(index + 1)) throw applicationError("VALIDATION_ERROR", "Environment entries must be name=value.", { field: "env", reason: "invalid_value" }); const name = entry.slice(0, index); if (name in values || inherited.includes(name)) throw applicationError("VALIDATION_ERROR", "Environment policy contains a duplicate key.", { field: "env", reason: "duplicate" }); values[name] = entry.slice(index + 1); }
  const envPolicy = entries.length ? { kind: "set" as const, values } : { kind: "inherit" as const, allowlist: inherited };
  const data = { ...(expectedVersion === undefined ? { taskId: requiredFlag(parsed, "--task") } : { expectedVersion: parsePositive(expectedVersion, "expected-version")! }), executable: requiredFlag(parsed, "--executable"), args: flags(parsed, "--arg"), cwd: flag(parsed, "--cwd") ?? null, envPolicy };
  return record(client, parsed.command, "processDefinition", "POST", path, data, undefined, parsed.options.idempotencyKey);
}
async function scheduleAdd(client: Client, parsed: ParsedCommand) {
  noUnknownFlags(parsed, ["--task", "--definition", "--definition-version", "--kind", "--run-at", "--interval-seconds", "--disabled"]); rejectPositionals(parsed.positionals);
  const kind = requiredFlag(parsed, "--kind"); if (kind !== "one-shot" && kind !== "interval") throw applicationError("VALIDATION_ERROR", "Invalid schedule kind.", { field: "kind", reason: "invalid_value" });
  const intervalSeconds = parsePositive(flag(parsed, "--interval-seconds"), "interval-seconds");
  if (kind === "interval" && intervalSeconds === undefined) throw applicationError("USAGE_ERROR", "Option --interval-seconds is required for interval schedules.", { argument: "--interval-seconds" });
  if (kind === "one-shot" && intervalSeconds !== undefined) throw applicationError("USAGE_ERROR", "Option --interval-seconds is only valid for interval schedules.", { argument: "--interval-seconds" });
  return record(client, parsed.command, "schedule", "POST", "/v1/schedules", { taskId: requiredFlag(parsed, "--task"), definitionId: requiredFlag(parsed, "--definition"), definitionVersion: requirePositive(parsed, "--definition-version"), kind, runAt: requiredFlag(parsed, "--run-at"), ...(intervalSeconds === undefined ? {} : { intervalSeconds }), enabled: !boolFlag(parsed, "--disabled"), misfirePolicy: "coalesce" }, undefined, parsed.options.idempotencyKey);
}
async function pages(client: Client, path: string, base = new URLSearchParams()): Promise<unknown[]> {
  const items: unknown[] = [];
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  do {
    const params = new URLSearchParams(base);
    if (cursor) params.set("cursor", cursor);
    const page = await client.request<{ items: unknown[]; nextCursor: string | null }>("GET", path, undefined, params);
    items.push(...page.data.items);
    const nextCursor = page.data.nextCursor;
    if (nextCursor !== null && (page.data.items.length === 0 || nextCursor === cursor || seenCursors.has(nextCursor))) throw new Error("Pagination did not make progress.");
    if (nextCursor !== null) seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor !== null);
  return items;
}
async function historyPages(client: Client, path: string, base: URLSearchParams, publicLimit: number): Promise<Omit<HistoryPageData, "nextCursor">> {
  const events: HistoryPageData["events"] = [];
  let cursor: string | null = null;
  let first: Omit<HistoryPageData, "events" | "nextCursor"> | undefined;
  const seenCursors = new Set<string>();
  do {
    const params = new URLSearchParams(base);
    if (cursor) params.set("cursor", cursor);
    const page = await client.request<HistoryPageData>("GET", path, undefined, params);
    if (!first) first = { scope: page.data.scope, query: page.data.query };
    else if (page.data.scope.type !== first.scope.type || page.data.scope.id !== first.scope.id) throw new Error("History pagination changed scope.");
    events.push(...page.data.events.slice(0, publicLimit - events.length));
    if (events.length === publicLimit || page.data.nextCursor === null) break;
    if (page.data.events.length === 0 || page.data.nextCursor === cursor || seenCursors.has(page.data.nextCursor)) throw new Error("History pagination did not make progress.");
    seenCursors.add(page.data.nextCursor);
    cursor = page.data.nextCursor;
  } while (true);
  if (!first) throw new Error("History pagination returned no page.");
  return { ...first, events };
}
async function record(client: Client, command: string, key: string, method: "GET" | "POST", path: string, data?: unknown, params?: URLSearchParams, idempotencyKey?: string) { const result = await client.request(method, path, data, params, idempotencyKey); return success(command, { [key]: result.data }); }
function requiredFlag(parsed: ParsedCommand, name: string): string { const value = flag(parsed, name); if (value === undefined) throw applicationError("USAGE_ERROR", `Option ${name} is required.`, { argument: name }); return value; }
function requirePositive(parsed: ParsedCommand, name: string): number { const value = parsePositive(requiredFlag(parsed, name), name.slice(2)); return value!; }
function one(values: string[], label: string): string { if (values.length !== 1) throw applicationError("USAGE_ERROR", `Expected ${label}.`, { argument: label }); return values[0]!; }
function rejectPositionals(values: string[]): void { if (values.length) throw applicationError("USAGE_ERROR", "Unexpected argument.", { argument: values[0]! }); }
function resolveInvocationPath(value: string, cwd: string): string { return value.startsWith("/") ? value : `${cwd}/${value}`; }
