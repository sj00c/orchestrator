import { createConnection } from "node:net";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { ProcessIdentity } from "../../domain/model.ts";
import { RunnerRuntimeError, type RunnerAdoptionInput, type RunnerDiscoveryInput, type RunnerExecInput, type RunnerExecOutcome, type RunnerHandle, type RunnerLaunchInput, type RunnerResult, type RunnerResultRequest, type RunnerRuntime, type RunnerShutdownOptions, type RunnerStopInput, type RunnerStopOutcome } from "../../ports/runner-runtime.ts";
import { RUNNER_PROTOCOL_VERSION, sameIdentity, sameSecret, tokenProof, validateProcessSpec, validateResult } from "../../runner/protocol.ts";
import { DESCRIPTOR_FILE, readOwnedJson } from "../../runner/result-store.ts";

const READY_TIMEOUT_MS = 5_000;
const MAX_REPLY_BYTES = 64 * 1024;
const DEFAULT_STOP_ALL_DEADLINE_MS = 10_000;
const HARD_STOP_RESERVE_MS = 2_000;

/** Bun process adapter. The only runner secret travels on its stdin pipe, never argv or environment. */
export class BunRunnerRuntime implements RunnerRuntime {
  private readonly liveRunners = new Map<string, ManagedRunner>();

  async launch(input: RunnerLaunchInput): Promise<RunnerHandle> {
    validateLaunch(input);
    const tokenBytes = new TextEncoder().encode(`${input.token}\n`);
    const tokenStream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(tokenBytes); controller.close(); } });
    const childProcess = Bun.spawn([process.execPath, new URL("../../runner/main.ts", import.meta.url).pathname, "--attempt-dir", input.attemptDirectory, "--attempt-id", input.attemptId], { stdin: tokenStream, stdout: "inherit", stderr: "inherit" });
    const descriptor = await waitForDescriptor(input.attemptDirectory, input.attemptId, input.token);
    const handle = { attemptId: input.attemptId, endpoint: descriptor.endpoint, runner: descriptor.runner, tokenProof: descriptor.tokenProof, leaseToken: input.leaseToken };
    this.remember(input, handle, childProcess);
    return handle;
  }

  async discover(input: RunnerDiscoveryInput): Promise<RunnerHandle | null> {
    if (!validateDiscovery(input)) throw new Error("invalid runner discovery input");
    const descriptor = await waitForDescriptorOrNull(input.attemptDirectory, input.attemptId, input.token);
    if (descriptor === null) return null;
    const handle = { attemptId: input.attemptId, endpoint: descriptor.endpoint, runner: descriptor.runner, tokenProof: descriptor.tokenProof, leaseToken: input.leaseToken };
    this.remember(input, handle, null);
    return handle;
  }

  async adopt(input: RunnerAdoptionInput): Promise<RunnerHandle | null> {
    const descriptor = await readDescriptor(input.attemptDirectory, input.attemptId, input.token);
    if (descriptor === null) return null;
    if (!sameIdentity(input.runner, descriptor.runner)) {
      throw new RunnerRuntimeError("RUNNER_DESCRIPTOR_INVALID", "runner descriptor identity does not match the persisted runner");
    }
    if (input.previousLeaseToken !== undefined) {
      if (!isPreviousLease(input.previousLeaseToken, input.leaseToken)) {
        throw new RunnerRuntimeError("RUNNER_CONTROL_FENCE", "runner takeover lease is invalid");
      }
      const takeover = await control(descriptor.endpoint, {
        type: "TAKEOVER",
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        attemptId: input.attemptId,
        token: input.token,
        previousLeaseToken: input.previousLeaseToken,
        leaseToken: input.leaseToken,
        runner: input.runner,
      });
      assertControlSuccess(takeover);
      if (!isTakeoverAck(takeover)) throw new RunnerRuntimeError("RUNNER_CONTROL_INVALID_RESPONSE", "runner returned an invalid takeover response");
    }
    const reply = await control(descriptor.endpoint, { type: "STATUS", protocolVersion: RUNNER_PROTOCOL_VERSION, attemptId: input.attemptId, token: input.token, leaseToken: input.leaseToken, runner: input.runner });
    assertControlSuccess(reply);
    if (!isAck(reply)) throw new RunnerRuntimeError("RUNNER_CONTROL_INVALID_RESPONSE", "runner returned an invalid status response");
    const handle = { attemptId: input.attemptId, endpoint: descriptor.endpoint, runner: descriptor.runner, tokenProof: descriptor.tokenProof, leaseToken: input.leaseToken };
    this.remember(input, handle, null);
    return handle;
  }

  async exec(input: RunnerExecInput): Promise<RunnerExecOutcome> {
    if (!validateExec(input)) throw new Error("invalid runner exec input");
    const tracked = this.liveRunners.get(input.attemptId);
    if (tracked === undefined || !sameTrackedAttempt(tracked, input)) {
      throw new Error("runner handle is not tracked or does not match exec grant");
    }
    const descriptor = await readDescriptor(input.attemptDirectory, input.attemptId, input.token);
    if (
      descriptor === null ||
      !sameIdentity(tracked.handle.runner, descriptor.runner) ||
      !sameIdentity(input.runner, descriptor.runner)
    ) {
      throw new RunnerRuntimeError("RUNNER_DESCRIPTOR_INVALID", "runner descriptor identity does not match the exec grant");
    }
    const reply = await control(descriptor.endpoint, {
      type: "EXEC",
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      attemptId: input.attemptId,
      token: input.token,
      leaseToken: input.leaseToken,
      specHash: input.specHash,
      spec: input.spec,
    });
    assertControlSuccess(reply);
    if (!isExecAck(reply) || reply.status !== "running") {
      throw new RunnerRuntimeError("RUNNER_CONTROL_INVALID_RESPONSE", "runner returned an invalid exec response");
    }
    return {
      attemptId: input.attemptId,
      tokenProof: tracked.handle.tokenProof,
      leaseToken: input.leaseToken,
      runner: tracked.handle.runner,
      child: reply.child,
      grantedAt: new Date().toISOString(),
    };
  }

  async stop(input: RunnerStopInput): Promise<RunnerStopOutcome> {
    const descriptor = await readDescriptor(input.attemptDirectory, input.attemptId, input.token);
    if (descriptor === null) return { attemptId: input.attemptId, tokenProof: tokenProof(input.token), leaseToken: input.leaseToken, runner: input.runner, accepted: false, alreadyFinished: false };
    if (!sameIdentity(input.runner, descriptor.runner)) {
      throw new RunnerRuntimeError("RUNNER_DESCRIPTOR_INVALID", "runner descriptor identity does not match the stop request");
    }
    const reply = await control(descriptor.endpoint, { type: "STOP", protocolVersion: RUNNER_PROTOCOL_VERSION, attemptId: input.attemptId, token: input.token, leaseToken: input.leaseToken, runner: input.runner, graceMs: input.graceMs });
    assertControlSuccess(reply);
    if (!isAck(reply)) throw new RunnerRuntimeError("RUNNER_CONTROL_INVALID_RESPONSE", "runner returned an invalid stop response");
    return { attemptId: input.attemptId, tokenProof: tokenProof(input.token), leaseToken: input.leaseToken, runner: input.runner, accepted: isAck(reply), alreadyFinished: isAck(reply) && reply.status === "finished" };
  }

  async stopAll(options: RunnerShutdownOptions = { graceMs: DEFAULT_STOP_ALL_DEADLINE_MS - HARD_STOP_RESERVE_MS, hardDeadlineMs: DEFAULT_STOP_ALL_DEADLINE_MS }): Promise<void> {
    const { graceMs, hardDeadlineMs } = options;
    if (!Number.isSafeInteger(graceMs) || graceMs < 0 || !Number.isSafeInteger(hardDeadlineMs) || hardDeadlineMs <= 0 || graceMs > hardDeadlineMs) {
      throw new Error("invalid runner shutdown deadlines");
    }
    const tracked = [...this.liveRunners.values()];
    if (tracked.length === 0) return;
    const deadline = Date.now() + hardDeadlineMs;
    await Promise.all(tracked.map((runner) => this.stopTracked(runner, graceMs, deadline)));
    const remaining = await this.waitForCompletion(tracked, Math.min(deadline, Date.now() + graceMs));
    if (remaining.length !== 0) {
      await Promise.all(remaining.map((runner) => this.stopTracked(runner, 0, deadline)));
    }
    const unresolved = await this.waitForCompletion(remaining, deadline);
    if (unresolved.length !== 0) {
      for (const runner of unresolved) {
        if (runner.process !== null) runner.process.kill("SIGKILL");
      }
      throw new Error(`runner shutdown deadline expired with ${unresolved.length} unreconciled attempt(s)`);
    }
  }

  async readResult(input: RunnerResultRequest): Promise<RunnerResult | null> {
    if (input.previousLeaseToken !== undefined && !isPreviousLease(input.previousLeaseToken, input.leaseToken)) {
      throw new RunnerRuntimeError("RUNNER_CONTROL_FENCE", "result lease is invalid");
    }
    const value = await readOwnedJson(join(input.attemptDirectory, "result.json"));
    const resultLeaseToken = input.previousLeaseToken ?? input.leaseToken;
    if (value === null) return null;
    if (!validateResult(value) || value.attemptId !== input.attemptId || value.leaseToken !== resultLeaseToken || !sameIdentity(input.runner, value.runner) || !sameSecret(tokenProof(input.token), value.tokenProof)) {
      throw new RunnerRuntimeError("RUNNER_RESULT_INVALID", "result artifact does not authenticate the current attempt");
    }
    this.liveRunners.delete(input.attemptId);
    return value;
  }

  private remember(input: RunnerLaunchInput | RunnerDiscoveryInput | RunnerAdoptionInput, handle: RunnerHandle, process: Bun.Subprocess | null): void {
    this.liveRunners.set(input.attemptId, { input, handle, process });
  }

  private async stopTracked(runner: ManagedRunner, graceMs: number, deadline: number): Promise<RunnerStopOutcome> {
    const remaining = deadline - Date.now();
    if (remaining < 0) throw new Error("runner shutdown deadline expired");
    const stopInput: RunnerStopInput = {
      attemptId: runner.input.attemptId,
      attemptDirectory: runner.input.attemptDirectory,
      token: runner.input.token,
      leaseToken: runner.input.leaseToken,
      runner: runner.handle.runner,
      graceMs: Math.min(graceMs, remaining),
    };
    return withinDeadline(this.stop(stopInput), deadline);
  }

  private async pending(runners: readonly ManagedRunner[]): Promise<ManagedRunner[]> {
    const pending: ManagedRunner[] = [];
    await Promise.all(runners.map(async (runner) => {
      const result = await this.readResult({
        attemptId: runner.input.attemptId,
        attemptDirectory: runner.input.attemptDirectory,
        token: runner.input.token,
        leaseToken: runner.input.leaseToken,
        runner: runner.handle.runner,
      });
      if (result === null) pending.push(runner);
    }));
    return pending;
  }

  private async waitForCompletion(runners: readonly ManagedRunner[], deadline: number): Promise<ManagedRunner[]> {
    let unresolved = await this.pending(runners);
    while (unresolved.length !== 0 && Date.now() < deadline) {
      await Bun.sleep(Math.min(25, deadline - Date.now()));
      unresolved = await this.pending(unresolved);
    }
    return unresolved;
  }
}

interface Descriptor { protocolVersion: number; attemptId: string; endpoint: string; runner: ProcessIdentity; tokenProof: string; }
interface ManagedRunner {
  input: RunnerLaunchInput | RunnerDiscoveryInput | RunnerAdoptionInput;
  handle: RunnerHandle;
  process: Bun.Subprocess | null;
}
async function waitForDescriptor(directory: string, attemptId: string, token: string): Promise<Descriptor> {
  const descriptor = await waitForDescriptorOrNull(directory, attemptId, token);
  if (descriptor !== null) return descriptor;
  throw new Error("runner did not publish an authenticated descriptor");
}
async function waitForDescriptorOrNull(directory: string, attemptId: string, token: string): Promise<Descriptor | null> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const descriptor = await readDescriptor(directory, attemptId, token);
    if (descriptor !== null) return descriptor;
    await Bun.sleep(25);
  }
  return null;
}
async function readDescriptor(directory: string, attemptId: string, token: string): Promise<Descriptor | null> {
  const value = await readOwnedJson(join(directory, DESCRIPTOR_FILE));
  if (value === null) return null;
  if (!isDescriptor(value) || value.protocolVersion !== RUNNER_PROTOCOL_VERSION || value.attemptId !== attemptId || !sameSecret(value.tokenProof, tokenProof(token)) || !value.endpoint.startsWith(`${directory}/`)) {
    throw new RunnerRuntimeError("RUNNER_DESCRIPTOR_INVALID", "runner descriptor is invalid");
  }
  try {
    const socket = await lstat(value.endpoint);
    if (!socket.isSocket() || socket.uid !== currentUid() || (socket.mode & 0o077) !== 0) {
      throw new RunnerRuntimeError("RUNNER_DESCRIPTOR_INVALID", "runner control socket has unsafe metadata");
    }
  } catch (error) {
    if (error instanceof RunnerRuntimeError) throw error;
    throw new RunnerRuntimeError("RUNNER_DESCRIPTOR_INVALID", "runner control socket is unavailable", error);
  }
  return value;
}
async function control(endpoint: string, message: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let socket: ReturnType<typeof createConnection>;
    try {
      socket = createConnection(endpoint);
    } catch (error) {
      reject(new RunnerRuntimeError("RUNNER_CONTROL_DISCONNECTED", "runner control connection failed", error));
      return;
    }
    let reply = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.end(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk: string) => { reply += chunk; if (Buffer.byteLength(reply, "utf8") > MAX_REPLY_BYTES) socket.destroy(new Error("runner response exceeds limit")); });
    socket.once("error", (error) => reject(new RunnerRuntimeError("RUNNER_CONTROL_DISCONNECTED", "runner control connection failed", error)));
    socket.once("close", () => {
      if (reply.length === 0) {
        reject(new RunnerRuntimeError("RUNNER_CONTROL_DISCONNECTED", "runner control connection closed without a response"));
        return;
      }
      try { resolve(JSON.parse(reply)); }
      catch (error) { reject(new RunnerRuntimeError("RUNNER_CONTROL_INVALID_RESPONSE", "runner returned invalid control JSON", error)); }
    });
  });
}
function validateLaunch(input: RunnerLaunchInput): void { if (!input.attemptId || !input.attemptDirectory.startsWith("/") || input.token.length < 32 || !Number.isSafeInteger(input.leaseToken) || input.leaseToken <= 0 || !input.specHash) throw new Error("invalid runner launch input"); }
function validateDiscovery(input: RunnerDiscoveryInput): boolean {
  return input.attemptId.length > 0 &&
    input.attemptDirectory.startsWith("/") &&
    input.token.length >= 32 &&
    Number.isSafeInteger(input.leaseToken) &&
    input.leaseToken > 0 &&
    input.specHash.length > 0 &&
    validateProcessSpec(input.spec);
}
function validateExec(input: RunnerExecInput): boolean {
  return input.attemptId.length > 0 &&
    input.attemptDirectory.startsWith("/") &&
    input.token.length >= 32 &&
    Number.isSafeInteger(input.leaseToken) &&
    input.leaseToken > 0 &&
    isIdentity(input.runner) &&
    input.specHash.length > 0 &&
    validateProcessSpec(input.spec);
}
function isPreviousLease(previousLeaseToken: number, leaseToken: number): boolean {
  return Number.isSafeInteger(previousLeaseToken) &&
    previousLeaseToken > 0 &&
    Number.isSafeInteger(leaseToken) &&
    leaseToken > previousLeaseToken;
}
function sameTrackedAttempt(tracked: ManagedRunner, input: RunnerExecInput): boolean {
  return tracked.input.attemptId === input.attemptId &&
    tracked.input.attemptDirectory === input.attemptDirectory &&
    sameSecret(tracked.input.token, input.token) &&
    tracked.input.leaseToken === input.leaseToken &&
    tracked.input.specHash === input.specHash &&
    sameIdentity(tracked.handle.runner, input.runner);
}
function isDescriptor(value: unknown): value is Descriptor { return isRecord(value) && typeof value.protocolVersion === "number" && typeof value.attemptId === "string" && typeof value.endpoint === "string" && typeof value.tokenProof === "string" && isIdentity(value.runner); }
function isIdentity(value: unknown): value is ProcessIdentity { return isRecord(value) && typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.pgid === "number" && Number.isSafeInteger(value.pgid) && value.pgid > 0 && typeof value.startedAt === "string" && typeof value.executableIdentity === "string"; }
function isAck(value: unknown): value is { ok: true; status: string } { return isRecord(value) && value.ok === true && typeof value.status === "string"; }
function isTakeoverAck(value: unknown): value is { ok: true; status: "granted" | "running" } {
  return isRecord(value) &&
    value.ok === true &&
    (value.status === "granted" || value.status === "running") &&
    (value.child === undefined || isIdentity(value.child));
}
function isExecAck(value: unknown): value is { ok: true; status: "running"; child: ProcessIdentity } {
  return isRecord(value) && value.ok === true && value.status === "running" && isIdentity(value.child);
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function assertControlSuccess(value: unknown): void {
  if (!isRecord(value) || value.ok !== false || typeof value.code !== "string") return;
  if (value.code === "AUTH_FAILED") throw new RunnerRuntimeError("RUNNER_CONTROL_AUTH", "runner rejected control authentication");
  if (value.code === "FENCE_MISMATCH") throw new RunnerRuntimeError("RUNNER_CONTROL_FENCE", "runner rejected control fence");
  throw new RunnerRuntimeError("RUNNER_CONTROL_REJECTED", `runner rejected control request: ${value.code}`);
}
function currentUid(): number {
  const getuid = process.getuid;
  if (getuid === undefined) throw new Error("current uid is unavailable");
  return getuid.call(process);
}
async function withinDeadline<Result>(operation: Promise<Result>, deadline: number): Promise<Result> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("runner shutdown deadline expired");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("runner shutdown deadline expired")), remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}


