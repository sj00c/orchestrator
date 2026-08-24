import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BunRunnerRuntime } from "../../src/adapters/process/runner-runtime.ts";
import { openIsolatedTestSqliteDatabase } from "../../src/adapters/sqlite/database.ts";
import { ExecutionService } from "../../src/application/execution-service.ts";
import { canResumeExecutionAttempt, resumeExecutionAttempt, transitionExecutionAttempt } from "../../src/domain/execution.ts";
import type { ExecutionAttempt } from "../../src/domain/model.ts";
import { normalizeProcessSpec, processSpecHash } from "../../src/domain/process-spec.ts";
import { RunnerRuntimeError, type RunnerRuntime } from "../../src/ports/runner-runtime.ts";

const owner = "11111111-1111-4111-8111-111111111111";
const resumed = "22222222-2222-4222-8222-222222222222";
const runner = { pid: 101, pgid: 101, startedAt: "2026-01-01T00:00:00.000Z", executableIdentity: process.execPath };
const child = { pid: 102, pgid: 101, startedAt: "2026-01-01T00:00:01.000Z", executableIdentity: "/usr/bin/true" };
const fence = { ownerInstanceId: owner, leaseToken: 1 };
const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function attempt(state: ExecutionAttempt["state"] = "queued"): ExecutionAttempt {
  return { id: "33333333-3333-4333-8333-333333333333", taskId: "44444444-4444-4444-8444-444444444444", scheduleId: null, definitionId: "55555555-5555-4555-8555-555555555555", definitionVersion: 1, trigger: "manual", scheduledFor: null, attemptNo: 1, spec: { executable: "/usr/bin/true", args: [], cwd: null, envPolicy: { kind: "set", values: {} } }, specHash: "v1", state, ownerInstanceId: state === "queued" ? null : owner, leaseToken: state === "queued" ? null : 1, runnerTokenHash: state === "queued" || state === "claimed" ? null : "proof", runner: ["runner_ready", "running", "stopping"].includes(state) ? runner : null, controlEndpoint: ["runner_ready", "running", "stopping"].includes(state) ? "/tmp/control.sock" : null, child: ["running", "stopping"].includes(state) ? child : null, execGrantedAt: ["running", "stopping"].includes(state) ? "2026-01-01T00:00:01.000Z" : null, exitCode: null, signal: null, errorCode: null, possibleLiveChild: false, queuedAt: "2026-01-01T00:00:00.000Z", startedAt: null, heartbeatAt: null, finishedAt: null };
}

describe("execution recovery domain model", () => {
  test.each([
    ["unclaimed work has no fence", "queued", false],
    ["claim and launch failures cannot retain a child", "claimed", false],
    ["unpublished runner launch has no child identity", "runner_launching", false],
    ["published runner uncertainty remains child-safe before execution", "runner_ready", false],
    ["running and stopping uncertainty preserves the live-child fence", "running", true],
    ["stopping uncertainty preserves the live-child fence", "stopping", true],
  ] as const)("%s", (_name, state, possibleLiveChild) => {
    const result = transitionExecutionAttempt(attempt(state), { type: "lost", fence: state === "queued" ? null : fence, finishedAt: "2026-01-01T00:01:00.000Z", possibleLiveChild, errorCode: "RECOVERY_RECONCILIATION" });
    expect(result).toMatchObject({ ok: true, attempt: { state: "lost", possibleLiveChild, errorCode: "RECOVERY_RECONCILIATION" } });
  });

  test("blocks restart adoption/resume whenever reconciliation cannot disprove a live child", () => {
    const lost = transitionExecutionAttempt(attempt("running"), { type: "lost", fence, finishedAt: "2026-01-01T00:01:00.000Z", possibleLiveChild: true, errorCode: "RUNNER_UNREACHABLE" });
    if (!lost.ok) throw new Error("recovery fixture did not reach lost state");
    expect(canResumeExecutionAttempt(lost.attempt)).toMatchObject({ ok: false, reason: "POSSIBLE_LIVE_CHILD" });
    expect(resumeExecutionAttempt(lost.attempt, { id: resumed, attemptNo: 2, queuedAt: "2026-01-01T00:02:00.000Z" })).toMatchObject({ ok: false, reason: "POSSIBLE_LIVE_CHILD" });
  });

  test("permits a reconciled lost attempt to resume only as a new fenced occurrence", () => {
    const lost = transitionExecutionAttempt(attempt("runner_launching"), { type: "lost", fence, finishedAt: "2026-01-01T00:01:00.000Z", possibleLiveChild: false, errorCode: "RUNNER_NOT_FOUND" });
    if (!lost.ok) throw new Error("recovery fixture did not reach lost state");
    expect(resumeExecutionAttempt(lost.attempt, { id: resumed, attemptNo: 2, queuedAt: "2026-01-01T00:02:00.000Z" })).toMatchObject({ ok: true, attempt: { id: resumed, state: "queued", ownerInstanceId: null, runner: null, child: null } });
  });

  test("does not re-fence a terminal attempt after a valid successor lease wins the takeover race", () => {
    const root = mkdtempSync("/tmp/orchestrator-takeover-race-");
    temporaryDirectories.push(root);
    const database = openIsolatedTestSqliteDatabase(join(root, "state.sqlite"));
    const at = "2026-01-01T00:00:00.000Z";
    const running = attempt("running");
    database.execute((tx) => {
      tx.projects.add({ id: "66666666-6666-4666-8666-666666666666", name: "Takeover race", rootPath: root, version: 1, createdAt: at, updatedAt: at });
      tx.tasks.add({ id: running.taskId, projectId: "66666666-6666-4666-8666-666666666666", title: "Takeover task", description: null, plannedState: "planned", observedState: "unknown", blockedReason: null, version: 1, createdAt: at, updatedAt: at, startedAt: null, finishedAt: null });
      tx.tasks.addDefinition({ id: running.definitionId, version: 1, taskId: running.taskId, executable: running.spec.executable, args: running.spec.args, cwd: running.spec.cwd, envPolicy: running.spec.envPolicy, specHash: running.specHash, createdAt: at });
      tx.projects.upsertDaemon({ instanceId: owner, version: "test", phase: "ready", startedAt: at, heartbeatAt: at, configFingerprint: "owner" });
      tx.projects.upsertDaemon({ instanceId: resumed, version: "test", phase: "ready", startedAt: at, heartbeatAt: at, configFingerprint: "successor" });
      tx.tasks.addAttempt(running);
      expect(tx.projects.acquireLease("execution_attempt", running.id, owner, "2026-01-01T00:00:30.000Z", at)).toBe(1);
  });
    const terminal = transitionExecutionAttempt(running, { type: "complete", input: { ...fence, runner, finishedAt: "2026-01-01T00:00:31.000Z", resultHash: "result", exitCode: 0, signal: null } });
    if (!terminal.ok) throw new Error("running fixture did not complete");
    database.execute((tx) => {
      expect(tx.tasks.updateAttempt(running, terminal.attempt)).toBe(true);
      expect(tx.projects.releaseLease("execution_attempt", running.id, owner, 1, "2026-01-01T00:00:31.000Z")).toBe(true);
      expect(tx.projects.acquireLease("execution_attempt", running.id, resumed, "2026-01-01T00:01:00.000Z", "2026-01-01T00:00:31.000Z")).toBe(2);
      expect(tx.projects.takeoverAttempt(running.id, fence, { ownerInstanceId: resumed, leaseToken: 2 })).toBeNull();
      expect(tx.projects.releaseLease("execution_attempt", running.id, resumed, 2, "2026-01-01T00:00:31.000Z")).toBe(true);
      const thirdOwner = "77777777-7777-4777-8777-777777777777";
      tx.projects.upsertDaemon({ instanceId: thirdOwner, version: "test", phase: "ready", startedAt: at, heartbeatAt: at, configFingerprint: "third" });
      expect(tx.projects.acquireLease("execution_attempt", running.id, thirdOwner, "2026-01-01T00:01:01.000Z", "2026-01-01T00:00:31.000Z")).toBe(3);
  });
    expect(database.attempts.getById(running.id)).toMatchObject({ state: "succeeded", ownerInstanceId: owner, leaseToken: 1 });
    database.close();
  });

  test("K2/K3/K4/K5: discovers a published pre-EXEC runner, replays a lost grant ACK, and durably grants exactly one child", async () => {
    const root = mkdtempSync("/tmp/orchestrator-pre-exec-");
    temporaryDirectories.push(root);
    const attemptDirectory = join(root, "attempt");
    const sentinelDirectory = join(root, "sentinel");
    const attemptId = "66666666-6666-4666-8666-666666666666";
    const token = "a".repeat(64);
    const spec = normalizeProcessSpec({
      executable: process.execPath,
      args: ["-e", `require("node:fs").mkdirSync(${JSON.stringify(sentinelDirectory)}); setTimeout(() => process.exit(0), 100)`],
      cwd: null,
      envPolicy: { kind: "set", values: {} },
    });
    const specHash = processSpecHash(spec);
    const first = new BunRunnerRuntime();
    const published = await first.launch({ attemptId, attemptDirectory, token, leaseToken: 1, specHash, spec });
    const replacement = new BunRunnerRuntime();
    const discovered = await replacement.discover({ attemptId, attemptDirectory, token, leaseToken: 1, specHash, spec });
    expect(discovered).toMatchObject({ runner: published.runner, endpoint: published.endpoint });
    if (discovered === null) throw new Error("published runner was not discoverable");
    const grant = { attemptId, attemptDirectory, token, leaseToken: 1, runner: discovered.runner, specHash, spec };
    const firstExec = await replacement.exec(grant);
    const replayedExec = await replacement.exec(grant);
    expect(replayedExec.child).toEqual(firstExec.child);
    const deadline = Date.now() + 5_000;
    let result = null;
    while (Date.now() < deadline && result === null) {
      result = await replacement.readResult({ attemptId, attemptDirectory, token, leaseToken: 1, runner: discovered.runner });
      if (result === null) await Bun.sleep(20);
    }
    expect(result).toMatchObject({ exitCode: 0, signal: null });
    expect(existsSync(sentinelDirectory)).toBe(true);
  }, 10_000);

  test("K4/K5: recovers a lost post-grant ACK without duplicating the child", async () => {
    const root = mkdtempSync("/tmp/orchestrator-lost-exec-ack-");
    temporaryDirectories.push(root);
    const database = openIsolatedTestSqliteDatabase(join(root, "state.sqlite"));
    const projectId = "66666666-6666-4666-8666-666666666666";
    const taskId = "77777777-7777-4777-8777-777777777777";
    const definitionId = "88888888-8888-4888-8888-888888888888";
    const attemptId = "99999999-9999-4999-8999-999999999999";
    const sentinelDirectory = join(root, "sentinel");
    const now = "2026-01-01T00:00:00.000Z";
    const spec = normalizeProcessSpec({
      executable: process.execPath,
      args: ["-e", `require("node:fs").mkdirSync(${JSON.stringify(sentinelDirectory)}); setTimeout(() => process.exit(0), 2000)`],
      cwd: null,
      envPolicy: { kind: "set", values: {} },
    });
    const delegated = new BunRunnerRuntime();
    const execOutcomes: Awaited<ReturnType<RunnerRuntime["exec"]>>[] = [];
    let execCalls = 0;
    let adoptCalls = 0;
    const runtime: RunnerRuntime = {
      launch: (input) => delegated.launch(input),
      discover: (input) => delegated.discover(input),
      adopt: async (input) => {
        adoptCalls++;
        return delegated.adopt(input);
      },
      exec: async (input) => {
        const outcome = await delegated.exec(input);
        execOutcomes.push(outcome);
        execCalls++;
        if (execCalls === 1) throw new RunnerRuntimeError("RUNNER_CONTROL_DISCONNECTED", "simulated lost EXEC ACK");
        return outcome;
      },
      stop: (input) => delegated.stop(input),
      stopAll: (options) => delegated.stopAll(options),
      readResult: (input) => delegated.readResult(input),
    };
    const execution = new ExecutionService({
      clock: { now: () => now },
      ids: { next: () => attemptId },
      attempts: database.attempts,
      unitOfWork: database,
      runner: runtime,
      runtime: { attemptDirectory: (id) => join(root, id), issueToken: () => "a".repeat(64), graceMs: 0, hardStopMs: 1 },
      instanceId: owner,
      leaseSeconds: 30,
    });
    let testError: unknown;
    try {
      database.execute((tx) => {
        tx.projects.add({ id: projectId, name: "Lost ACK", rootPath: root, version: 1, createdAt: now, updatedAt: now });
        tx.projects.upsertDaemon({ instanceId: owner, version: "test", phase: "ready", startedAt: now, heartbeatAt: now, configFingerprint: "lost-ack" });
        tx.tasks.add({ id: taskId, projectId, title: "Recover grant", description: null, plannedState: "planned", observedState: "unknown", blockedReason: null, version: 1, createdAt: now, updatedAt: now, startedAt: null, finishedAt: null });
        tx.tasks.addDefinition({ id: definitionId, version: 1, taskId, executable: spec.executable, args: spec.args, cwd: spec.cwd, envPolicy: spec.envPolicy, specHash: processSpecHash(spec), createdAt: now });
      });

      const started = execution.start(taskId, definitionId, 1);
      expect(started.id).toBe(attemptId);
      expect(await execution.dispatch(1)).toBe(0);
      expect(database.attempts.getById(attemptId)).toMatchObject({ state: "runner_ready", possibleLiveChild: false, child: null });
      expect(execCalls).toBe(1);

      expect(await execution.reconcile(1)).toBe(1);
      const running = database.attempts.getById(attemptId);
      expect(running).toMatchObject({ state: "running", possibleLiveChild: false });
      expect(running?.child).toEqual(execOutcomes[0]?.child);
      expect(adoptCalls).toBe(1);
      expect(execCalls).toBe(2);
      expect(execOutcomes[1]?.child).toEqual(execOutcomes[0]?.child);
      await Bun.sleep(50);
      expect(existsSync(sentinelDirectory)).toBe(true);

      await Bun.sleep(2_100);
      expect(await execution.reconcile(1)).toBe(1);
      expect(database.attempts.getById(attemptId)).toMatchObject({ state: "succeeded", possibleLiveChild: false, child: running?.child, exitCode: 0, signal: null });
    } catch (error) {
      testError = error;
      throw error;
    } finally {
      try {
        await delegated.stopAll({ graceMs: 0, hardDeadlineMs: 2_000 });
      } catch (cleanupError) {
        if (testError === undefined) throw cleanupError;
      }
      database.close();
    }
  }, 10_000);
});
