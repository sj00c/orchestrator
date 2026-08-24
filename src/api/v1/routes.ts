import { ApplicationError, applicationError, errorEnvelope, type AnyApplicationError, type ErrorEnvelopeV1 } from "../../application/errors.ts";
import { normalizeProcessSpec, ProcessSpecValidationError } from "../../domain/process-spec.ts";
import { OBSERVED_STATES, PLANNED_STATES, type PlannedTransitionCommand } from "../../domain/model.ts";
import { API_VERSION, type MutationBody } from "./contract.ts";

export type HttpMethod = "GET" | "POST";
export type RouteName =
  | "health" | "project.add" | "project.list" | "project.show"
  | "task.add" | "task.list" | "task.show" | "task.transition"
  | "status" | "history.project" | "history.task"
  | "definition.add" | "definition.list" | "definition.show" | "definition.version"
  | "schedule.add" | "schedule.list" | "schedule.show" | "schedule.disable"
  | "attempt.add" | "attempt.list" | "attempt.show" | "attempt.stop" | "attempt.resume" | "task.execution";
export interface RouteMatch { name: RouteName; method: HttpMethod; path: string; params: Record<string, string>; command: string; mutation: boolean; }

const routes: readonly Omit<RouteMatch, "params">[] = [
  { name: "health", method: "GET", path: "/v1/health", command: "daemon status", mutation: false },
  { name: "project.add", method: "POST", path: "/v1/projects", command: "project add", mutation: true },
  { name: "project.list", method: "GET", path: "/v1/projects", command: "project list", mutation: false },
  { name: "project.show", method: "GET", path: "/v1/projects/:project", command: "project show", mutation: false },
  { name: "task.add", method: "POST", path: "/v1/tasks", command: "task add", mutation: true },
  { name: "task.list", method: "GET", path: "/v1/tasks", command: "task list", mutation: false },
  { name: "task.show", method: "GET", path: "/v1/tasks/:task", command: "task show", mutation: false },
  { name: "task.transition", method: "POST", path: "/v1/tasks/:task/transitions", command: "task transition", mutation: true },
  { name: "status", method: "GET", path: "/v1/status", command: "status", mutation: false },
  { name: "history.project", method: "GET", path: "/v1/projects/:project/history", command: "history", mutation: false },
  { name: "history.task", method: "GET", path: "/v1/tasks/:task/history", command: "history", mutation: false },
  { name: "definition.add", method: "POST", path: "/v1/process-definitions", command: "process-definition add", mutation: true },
  { name: "definition.list", method: "GET", path: "/v1/process-definitions", command: "process-definition list", mutation: false },
  { name: "definition.show", method: "GET", path: "/v1/process-definitions/:definition", command: "process-definition show", mutation: false },
  { name: "definition.version", method: "POST", path: "/v1/process-definitions/:definition/versions", command: "process-definition version", mutation: true },
  { name: "schedule.add", method: "POST", path: "/v1/schedules", command: "schedule add", mutation: true },
  { name: "schedule.list", method: "GET", path: "/v1/schedules", command: "schedule list", mutation: false },
  { name: "schedule.show", method: "GET", path: "/v1/schedules/:schedule", command: "schedule show", mutation: false },
  { name: "schedule.disable", method: "POST", path: "/v1/schedules/:schedule/disable", command: "schedule disable", mutation: true },
  { name: "attempt.add", method: "POST", path: "/v1/execution-attempts", command: "process start", mutation: true },
  { name: "attempt.list", method: "GET", path: "/v1/execution-attempts", command: "process list", mutation: false },
  { name: "attempt.show", method: "GET", path: "/v1/execution-attempts/:attempt", command: "process show", mutation: false },
  { name: "attempt.stop", method: "POST", path: "/v1/execution-attempts/:attempt/stop", command: "process stop", mutation: true },
  { name: "attempt.resume", method: "POST", path: "/v1/execution-attempts/:attempt/resume", command: "process resume", mutation: true },
  { name: "task.execution", method: "GET", path: "/v1/tasks/:task/execution", command: "process status", mutation: false },
];

export function resolveRoute(method: string, path: string): RouteMatch {
  for (const route of routes) {
    if (route.method !== method.toUpperCase()) continue;
    const params: Record<string, string> = {};
    const expression = `^${route.path.replace(/:([a-z]+)/g, (_all, key: string) => { params[key] = ""; return "([^/]+)"; })}$`;
    const match = new RegExp(expression).exec(path);
    if (!match) continue;
    let index = 1;
    for (const key of Object.keys(params)) {
      const value = match[index++];
      if (value === undefined) throw invalid("path", "invalid_route_parameter");
      params[key] = decodeURIComponent(value);
    }
    return { ...route, params };
  }
  throw applicationError("NOT_FOUND", "API route was not found.", { resource: "project" });
}

export function validateMutationBody<Data>(body: unknown): Data {
  if (!isObject(body) || body.schemaVersion !== API_VERSION || !isObject(body.data) || Object.keys(body).some((key) => key !== "schemaVersion" && key !== "data")) {
    throw applicationError("VALIDATION_ERROR", "Mutation body must be a v1 envelope.", { field: "body", reason: "invalid_envelope" });
  }
  return body.data as Data;
}

export function validateRouteInput(route: RouteMatch, query: URLSearchParams, body: unknown): unknown {
  validateQueryKeys(route, query);
  if (route.mutation) {
    const data = validateMutationBody<Record<string, unknown>>(body);
    switch (route.name) {
      case "project.add": return { name: requiredString(data, "name"), root: requiredString(data, "root") };
      case "task.add": return { project: requiredString(data, "project"), title: requiredString(data, "title"), description: optionalNullableString(data, "description"), plannedState: enumValue(data, "plannedState", ["planned", "ready"] as const, "planned") };
      case "task.transition": return transition(data);
      case "definition.add": return { taskId: requiredString(data, "taskId"), ...processSpec(data) };
      case "definition.version": return { expectedVersion: requiredPositive(data, "expectedVersion"), ...processSpec(data) };
      case "schedule.add": return schedule(data);
      case "schedule.disable": return {};
      case "attempt.add": return withOptional({ taskId: requiredString(data, "taskId"), definitionId: requiredString(data, "definitionId") }, "definitionVersion", optionalPositive(data, "definitionVersion"));
      case "attempt.stop": return withOptional({}, "graceMs", optionalPositive(data, "graceMs"));
      case "attempt.resume": return {};
      default: throw invalid("body", "route_does_not_accept_body");
    }
  }
  switch (route.name) {
    case "project.list": return pageQuery(query);
    case "definition.list": case "schedule.list": case "attempt.list": return withOptional(pageQuery(query), "taskId", optional(query, "taskId"));
    case "task.list": return withOptional(withOptional(withOptional(pageQuery(query), "project", optional(query, "project")), "plannedState", optionalEnum(query, "plannedState", PLANNED_STATES)), "observedState", optionalEnum(query, "observedState", OBSERVED_STATES));
    case "status": return withOptional(pageQuery(query), "project", optional(query, "project"));
    case "history.project": case "history.task": return withOptional(withOptional(withOptional({}, "cursor", optional(query, "cursor")), "since", optional(query, "since")), "limit", positive(query, "limit", 1000));
    default: return {};
  }
}

export function httpError(command: string, error: unknown): { status: number; body: ErrorEnvelopeV1; headers: Record<string, string> } {
  const appError = error instanceof ApplicationError && isKnownApplicationCode(error.code)
    ? error as AnyApplicationError
    : applicationError("STORAGE_ERROR", "Unexpected daemon failure.", { operation: "read" });
  const status = HTTP_STATUS[appError.code];
  const headers = appError.code === "IDEMPOTENCY_IN_PROGRESS" ? { "Retry-After": "1" } : {};
  return { status, body: errorEnvelope(command, appError), headers };
}

export const HTTP_STATUS: Record<AnyApplicationError["code"], number> = {
  USAGE_ERROR: 400, CONFIG_ERROR: 400, VALIDATION_ERROR: 400, PROJECT_CONFLICT: 409, NOT_FOUND: 404,
  INVALID_TRANSITION: 409, VERSION_CONFLICT: 409, DB_BUSY: 503, CONSTRAINT_VIOLATION: 500,
  MIGRATION_FAILED: 500, SCHEMA_TOO_NEW: 500, STORAGE_ERROR: 500, DAEMON_UNAVAILABLE: 503,
  UNKNOWN_OUTCOME: 503, LOCK_CAPABILITY_UNAVAILABLE: 503, RESPONSE_TOO_LARGE: 413,
  IDEMPOTENCY_CONFLICT: 409, IDEMPOTENCY_IN_PROGRESS: 409, IDEMPOTENCY_EXPIRED: 409,
  EXECUTION_CONFLICT: 409, EVIDENCE_CONFLICT: 409, INSTALL_CONFLICT: 409,
};
function isKnownApplicationCode(code: unknown): code is AnyApplicationError["code"] {
  return typeof code === "string" && Object.hasOwn(HTTP_STATUS, code);
}

function pageQuery(query: URLSearchParams) { return withOptional(withOptional({}, "limit", positive(query, "limit", 250)), "cursor", optional(query, "cursor")); }
function validateQueryKeys(route: RouteMatch, query: URLSearchParams): void {
  const allowed = route.name === "task.list" ? ["limit", "cursor", "project", "plannedState", "observedState"]
    : route.name === "status" ? ["limit", "cursor", "project"]
    : route.name === "history.project" || route.name === "history.task" ? ["limit", "cursor", "since"]
    : route.name === "definition.list" || route.name === "schedule.list" || route.name === "attempt.list" ? ["limit", "cursor", "taskId"]
    : route.mutation || route.name === "health" || route.name.endsWith(".show") || route.name === "task.execution" ? []
    : ["limit", "cursor"];
  for (const key of query.keys()) if (!allowed.includes(key)) throw invalid(key, "unknown_query_parameter");
}
function positive(query: URLSearchParams, key: string, maximum: number): number | undefined { const value = optional(query, key); if (value === undefined) return undefined; if (!/^[1-9][0-9]*$/.test(value) || Number(value) > maximum) throw invalid(key, "out_of_range"); return Number(value); }
function optional(query: URLSearchParams, key: string): string | undefined { const values = query.getAll(key); if (values.length > 1) throw invalid(key, "duplicate"); return values[0]; }
function optionalEnum<T extends readonly string[]>(query: URLSearchParams, key: string, values: T): T[number] | undefined { const value = optional(query, key); if (value === undefined) return undefined; if (!(values as readonly string[]).includes(value)) throw invalid(key, "invalid_value"); return value as T[number]; }
function requiredString(data: Record<string, unknown>, key: string): string { const value = data[key]; if (typeof value !== "string" || !value.trim()) throw invalid(key, "required"); return value; }
function optionalNullableString(data: Record<string, unknown>, key: string): string | null { const value = data[key]; if (value === undefined || value === null) return null; if (typeof value !== "string") throw invalid(key, "invalid_type"); return value; }
function enumValue<T extends readonly string[]>(data: Record<string, unknown>, key: string, values: T, fallback: T[number]): T[number] { const value = data[key]; if (value === undefined) return fallback; if (typeof value !== "string" || !(values as readonly string[]).includes(value)) throw invalid(key, "invalid_value"); return value as T[number]; }
function transition(data: Record<string, unknown>): PlannedTransitionCommand { const type = enumValue(data, "type", ["start", "pause", "resume", "block", "complete", "cancel"] as const, "start"); if (type === "block") return { type, reason: requiredString(data, "reason") }; return { type }; }
function processSpec(data: Record<string, unknown>) {
  try {
    return normalizeProcessSpec({ executable: data.executable, args: data.args, cwd: data.cwd === undefined ? null : data.cwd, envPolicy: data.envPolicy });
  } catch (error) {
    if (error instanceof ProcessSpecValidationError) invalid("process", error.reason);
    throw error;
  }
}
function schedule(data: Record<string, unknown>) {
  const kind = enumValue(data, "kind", ["one-shot", "interval"] as const, "one-shot");
  const intervalSeconds = optionalPositive(data, "intervalSeconds");
  if ((kind === "interval") !== (intervalSeconds !== undefined)) throw invalid("intervalSeconds", "required_for_interval");
  return { taskId: requiredString(data, "taskId"), definitionId: requiredString(data, "definitionId"), definitionVersion: requiredPositive(data, "definitionVersion"), kind, runAt: requiredString(data, "runAt"), intervalSeconds: intervalSeconds ?? null, enabled: optionalBoolean(data, "enabled", true), misfirePolicy: enumValue(data, "misfirePolicy", ["coalesce"] as const, "coalesce") };
}
function requiredPositive(data: Record<string, unknown>, key: string): number { const value = optionalPositive(data, key); if (value === undefined) throw invalid(key, "required"); return value; }
function optionalPositive(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isSafeInteger(value) || value < 1) throw invalid(key, "out_of_range");
  return value;
}
function optionalBoolean(data: Record<string, unknown>, key: string, fallback: boolean): boolean { const value = data[key]; if (value === undefined) return fallback; if (typeof value !== "boolean") throw invalid(key, "invalid_type"); return value; }
function withOptional<Base extends object, Key extends string, Value>(base: Base, key: Key, value: Value | undefined): Base & Partial<Record<Key, Value>> {
  return value === undefined ? base : { ...base, [key]: value };
}
function invalid(field: string, reason: string): never { throw applicationError("VALIDATION_ERROR", "Invalid API request.", { field, reason }); }
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
