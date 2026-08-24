import { createHash } from "node:crypto";
import { realpathSync, statSync, type Stats } from "node:fs";
import type { EnvironmentPolicy, ProcessSpec } from "./model.ts";

export const MAX_PROCESS_ARGUMENTS = 256;
export const MAX_PROCESS_ARGUMENT_LENGTH = 8 * 1024;
export const MAX_ENVIRONMENT_ENTRIES = 128;
export const MAX_ENVIRONMENT_VALUE_LENGTH = 32 * 1024;

export class ProcessSpecValidationError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid process specification: ${reason}`);
    this.name = "ProcessSpecValidationError";
  }
}

/** Validates daemon input, resolves filesystem paths, and returns its canonical form. */
export function normalizeProcessSpec(value: unknown): ProcessSpec {
  const spec = parseProcessSpec(value);
  const executable = canonicalPath(spec.executable, "executable", (stats) => stats.isFile() && (stats.mode & 0o111) !== 0);
  const cwd = spec.cwd === null ? null : canonicalPath(spec.cwd, "cwd", (stats) => stats.isDirectory());
  return canonicalSpec(executable, spec.args, cwd, spec.envPolicy);
}

/** Validates a persisted or transmitted canonical snapshot without resolving paths again. */
export function isFrozenProcessSpec(value: unknown): value is ProcessSpec {
  try {
    const spec = parseProcessSpec(value);
    if (!isCanonicalPath(spec.executable) || (spec.cwd !== null && !isCanonicalPath(spec.cwd))) return false;
    const canonical = canonicalSpec(spec.executable, spec.args, spec.cwd, spec.envPolicy);
    return sameSpec(value, canonical);
  } catch {
    return false;
  }
}

export function processSpecHash(spec: ProcessSpec): string {
  if (!isFrozenProcessSpec(spec)) throw new ProcessSpecValidationError("not_canonical");
  return createHash("sha256").update(canonicalProcessSpecJson(spec), "utf8").digest("hex");
}

export function canonicalProcessSpecJson(spec: ProcessSpec): string {
  return JSON.stringify({ executable: spec.executable, args: spec.args, cwd: spec.cwd, envPolicy: spec.envPolicy });
}

function parseProcessSpec(value: unknown): ProcessSpec {
  if (!isRecord(value) || !hasOnlyKeys(value, ["executable", "args", "cwd", "envPolicy"])) fail("shape");
  if (!isSafeString(value.executable) || !value.executable.startsWith("/")) fail("executable");
  if (!Array.isArray(value.args) || value.args.length > MAX_PROCESS_ARGUMENTS || !value.args.every((arg) => isBoundedString(arg, MAX_PROCESS_ARGUMENT_LENGTH))) fail("args");
  if (value.cwd !== null && (!isSafeString(value.cwd) || !value.cwd.startsWith("/"))) fail("cwd");
  return { executable: value.executable, args: [...value.args], cwd: value.cwd, envPolicy: parseEnvironmentPolicy(value.envPolicy) };
}

function parseEnvironmentPolicy(value: unknown): EnvironmentPolicy {
  if (!isRecord(value) || typeof value.kind !== "string") fail("envPolicy");
  if (value.kind === "inherit") {
    if (!hasOnlyKeys(value, ["kind", "allowlist"]) || !Array.isArray(value.allowlist) || value.allowlist.length > MAX_ENVIRONMENT_ENTRIES || !value.allowlist.every(isEnvironmentName) || new Set(value.allowlist).size !== value.allowlist.length) fail("envPolicy.allowlist");
    return { kind: "inherit", allowlist: [...value.allowlist].sort(compareKeys) };
  }
  if (value.kind === "set") {
    if (!hasOnlyKeys(value, ["kind", "values"]) || !isRecord(value.values)) fail("envPolicy.values");
    const entries = Object.entries(value.values);
    if (entries.length > MAX_ENVIRONMENT_ENTRIES || entries.some(([name, entry]) => !isEnvironmentName(name) || !isBoundedString(entry, MAX_ENVIRONMENT_VALUE_LENGTH))) fail("envPolicy.values");
    const values: Record<string, string> = {};
    for (const [name, entry] of entries.sort(([left], [right]) => compareKeys(left, right))) values[name] = entry as string;
    return { kind: "set", values };
  }
  fail("envPolicy.kind");
}

function canonicalSpec(executable: string, args: readonly string[], cwd: string | null, envPolicy: EnvironmentPolicy): ProcessSpec {
  return envPolicy.kind === "inherit"
    ? { executable, args: [...args], cwd, envPolicy: { kind: "inherit", allowlist: [...envPolicy.allowlist].sort(compareKeys) } }
    : { executable, args: [...args], cwd, envPolicy: { kind: "set", values: Object.fromEntries(Object.entries(envPolicy.values).sort(([left], [right]) => compareKeys(left, right))) } };
}

function canonicalPath(value: string, field: string, predicate: (stats: Stats) => boolean): string {
  try {
    const canonical = realpathSync(value);
    const stats = statSync(canonical);
    if (!stats || !predicate(stats)) fail(field);
    return canonical;
  } catch (error) {
    if (error instanceof ProcessSpecValidationError) throw error;
    fail(field);
  }
}
function isCanonicalPath(value: string): boolean { return isSafeString(value) && value.startsWith("/") && (value === "/" || !value.endsWith("/")) && !value.split("/").slice(1).some((segment) => segment === "" || segment === "." || segment === ".."); }
function sameSpec(value: unknown, canonical: ProcessSpec): boolean { return JSON.stringify(value) === canonicalProcessSpecJson(canonical); }
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value); return actual.length === keys.length && actual.every((key) => keys.includes(key)); }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function isSafeString(value: unknown): value is string { return typeof value === "string" && value.length > 0 && !value.includes("\0"); }
function isBoundedString(value: unknown, maximum: number): value is string { return isSafeString(value) && value.length <= maximum; }
function isEnvironmentName(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value); }
function compareKeys(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function fail(reason: string): never { throw new ProcessSpecValidationError(reason); }
