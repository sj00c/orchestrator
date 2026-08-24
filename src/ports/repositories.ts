import type {
  CanonicalTimestamp,

  Daemon,
  EventV1,
  ExecutionAttempt,
  IdempotencyCommand,
  ObservedState,
  PlannedState,
  PlannedTransitionCommandName,
  ProcessDefinitionVersion,
  Project,
  Schedule,
  Task,
  Uuid,
} from "../domain/model.ts";
import type { AttemptFence } from "../domain/execution.ts";
import type {
  EvidenceIngestResult,
  ObservedEvidence,
  ObservedEvidenceHead,
  StoredEvidence,
} from "../domain/evidence.ts";

export interface ProjectQueries {
  getById(id: Uuid): Project | null;
  getByName(name: string): Project | null;
  list(): Project[];
  page(page: CreatedAtIdPageRequest): KeysetPage<Project, CreatedAtIdKey>;
}
export interface CreatedAtIdKey { createdAt: CanonicalTimestamp; id: Uuid; }
export interface QueuedAtIdKey { queuedAt: CanonicalTimestamp; id: Uuid; }
export interface EventSequenceKey { sequence: number; }
export interface DefinitionKey extends CreatedAtIdKey { version: number; }
export interface StatusFlatKey extends CreatedAtIdKey {
  taskCreatedAt: CanonicalTimestamp | null;
  taskId: Uuid | null;
}
export interface KeysetPageRequest<Key> { limit: number; after: Key | null; }
export type CreatedAtIdPageRequest = KeysetPageRequest<CreatedAtIdKey>;
export interface KeysetPage<Item, Key> { items: Item[]; nextKey: Key | null; }

export interface TaskPageFilter {
  projectId?: Uuid;
  plannedState?: PlannedState;
  observedState?: ObservedState;
}
export interface TaskQueries {
  getById(id: Uuid): Task | null;
  listByProject(projectId: Uuid): Task[];
  page(filter: TaskPageFilter, page: CreatedAtIdPageRequest): KeysetPage<Task, CreatedAtIdKey>;
}
export interface HistoryQueries {
  listForProject(projectId: Uuid, since: CanonicalTimestamp | null, limit: number): EventV1[];
  listForTask(taskId: Uuid, since: CanonicalTimestamp | null, limit: number): EventV1[];
  pageForProject(projectId: Uuid, page: KeysetPageRequest<EventSequenceKey>): KeysetPage<EventV1, EventSequenceKey>;
  pageForTask(taskId: Uuid, page: KeysetPageRequest<EventSequenceKey>): KeysetPage<EventV1, EventSequenceKey>;
}
export interface DefinitionPageFilter { taskId?: Uuid; definitionId?: Uuid; }
export interface DefinitionQueries {
  get(id: Uuid, version: number): ProcessDefinitionVersion | null;
  listForTask(taskId: Uuid): ProcessDefinitionVersion[];
  getLatest(id: Uuid): ProcessDefinitionVersion | null;
  page(filter: DefinitionPageFilter, page: KeysetPageRequest<DefinitionKey>): KeysetPage<ProcessDefinitionVersion, DefinitionKey>;
}
export interface SchedulePageFilter { taskId?: Uuid; enabled?: boolean; }
export interface ScheduleQueries {
  getById(id: Uuid): Schedule | null;
  listByTask(taskId: Uuid): Schedule[];
  listDue(at: CanonicalTimestamp, limit: number): Schedule[];
  page(filter: SchedulePageFilter, page: CreatedAtIdPageRequest): KeysetPage<Schedule, CreatedAtIdKey>;
}
export interface AttemptPageFilter {
  taskId?: Uuid;
  state?: ExecutionAttempt["state"];
  trigger?: ExecutionAttempt["trigger"];
  scheduleId?: Uuid;
}
export interface AttemptQueries {
  getById(id: Uuid): ExecutionAttempt | null;
  getActiveForTask(taskId: Uuid): ExecutionAttempt | null;
  getLatestForTask(taskId: Uuid): ExecutionAttempt | null;
  listClaimable(limit: number): ExecutionAttempt[];
  listRecoverable(limit: number): ExecutionAttempt[];
  page(filter: AttemptPageFilter, page: KeysetPageRequest<QueuedAtIdKey>): KeysetPage<ExecutionAttempt, QueuedAtIdKey>;
}
export interface TaskFlatStatusRecord {
  project: Project;
  countsFragment: { planned: PlannedState | null; observed: ObservedState | null };
  task: Task | null;
  projectDone: boolean;
}
export interface StatusQueries {
  pageTaskFlat(projectId: Uuid | null, page: KeysetPageRequest<StatusFlatKey>): KeysetPage<TaskFlatStatusRecord, StatusFlatKey>;
}
export interface DaemonQueries {
  get(instanceId: Uuid): Daemon | null;
  listLive(since: CanonicalTimestamp): Daemon[];
}
export interface IdempotencyQueries {
  get(idempotencyKey: string): IdempotencyCommand | null;
  getTombstone(idempotencyKey: string): IdempotencyTombstone | null;
}
export interface IdempotencyTombstone {
  idempotencyKey: string;
  requestHash: string;
  command: string;
  outcomeDigest: string;
  completedAt: CanonicalTimestamp;
  compactedAt: CanonicalTimestamp;
}
export interface EvidenceQueries {
  get(source: string, evidenceId: string): StoredEvidence | null;
  getHead(taskId: Uuid): ObservedEvidenceHead | null;
}

export interface ProjectWriteRepository {
  getProjectById(id: Uuid): Project | null;
  getProjectByName(name: string): Project | null;
  resolveProjectReference(reference: string): Project | null;
  add(project: Project): void;
}
export interface TaskWriteRepository {
  getById(id: Uuid): Task | null;
  add(task: Task): void;
  applyPlannedTransition(previous: Task, next: Task, command: PlannedTransitionCommandName): void;
  /** Atomically updates observed current state and appends its v1 event. */
  applyObservedTransition(previous: Task, next: Task, source: string, evidenceId: string | null): void;
}
export interface DefinitionWriteRepository {
  getDefinition(id: Uuid, version: number): ProcessDefinitionVersion | null;
  addDefinition(definition: ProcessDefinitionVersion): void;
}
export interface ScheduleWriteRepository {
  getSchedule(id: Uuid): Schedule | null;
  addSchedule(schedule: Schedule): void;
  updateSchedule(previous: Schedule, next: Schedule): boolean;
  disableSchedule(id: Uuid, expectedVersion: number, updatedAt: CanonicalTimestamp): boolean;
}
export interface AttemptWriteRepository {
  getAttempt(id: Uuid): ExecutionAttempt | null;
  getActiveAttempt(taskId: Uuid): ExecutionAttempt | null;
  addAttempt(attempt: ExecutionAttempt): void;
  updateAttempt(previous: ExecutionAttempt, next: ExecutionAttempt): boolean;
  claimAttempt(id: Uuid, fence: AttemptFence): ExecutionAttempt | null;
  /**
   * Transfers an active attempt only to the already-acquired, newer attempt
   * lease. The previous owner/token must still fence the row.
   */
  takeoverAttempt(id: Uuid, previousFence: AttemptFence, nextFence: AttemptFence): ExecutionAttempt | null;
}
export interface DaemonWriteRepository {
  upsertDaemon(daemon: Daemon): void;
  heartbeat(instanceId: Uuid, at: CanonicalTimestamp): boolean;
  acquireLease(resourceType: string, resourceId: string, ownerInstanceId: Uuid, expiresAt: CanonicalTimestamp, at: CanonicalTimestamp): number | null;
  renewLease(resourceType: string, resourceId: string, ownerInstanceId: Uuid, token: number, expiresAt: CanonicalTimestamp, at: CanonicalTimestamp): boolean;
  releaseLease(resourceType: string, resourceId: string, ownerInstanceId: Uuid, token: number, at: CanonicalTimestamp): boolean;
}
export interface IdempotencyWriteRepository {
  getCommand(idempotencyKey: string): IdempotencyCommand | null;
  getTombstone(idempotencyKey: string): IdempotencyTombstone | null;
  listCompletedCommandsOlderThan(cutoff: CanonicalTimestamp, limit: number): IdempotencyCommand[];
  addCommand(command: IdempotencyCommand, responseJson: string | null): void;
  updateCommand(previous: IdempotencyCommand, next: IdempotencyCommand, responseJson: string | null): boolean;
  compactCommand(command: IdempotencyCommand): void;
}
export interface EvidenceWriteRepository {
  /** Persists replay/conflict/stale outcomes, and accepted current/event/head atomically. */
  ingestEvidence(evidence: ObservedEvidence, current: Task, next: Task | null): EvidenceIngestResult;
}

/**
 * All write capabilities are valid only in UnitOfWork.execute's callback.
 * They are intentionally combined on the legacy project/task handles so the
 * v1 composition root remains source-compatible until daemon composition owns
 * the database.
 */
export interface TransactionWritePorts {
  readonly projects: ProjectWriteRepository & DefinitionWriteRepository & ScheduleWriteRepository & AttemptWriteRepository & DaemonWriteRepository & IdempotencyWriteRepository & EvidenceWriteRepository;
  readonly tasks: TaskWriteRepository & DefinitionWriteRepository & ScheduleWriteRepository & AttemptWriteRepository & DaemonWriteRepository & IdempotencyWriteRepository & EvidenceWriteRepository;
}
