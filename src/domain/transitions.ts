import type {
  CanonicalTimestamp,
  Clock,
  ObservedState,
  PlannedState,
  PlannedTransitionCommand,
  PlannedTransitionCommandName,
  Task,
} from "./model.ts";

export const ALLOWED_PLANNED_FROM: Readonly<
  Record<PlannedTransitionCommandName, readonly PlannedState[]>
> = {
  start: ["planned", "ready"],
  pause: ["active"],
  resume: ["paused", "blocked"],
  block: ["planned", "ready", "active", "paused"],
  complete: ["active", "paused", "blocked"],
  cancel: ["planned", "ready", "active", "paused", "blocked"],
};

export const ALLOWED_OBSERVED_TO: Readonly<
  Record<ObservedState, readonly ObservedState[]>
> = {
  unknown: ["idle", "running", "succeeded", "failed", "stale"],
  idle: ["running", "stale", "unknown"],
  running: ["succeeded", "failed", "stale", "unknown"],
  succeeded: ["stale", "unknown"],
  failed: ["stale", "unknown"],
  stale: ["unknown", "idle", "running", "succeeded", "failed"],
};

export type PlannedTransitionTask = Pick<
  Task,
  | "id"
  | "plannedState"
  | "observedState"
  | "blockedReason"
  | "version"
  | "createdAt"
  | "updatedAt"
  | "startedAt"
  | "finishedAt"
>;

export interface SuccessfulPlannedTransition {
  ok: true;
  command: PlannedTransitionCommandName;
  occurredAt: CanonicalTimestamp;
  previous: PlannedTransitionTask;
  next: PlannedTransitionTask;
}

export interface InvalidPlannedTransition {
  ok: false;
  command: PlannedTransitionCommandName;
  taskId: string;
  fromState: PlannedState;
  allowedFrom: readonly PlannedState[];
  reason: "invalid_from_state" | "empty_block_reason";
}

export type PlannedTransitionResult =
  | SuccessfulPlannedTransition
  | InvalidPlannedTransition;

export function isTerminalPlannedState(state: PlannedState): boolean {
  return state === "done" || state === "canceled";
}

export function canTransitionPlanned(
  from: PlannedState,
  command: PlannedTransitionCommandName,
): boolean {
  return ALLOWED_PLANNED_FROM[command].includes(from);
}

/**
 * Applies a planned-state command without mutating its input. Invalid commands do
 * not sample the clock. A successful command samples it exactly once and uses
 * that value for both current-state update and event occurrence.
 */
export function transitionPlanned(
  task: PlannedTransitionTask,
  command: PlannedTransitionCommand,
  clock: Clock,
): PlannedTransitionResult {
  const allowedFrom = ALLOWED_PLANNED_FROM[command.type];

  if (!allowedFrom.includes(task.plannedState)) {
    return {
      ok: false,
      command: command.type,
      taskId: task.id,
      fromState: task.plannedState,
      allowedFrom,
      reason: "invalid_from_state",
    };
  }

  const blockedReason =
    command.type === "block" ? command.reason.trim() : null;
  if (command.type === "block" && !blockedReason) {
    return {
      ok: false,
      command: command.type,
      taskId: task.id,
      fromState: task.plannedState,
      allowedFrom,
      reason: "empty_block_reason",
    };
  }

  const occurredAt = clock.now();
  const nextState = plannedStateAfter(command.type);
  const entersActive = nextState === "active";
  const entersTerminal = nextState === "done" || nextState === "canceled";

  const next: PlannedTransitionTask = {
    ...task,
    plannedState: nextState,
    // Planned commands intentionally preserve this observed value unchanged.
    observedState: task.observedState,
    blockedReason,
    version: task.version + 1,
    updatedAt: occurredAt,
    startedAt: entersActive ? task.startedAt ?? occurredAt : task.startedAt,
    finishedAt: entersTerminal ? occurredAt : null,
  };

  return {
    ok: true,
    command: command.type,
    occurredAt,
    previous: task,
    next,
  };
}

function plannedStateAfter(command: PlannedTransitionCommandName): PlannedState {
  switch (command) {
    case "start":
    case "resume":
      return "active";
    case "pause":
      return "paused";
    case "block":
      return "blocked";
    case "complete":
      return "done";
    case "cancel":
      return "canceled";
  }
}
