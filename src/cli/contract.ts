import { resolve } from "node:path";
import { applicationError } from "../application/errors.ts";
import type { ObservedState, PlannedState } from "../domain/model.ts";

export const CLI_VERSION = "0.1.0";
export const HISTORY_DEFAULT_LIMIT = 100;
export const HISTORY_MAX_LIMIT = 1000;
export const COMMANDS = ["project add", "project list", "project show", "task add", "task list", "task show", "task start", "task pause", "task resume", "task block", "task complete", "task cancel", "status", "history"] as const;
export interface GlobalOptions { db: string; json: boolean; verbose: boolean; help: boolean; version: boolean; }
export interface ParsedCommand { command: string; options: GlobalOptions; positionals: string[]; flags: Map<string, string | true>; }

export function parseCommand(argv: string[], env: Record<string, string | undefined> = process.env, cwd = process.cwd()): ParsedCommand {
  let dbFlag: string | undefined;
  let json = false, verbose = false, help = false, version = false;
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--db") { dbFlag = requireValue(argv[++index], "--db"); }
    else if (arg === "--json") json = true;
    else if (arg === "--verbose") verbose = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--version") version = true;
    else rest.push(arg);
  }
  const commandLength = rest[0] === "project" || rest[0] === "task" ? 2 : rest[0] === "status" || rest[0] === "history" ? 1 : 0;
  const command = rest.slice(0, commandLength).join(" ");
  const positionals = rest.slice(commandLength);
  const flags = new Map<string, string | true>();
  const clean: string[] = [];
  for (let i = 0; i < positionals.length; i++) { const value = positionals[i]!; if (!value.startsWith("--")) { clean.push(value); continue; } const next = positionals[i + 1]; if (next !== undefined && !next.startsWith("--")) { flags.set(value, next); i++; } else flags.set(value, true); }
  return { command, options: { db: help || version ? "" : databasePath(dbFlag, env, cwd), json, verbose, help, version }, positionals: clean, flags };
}

export function databasePath(explicit: string | undefined, env: Record<string, string | undefined> = process.env, cwd = process.cwd()): string {
  const selected = nonEmpty(explicit) ?? nonEmpty(env.ORCHESTRATOR_DB) ?? (nonEmpty(env.XDG_STATE_HOME) ? `${env.XDG_STATE_HOME}/orchestrator/orchestrator.db` : null) ?? (nonEmpty(env.HOME) ? `${env.HOME}/.local/state/orchestrator/orchestrator.db` : null);
  if (!selected) throw applicationError("CONFIG_ERROR", "No database location is configured.", { key: "HOME" });
  return resolve(cwd, selected);
}
export function flag(parsed: ParsedCommand, name: string): string | undefined { const value = parsed.flags.get(name); if (value === undefined) return undefined; if (value === true) throw applicationError("USAGE_ERROR", `Option ${name} requires a value.`, { argument: name }); return value; }
export function noUnknownFlags(parsed: ParsedCommand, allowed: readonly string[]): void { for (const key of parsed.flags.keys()) if (!allowed.includes(key)) throw applicationError("USAGE_ERROR", "Unknown option.", { argument: key }); }
export function parseHistoryLimit(value: string | undefined): number { if (value === undefined) return HISTORY_DEFAULT_LIMIT; if (!/^[1-9][0-9]*$/.test(value) || Number(value) > HISTORY_MAX_LIMIT) throw applicationError("VALIDATION_ERROR", "History limit must be an integer from 1 through 1000.", { field: "limit", reason: "out_of_range" }); return Number(value); }
export function parseSince(value: string | undefined): string | null {
  if (value === undefined) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) throw invalidSince();
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = "", zone, sign, offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText), hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  const offsetHour = zone === "Z" ? 0 : Number(offsetHourText);
  const offsetMinute = zone === "Z" ? 0 : Number(offsetMinuteText);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) throw invalidSince();
  const calendar = utcDate(year, month - 1, day, 0, 0, 0, 0);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) throw invalidSince();
  const milliseconds = Number(`${fraction.slice(0, 3).padEnd(3, "0")}`);
  const offset = (offsetHour * 60 + offsetMinute) * 60_000 * (sign === "-" ? -1 : 1);
  const instant = new Date(utcDate(year, month - 1, day, hour, minute, second, milliseconds).getTime() - offset);
  if (Number.isNaN(instant.getTime())) throw invalidSince();
  return instant.toISOString();
}
export function parsePlannedState(value: string | undefined): PlannedState | undefined { if (value === undefined) return undefined; if (!( ["planned", "ready", "active", "paused", "blocked", "done", "canceled"] as string[]).includes(value)) throw applicationError("VALIDATION_ERROR", "Invalid planned state.", { field: "planned-state", reason: "invalid_state" }); return value as PlannedState; }
export function parseObservedState(value: string | undefined): ObservedState | undefined { if (value === undefined) return undefined; if (!( ["unknown", "idle", "running", "succeeded", "failed", "stale"] as string[]).includes(value)) throw applicationError("VALIDATION_ERROR", "Invalid observed state.", { field: "observed-state", reason: "invalid_state" }); return value as ObservedState; }
function nonEmpty(value: string | undefined): string | null { return value && value.length > 0 ? value : null; }
function requireValue(value: string | undefined, argument: string): string { if (value === undefined || value.startsWith("--")) throw applicationError("USAGE_ERROR", `Option ${argument} requires a value.`, { argument }); return value; }
function invalidSince() { return applicationError("VALIDATION_ERROR", "Since must be an RFC3339 instant with an explicit offset.", { field: "since", reason: "invalid_rfc3339" }); }
function utcDate(year: number, month: number, day: number, hour: number, minute: number, second: number, millisecond: number): Date {
  const result = new Date(0);
  result.setUTCFullYear(year, month, day);
  result.setUTCHours(hour, minute, second, millisecond);
  return result;
}
