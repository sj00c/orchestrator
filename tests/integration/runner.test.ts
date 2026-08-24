import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { BunRunnerRuntime } from "../../src/adapters/process/runner-runtime.ts";
import { normalizeProcessSpec, processSpecHash } from "../../src/domain/process-spec.ts";
import { RUNNER_PROTOCOL_VERSION, tokenProof } from "../../src/runner/protocol.ts";
import { writeAtomicJson } from "../../src/runner/result-store.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const attemptId = "11111111-1111-4111-8111-111111111111";
const token = "a".repeat(64);
const trueSpec = normalizeProcessSpec({ executable: "/bin/sleep", args: ["1"], cwd: null, envPolicy: { kind: "set", values: {} } });
const trueHash = processSpecHash(trueSpec);
const sleepSpec = normalizeProcessSpec({ executable: "/bin/sleep", args: ["60"], cwd: null, envPolicy: { kind: "set", values: {} } });
const sleepHash = processSpecHash(sleepSpec);

describe("runner process protocol", () => {
  test("K2/K3/K4/K5: publishes READY, tolerates a lost EXEC ACK without a duplicate child, and writes a verified result", async () => {
    const directory = mkdtempSync("/tmp/orchestrator-runner-"); dirs.push(directory);
    const runtime = new BunRunnerRuntime();
    const ready = await runtime.launch({ attemptId, attemptDirectory: directory, token, leaseToken: 7, specHash: trueHash, spec: trueSpec });
    expect(ready).toMatchObject({ attemptId, leaseToken: 7, tokenProof: tokenProof(token) });
    await sendAndDrop(ready.endpoint, { type: "EXEC", protocolVersion: RUNNER_PROTOCOL_VERSION, attemptId, token, leaseToken: 7, specHash: trueHash, spec: trueSpec });
    await Bun.sleep(25);
    const replacement = new BunRunnerRuntime();
    const adopted = await replacement.adopt({ attemptId, attemptDirectory: directory, token, leaseToken: 7, specHash: trueHash, runner: ready.runner });
    expect(adopted).toMatchObject({ endpoint: ready.endpoint, runner: ready.runner });
    if (adopted === null) throw new Error("runner was not adoptable after the lost ACK");
    const replayed = await replacement.exec({ attemptId, attemptDirectory: directory, token, leaseToken: 7, runner: adopted.runner, specHash: trueHash, spec: trueSpec });
    expect((await replacement.exec({ attemptId, attemptDirectory: directory, token, leaseToken: 7, runner: adopted.runner, specHash: trueHash, spec: trueSpec })).child).toEqual(replayed.child);
    expect(await control(ready.endpoint, { type: "EXEC", protocolVersion: RUNNER_PROTOCOL_VERSION, attemptId, token, leaseToken: 8, specHash: trueHash, spec: trueSpec })).toMatchObject({ ok: false, code: "FENCE_MISMATCH" });
    const result = await waitForResult(runtime, directory, ready);
    expect(result).toMatchObject({ attemptId, leaseToken: 7, exitCode: 0, signal: null, tokenProof: tokenProof(token) });
  }, 10_000);

  test("rejects unauthenticated control messages before they can execute a process", async () => {
    const directory = mkdtempSync("/tmp/orchestrator-runner-"); dirs.push(directory);
    const ready = await new BunRunnerRuntime().launch({ attemptId, attemptDirectory: directory, token, leaseToken: 3, specHash: trueHash, spec: trueSpec });
    expect(await control(ready.endpoint, { type: "EXEC", protocolVersion: RUNNER_PROTOCOL_VERSION, attemptId, token: "b".repeat(64), leaseToken: 3, specHash: trueHash, spec: trueSpec })).toMatchObject({ ok: false, code: "AUTH_FAILED" });
  }, 10_000);

  test("rejects a wrong spec hash before granting or spawning a child", async () => {
    const directory = mkdtempSync("/tmp/orchestrator-runner-"); dirs.push(directory);
    const ready = await new BunRunnerRuntime().launch({ attemptId, attemptDirectory: directory, token, leaseToken: 4, specHash: trueHash, spec: trueSpec });
    expect(await control(ready.endpoint, { type: "EXEC", protocolVersion: RUNNER_PROTOCOL_VERSION, attemptId, token, leaseToken: 4, specHash: "wrong-spec-hash", spec: trueSpec })).toMatchObject({ ok: false, code: "SPEC_MISMATCH" });
    expect(await control(ready.endpoint, { type: "STATUS", protocolVersion: RUNNER_PROTOCOL_VERSION, attemptId, token, leaseToken: 4, runner: ready.runner })).toMatchObject({ ok: true, status: "ready" });
    expect(existsSync(join(directory, "child.json"))).toBe(false);
  }, 10_000);

  test("rejects malformed STOP and refuses a mismatched stored child identity without signaling the live child", async () => {
    const directory = mkdtempSync("/tmp/orchestrator-runner-"); dirs.push(directory);
    const runtime = new BunRunnerRuntime();
    const ready = await runtime.launch({ attemptId, attemptDirectory: directory, token, leaseToken: 10, specHash: sleepHash, spec: sleepSpec });
    const exec = await control(ready.endpoint, { type: "EXEC", protocolVersion: RUNNER_PROTOCOL_VERSION, attemptId, token, leaseToken: 10, specHash: sleepHash, spec: sleepSpec });
    expect(await control(ready.endpoint, { type: "STOP", protocolVersion: RUNNER_PROTOCOL_VERSION, attemptId, token, leaseToken: 10, runner: ready.runner })).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    await writeAtomicJson(join(directory, "child.json"), { ...exec.child, pid: 999_999, pgid: 999_999 });
    expect(await control(ready.endpoint, { type: "STOP", protocolVersion: RUNNER_PROTOCOL_VERSION, attemptId, token, leaseToken: 10, runner: ready.runner, graceMs: 0 })).toMatchObject({ ok: false, code: "IDENTITY_MISMATCH" });
    expect(await control(ready.endpoint, { type: "STATUS", protocolVersion: RUNNER_PROTOCOL_VERSION, attemptId, token, leaseToken: 10, runner: ready.runner })).toMatchObject({ ok: true, status: "running", child: exec.child });
    await writeAtomicJson(join(directory, "child.json"), exec.child);
    expect(await runtime.stop({ attemptId, attemptDirectory: directory, token, leaseToken: 10, runner: ready.runner, graceMs: 0 })).toMatchObject({ accepted: true });
    await waitForResult(runtime, directory, ready);
  }, 10_000);

  test("K7: stops a verified real process group and records its signal result", async () => {
    const directory = mkdtempSync("/tmp/orchestrator-runner-"); dirs.push(directory);
    const runtime = new BunRunnerRuntime();
    const ready = await runtime.launch({ attemptId, attemptDirectory: directory, token, leaseToken: 11, specHash: sleepHash, spec: sleepSpec });
    await control(ready.endpoint, { type: "EXEC", protocolVersion: RUNNER_PROTOCOL_VERSION, attemptId, token, leaseToken: 11, specHash: sleepHash, spec: sleepSpec });
    expect(await runtime.stop({ attemptId, attemptDirectory: directory, token, leaseToken: 11, runner: ready.runner, graceMs: 0 })).toMatchObject({ accepted: true });
    expect(await waitForResult(runtime, directory, ready)).toMatchObject({ signal: "SIGTERM" });
  }, 10_000);
});

function control(endpoint: string, request: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint); let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => { response += chunk; });
    socket.once("error", reject);
    socket.once("close", () => { try { resolve(JSON.parse(response)); } catch (error) { reject(error); } });
  });
}
function sendAndDrop(endpoint: string, request: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`, () => {
      socket.destroy();
      resolve();
    }));
    socket.once("error", reject);
  });
}
async function waitForResult(runtime: BunRunnerRuntime, directory: string, ready: { attemptId: string; runner: any; leaseToken: number }): Promise<any> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const result = await runtime.readResult({ attemptId: ready.attemptId, attemptDirectory: directory, token, leaseToken: ready.leaseToken, runner: ready.runner });
    if (result !== null) return result;
    if (Date.now() >= deadline) throw new Error("runner did not persist result at deterministic barrier");
    await Bun.sleep(20);
  }
}
