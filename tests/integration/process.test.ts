import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BunRunnerRuntime } from "../../src/adapters/process/runner-runtime.ts";
import { normalizeProcessSpec, processSpecHash } from "../../src/domain/process-spec.ts";
import { RUNNER_PROTOCOL_VERSION } from "../../src/runner/protocol.ts";
import { createConnection } from "node:net";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const attemptId = "11111111-1111-4111-8111-111111111111";
const token = "a".repeat(64);

describe("managed process runner", () => {
  test("executes a structured argv exactly once without a shell and preserves its result", async () => {
    const directory = mkdtempSync("/tmp/orchestrator-process-"); directories.push(directory);
    const output = join(directory, "argv.json");
    const runtime = new BunRunnerRuntime();
    const spec = normalizeProcessSpec({ executable: process.execPath, args: ["-e", "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))", output, "literal;not-a-shell-command"], cwd: null, envPolicy: { kind: "set", values: {} } });
    const specHash = processSpecHash(spec);
    const ready = await runtime.launch({ attemptId, attemptDirectory: directory, token, leaseToken: 1, specHash, spec });
    const request = { type: "EXEC", protocolVersion: RUNNER_PROTOCOL_VERSION, attemptId, token, leaseToken: 1, specHash, spec };
    expect(await control(ready.endpoint, request)).toMatchObject({ ok: true, status: "running" });
    expect(await control(ready.endpoint, request)).toMatchObject({ ok: true });
    const result = await waitForResult(runtime, directory, ready);
    expect(result).toMatchObject({ exitCode: 0, signal: null, leaseToken: 1 });
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(["literal;not-a-shell-command"]);
    try { process.kill(ready.runner.pid, "SIGKILL"); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }, 10_000);

  test("refuses a stop request whose runner identity does not match", async () => {
    const directory = mkdtempSync("/tmp/orchestrator-process-"); directories.push(directory);
    const spec = normalizeProcessSpec({ executable: "/bin/sleep", args: ["60"], cwd: null, envPolicy: { kind: "set", values: {} } });
    const ready = await new BunRunnerRuntime().launch({ attemptId, attemptDirectory: directory, token, leaseToken: 2, specHash: processSpecHash(spec), spec });
    try {
      const result = await control(ready.endpoint, { type: "STOP", protocolVersion: RUNNER_PROTOCOL_VERSION, attemptId, token, leaseToken: 2, runner: { ...ready.runner, startedAt: "2026-01-01T00:00:00.000Z" }, graceMs: 0 });
      expect(result).toMatchObject({ ok: false, code: "IDENTITY_MISMATCH" });
    } finally {
      process.kill(ready.runner.pid, "SIGKILL");
    }
  }, 10_000);
});

function control(endpoint: string, request: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint); let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => { response += chunk; });
    socket.once("error", reject);
    socket.once("end", () => resolve(JSON.parse(response)));
  });
}
async function waitForResult(runtime: BunRunnerRuntime, directory: string, ready: { attemptId: string; runner: any; tokenProof: string; endpoint: string }): Promise<any> {
  for (let tries = 0; tries < 100; tries++) {
    const result = await runtime.readResult({ attemptId: ready.attemptId, attemptDirectory: directory, token, leaseToken: 1, runner: ready.runner });
    if (result !== null) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("runner did not publish a result");
}
