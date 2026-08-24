import { createHash, timingSafeEqual } from "node:crypto";
import { isFrozenProcessSpec } from "../domain/process-spec.ts";
import type { ProcessIdentity, ProcessSpec } from "../domain/model.ts";
import type { RunnerResult } from "../ports/runner-runtime.ts";

export const RUNNER_PROTOCOL_VERSION = 1;
export const MAX_CONTROL_MESSAGE_BYTES = 64 * 1024;

export interface RunnerDescriptor {
  protocolVersion: typeof RUNNER_PROTOCOL_VERSION;
  attemptId: string;
  endpoint: string;
  runner: ProcessIdentity;
  tokenProof: string;
}

export type RunnerControlRequest =
  | { type: "EXEC"; protocolVersion: number; attemptId: string; token: string; leaseToken: number; specHash: string; spec: ProcessSpec }
  | { type: "TAKEOVER"; protocolVersion: number; attemptId: string; token: string; previousLeaseToken: number; leaseToken: number; runner: ProcessIdentity }
  | { type: "STOP"; protocolVersion: number; attemptId: string; token: string; leaseToken: number; runner: ProcessIdentity; graceMs: number }
  | { type: "STATUS"; protocolVersion: number; attemptId: string; token: string; leaseToken: number; runner: ProcessIdentity };

export type RunnerControlResponse =
  | { ok: true; type: "ACK"; status: "ready" | "granted" | "running" | "stopping" | "finished"; child?: ProcessIdentity; result?: RunnerResult }
  | { ok: false; code: "AUTH_FAILED" | "INVALID_REQUEST" | "IDENTITY_MISMATCH" | "FENCE_MISMATCH" | "SPEC_MISMATCH" | "ALREADY_GRANTED" | "NOT_RUNNING" };

export function tokenProof(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function sameSecret(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(actual, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function sameIdentity(expected: ProcessIdentity, actual: ProcessIdentity): boolean {
  return expected.pid === actual.pid
    && expected.pgid === actual.pgid
    && expected.startedAt === actual.startedAt
    && expected.executableIdentity === actual.executableIdentity;
}

export function canonicalResultPayload(result: Omit<RunnerResult, "resultHash">): string {
  return JSON.stringify({
    attemptId: result.attemptId,
    tokenProof: result.tokenProof,
    leaseToken: result.leaseToken,
    runner: result.runner,
    child: result.child,
    exitCode: result.exitCode,
    signal: result.signal,
    finishedAt: result.finishedAt,
    sequence: result.sequence,
  });
}

export function resultHash(result: Omit<RunnerResult, "resultHash">): string {
  return createHash("sha256").update(canonicalResultPayload(result), "utf8").digest("hex");
}

export function validateProcessSpec(value: unknown): value is ProcessSpec {
  return isFrozenProcessSpec(value);
}

export function validateResult(value: unknown): value is RunnerResult {
  if (!isResultShape(value)) return false;
  const payload = {
    attemptId: value.attemptId,
    tokenProof: value.tokenProof,
    leaseToken: value.leaseToken,
    runner: value.runner,
    child: value.child,
    exitCode: value.exitCode,
    signal: value.signal,
    finishedAt: value.finishedAt,
    sequence: value.sequence,
  };
  return sameSecret(value.resultHash, resultHash(payload));
}

export function parseControlMessage(value: string): unknown | null {
  if (Buffer.byteLength(value, "utf8") > MAX_CONTROL_MESSAGE_BYTES) return null;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isSafeString(value: unknown): value is string { return typeof value === "string" && !value.includes("\0"); }
function isPositiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function isIdentity(value: unknown): value is ProcessIdentity { return isRecord(value) && isPositiveInteger(value.pid) && isPositiveInteger(value.pgid) && typeof value.startedAt === "string" && typeof value.executableIdentity === "string" && value.executableIdentity.length > 0; }
function isResultShape(value: unknown): value is RunnerResult {
  return isRecord(value) &&
    typeof value.resultHash === "string" &&
    typeof value.attemptId === "string" &&
    typeof value.tokenProof === "string" &&
    isPositiveInteger(value.leaseToken) &&
    isIdentity(value.runner) &&
    (value.child === null || isIdentity(value.child)) &&
    (value.exitCode === null || Number.isInteger(value.exitCode)) &&
    (value.signal === null || isSafeString(value.signal)) &&
    (value.exitCode === null) !== (value.signal === null) &&
    typeof value.finishedAt === "string" &&
    isPositiveInteger(value.sequence);
}
