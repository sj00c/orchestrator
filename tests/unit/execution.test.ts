import { describe, expect, test } from "bun:test";
import { canResumeExecutionAttempt, enqueueExecutionAttempt, resumeExecutionAttempt, transitionExecutionAttempt, type AttemptFence } from "../../src/domain/execution.ts";
import type { ExecutionAttempt, ProcessIdentity } from "../../src/domain/model.ts";

const owner = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const attemptId = "33333333-3333-4333-8333-333333333333";
const fence: AttemptFence = { ownerInstanceId: owner, leaseToken: 7 };
const runner: ProcessIdentity = { pid: 41, pgid: 41, startedAt: "2026-01-01T00:00:01.000Z", executableIdentity: "runner-sha" };
const child: ProcessIdentity = { pid: 42, pgid: 42, startedAt: "2026-01-01T00:00:02.000Z", executableIdentity: "child-sha" };
function attempt(overrides: Partial<ExecutionAttempt> = {}): ExecutionAttempt {
  return { id: attemptId, taskId, scheduleId: null, definitionId: "44444444-4444-4444-8444-444444444444", definitionVersion: 1, trigger: "manual", scheduledFor: null, attemptNo: 1, spec: { executable: "echo", args: ["ok"], cwd: null, envPolicy: { kind: "inherit", allowlist: [] } }, specHash: "spec", state: "queued", ownerInstanceId: null, leaseToken: null, runnerTokenHash: null, runner: null, controlEndpoint: null, child: null, execGrantedAt: null, exitCode: null, signal: null, errorCode: null, possibleLiveChild: false, queuedAt: "2026-01-01T00:00:00.000Z", startedAt: null, heartbeatAt: null, finishedAt: null, ...overrides };
}
function step(current: ExecutionAttempt, transition: Parameters<typeof transitionExecutionAttempt>[1]): ExecutionAttempt {
  const result = transitionExecutionAttempt(current, transition); expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.reason); return result.attempt;
}
function running(): ExecutionAttempt {
  const claimed = step(attempt(), { type: "claim", fence });
  const launching = step(claimed, { type: "launch_runner", fence, runnerTokenHash: "token-proof" });
  const ready = step(launching, { type: "runner_ready", input: { ...fence, runner, controlEndpoint: "/tmp/control.sock" } });
  return step(ready, { type: "running", input: { ...fence, runner, child, grantedAt: "2026-01-01T00:00:02.000Z" } });
}

describe("execution attempt state machine", () => {
  test("preserves the complete durable transition chain and runtime identities", () => {
    const result = running();
    expect(result).toMatchObject({ state: "running", ownerInstanceId: owner, leaseToken: 7, runner, child, execGrantedAt: "2026-01-01T00:00:02.000Z", startedAt: "2026-01-01T00:00:02.000Z", heartbeatAt: "2026-01-01T00:00:02.000Z" });
  });

  test.each([
    [0, null, "succeeded"],
    [1, null, "failed"],
    [null, "SIGTERM", "failed"],
  ] as const)("maps completion outcome %# to observed terminal state", (exitCode, signal, state) => {
    const result = transitionExecutionAttempt(running(), { type: "complete", input: { ...fence, runner, finishedAt: "2026-01-01T00:00:03.000Z", resultHash: "result", exitCode, signal } });
    expect(result).toMatchObject({ ok: true, attempt: { state, exitCode, signal, errorCode: null, possibleLiveChild: false, finishedAt: "2026-01-01T00:00:03.000Z" } });
  });

  test("maps a stopped execution to stopped regardless of child exit result", () => {
    const stopping = step(running(), { type: "stop", fence, requestedAt: "2026-01-01T00:00:03.000Z" });
    const result = transitionExecutionAttempt(stopping, { type: "complete", input: { ...fence, runner, finishedAt: "2026-01-01T00:00:04.000Z", resultHash: "result", exitCode: 0, signal: null } });
    expect(result).toMatchObject({ ok: true, attempt: { state: "stopped", heartbeatAt: "2026-01-01T00:00:04.000Z" } });
  });

  test.each([
    [attempt({ state: "claimed", ownerInstanceId: owner, leaseToken: 7 }), { type: "launch_runner", fence: { ...fence, leaseToken: 8 }, runnerTokenHash: "x" }, "FENCE_MISMATCH"],
    [attempt(), { type: "claim", fence: { ...fence, leaseToken: 0 } }, "LEASE_MISMATCH"],
    [attempt({ state: "runner_launching", ownerInstanceId: owner, leaseToken: 7, runnerTokenHash: "x" }), { type: "runner_ready", input: { ...fence, runner, controlEndpoint: "" } }, "RUNNER_IDENTITY_MISMATCH"],
    [running(), { type: "complete", input: { ...fence, runner: { ...runner, pid: 99 }, finishedAt: "2026-01-01T00:00:03.000Z", resultHash: "x", exitCode: 0, signal: null } }, "RESULT_INVALID"],
    [running(), { type: "complete", input: { ...fence, runner, finishedAt: "2026-01-01T00:00:03.000Z", resultHash: "", exitCode: 0, signal: null } }, "RESULT_INVALID"],
    [attempt({ state: "succeeded" }), { type: "lost", fence: null, finishedAt: "2026-01-01T00:00:03.000Z", possibleLiveChild: false, errorCode: "x" }, "INVALID_STATE"],
  ] as const)("rejects fence, lease, identity, result, and terminal-state violations %#", (current, transition, reason) => {
    expect(transitionExecutionAttempt(current, transition)).toEqual({ ok: false, reason });
  });

  test.each([
    ["manual", null, true, null],
    ["schedule", null, true, null],
    ["schedule", { id: "active", state: "running" }, false, "skipped"],
    ["manual", { id: "active", state: "running" }, false, null],
    ["schedule", { id: "done", state: "succeeded" }, true, null],
  ] as const)("enforces task-wide active attempt cardinality %#", (trigger, active, accepted, skippedState) => {
    const result = enqueueExecutionAttempt(attempt({ trigger }), active);
    expect(result.ok).toBe(accepted);
    if (skippedState) expect(result).toMatchObject({ skippedAttempt: { state: skippedState, errorCode: "TASK_BUSY" } });
  });

  test("permits only safe terminal attempts to resume with a monotonic attempt number", () => {
    const finished = attempt({ state: "failed", attemptNo: 3, finishedAt: "2026-01-01T00:00:03.000Z", errorCode: null });
    expect(canResumeExecutionAttempt(finished).ok).toBe(true);
    expect(resumeExecutionAttempt(finished, { id: "55555555-5555-4555-8555-555555555555", attemptNo: 4, queuedAt: "2026-01-01T00:01:00.000Z" })).toMatchObject({ ok: true, attempt: { trigger: "resume", state: "queued", attemptNo: 4, ownerInstanceId: null, runner: null, child: null } });
    expect(canResumeExecutionAttempt(attempt({ state: "lost", possibleLiveChild: true }))).toEqual({ ok: false, reason: "POSSIBLE_LIVE_CHILD" });
    expect(resumeExecutionAttempt(finished, { id: attemptId, attemptNo: 3, queuedAt: "2026-01-01T00:01:00.000Z" })).toEqual({ ok: false, reason: "RESUME_NOT_ALLOWED" });
  });
});
