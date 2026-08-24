import type {
  ActiveExecutionAttemptState,
  CanonicalTimestamp,
  ExecutionAttempt,
  ExecutionAttemptState,
  ProcessIdentity,
  TerminalExecutionAttemptState,
  Uuid,
} from "./model.ts";

export type ExecutionConflictReason =
  | "TASK_BUSY"
  | "INVALID_STATE"
  | "FENCE_MISMATCH"
  | "LEASE_MISMATCH"
  | "RUNNER_IDENTITY_MISMATCH"
  | "RESULT_INVALID"
  | "POSSIBLE_LIVE_CHILD"
  | "RESUME_NOT_ALLOWED";

export type ExecutionTransitionResult =
  | { ok: true; attempt: ExecutionAttempt }
  | { ok: false; reason: ExecutionConflictReason };

export interface AttemptFence {
  ownerInstanceId: Uuid;
  leaseToken: number;
}

export interface RunnerReadyInput extends AttemptFence {
  runner: ProcessIdentity;
  controlEndpoint: string;
}

export interface RunningInput extends AttemptFence {
  runner: ProcessIdentity;
  child: ProcessIdentity;
  grantedAt: CanonicalTimestamp;
}

export interface CompletionInput extends AttemptFence {
  runner: ProcessIdentity;
  finishedAt: CanonicalTimestamp;
  resultHash: string;
  exitCode: number | null;
  signal: string | null;
}

export type ExecutionTransition =
  | { type: "claim"; fence: AttemptFence }
  | { type: "launch_runner"; fence: AttemptFence; runnerTokenHash: string }
  | { type: "runner_ready"; input: RunnerReadyInput }
  | { type: "running"; input: RunningInput }
  | { type: "stop"; fence: AttemptFence; requestedAt: CanonicalTimestamp }
  | { type: "complete"; input: CompletionInput }
  | {
      type: "lost";
      fence: AttemptFence | null;
      finishedAt: CanonicalTimestamp;
      possibleLiveChild: boolean;
      errorCode: string;
    };

const ACTIVE_STATES: readonly ActiveExecutionAttemptState[] = [
  "queued",
  "claimed",
  "runner_launching",
  "runner_ready",
  "running",
  "stopping",
];

function hasFence(attempt: ExecutionAttempt, fence: AttemptFence): boolean {
  return (
    attempt.ownerInstanceId === fence.ownerInstanceId &&
    attempt.leaseToken === fence.leaseToken
  );
}

function sameIdentity(
  expected: ProcessIdentity | null,
  actual: ProcessIdentity,
): boolean {
  return (
    expected !== null &&
    expected.pid === actual.pid &&
    expected.startedAt === actual.startedAt &&
    expected.executableIdentity === actual.executableIdentity
  );
}

function terminal(
  attempt: ExecutionAttempt,
  state: TerminalExecutionAttemptState,
  finishedAt: CanonicalTimestamp,
  fields: Pick<
    ExecutionAttempt,
    "exitCode" | "signal" | "errorCode" | "possibleLiveChild"
  >,
): ExecutionAttempt {
  return { ...attempt, ...fields, state, finishedAt, heartbeatAt: finishedAt };
}

function invalid(): ExecutionTransitionResult {
  return { ok: false, reason: "INVALID_STATE" };
}

/**
 * Applies one durable execution transition. Callers must persist the returned
 * attempt with a conditional state/fence update in the same transaction.
 */
export function transitionExecutionAttempt(
  attempt: ExecutionAttempt,
  transition: ExecutionTransition,
): ExecutionTransitionResult {
  switch (transition.type) {
    case "claim":
      if (attempt.state !== "queued") return invalid();
      if (
        attempt.ownerInstanceId !== null ||
        attempt.leaseToken !== null ||
        transition.fence.leaseToken <= 0
      ) {
        return { ok: false, reason: "LEASE_MISMATCH" };
      }
      return {
        ok: true,
        attempt: {
          ...attempt,
          state: "claimed",
          ownerInstanceId: transition.fence.ownerInstanceId,
          leaseToken: transition.fence.leaseToken,
        },
      };

    case "launch_runner":
      if (attempt.state !== "claimed") return invalid();
      if (!hasFence(attempt, transition.fence)) {
        return { ok: false, reason: "FENCE_MISMATCH" };
      }
      if (transition.runnerTokenHash.length === 0) {
        return { ok: false, reason: "RESULT_INVALID" };
      }
      return {
        ok: true,
        attempt: {
          ...attempt,
          state: "runner_launching",
          runnerTokenHash: transition.runnerTokenHash,
        },
      };

    case "runner_ready":
      if (attempt.state !== "runner_launching") return invalid();
      if (!hasFence(attempt, transition.input)) {
        return { ok: false, reason: "FENCE_MISMATCH" };
      }
      if (
        attempt.runnerTokenHash === null ||
        transition.input.controlEndpoint.length === 0
      ) {
        return { ok: false, reason: "RUNNER_IDENTITY_MISMATCH" };
      }
      return {
        ok: true,
        attempt: {
          ...attempt,
          state: "runner_ready",
          runner: transition.input.runner,
          controlEndpoint: transition.input.controlEndpoint,
        },
      };

    case "running":
      if (attempt.state !== "runner_ready") return invalid();
      if (!hasFence(attempt, transition.input)) {
        return { ok: false, reason: "FENCE_MISMATCH" };
      }
      if (!sameIdentity(attempt.runner, transition.input.runner)) {
        return { ok: false, reason: "RUNNER_IDENTITY_MISMATCH" };
      }
      return {
        ok: true,
        attempt: {
          ...attempt,
          state: "running",
          child: transition.input.child,
          execGrantedAt: transition.input.grantedAt,
          startedAt: transition.input.grantedAt,
          heartbeatAt: transition.input.grantedAt,
        },
      };

    case "stop":
      if (attempt.state !== "running") return invalid();
      if (!hasFence(attempt, transition.fence)) {
        return { ok: false, reason: "FENCE_MISMATCH" };
      }
      if (attempt.runner === null || attempt.controlEndpoint === null) {
        return { ok: false, reason: "RUNNER_IDENTITY_MISMATCH" };
      }
      return {
        ok: true,
        attempt: {
          ...attempt,
          state: "stopping",
          heartbeatAt: transition.requestedAt,
        },
      };

    case "complete": {
      if (attempt.state !== "running" && attempt.state !== "stopping") {
        return invalid();
      }
      if (!hasFence(attempt, transition.input)) {
        return { ok: false, reason: "FENCE_MISMATCH" };
      }
      if (
        !sameIdentity(attempt.runner, transition.input.runner) ||
        transition.input.resultHash.length === 0 ||
        (transition.input.exitCode === null && transition.input.signal === null) ||
        (transition.input.exitCode !== null && transition.input.signal !== null)
      ) {
        return { ok: false, reason: "RESULT_INVALID" };
      }
      const state: TerminalExecutionAttemptState =
        attempt.state === "stopping"
          ? "stopped"
          : transition.input.exitCode === 0
            ? "succeeded"
            : "failed";
      return {
        ok: true,
        attempt: terminal(attempt, state, transition.input.finishedAt, {
          exitCode: transition.input.exitCode,
          signal: transition.input.signal,
          errorCode: null,
          possibleLiveChild: false,
        }),
      };
    }

    case "lost":
      if (!ACTIVE_STATES.includes(attempt.state as ActiveExecutionAttemptState)) {
        return invalid();
      }
      if (
        (attempt.ownerInstanceId === null && transition.fence !== null) ||
        (attempt.ownerInstanceId !== null &&
          (transition.fence === null || !hasFence(attempt, transition.fence)))
      ) {
        return { ok: false, reason: "FENCE_MISMATCH" };
      }
      if (transition.errorCode.length === 0) {
        return { ok: false, reason: "RESULT_INVALID" };
      }
      return {
        ok: true,
        attempt: terminal(attempt, "lost", transition.finishedAt, {
          exitCode: null,
          signal: null,
          errorCode: transition.errorCode,
          possibleLiveChild: transition.possibleLiveChild,
        }),
      };
  }
}

export type EnqueueAttemptResult =
  | { ok: true; attempt: ExecutionAttempt }
  | {
      ok: false;
      reason: "TASK_BUSY";
      skippedAttempt: ExecutionAttempt | null;
    };

/**
 * Enforces the task-wide active-attempt invariant before persistence. Scheduled
 * work consumes its occurrence as skipped; manual/resume work returns conflict.
 */
export function enqueueExecutionAttempt(
  attempt: ExecutionAttempt,
  activeAttempt: Pick<ExecutionAttempt, "id" | "state"> | null,
): EnqueueAttemptResult {
  if (attempt.state !== "queued") {
    return { ok: false, reason: "TASK_BUSY", skippedAttempt: null };
  }
  if (
    activeAttempt === null ||
    !ACTIVE_STATES.includes(activeAttempt.state as ActiveExecutionAttemptState)
  ) {
    return { ok: true, attempt };
  }
  if (attempt.trigger !== "schedule") {
    return { ok: false, reason: "TASK_BUSY", skippedAttempt: null };
  }
  return {
    ok: false,
    reason: "TASK_BUSY",
    skippedAttempt: terminal(attempt, "skipped", attempt.queuedAt, {
      exitCode: null,
      signal: null,
      errorCode: "TASK_BUSY",
      possibleLiveChild: false,
    }),
  };
}

/** A resume is legal only when no possibly-live child can overlap it. */
export function canResumeExecutionAttempt(
  attempt: ExecutionAttempt,
): ExecutionTransitionResult {
  if (
    (attempt.state !== "succeeded" &&
      attempt.state !== "failed" &&
      attempt.state !== "stopped" &&
      attempt.state !== "lost") ||
    attempt.possibleLiveChild
  ) {
    return {
      ok: false,
      reason: attempt.possibleLiveChild
        ? "POSSIBLE_LIVE_CHILD"
        : "RESUME_NOT_ALLOWED",
    };
  }
  return { ok: true, attempt };
}

export interface ResumeAttemptInput {
  id: Uuid;
  attemptNo: number;
  queuedAt: CanonicalTimestamp;
}

/**
 * Copies only the immutable definition snapshot into a new manual attempt.
 * Persistence must still apply the task's active-attempt constraint.
 */
export function resumeExecutionAttempt(
  attempt: ExecutionAttempt,
  input: ResumeAttemptInput,
): ExecutionTransitionResult {
  const eligibility = canResumeExecutionAttempt(attempt);
  if (!eligibility.ok) return eligibility;
  if (input.attemptNo <= attempt.attemptNo) {
    return { ok: false, reason: "RESUME_NOT_ALLOWED" };
  }
  return {
    ok: true,
    attempt: {
      ...attempt,
      id: input.id,
      scheduleId: null,
      trigger: "resume",
      scheduledFor: null,
      attemptNo: input.attemptNo,
      state: "queued",
      ownerInstanceId: null,
      leaseToken: null,
      runnerTokenHash: null,
      runner: null,
      controlEndpoint: null,
      child: null,
      execGrantedAt: null,
      exitCode: null,
      signal: null,
      errorCode: null,
      possibleLiveChild: false,
      queuedAt: input.queuedAt,
      startedAt: null,
      heartbeatAt: null,
      finishedAt: null,
    },
  };
}
