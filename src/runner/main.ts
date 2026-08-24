import { createServer, type Socket } from "node:net";
import { chmod, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DarwinProcessInspector } from "../adapters/process/darwin-inspector.ts";
import { processSpecHash } from "../domain/process-spec.ts";
import type { ProcessIdentity, ProcessSpec } from "../domain/model.ts";
import type { RunnerResult } from "../ports/runner-runtime.ts";
import { parseControlMessage, resultHash, RUNNER_PROTOCOL_VERSION, sameIdentity, sameSecret, tokenProof, validateProcessSpec } from "./protocol.ts";
import { CHILD_FILE, DESCRIPTOR_FILE, GRANT_FILE, ensureAttemptDirectory, readOwnedJson, readResult, writeAtomicJson, writeResult } from "./result-store.ts";

interface Arguments { attemptDirectory: string; attemptId: string; }
interface Grant { attemptId: string; leaseToken: number; specHash: string; }

const args = parseArguments(Bun.argv.slice(2));
const token = (await Bun.stdin.text()).trim();
if (token.length < 32) fail("runner token is missing or too short");
await ensureAttemptDirectory(args.attemptDirectory);
const inspector = new DarwinProcessInspector();
const runner = await inspectedIdentity(process.pid);
const endpoint = join(args.attemptDirectory, "control.sock");
await unlink(endpoint).catch(() => undefined);

let grant: Grant | null = await readGrant();
let child: Bun.Subprocess<"ignore", "inherit", "inherit"> | null = null;
let childIdentity: ProcessIdentity | null = null;
let stopping = false;
let sequence = 0;
let controlServer: ReturnType<typeof createServer> | null = null;

const descriptor = { protocolVersion: RUNNER_PROTOCOL_VERSION, attemptId: args.attemptId, endpoint, runner, tokenProof: tokenProof(token) };
controlServer = createServer({ allowHalfOpen: true }, (socket) => void handleConnection(socket));
await new Promise<void>((resolve, reject) => {
  controlServer!.once("error", reject);
  controlServer!.listen(endpoint, () => resolve());
});
await chmod(endpoint, 0o600);
await writeAtomicJson(join(args.attemptDirectory, DESCRIPTOR_FILE), descriptor);
process.stdout.write(`${JSON.stringify({ type: "READY", ...descriptor })}\n`);

async function handleConnection(socket: Socket): Promise<void> {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > 64 * 1024) { socket.destroy(); return; }
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    buffer = "";
    void respond(socket, line);
  });
}

async function respond(socket: Socket, line: string): Promise<void> {
  const request = parseControlMessage(line);
  const response = await dispatch(request);
  socket.end(`${JSON.stringify(response)}\n`);
}

async function dispatch(request: unknown): Promise<unknown> {
  if (!isRecord(request) || request.protocolVersion !== RUNNER_PROTOCOL_VERSION || request.attemptId !== args.attemptId || typeof request.token !== "string" || !sameSecret(token, request.token)) return { ok: false, code: "AUTH_FAILED" };
  const leaseToken = request.leaseToken;
  if (!isPositiveInteger(leaseToken)) return { ok: false, code: "INVALID_REQUEST" };
  if (request.type === "STATUS") {
    if (!isRunnerIdentity(request.runner) || !sameIdentity(runner, request.runner)) return { ok: false, code: "IDENTITY_MISMATCH" };
    if (grant !== null && leaseToken !== grant.leaseToken) return { ok: false, code: "FENCE_MISMATCH" };
    const result = await readResult(args.attemptDirectory);
    return { ok: true, type: "ACK", status: result ? "finished" : child ? "running" : grant ? "granted" : "ready", ...(result ? { result } : childIdentity ? { child: childIdentity } : {}) };
  }
  if (request.type === "EXEC") return execute(request, leaseToken);
  if (request.type === "TAKEOVER") return takeover(request, leaseToken);
  if (request.type === "STOP") return stop(request, leaseToken);
  return { ok: false, code: "INVALID_REQUEST" };
}

async function execute(request: Record<string, unknown>, leaseToken: number): Promise<unknown> {
  if (typeof request.specHash !== "string" || !validateProcessSpec(request.spec)) return { ok: false, code: "INVALID_REQUEST" };
  if (!sameSecret(request.specHash, processSpecHash(request.spec))) return { ok: false, code: "SPEC_MISMATCH" };
  if (grant !== null) {
    if (grant.leaseToken !== leaseToken || grant.specHash !== request.specHash) return { ok: false, code: "FENCE_MISMATCH" };
    return { ok: true, type: "ACK", status: child ? "running" : "granted", ...(childIdentity ? { child: childIdentity } : {}) };
  }
  grant = { attemptId: args.attemptId, leaseToken, specHash: request.specHash };
  await writeAtomicJson(join(args.attemptDirectory, GRANT_FILE), grant);
  await spawnChild(request.spec);
  return { ok: true, type: "ACK", status: "running", child: childIdentity! };
}

async function takeover(request: Record<string, unknown>, leaseToken: number): Promise<unknown> {
  const previousLeaseToken = request.previousLeaseToken;
  if (!isRunnerIdentity(request.runner) || !sameIdentity(runner, request.runner) || !isPositiveInteger(previousLeaseToken)) {
    return { ok: false, code: "INVALID_REQUEST" };
  }
  if (grant === null || grant.leaseToken !== previousLeaseToken || leaseToken <= previousLeaseToken) {
    return { ok: false, code: "FENCE_MISMATCH" };
  }
  if (await readResult(args.attemptDirectory)) return { ok: false, code: "NOT_RUNNING" };
  grant = { ...grant, leaseToken };
  await writeAtomicJson(join(args.attemptDirectory, GRANT_FILE), grant);
  return { ok: true, type: "ACK", status: child === null ? "granted" : "running", ...(childIdentity === null ? {} : { child: childIdentity }) };
}

async function spawnChild(spec: ProcessSpec): Promise<void> {
  const environment = makeEnvironment(spec);
  try {
    child = Bun.spawn([spec.executable, ...spec.args], {
      ...(spec.cwd === null ? {} : { cwd: spec.cwd }),
      env: environment,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      detached: true,
    });
  } catch (error) {
    await finish(null, "SPAWN_FAILED");
    throw error;
  }
  try {
    let actual = null;
    for (let retry = 0; retry < 20; retry++) {
      const candidate = await inspector.inspect(child.pid);
      if (candidate !== null && candidate.executable === spec.executable && candidate.pgid === child.pid) {
        actual = candidate;
        break;
      }
      await Bun.sleep(5);
    }
    if (actual === null || actual.executable === undefined) {
      const alreadyExited = await Promise.race([child.exited.then(() => true), Bun.sleep(25).then(() => false)]);
      if (!alreadyExited) throw new Error("Live child identity could not be inspected");
      childIdentity = { pid: child.pid, pgid: child.pid, startedAt: new Date().toISOString(), executableIdentity: spec.executable };
    } else {
      childIdentity = { pid: actual.pid, pgid: actual.pgid, startedAt: actual.startedAt, executableIdentity: actual.executable };
    }
  } catch (error) {
    process.kill(-child.pid, "SIGKILL");
    await child.exited;
    child = null;
    await finish(null, "CHILD_IDENTITY_INVALID");
    throw error;
  }
  await writeAtomicJson(join(args.attemptDirectory, CHILD_FILE), childIdentity);
  void waitForChild(child);
}

async function waitForChild(processToWait: Bun.Subprocess<"ignore", "inherit", "inherit">): Promise<void> {
  await processToWait.exited;
  const exitCode = processToWait.exitCode;
  const signal = processToWait.signalCode ?? null;
  await finish(exitCode ?? null, signal === null ? "UNKNOWN_EXIT" : signal);
}

async function stop(request: Record<string, unknown>, leaseToken: number): Promise<unknown> {
  if (!isRunnerIdentity(request.runner) || !sameIdentity(runner, request.runner)) return { ok: false, code: "IDENTITY_MISMATCH" };
  if (grant === null || leaseToken !== grant.leaseToken) return { ok: false, code: "FENCE_MISMATCH" };
  if (await readResult(args.attemptDirectory)) return { ok: true, type: "ACK", status: "finished" };
  if (child === null || childIdentity === null || !isStopGrace(request.graceMs)) return { ok: false, code: "INVALID_REQUEST" };
  const storedChild = await readStoredChildIdentity();
  if (storedChild === null) return { ok: false, code: "IDENTITY_MISMATCH" };
  try {
    await inspector.signal(storedChild, "SIGTERM");
  } catch {
    return { ok: false, code: "IDENTITY_MISMATCH" };
  }
  stopping = true;
  setTimeout(() => {
    if (child !== null && child.exitCode === null) void hardStop(storedChild);
  }, request.graceMs).unref();
  return { ok: true, type: "ACK", status: "stopping" };
}

async function hardStop(identity: ProcessIdentity): Promise<void> {
  try {
    await inspector.signal(identity, "SIGKILL");
  } catch {
    const current = await inspector.inspect(identity.pid);
    if (current !== null && current.executable !== undefined && sameIdentity(identity, {
      pid: current.pid,
      pgid: current.pgid,
      startedAt: current.startedAt,
      executableIdentity: current.executable,
    })) {
      console.error(JSON.stringify({ type: "runner_stop_error", attemptId: args.attemptId, code: "SIGNAL_FAILED" }));
    }
  }
}

async function finish(exitCode: number | null, signal: string | null): Promise<void> {
  if (grant === null || await readResult(args.attemptDirectory)) return;
  const payload = { attemptId: args.attemptId, tokenProof: tokenProof(token), leaseToken: grant.leaseToken, runner, child: childIdentity, exitCode, signal: exitCode === null ? signal : null, finishedAt: new Date().toISOString(), sequence: ++sequence };
  const result: RunnerResult = { ...payload, resultHash: resultHash(payload) };
  await writeResult(args.attemptDirectory, result);
  const server = controlServer;
  controlServer = null;
  if (server !== null) {
    server.close(() => {
      void unlink(endpoint).catch(() => undefined);
    });
  }
}

async function readGrant(): Promise<Grant | null> {
  const value = await readOwnedJson(join(args.attemptDirectory, GRANT_FILE));
  return isGrant(value) && value.attemptId === args.attemptId ? value : null;
}

function makeEnvironment(spec: ProcessSpec): Record<string, string> {
  if (spec.envPolicy.kind === "set") return { ...spec.envPolicy.values };
  const environment: Record<string, string> = {};
  for (const key of spec.envPolicy.allowlist) { const value = process.env[key]; if (value !== undefined) environment[key] = value; }
  return environment;
}
async function readStoredChildIdentity(): Promise<ProcessIdentity | null> {
  const value = await readOwnedJson(join(args.attemptDirectory, CHILD_FILE));
  return isRunnerIdentity(value) ? value : null;
}
function parseArguments(values: string[]): Arguments { const directory = values[0] === "--attempt-dir" ? values[1] : undefined; const attemptId = values[2] === "--attempt-id" ? values[3] : undefined; if (!directory || !attemptId || values.length !== 4 || !directory.startsWith("/") || attemptId.includes("/")) fail("invalid runner arguments"); return { attemptDirectory: directory, attemptId }; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
async function inspectedIdentity(pid: number): Promise<ProcessIdentity> {
  const actual = await inspector.inspect(pid);
  if (actual === null || actual.executable === undefined) throw new Error("Process identity could not be inspected");
  return { pid: actual.pid, pgid: actual.pgid, startedAt: actual.startedAt, executableIdentity: actual.executable };
}
function isRunnerIdentity(value: unknown): value is ProcessIdentity { return isRecord(value) && isPositiveInteger(value.pid) && isPositiveInteger(value.pgid) && typeof value.startedAt === "string" && typeof value.executableIdentity === "string" && value.executableIdentity.length > 0; }
function isPositiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function isStopGrace(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 60_000; }
function isGrant(value: unknown): value is Grant { return isRecord(value) && typeof value.attemptId === "string" && isPositiveInteger(value.leaseToken) && typeof value.specHash === "string" && value.specHash.length > 0; }
function fail(message: string): never { throw new Error(message); }
