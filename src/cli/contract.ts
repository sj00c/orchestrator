import { resolve } from "node:path";
import { applicationError } from "../application/errors.ts";
import type { ObservedState, PlannedState } from "../domain/model.ts";

export const CLI_VERSION = "0.1.0";
export const HISTORY_DEFAULT_LIMIT = 100;
export const HISTORY_MAX_LIMIT = 1000;
export const COMMANDS = [
  "daemon install", "daemon uninstall", "daemon start", "daemon stop", "daemon status", "daemon logs",
  "project add", "project list", "project show", "task add", "task list", "task show", "task start", "task pause", "task resume", "task block", "task complete", "task cancel",
  "status", "history", "process-definition add", "process-definition list", "process-definition show", "process-definition version",
  "schedule add", "schedule list", "schedule show", "schedule disable", "process start", "process list", "process show", "process stop", "process resume", "process status",
] as const;
export interface GlobalOptions { config?: string; socket?: string; idempotencyKey?: string; json: boolean; verbose: boolean; help: boolean; version: boolean; }
export interface ParsedCommand { command: string; options: GlobalOptions; positionals: string[]; flags: Map<string, string | true | string[]>; cwd: string; }

const TWO_WORD = new Set(["daemon", "project", "task", "process-definition", "schedule", "process"]);

export function parseCommand(argv: string[], _env: Record<string, string | undefined> = process.env, cwd = process.cwd()): ParsedCommand {
  let config: string | undefined, socket: string | undefined, idempotencyKey: string | undefined;
  let json = false, verbose = false, help = false, version = false;
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--config") config = absolute(requireValue(argv[++index], "--config"), "config");
    else if (arg === "--socket") socket = absolute(requireValue(argv[++index], "--socket"), "socket");
    else if (arg === "--idempotency-key") idempotencyKey = requireValue(argv[++index], "--idempotency-key");
    else if (arg === "--json") json = true;
    else if (arg === "--verbose") verbose = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--version") version = true;
    else rest.push(arg);
  }
  const commandLength = TWO_WORD.has(rest[0] ?? "") ? 2 : rest[0] === "status" || rest[0] === "history" ? 1 : 0;
  const command = rest.slice(0, commandLength).join(" ");
  if (command !== "daemon install" && rest.includes("--db")) throw applicationError("USAGE_ERROR", "Unknown option.", { argument: "--db" });
  const flags = new Map<string, string | true | string[]>();
  const positionals: string[] = [];
  for (let index = commandLength; index < rest.length; index++) {
    const value = rest[index]!;
    if (!value.startsWith("--")) { positionals.push(value); continue; }
    const next = rest[index + 1];
    const flagValue: string | true = next !== undefined && !next.startsWith("--") ? (index++, next) : true;
    const prior = flags.get(value);
    flags.set(value, prior === undefined ? flagValue : Array.isArray(prior) ? [...prior, flagValue as string] : [prior as string, flagValue as string]);
  }
  return {
    command,
    options: {
      ...(config === undefined ? {} : { config }),
      ...(socket === undefined ? {} : { socket }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      json,
      verbose,
      help,
      version,
    },
    positionals,
    flags,
    cwd,
  };
}

export function flag(parsed: ParsedCommand, name: string): string | undefined {
  const value = parsed.flags.get(name);
  if (value === undefined) return undefined;
  if (value === true) throw applicationError("USAGE_ERROR", `Option ${name} requires a value.`, { argument: name });
  if (Array.isArray(value)) throw applicationError("USAGE_ERROR", `Option ${name} may only be specified once.`, { argument: name });
  return value;
}
export function flags(parsed: ParsedCommand, name: string): string[] {
  const value = parsed.flags.get(name);
  if (value === undefined) return [];
  if (value === true) throw applicationError("USAGE_ERROR", `Option ${name} requires a value.`, { argument: name });
  return Array.isArray(value) ? value : [value];
}
export function boolFlag(parsed: ParsedCommand, name: string): boolean { const value = parsed.flags.get(name); if (value === undefined) return false; if (value !== true) throw applicationError("USAGE_ERROR", `Option ${name} does not take a value.`, { argument: name }); return true; }
export function noUnknownFlags(parsed: ParsedCommand, allowed: readonly string[]): void { for (const key of parsed.flags.keys()) if (!allowed.includes(key)) throw applicationError("USAGE_ERROR", "Unknown option.", { argument: key }); }
export function parseHistoryLimit(value: string | undefined): number { if (value === undefined) return HISTORY_DEFAULT_LIMIT; return positive(value, "History limit must be an integer from 1 through 1000.", "limit", HISTORY_MAX_LIMIT); }
export function parsePositive(value: string | undefined, field: string): number | undefined { return value === undefined ? undefined : positive(value, `${field} must be a positive integer.`, field, Number.MAX_SAFE_INTEGER); }
export function parseSince(value: string | undefined): string | null {
  if (value === undefined) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) throw invalidSince();
  const [, y, mo, d, h, mi, s, fraction = "", zone, sign, oh, omi] = match;
  const year = Number(y), month = Number(mo), day = Number(d), hour = Number(h), minute = Number(mi), second = Number(s), offsetHour = zone === "Z" ? 0 : Number(oh), offsetMinute = zone === "Z" ? 0 : Number(omi);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) throw invalidSince();
  const calendar = utcDate(year, month - 1, day, 0, 0, 0, 0);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) throw invalidSince();
  const instant = new Date(utcDate(year, month - 1, day, hour, minute, second, Number(`${fraction.slice(0, 3).padEnd(3, "0")}`)).getTime() - (offsetHour * 60 + offsetMinute) * 60_000 * (sign === "-" ? -1 : 1));
  if (Number.isNaN(instant.getTime())) throw invalidSince();
  return instant.toISOString();
}
export function parsePlannedState(value: string | undefined): PlannedState | undefined { return enumState(value, ["planned", "ready", "active", "paused", "blocked", "done", "canceled"], "planned-state") as PlannedState | undefined; }
export function parseObservedState(value: string | undefined): ObservedState | undefined { return enumState(value, ["unknown", "idle", "running", "succeeded", "failed", "stale"], "observed-state") as ObservedState | undefined; }
export function query(params: Record<string, string | number | null | undefined>): URLSearchParams { const result = new URLSearchParams(); for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) result.set(key, String(value)); return result; }
function positive(value: string, message: string, field: string, maximum: number): number { if (!/^[1-9][0-9]*$/.test(value) || Number(value) > maximum) throw applicationError("VALIDATION_ERROR", message, { field, reason: "out_of_range" }); return Number(value); }
function enumState(value: string | undefined, values: string[], field: string): string | undefined { if (value === undefined) return undefined; if (!values.includes(value)) throw applicationError("VALIDATION_ERROR", `Invalid ${field.replace("-", " ")}.`, { field, reason: "invalid_state" }); return value; }
function absolute(value: string, key: string): string { if (!value.startsWith("/") || value.includes("\0")) throw applicationError("CONFIG_ERROR", "Path must be absolute and contain no NUL byte.", { key }); return resolve(value); }
function requireValue(value: string | undefined, argument: string): string { if (value === undefined || value.startsWith("--")) throw applicationError("USAGE_ERROR", `Option ${argument} requires a value.`, { argument }); return value; }
function invalidSince() { return applicationError("VALIDATION_ERROR", "Since must be an RFC3339 instant with an explicit offset.", { field: "since", reason: "invalid_rfc3339" }); }
function utcDate(year: number, month: number, day: number, hour: number, minute: number, second: number, millisecond: number): Date { const result = new Date(0); result.setUTCFullYear(year, month, day); result.setUTCHours(hour, minute, second, millisecond); return result; }
