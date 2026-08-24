export type Uuid = string;

/** A UTC instant formatted as YYYY-MM-DDTHH:mm:ss.sssZ. */
export type CanonicalTimestamp = string;

export interface Clock {
  now(): CanonicalTimestamp;
}

export const PLANNED_STATES = [
  "planned",
  "ready",
  "active",
  "paused",
  "blocked",
  "done",
  "canceled",
] as const;

export type PlannedState = (typeof PLANNED_STATES)[number];

export const OBSERVED_STATES = [
  "unknown",
  "idle",
  "running",
  "succeeded",
  "failed",
  "stale",
] as const;

export type ObservedState = (typeof OBSERVED_STATES)[number];

export type NonTerminalPlannedState = Exclude<
  PlannedState,
  "done" | "canceled"
>;
export type TerminalPlannedState = "done" | "canceled";

export interface Project {
  id: Uuid;
  name: string;
  rootPath: string;
  version: number;
  createdAt: CanonicalTimestamp;
  updatedAt: CanonicalTimestamp;
}

export interface Task {
  id: Uuid;
  projectId: Uuid;
  title: string;
  description: string | null;
  plannedState: PlannedState;
  observedState: ObservedState;
  blockedReason: string | null;
  version: number;
  createdAt: CanonicalTimestamp;
  updatedAt: CanonicalTimestamp;
  startedAt: CanonicalTimestamp | null;
  finishedAt: CanonicalTimestamp | null;
}

export interface ProjectV1 {
  id: string;
  name: string;
  rootPath: string;
  version: number;
  createdAt: CanonicalTimestamp;
  updatedAt: CanonicalTimestamp;
}

export interface TaskV1 {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  plannedState: PlannedState;
  observedState: ObservedState;
  blockedReason: string | null;
  version: number;
  createdAt: CanonicalTimestamp;
  updatedAt: CanonicalTimestamp;
  startedAt: CanonicalTimestamp | null;
  finishedAt: CanonicalTimestamp | null;
}

export type AggregateType = "project" | "task";
export type EventType =
  | "project.added"
  | "task.added"
  | "task.planned_state_changed"
  | "task.observed_state_changed";

export interface ProjectAddedPayloadV1 {
  name: string;
  rootPath: string;
}

export interface TaskAddedPayloadV1 {
  projectId: Uuid;
  title: string;
  description: string | null;
  initialPlannedState: "planned" | "ready";
  initialObservedState: "unknown";
}

export interface TaskPlannedStateChangedPayloadV1 {
  command: PlannedTransitionCommandName;
  blockedReason: string | null;
}

export interface TaskObservedStateChangedPayloadV1 {
  source: string;
  evidenceId: string | null;
}

export type EventPayloadV1 =
  | ProjectAddedPayloadV1
  | TaskAddedPayloadV1
  | TaskPlannedStateChangedPayloadV1
  | TaskObservedStateChangedPayloadV1;

export interface StateChange<State> {
  from: State | null;
  to: State;
}

interface EventBaseV1 {
  sequence: number;
  projectId: Uuid;
  aggregateId: Uuid;
  aggregateVersion: number;
  eventSchemaVersion: 1;
  occurredAt: CanonicalTimestamp;
}

export type EventV1 =
  | (EventBaseV1 & {
      aggregateType: "project";
      eventType: "project.added";
      planned: null;
      observed: null;
      payload: ProjectAddedPayloadV1;
    })
  | (EventBaseV1 & {
      aggregateType: "task";
      eventType: "task.added";
      planned: StateChange<"planned" | "ready">;
      observed: StateChange<"unknown">;
      payload: TaskAddedPayloadV1;
    })
  | (EventBaseV1 & {
      aggregateType: "task";
      eventType: "task.planned_state_changed";
      planned: { from: PlannedState; to: PlannedState };
      observed: null;
      payload: TaskPlannedStateChangedPayloadV1;
    })
  | (EventBaseV1 & {
      aggregateType: "task";
      eventType: "task.observed_state_changed";
      planned: null;
      observed: { from: ObservedState; to: ObservedState };
      payload: TaskObservedStateChangedPayloadV1;
    });

export interface CountsV1 {
  planned: Record<PlannedState, number>;
  observed: Record<ObservedState, number>;
}

export interface StatusProjectV1 {
  project: ProjectV1;
  counts: CountsV1;
  tasks: TaskV1[];
}

export type SuccessDataV1 =
  | { project: ProjectV1 }
  | { projects: ProjectV1[] }
  | { task: TaskV1 }
  | { tasks: TaskV1[] }
  | { projects: StatusProjectV1[] }
  | {
      scope: { type: "project" | "task"; id: string };
      events: EventV1[];
      query: { limit: number; since: CanonicalTimestamp | null };
    };

export interface SuccessEnvelopeV1<Data = SuccessDataV1> {
  ok: true;
  data: Data;
  meta: { command: string; schemaVersion: 1 };
}

export type PlannedTransitionCommandName =
  | "start"
  | "pause"
  | "resume"
  | "block"
  | "complete"
  | "cancel";

export type PlannedTransitionCommand =
  | { type: "start" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "block"; reason: string }
  | { type: "complete" }
  | { type: "cancel" };
