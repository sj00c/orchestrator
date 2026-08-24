import type { Database } from "bun:sqlite";
import type {
  EventV1,
  Daemon,
  ExecutionAttempt,
  IdempotencyCommand,
  ObservedState,
  PlannedState,
  PlannedTransitionCommandName,
  ProcessDefinitionVersion,
  Project,
  Schedule,
  Task,
} from "../../domain/model.ts";
import type {
  AttemptWriteRepository,
  DaemonWriteRepository,
  DefinitionQueries,
  DefinitionWriteRepository,
  EvidenceWriteRepository,
  EvidenceQueries,
  HistoryQueries,
  IdempotencyWriteRepository,
  IdempotencyQueries,
  IdempotencyTombstone,
  ProjectQueries,
  ProjectWriteRepository,
  ScheduleQueries,
  ScheduleWriteRepository,
  AttemptQueries,
  DaemonQueries,
  CreatedAtIdPageRequest,
  CreatedAtIdKey,
  DefinitionKey,
  DefinitionPageFilter,
  EventSequenceKey,
  KeysetPage,
  KeysetPageRequest,
  QueuedAtIdKey,
  SchedulePageFilter,
  StatusFlatKey,
  StatusQueries,
  TaskFlatStatusRecord,
  TaskPageFilter,
  AttemptPageFilter,
  TaskQueries,
  TaskWriteRepository,
} from "../../ports/repositories.ts";
import type { AttemptFence } from "../../domain/execution.ts";
import type { EvidenceIngestResult, ObservedEvidence, ObservedEvidenceHead, StoredEvidence } from "../../domain/evidence.ts";
import { classifyEvidence, evidenceHead } from "../../domain/evidence.ts";
import { applicationError } from "../../application/errors.ts";
import { mapSqliteError } from "./database.ts";

type ProjectRow = {
  id: string; name: string; root_path: string; version: number; created_at: string; updated_at: string;
};
type TaskRow = {
  id: string; project_id: string; title: string; description: string | null;
  planned_state: PlannedState; observed_state: ObservedState; blocked_reason: string | null;
  version: number; created_at: string; updated_at: string; started_at: string | null; finished_at: string | null;
};
type EventRow = {
  sequence: number; project_id: string; aggregate_type: "project" | "task"; aggregate_id: string;
  aggregate_version: number; event_schema_version: 1; event_type: EventV1["eventType"];
  from_planned: PlannedState | null; to_planned: PlannedState | null;
  from_observed: ObservedState | null; to_observed: ObservedState | null;
  payload_json: string; occurred_at: string;
};
type DefinitionRow = { id: string; version: number; task_id: string; executable: string; args_json: string; cwd: string | null; env_policy_json: string; spec_hash: string; created_at: string };
type ScheduleRow = { id: string; task_id: string; definition_id: string; definition_version: number; kind: "one-shot" | "interval"; run_at: string; interval_seconds: number | null; misfire_policy: "coalesce"; next_run_at: string | null; enabled: number; version: number; created_at: string; updated_at: string };
type AttemptRow = {
  id: string; task_id: string; schedule_id: string | null; definition_id: string; definition_version: number; trigger: ExecutionAttempt["trigger"]; scheduled_for: string | null; attempt_no: number; spec_json: string; spec_hash: string; state: ExecutionAttempt["state"]; owner_instance_id: string | null; lease_token: number | null; runner_token_hash: string | null; runner_pid: number | null; runner_pgid: number | null; runner_started_at: string | null; runner_executable_identity: string | null; control_endpoint: string | null; child_pid: number | null; child_pgid: number | null; child_started_at: string | null; child_executable_identity: string | null; exec_granted_at: string | null; exit_code: number | null; signal: string | null; error_code: string | null; possible_live_child: number; queued_at: string; started_at: string | null; heartbeat_at: string | null; finished_at: string | null;
};
type EvidenceRow = { id: string; source: string; evidence_id: string; canonical_hash: string; task_id: string; attempt_id: string | null; captured_at: string; source_sequence: number; target_state: ObservedState; outcome: "applied" | "ignored_stale"; aggregate_version: number | null; created_at: string };
type StatusRow = ProjectRow & {
  task_id: string | null; task_project_id: string | null; title: string | null; description: string | null;
  planned_state: PlannedState | null; observed_state: ObservedState | null; blocked_reason: string | null;
  task_version: number | null; task_created_at: string | null; task_updated_at: string | null; started_at: string | null; finished_at: string | null; project_done: number;
};

function toProject(row: ProjectRow): Project {
  return { id: row.id, name: row.name, rootPath: row.root_path, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
}
function toTask(row: TaskRow): Task {
  return {
    id: row.id, projectId: row.project_id, title: row.title, description: row.description,
    plannedState: row.planned_state, observedState: row.observed_state, blockedReason: row.blocked_reason,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
    startedAt: row.started_at, finishedAt: row.finished_at,
  };
}
function toEvent(row: EventRow): EventV1 {
  const base = { sequence: row.sequence, projectId: row.project_id, aggregateId: row.aggregate_id, aggregateVersion: row.aggregate_version, eventSchemaVersion: row.event_schema_version, occurredAt: row.occurred_at } as const;
  const payload: unknown = JSON.parse(row.payload_json);
  switch (row.event_type) {
    case "project.added": return { ...base, aggregateType: "project", eventType: row.event_type, planned: null, observed: null, payload: payload as EventV1 & never } as EventV1;
    case "task.added": return { ...base, aggregateType: "task", eventType: row.event_type, planned: { from: null, to: row.to_planned as "planned" | "ready" }, observed: { from: null, to: "unknown" }, payload: payload as EventV1 & never } as EventV1;
    case "task.planned_state_changed": return { ...base, aggregateType: "task", eventType: row.event_type, planned: { from: row.from_planned!, to: row.to_planned! }, observed: null, payload: payload as EventV1 & never } as EventV1;
    case "task.observed_state_changed": return { ...base, aggregateType: "task", eventType: row.event_type, planned: null, observed: { from: row.from_observed!, to: row.to_observed! }, payload: payload as EventV1 & never } as EventV1;
  }
}
function toDefinition(row: DefinitionRow): ProcessDefinitionVersion {
  return { id: row.id, version: row.version, taskId: row.task_id, executable: row.executable, args: JSON.parse(row.args_json), cwd: row.cwd, envPolicy: JSON.parse(row.env_policy_json), specHash: row.spec_hash, createdAt: row.created_at } as ProcessDefinitionVersion;
}
function toSchedule(row: ScheduleRow): Schedule {
  return { id: row.id, taskId: row.task_id, definitionId: row.definition_id, definitionVersion: row.definition_version, kind: row.kind, runAt: row.run_at, intervalSeconds: row.interval_seconds, misfirePolicy: row.misfire_policy, nextRunAt: row.next_run_at, enabled: row.enabled === 1, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at };
}
function toAttempt(row: AttemptRow): ExecutionAttempt {
  const spec = JSON.parse(row.spec_json);
  const identity = (pid: number | null, pgid: number | null, startedAt: string | null, executableIdentity: string | null) => pid === null || pgid === null || startedAt === null || executableIdentity === null ? null : { pid, pgid, startedAt, executableIdentity };
  return { id: row.id, taskId: row.task_id, scheduleId: row.schedule_id, definitionId: row.definition_id, definitionVersion: row.definition_version, trigger: row.trigger, scheduledFor: row.scheduled_for, attemptNo: row.attempt_no, spec, specHash: row.spec_hash, state: row.state, ownerInstanceId: row.owner_instance_id, leaseToken: row.lease_token, runnerTokenHash: row.runner_token_hash, runner: identity(row.runner_pid, row.runner_pgid, row.runner_started_at, row.runner_executable_identity), controlEndpoint: row.control_endpoint, child: identity(row.child_pid, row.child_pgid, row.child_started_at, row.child_executable_identity), execGrantedAt: row.exec_granted_at, exitCode: row.exit_code, signal: row.signal, errorCode: row.error_code, possibleLiveChild: row.possible_live_child === 1, queuedAt: row.queued_at, startedAt: row.started_at, heartbeatAt: row.heartbeat_at, finishedAt: row.finished_at };
}
function toEvidence(row: EvidenceRow): StoredEvidence {
  return { id: row.id, source: row.source, evidenceId: row.evidence_id, canonicalHash: row.canonical_hash, taskId: row.task_id, attemptId: row.attempt_id, capturedAt: row.captured_at, sourceSequence: row.source_sequence, targetState: row.target_state, outcome: row.outcome, aggregateVersion: row.aggregate_version, createdAt: row.created_at };
}
function toStatusRecord(row: StatusRow): TaskFlatStatusRecord {
  const project = toProject(row);
  const task = row.task_id === null ? null : {
    id: row.task_id, projectId: row.task_project_id!, title: row.title!, description: row.description,
    plannedState: row.planned_state!, observedState: row.observed_state!, blockedReason: row.blocked_reason,
    version: row.task_version!, createdAt: row.task_created_at!, updatedAt: row.task_updated_at!,
    startedAt: row.started_at, finishedAt: row.finished_at,
  };
  return {
    project,
    countsFragment: { planned: task?.plannedState ?? null, observed: task?.observedState ?? null },
    task,
    projectDone: row.project_done === 1,
  };
}
function pageLimit<Key>(page: KeysetPageRequest<Key>): number {
  if (!Number.isInteger(page.limit) || page.limit < 1) throw new RangeError("Page limit must be a positive whole number.");
  return page.limit + 1;
}
function pageResults<Row, Item, Key>(
  rows: Row[],
  limit: number,
  map: (row: Row) => Item,
  key: (row: Row) => Key,
): KeysetPage<Item, Key> {
  const hasMore = rows.length > limit;
  const emitted = hasMore ? rows.slice(0, limit) : rows;
  return { items: emitted.map(map), nextKey: hasMore ? key(emitted[emitted.length - 1]!) : null };
}

export class SqliteProjectQueries implements ProjectQueries {
  constructor(private readonly database: Database) {}

  getById(id: string): Project | null {
    return read(() => {
      const row = this.database.query<ProjectRow, [string]>("SELECT * FROM projects WHERE id = ?").get(id);
      return row ? toProject(row) : null;
    });
  }
  getByName(name: string): Project | null {
    return read(() => {
      const row = this.database.query<ProjectRow, [string]>("SELECT * FROM projects WHERE name = ? COLLATE NOCASE").get(name);
      return row ? toProject(row) : null;
    });
  }
  list(): Project[] {
    return read(() => this.database.query<ProjectRow, []>("SELECT * FROM projects ORDER BY created_at ASC, id ASC").all().map(toProject));
  }
  page(page: CreatedAtIdPageRequest): KeysetPage<Project, CreatedAtIdKey> {
    return read(() => pageResults(
      this.database.query<ProjectRow, [string | null, string | null, string | null, string | null, number]>("SELECT * FROM projects WHERE ? IS NULL OR created_at > ? OR (created_at = ? AND id > ?) ORDER BY created_at,id LIMIT ?").all(page.after?.createdAt ?? null, page.after?.createdAt ?? null, page.after?.createdAt ?? null, page.after?.id ?? null, pageLimit(page)),
      page.limit, toProject, (row) => ({ createdAt: row.created_at, id: row.id }),
    ));
  }
}

export class SqliteTaskQueries implements TaskQueries {
  constructor(private readonly database: Database) {}
  getById(id: string): Task | null {
    return read(() => {
      const row = this.database.query<TaskRow, [string]>("SELECT * FROM tasks WHERE id = ?").get(id);
      return row ? toTask(row) : null;
    });
  }
  listByProject(projectId: string): Task[] {
    return read(() => this.database.query<TaskRow, [string]>("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at ASC, id ASC").all(projectId).map(toTask));
  }
  page(filter: TaskPageFilter, page: CreatedAtIdPageRequest): KeysetPage<Task, CreatedAtIdKey> {
    return read(() => {
      const rows = this.database.query<TaskRow, [string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null, number]>("SELECT * FROM tasks WHERE (? IS NULL OR project_id=?) AND (? IS NULL OR planned_state=?) AND (? IS NULL OR observed_state=?) AND (? IS NULL OR created_at > ? OR (created_at=? AND id>?)) ORDER BY created_at,id LIMIT ?").all(filter.projectId ?? null, filter.projectId ?? null, filter.plannedState ?? null, filter.plannedState ?? null, filter.observedState ?? null, filter.observedState ?? null, page.after?.createdAt ?? null, page.after?.createdAt ?? null, page.after?.createdAt ?? null, page.after?.id ?? null, pageLimit(page));
      return pageResults(rows, page.limit, toTask, (row) => ({ createdAt: row.created_at, id: row.id }));
    });
  }
}

export class SqliteHistoryQueries implements HistoryQueries {
  constructor(private readonly database: Database) {}
  listForProject(projectId: string, since: string | null, limit: number): EventV1[] {
    return this.listEvents("SELECT * FROM events WHERE project_id = ? AND (? IS NULL OR occurred_at >= ?) ORDER BY sequence ASC LIMIT ?", [projectId, since, since, limit]);
  }
  listForTask(taskId: string, since: string | null, limit: number): EventV1[] {
    return this.listEvents("SELECT * FROM events WHERE aggregate_type = 'task' AND aggregate_id = ? AND (? IS NULL OR occurred_at >= ?) ORDER BY sequence ASC LIMIT ?", [taskId, since, since, limit]);
  }
  pageForProject(projectId: string, page: KeysetPageRequest<EventSequenceKey>): KeysetPage<EventV1, EventSequenceKey> {
    return this.pageEvents("SELECT * FROM events WHERE project_id=? AND (? IS NULL OR sequence>?) ORDER BY sequence LIMIT ?", [projectId, page.after?.sequence ?? null, page.after?.sequence ?? null, pageLimit(page)], page);
  }
  pageForTask(taskId: string, page: KeysetPageRequest<EventSequenceKey>): KeysetPage<EventV1, EventSequenceKey> {
    return this.pageEvents("SELECT * FROM events WHERE aggregate_type='task' AND aggregate_id=? AND (? IS NULL OR sequence>?) ORDER BY sequence LIMIT ?", [taskId, page.after?.sequence ?? null, page.after?.sequence ?? null, pageLimit(page)], page);
  }
  private listEvents(sql: string, params: [string, string | null, string | null, number]): EventV1[] {
    return read(() => this.database.query<EventRow, [string, string | null, string | null, number]>(sql).all(...params).map(toEvent));
  }
  private pageEvents(sql: string, params: [string, number | null, number | null, number], page: KeysetPageRequest<EventSequenceKey>): KeysetPage<EventV1, EventSequenceKey> {
    return read(() => pageResults(this.database.query<EventRow, [string, number | null, number | null, number]>(sql).all(...params), page.limit, toEvent, (row) => ({ sequence: row.sequence })));
  }
}

export class SqliteDefinitionQueries implements DefinitionQueries {
  constructor(private readonly database: Database) {}
  get(id: string, version: number): ProcessDefinitionVersion | null {
    return read(() => { const row = this.database.query<DefinitionRow, [string, number]>("SELECT * FROM process_definitions WHERE id=? AND version=?").get(id, version); return row ? toDefinition(row) : null; });
  }
  listForTask(taskId: string): ProcessDefinitionVersion[] {
    return read(() => this.database.query<DefinitionRow, [string]>("SELECT * FROM process_definitions WHERE task_id=? ORDER BY id ASC, version DESC").all(taskId).map(toDefinition));
  }
  getLatest(id: string): ProcessDefinitionVersion | null {
    return read(() => { const row = this.database.query<DefinitionRow, [string]>("SELECT * FROM process_definitions WHERE id=? ORDER BY version DESC LIMIT 1").get(id); return row ? toDefinition(row) : null; });
  }
  page(filter: DefinitionPageFilter, page: KeysetPageRequest<DefinitionKey>): KeysetPage<ProcessDefinitionVersion, DefinitionKey> {
    return read(() => {
      const rows = this.database.query<DefinitionRow, [string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null, number | null, number]>("SELECT * FROM process_definitions WHERE (? IS NULL OR task_id=?) AND (? IS NULL OR id=?) AND (? IS NULL OR created_at>? OR (created_at=? AND (id>? OR (id=? AND version>?)))) ORDER BY created_at,id,version LIMIT ?").all(filter.taskId ?? null, filter.taskId ?? null, filter.definitionId ?? null, filter.definitionId ?? null, page.after?.createdAt ?? null, page.after?.createdAt ?? null, page.after?.createdAt ?? null, page.after?.id ?? null, page.after?.id ?? null, page.after?.version ?? null, pageLimit(page));
      return pageResults(rows, page.limit, toDefinition, (row) => ({ createdAt: row.created_at, id: row.id, version: row.version }));
    });
  }
}
export class SqliteScheduleQueries implements ScheduleQueries {
  constructor(private readonly database: Database) {}
  getById(id: string): Schedule | null {
    return read(() => { const row = this.database.query<ScheduleRow, [string]>("SELECT * FROM schedules WHERE id=?").get(id); return row ? toSchedule(row) : null; });
  }
  listByTask(taskId: string): Schedule[] {
    return read(() => this.database.query<ScheduleRow, [string]>("SELECT * FROM schedules WHERE task_id=? ORDER BY created_at,id").all(taskId).map(toSchedule));
  }
  listDue(at: string, limit: number): Schedule[] {
    return read(() => this.database.query<ScheduleRow, [string, number]>("SELECT * FROM schedules WHERE enabled=1 AND next_run_at <= ? ORDER BY next_run_at,id LIMIT ?").all(at, limit).map(toSchedule));
  }
  page(filter: SchedulePageFilter, page: CreatedAtIdPageRequest): KeysetPage<Schedule, CreatedAtIdKey> {
    return read(() => {
      const enabled = filter.enabled === undefined ? null : Number(filter.enabled);
      const rows = this.database.query<ScheduleRow, [string | null, string | null, number | null, number | null, string | null, string | null, string | null, string | null, number]>("SELECT * FROM schedules WHERE (? IS NULL OR task_id=?) AND (? IS NULL OR enabled=?) AND (? IS NULL OR created_at>? OR (created_at=? AND id>?)) ORDER BY created_at,id LIMIT ?").all(filter.taskId ?? null, filter.taskId ?? null, enabled, enabled, page.after?.createdAt ?? null, page.after?.createdAt ?? null, page.after?.createdAt ?? null, page.after?.id ?? null, pageLimit(page));
      return pageResults(rows, page.limit, toSchedule, (row) => ({ createdAt: row.created_at, id: row.id }));
    });
  }
}
export class SqliteAttemptQueries implements AttemptQueries {
  constructor(private readonly database: Database) {}
  getById(id: string): ExecutionAttempt | null {
    return read(() => { const row = this.database.query<AttemptRow, [string]>("SELECT * FROM execution_attempts WHERE id=?").get(id); return row ? toAttempt(row) : null; });
  }
  getActiveForTask(taskId: string): ExecutionAttempt | null {
    return read(() => { const row = this.database.query<AttemptRow, [string]>("SELECT * FROM execution_attempts WHERE task_id=? AND state IN ('queued','claimed','runner_launching','runner_ready','running','stopping')").get(taskId); return row ? toAttempt(row) : null; });
  }
  getLatestForTask(taskId: string): ExecutionAttempt | null {
    return read(() => { const row = this.database.query<AttemptRow, [string]>("SELECT * FROM execution_attempts WHERE task_id=? ORDER BY attempt_no DESC LIMIT 1").get(taskId); return row ? toAttempt(row) : null; });
  }
  listClaimable(limit: number): ExecutionAttempt[] {
    return read(() => this.database.query<AttemptRow, [number]>("SELECT * FROM execution_attempts WHERE state='queued' ORDER BY queued_at,id LIMIT ?").all(limit).map(toAttempt));
  }
  listRecoverable(limit: number): ExecutionAttempt[] {
    return read(() => this.database.query<AttemptRow, [number]>("SELECT * FROM execution_attempts WHERE state IN ('claimed','runner_launching','runner_ready','running','stopping') ORDER BY queued_at,id LIMIT ?").all(limit).map(toAttempt));
  }
  page(filter: AttemptPageFilter, page: KeysetPageRequest<QueuedAtIdKey>): KeysetPage<ExecutionAttempt, QueuedAtIdKey> {
    return read(() => {
      const rows = this.database.query<AttemptRow, [string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null, number]>("SELECT * FROM execution_attempts WHERE (? IS NULL OR task_id=?) AND (? IS NULL OR state=?) AND (? IS NULL OR trigger=?) AND (? IS NULL OR schedule_id=?) AND (? IS NULL OR queued_at>? OR (queued_at=? AND id>?)) ORDER BY queued_at,id LIMIT ?").all(filter.taskId ?? null, filter.taskId ?? null, filter.state ?? null, filter.state ?? null, filter.trigger ?? null, filter.trigger ?? null, filter.scheduleId ?? null, filter.scheduleId ?? null, page.after?.queuedAt ?? null, page.after?.queuedAt ?? null, page.after?.queuedAt ?? null, page.after?.id ?? null, pageLimit(page));
      return pageResults(rows, page.limit, toAttempt, (row) => ({ queuedAt: row.queued_at, id: row.id }));
    });
  }
}
export class SqliteDaemonQueries implements DaemonQueries {
  constructor(private readonly database: Database) {}
  get(instanceId: string): Daemon | null {
    return read(() => { const row = this.database.query<{ instance_id: string; version: string; phase: Daemon["phase"]; started_at: string; heartbeat_at: string; config_fingerprint: string }, [string]>("SELECT * FROM daemon_instances WHERE instance_id=?").get(instanceId); return row ? { instanceId: row.instance_id, version: row.version, phase: row.phase, startedAt: row.started_at, heartbeatAt: row.heartbeat_at, configFingerprint: row.config_fingerprint } : null; });
  }
  listLive(since: string): Daemon[] {
    return read(() => this.database.query<{ instance_id: string; version: string; phase: Daemon["phase"]; started_at: string; heartbeat_at: string; config_fingerprint: string }, [string]>("SELECT * FROM daemon_instances WHERE heartbeat_at >= ? ORDER BY heartbeat_at DESC,instance_id").all(since).map((row) => ({ instanceId: row.instance_id, version: row.version, phase: row.phase, startedAt: row.started_at, heartbeatAt: row.heartbeat_at, configFingerprint: row.config_fingerprint })));
  }
}
export class SqliteEvidenceQueries implements EvidenceQueries {
  constructor(private readonly database: Database) {}
  get(source: string, evidenceId: string): StoredEvidence | null {
    return read(() => { const row = this.database.query<EvidenceRow, [string, string]>("SELECT * FROM observed_evidence WHERE source=? AND evidence_id=?").get(source, evidenceId); return row ? toEvidence(row) : null; });
  }
  getHead(taskId: string): ObservedEvidenceHead | null {
    return read(() => { const row = this.database.query<{ task_id: string; last_captured_at: string; last_source_sequence: number; last_source: string; last_evidence_id: string }, [string]>("SELECT * FROM observed_heads WHERE task_id=?").get(taskId); return row ? { taskId: row.task_id, lastCapturedAt: row.last_captured_at, lastSourceSequence: row.last_source_sequence, lastSource: row.last_source, lastEvidenceId: row.last_evidence_id } : null; });
  }
}
export class SqliteIdempotencyQueries implements IdempotencyQueries {
  constructor(private readonly database: Database) {}
  get(idempotencyKey: string): IdempotencyCommand | null {
    return read(() => { const row = this.database.query<{ idempotency_key: string; request_hash: string; command: string; state: IdempotencyCommand["state"]; owner_instance_id: string | null; request_id: string; lease_expires_at: string | null; http_status: number | null; response_json: string | null; outcome_digest: string | null; created_at: string; completed_at: string | null; compacted_at: string | null }, [string]>("SELECT * FROM idempotency_commands WHERE idempotency_key=?").get(idempotencyKey); return row ? { idempotencyKey: row.idempotency_key, requestHash: row.request_hash, command: row.command, state: row.state, ownerInstanceId: row.owner_instance_id, requestId: row.request_id, leaseExpiresAt: row.lease_expires_at, httpStatus: row.http_status, responseJson: row.response_json, outcomeDigest: row.outcome_digest, createdAt: row.created_at, completedAt: row.completed_at, compactedAt: row.compacted_at } : null; });
  }
  getTombstone(idempotencyKey: string): IdempotencyTombstone | null {
    return read(() => { const row = this.database.query<{ idempotency_key: string; request_hash: string; command: string; outcome_digest: string; completed_at: string; compacted_at: string }, [string]>("SELECT * FROM idempotency_tombstones WHERE idempotency_key=?").get(idempotencyKey); return row ? { idempotencyKey: row.idempotency_key, requestHash: row.request_hash, command: row.command, outcomeDigest: row.outcome_digest, completedAt: row.completed_at, compactedAt: row.compacted_at } : null; });
  }
}

export class SqliteStatusQueries implements StatusQueries {
  constructor(private readonly database: Database) {}
  pageTaskFlat(projectId: string | null, page: KeysetPageRequest<StatusFlatKey>): KeysetPage<TaskFlatStatusRecord, StatusFlatKey> {
    return read(() => {
      const rows = this.database.query<StatusRow, [string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null, string | null, number]>(`
        WITH status_rows AS (
        SELECT p.*, NULL AS task_id, NULL AS task_project_id, NULL AS title, NULL AS description,
          NULL AS planned_state, NULL AS observed_state, NULL AS blocked_reason, NULL AS task_version,
          NULL AS task_created_at, NULL AS task_updated_at, NULL AS started_at, NULL AS finished_at,
          CASE WHEN NOT EXISTS (SELECT 1 FROM tasks t WHERE t.project_id=p.id) THEN 1 ELSE 0 END AS project_done
        FROM projects p
        WHERE ? IS NULL OR p.id=?
        UNION ALL
        SELECT p.*, t.id, t.project_id, t.title, t.description, t.planned_state, t.observed_state,
          t.blocked_reason, t.version, t.created_at, t.updated_at, t.started_at, t.finished_at,
          CASE WHEN NOT EXISTS (SELECT 1 FROM tasks later WHERE later.project_id=t.project_id AND (later.created_at>t.created_at OR (later.created_at=t.created_at AND later.id>t.id))) THEN 1 ELSE 0 END
        FROM projects p JOIN tasks t ON t.project_id=p.id
        WHERE ? IS NULL OR p.id=?
        )
        SELECT * FROM status_rows
        WHERE ? IS NULL OR created_at>? OR (created_at=? AND (id>? OR (id=? AND (
          (? IS NULL AND task_created_at IS NOT NULL) OR
          (? IS NOT NULL AND (task_created_at>? OR (task_created_at=? AND task_id>?)))
        ))))
        ORDER BY created_at,id,task_created_at IS NOT NULL,task_created_at,task_id LIMIT ?
      `).all(projectId, projectId, projectId, projectId, page.after?.createdAt ?? null, page.after?.createdAt ?? null, page.after?.createdAt ?? null, page.after?.id ?? null, page.after?.id ?? null, page.after?.taskCreatedAt ?? null, page.after?.taskCreatedAt ?? null, page.after?.taskCreatedAt ?? null, page.after?.taskCreatedAt ?? null, page.after?.taskId ?? null, pageLimit(page));
      return pageResults(rows, page.limit, toStatusRecord, (row) => ({ createdAt: row.created_at, id: row.id, taskCreatedAt: row.task_created_at, taskId: row.task_id }));
    });
  }
}

function read<T>(fn: () => T): T {
  try { return fn(); } catch (error) { throw mapSqliteError(error, "read"); }
}

export class SqliteTransactionWriteRepositories implements ProjectWriteRepository, TaskWriteRepository, DefinitionWriteRepository, ScheduleWriteRepository, AttemptWriteRepository, DaemonWriteRepository, IdempotencyWriteRepository, EvidenceWriteRepository {
  private active = true;
  constructor(private readonly database: Database) {}
  invalidate(): void { this.active = false; }
  getProjectById(id: string): Project | null {
    this.assertActive();
    try {
      const row = this.database.query<ProjectRow, [string]>("SELECT * FROM projects WHERE id = ?").get(id);
      return row ? toProject(row) : null;
    } catch (error) { throw mapSqliteError(error, "read"); }
  }
  getProjectByName(name: string): Project | null {
    this.assertActive();
    try {
      const row = this.database.query<ProjectRow, [string]>("SELECT * FROM projects WHERE name = ? COLLATE NOCASE").get(name);
      return row ? toProject(row) : null;
    } catch (error) { throw mapSqliteError(error, "read"); }
  }
  resolveProjectReference(reference: string): Project | null {
    this.assertActive();
    if (LOWERCASE_UUID_V4.test(reference)) {
      const project = this.getProjectById(reference);
      if (project !== null) return project;
    }
    return this.getProjectByName(reference);
  }
  getById(id: string): Task | null {
    this.assertActive();
    try {
      const row = this.database.query<TaskRow, [string]>("SELECT * FROM tasks WHERE id = ?").get(id);
      return row ? toTask(row) : null;
    } catch (error) { throw mapSqliteError(error, "read"); }
  }
  add(project: Project): void;
  add(task: Task): void;
  add(value: Project | Task): void {
    this.assertActive();
    try {
      if ("projectId" in value) this.addTask(value); else this.addProject(value);
    } catch (error) { throw mapSqliteError(error, "write"); }
  }
  applyPlannedTransition(previous: Task, next: Task, command: PlannedTransitionCommandName): void {
    this.assertActive();
    try {
      if (
        next.id !== previous.id ||
        next.projectId !== previous.projectId ||
        next.version !== previous.version + 1 ||
        next.observedState !== previous.observedState
      ) {
        throw applicationError("CONSTRAINT_VIOLATION", "Planned transition does not preserve aggregate invariants.", { constraint: "task transition" });
      }
      const result = this.database.query("UPDATE tasks SET planned_state=?, observed_state=?, blocked_reason=?, version=?, updated_at=?, started_at=?, finished_at=? WHERE id=? AND version=?").run(
        next.plannedState, next.observedState, next.blockedReason, next.version, next.updatedAt, next.startedAt, next.finishedAt, next.id, previous.version,
      );
      if (result.changes !== 1) throw new VersionConflictError(next.id, previous.version);
      this.database.query("INSERT INTO events (project_id,aggregate_type,aggregate_id,aggregate_version,event_type,from_planned,to_planned,from_observed,to_observed,payload_json,occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
        next.projectId, "task", next.id, next.version, "task.planned_state_changed", previous.plannedState, next.plannedState, null, null,
        JSON.stringify({ command, blockedReason: next.blockedReason }), next.updatedAt,
      );
    } catch (error) { throw mapSqliteError(error, "write"); }
  }
  applyObservedTransition(previous: Task, next: Task, source: string, evidenceId: string | null): void {
    this.assertActive();
    try {
      if (next.id !== previous.id || next.projectId !== previous.projectId || next.version !== previous.version + 1 || next.plannedState !== previous.plannedState) throw applicationError("CONSTRAINT_VIOLATION", "Observed transition does not preserve aggregate invariants.", { constraint: "task transition" });
      const result = this.database.query("UPDATE tasks SET observed_state=?,version=?,updated_at=? WHERE id=? AND version=?").run(next.observedState, next.version, next.updatedAt, next.id, previous.version);
      if (result.changes !== 1) throw new VersionConflictError(next.id, previous.version);
      this.database.query("INSERT INTO events (project_id,aggregate_type,aggregate_id,aggregate_version,event_type,from_planned,to_planned,from_observed,to_observed,payload_json,occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(next.projectId, "task", next.id, next.version, "task.observed_state_changed", null, null, previous.observedState, next.observedState, JSON.stringify({ source, evidenceId }), next.updatedAt);
    } catch (error) { throw mapSqliteError(error, "write"); }
  }
  addDefinition(definition: ProcessDefinitionVersion): void {
    this.assertActive();
    try {
      this.database.query("INSERT INTO process_definitions (id,version,task_id,executable,args_json,cwd,env_policy_json,spec_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(definition.id, definition.version, definition.taskId, definition.executable, JSON.stringify(definition.args), definition.cwd, JSON.stringify(definition.envPolicy), definition.specHash, definition.createdAt);
    } catch (error) { throw mapSqliteError(error, "write"); }
  }
  getDefinition(id: string, version: number): ProcessDefinitionVersion | null {
    this.assertActive();
    try { const row = this.database.query<DefinitionRow, [string, number]>("SELECT * FROM process_definitions WHERE id=? AND version=?").get(id, version); return row ? toDefinition(row) : null; } catch (error) { throw mapSqliteError(error, "read"); }
  }
  getSchedule(id: string): Schedule | null {
    this.assertActive();
    try { const row = this.database.query<ScheduleRow, [string]>("SELECT * FROM schedules WHERE id=?").get(id); return row ? toSchedule(row) : null; } catch (error) { throw mapSqliteError(error, "read"); }
  }
  addSchedule(schedule: Schedule): void {
    this.assertActive();
    try {
      this.database.query("INSERT INTO schedules (id,task_id,definition_id,definition_version,kind,run_at,interval_seconds,misfire_policy,next_run_at,enabled,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(schedule.id, schedule.taskId, schedule.definitionId, schedule.definitionVersion, schedule.kind, schedule.runAt, schedule.intervalSeconds, schedule.misfirePolicy, schedule.nextRunAt, Number(schedule.enabled), schedule.version, schedule.createdAt, schedule.updatedAt);
    } catch (error) { throw mapSqliteError(error, "write"); }
  }
  updateSchedule(previous: Schedule, next: Schedule): boolean {
    this.assertActive();
    try {
      return this.database.query("UPDATE schedules SET next_run_at=?,enabled=?,version=?,updated_at=? WHERE id=? AND version=?").run(next.nextRunAt, Number(next.enabled), next.version, next.updatedAt, previous.id, previous.version).changes === 1;
    } catch (error) { throw mapSqliteError(error, "write"); }
  }
  disableSchedule(id: string, expectedVersion: number, updatedAt: string): boolean {
    this.assertActive();
    try {
      return this.database.query("UPDATE schedules SET enabled=0,next_run_at=NULL,version=version+1,updated_at=? WHERE id=? AND version=? AND enabled=1").run(updatedAt, id, expectedVersion).changes === 1;
    } catch (error) { throw mapSqliteError(error, "write"); }
  }
  addAttempt(attempt: ExecutionAttempt): void {
    this.assertActive();
    try { this.insertAttempt(attempt); } catch (error) { throw mapSqliteError(error, "write"); }
  }
  getAttempt(id: string): ExecutionAttempt | null {
    this.assertActive();
    try { const row = this.database.query<AttemptRow, [string]>("SELECT * FROM execution_attempts WHERE id=?").get(id); return row ? toAttempt(row) : null; } catch (error) { throw mapSqliteError(error, "read"); }
  }
  getActiveAttempt(taskId: string): ExecutionAttempt | null {
    this.assertActive();
    try { const row = this.database.query<AttemptRow, [string]>("SELECT * FROM execution_attempts WHERE task_id=? AND state IN ('queued','claimed','runner_launching','runner_ready','running','stopping')").get(taskId); return row ? toAttempt(row) : null; } catch (error) { throw mapSqliteError(error, "read"); }
  }
  updateAttempt(previous: ExecutionAttempt, next: ExecutionAttempt): boolean {
    this.assertActive();
    try {
      const result = this.database.query("UPDATE execution_attempts SET state=?,owner_instance_id=?,lease_token=?,runner_token_hash=?,runner_pid=?,runner_pgid=?,runner_started_at=?,runner_executable_identity=?,control_endpoint=?,child_pid=?,child_pgid=?,child_started_at=?,child_executable_identity=?,exec_granted_at=?,exit_code=?,signal=?,error_code=?,possible_live_child=?,started_at=?,heartbeat_at=?,finished_at=? WHERE id=? AND state=? AND owner_instance_id IS ? AND lease_token IS ?").run(next.state, next.ownerInstanceId, next.leaseToken, next.runnerTokenHash, next.runner?.pid ?? null, next.runner?.pgid ?? null, next.runner?.startedAt ?? null, next.runner?.executableIdentity ?? null, next.controlEndpoint, next.child?.pid ?? null, next.child?.pgid ?? null, next.child?.startedAt ?? null, next.child?.executableIdentity ?? null, next.execGrantedAt, next.exitCode, next.signal, next.errorCode, Number(next.possibleLiveChild), next.startedAt, next.heartbeatAt, next.finishedAt, previous.id, previous.state, previous.ownerInstanceId, previous.leaseToken);
      return result.changes === 1;
    } catch (error) { throw mapSqliteError(error, "write"); }
  }
  claimAttempt(id: string, fence: AttemptFence): ExecutionAttempt | null {
    this.assertActive();
    try {
      const result = this.database.query("UPDATE execution_attempts SET state='claimed',owner_instance_id=?,lease_token=? WHERE id=? AND state='queued' AND owner_instance_id IS NULL AND lease_token IS NULL").run(fence.ownerInstanceId, fence.leaseToken, id);
      if (result.changes !== 1) return null;
      const row = this.database.query<AttemptRow, [string]>("SELECT * FROM execution_attempts WHERE id=?").get(id);
      return row ? toAttempt(row) : null;
    } catch (error) { throw mapSqliteError(error, "write"); }
  }
  takeoverAttempt(id: string, previousFence: AttemptFence, nextFence: AttemptFence): ExecutionAttempt | null {
    this.assertActive();
    try {
      if (
        nextFence.ownerInstanceId === previousFence.ownerInstanceId ||
        nextFence.leaseToken <= previousFence.leaseToken
      ) {
        return null;
      }
      const result = this.database.query(`
        UPDATE execution_attempts
        SET owner_instance_id=?, lease_token=?
        WHERE id=?
          AND owner_instance_id=?
          AND lease_token=?
          AND state IN ('claimed','runner_launching','runner_ready','running','stopping')
          AND EXISTS (
            SELECT 1 FROM leases
            WHERE resource_type='execution_attempt'
              AND resource_id=execution_attempts.id
              AND owner_instance_id=?
              AND token=?
              AND expires_at > updated_at
          )
      `).run(
        nextFence.ownerInstanceId,
        nextFence.leaseToken,
        id,
        previousFence.ownerInstanceId,
        previousFence.leaseToken,
        nextFence.ownerInstanceId,
        nextFence.leaseToken,
      );
      if (result.changes !== 1) return null;
      const row = this.database.query<AttemptRow, [string]>("SELECT * FROM execution_attempts WHERE id=?").get(id);
      return row ? toAttempt(row) : null;
    } catch (error) { throw mapSqliteError(error, "write"); }
  }
  upsertDaemon(daemon: Daemon): void {
    this.assertActive();
    try { this.database.query("INSERT INTO daemon_instances (instance_id,version,phase,started_at,heartbeat_at,config_fingerprint) VALUES (?,?,?,?,?,?) ON CONFLICT(instance_id) DO UPDATE SET version=excluded.version,phase=excluded.phase,heartbeat_at=excluded.heartbeat_at,config_fingerprint=excluded.config_fingerprint").run(daemon.instanceId, daemon.version, daemon.phase, daemon.startedAt, daemon.heartbeatAt, daemon.configFingerprint); } catch (error) { throw mapSqliteError(error, "write"); }
  }
  heartbeat(instanceId: string, at: string): boolean {
    this.assertActive();
    try { return this.database.query("UPDATE daemon_instances SET heartbeat_at=? WHERE instance_id=?").run(at, instanceId).changes === 1; } catch (error) { throw mapSqliteError(error, "write"); }
  }
  acquireLease(resourceType: string, resourceId: string, ownerInstanceId: string, expiresAt: string, at: string): number | null {
    this.assertActive();
    try {
      const result = this.database.query("INSERT INTO leases (resource_type,resource_id,owner_instance_id,token,expires_at,updated_at) VALUES (?,?,?,1,?,?) ON CONFLICT(resource_type,resource_id) DO UPDATE SET owner_instance_id=excluded.owner_instance_id,token=leases.token+1,expires_at=excluded.expires_at,updated_at=excluded.updated_at WHERE leases.owner_instance_id IS NULL OR leases.expires_at <= excluded.updated_at").run(resourceType, resourceId, ownerInstanceId, expiresAt, at);
      if (result.changes !== 1) return null;
      return this.database.query<{ token: number }, [string, string]>("SELECT token FROM leases WHERE resource_type=? AND resource_id=?").get(resourceType, resourceId)?.token ?? null;
    } catch (error) { throw mapSqliteError(error, "write"); }
  }
  renewLease(resourceType: string, resourceId: string, ownerInstanceId: string, token: number, expiresAt: string, at: string): boolean {
    this.assertActive();
    try {
      return this.database.query("UPDATE leases SET expires_at=?,updated_at=? WHERE resource_type=? AND resource_id=? AND owner_instance_id=? AND token=?").run(expiresAt, at, resourceType, resourceId, ownerInstanceId, token).changes === 1;
    } catch (error) { throw mapSqliteError(error, "write"); }
  }
  releaseLease(resourceType: string, resourceId: string, ownerInstanceId: string, token: number, at: string): boolean {
    this.assertActive();
    try { return this.database.query("UPDATE leases SET owner_instance_id=NULL,expires_at=NULL,updated_at=? WHERE resource_type=? AND resource_id=? AND owner_instance_id=? AND token=?").run(at, resourceType, resourceId, ownerInstanceId, token).changes === 1; } catch (error) { throw mapSqliteError(error, "write"); }
  }
  addCommand(command: IdempotencyCommand, responseJson: string | null): void {
    this.assertActive();
    try { this.database.query("INSERT INTO idempotency_commands (idempotency_key,request_hash,command,state,owner_instance_id,request_id,lease_expires_at,http_status,response_json,outcome_digest,created_at,completed_at,compacted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(command.idempotencyKey, command.requestHash, command.command, command.state, command.ownerInstanceId, command.requestId, command.leaseExpiresAt, command.httpStatus, responseJson, command.outcomeDigest, command.createdAt, command.completedAt, command.compactedAt); } catch (error) { throw mapSqliteError(error, "write"); }
  }
  getCommand(idempotencyKey: string): IdempotencyCommand | null {
    this.assertActive();
    try { const row = this.database.query<{ idempotency_key: string; request_hash: string; command: string; state: IdempotencyCommand["state"]; owner_instance_id: string | null; request_id: string; lease_expires_at: string | null; http_status: number | null; response_json: string | null; outcome_digest: string | null; created_at: string; completed_at: string | null; compacted_at: string | null }, [string]>("SELECT * FROM idempotency_commands WHERE idempotency_key=?").get(idempotencyKey); return row ? { idempotencyKey: row.idempotency_key, requestHash: row.request_hash, command: row.command, state: row.state, ownerInstanceId: row.owner_instance_id, requestId: row.request_id, leaseExpiresAt: row.lease_expires_at, httpStatus: row.http_status, responseJson: row.response_json, outcomeDigest: row.outcome_digest, createdAt: row.created_at, completedAt: row.completed_at, compactedAt: row.compacted_at } : null; } catch (error) { throw mapSqliteError(error, "read"); }
  }
  getTombstone(idempotencyKey: string): IdempotencyTombstone | null {
    this.assertActive();
    try { const row = this.database.query<{ idempotency_key: string; request_hash: string; command: string; outcome_digest: string; completed_at: string; compacted_at: string }, [string]>("SELECT * FROM idempotency_tombstones WHERE idempotency_key=?").get(idempotencyKey); return row ? { idempotencyKey: row.idempotency_key, requestHash: row.request_hash, command: row.command, outcomeDigest: row.outcome_digest, completedAt: row.completed_at, compactedAt: row.compacted_at } : null; } catch (error) { throw mapSqliteError(error, "read"); }
  }
  listCompletedCommandsOlderThan(cutoff: string, limit: number): IdempotencyCommand[] {
    this.assertActive();
    try {
      return this.database.query<{ idempotency_key: string; request_hash: string; command: string; state: IdempotencyCommand["state"]; owner_instance_id: string | null; request_id: string; lease_expires_at: string | null; http_status: number | null; response_json: string | null; outcome_digest: string | null; created_at: string; completed_at: string | null; compacted_at: string | null }, [string, number]>("SELECT * FROM idempotency_commands WHERE state='completed' AND completed_at < ? ORDER BY completed_at,idempotency_key LIMIT ?").all(cutoff, limit).map((row) => ({ idempotencyKey: row.idempotency_key, requestHash: row.request_hash, command: row.command, state: row.state, ownerInstanceId: row.owner_instance_id, requestId: row.request_id, leaseExpiresAt: row.lease_expires_at, httpStatus: row.http_status, responseJson: row.response_json, outcomeDigest: row.outcome_digest, createdAt: row.created_at, completedAt: row.completed_at, compactedAt: row.compacted_at }));
    } catch (error) { throw mapSqliteError(error, "read"); }
  }
  updateCommand(previous: IdempotencyCommand, next: IdempotencyCommand, responseJson: string | null): boolean {
    this.assertActive();
    try { return this.database.query("UPDATE idempotency_commands SET state=?,owner_instance_id=?,lease_expires_at=?,http_status=?,response_json=?,outcome_digest=?,completed_at=?,compacted_at=? WHERE idempotency_key=? AND state=? AND request_hash=?").run(next.state, next.ownerInstanceId, next.leaseExpiresAt, next.httpStatus, responseJson, next.outcomeDigest, next.completedAt, next.compactedAt, previous.idempotencyKey, previous.state, previous.requestHash).changes === 1; } catch (error) { throw mapSqliteError(error, "write"); }
  }
  compactCommand(command: IdempotencyCommand): void {
    this.assertActive();
    try {
      if (command.state !== "completed" || command.completedAt === null || command.compactedAt === null || command.outcomeDigest === null) throw applicationError("CONSTRAINT_VIOLATION", "Only completed commands can be compacted.", { constraint: "idempotency tombstone" });
      this.database.query("INSERT INTO idempotency_tombstones (idempotency_key,request_hash,command,outcome_digest,completed_at,compacted_at) VALUES (?,?,?,?,?,?)").run(command.idempotencyKey, command.requestHash, command.command, command.outcomeDigest, command.completedAt, command.compactedAt);
      this.database.query("DELETE FROM idempotency_commands WHERE idempotency_key=? AND state='completed' AND compacted_at IS NULL").run(command.idempotencyKey);
    } catch (error) { throw mapSqliteError(error, "write"); }
  }
  ingestEvidence(evidence: ObservedEvidence, current: Task, next: Task | null): EvidenceIngestResult {
    this.assertActive();
    try {
      const existingRow = this.database.query<EvidenceRow, [string, string]>("SELECT * FROM observed_evidence WHERE source=? AND evidence_id=?").get(evidence.source, evidence.evidenceId);
      const head = this.database.query<{ task_id: string; last_captured_at: string; last_source_sequence: number; last_source: string; last_evidence_id: string }, [string]>("SELECT * FROM observed_heads WHERE task_id=?").get(evidence.taskId);
      const result = classifyEvidence(evidence, existingRow ? toEvidence(existingRow) : null, head ? { taskId: head.task_id, lastCapturedAt: head.last_captured_at, lastSourceSequence: head.last_source_sequence, lastSource: head.last_source, lastEvidenceId: head.last_evidence_id } : null);
      if (result.kind === "duplicate" || result.kind === "conflict") return result;
      if (result.kind === "stale") {
        this.insertEvidence(evidence, "ignored_stale", null);
        return result;
      }
      if (next === null) throw applicationError("CONSTRAINT_VIOLATION", "Accepted evidence requires an observed transition.", { constraint: "evidence transition" });
      this.applyObservedTransition(current, next, evidence.source, evidence.evidenceId);
      this.insertEvidence(evidence, "applied", next.version);
      const newHead = evidenceHead(evidence);
      this.database.query("INSERT INTO observed_heads (task_id,last_captured_at,last_source_sequence,last_source,last_evidence_id) VALUES (?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET last_captured_at=excluded.last_captured_at,last_source_sequence=excluded.last_source_sequence,last_source=excluded.last_source,last_evidence_id=excluded.last_evidence_id").run(newHead.taskId, newHead.lastCapturedAt, newHead.lastSourceSequence, newHead.lastSource, newHead.lastEvidenceId);
      return result;
    } catch (error) { throw mapSqliteError(error, "write"); }
  }
  private insertAttempt(attempt: ExecutionAttempt): void {
    this.database.query("INSERT INTO execution_attempts (id,task_id,schedule_id,definition_id,definition_version,trigger,scheduled_for,attempt_no,spec_json,spec_hash,state,owner_instance_id,lease_token,runner_token_hash,runner_pid,runner_pgid,runner_started_at,runner_executable_identity,control_endpoint,child_pid,child_pgid,child_started_at,child_executable_identity,exec_granted_at,exit_code,signal,error_code,possible_live_child,queued_at,started_at,heartbeat_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(attempt.id, attempt.taskId, attempt.scheduleId, attempt.definitionId, attempt.definitionVersion, attempt.trigger, attempt.scheduledFor, attempt.attemptNo, JSON.stringify(attempt.spec), attempt.specHash, attempt.state, attempt.ownerInstanceId, attempt.leaseToken, attempt.runnerTokenHash, attempt.runner?.pid ?? null, attempt.runner?.pgid ?? null, attempt.runner?.startedAt ?? null, attempt.runner?.executableIdentity ?? null, attempt.controlEndpoint, attempt.child?.pid ?? null, attempt.child?.pgid ?? null, attempt.child?.startedAt ?? null, attempt.child?.executableIdentity ?? null, attempt.execGrantedAt, attempt.exitCode, attempt.signal, attempt.errorCode, Number(attempt.possibleLiveChild), attempt.queuedAt, attempt.startedAt, attempt.heartbeatAt, attempt.finishedAt);
  }
  private insertEvidence(evidence: ObservedEvidence, outcome: "applied" | "ignored_stale", aggregateVersion: number | null): void {
    this.database.query("INSERT INTO observed_evidence (id,source,evidence_id,canonical_hash,task_id,attempt_id,captured_at,source_sequence,target_state,outcome,aggregate_version,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(evidence.id, evidence.source, evidence.evidenceId, evidence.canonicalHash, evidence.taskId, evidence.attemptId, evidence.capturedAt, evidence.sourceSequence, evidence.targetState, outcome, aggregateVersion, evidence.createdAt);
  }
  private addProject(project: Project): void {
    if (project.version !== 1 || project.createdAt !== project.updatedAt) {
      throw applicationError("CONSTRAINT_VIOLATION", "New project must start at version one.", { constraint: "project initial state" });
    }
    this.database.query("INSERT INTO projects (id,name,root_path,version,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(project.id, project.name.trim(), project.rootPath, project.version, project.createdAt, project.updatedAt);
    this.database.query("INSERT INTO events (project_id,aggregate_type,aggregate_id,aggregate_version,event_type,payload_json,occurred_at) VALUES (?,?,?,?,?,?,?)").run(
      project.id, "project", project.id, project.version, "project.added", JSON.stringify({ name: project.name.trim(), rootPath: project.rootPath }), project.createdAt,
    );
  }
  private addTask(task: Task): void {
    if (
      task.version !== 1 ||
      (task.plannedState !== "planned" && task.plannedState !== "ready") ||
      task.observedState !== "unknown" ||
      task.blockedReason !== null ||
      task.createdAt !== task.updatedAt ||
      task.startedAt !== null ||
      task.finishedAt !== null
    ) {
      throw applicationError("CONSTRAINT_VIOLATION", "New task does not match the initial-state contract.", { constraint: "task initial state" });
    }
    this.database.query("INSERT INTO tasks (id,project_id,title,description,planned_state,observed_state,blocked_reason,version,created_at,updated_at,started_at,finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
      task.id, task.projectId, task.title.trim(), task.description, task.plannedState, task.observedState, task.blockedReason, task.version, task.createdAt, task.updatedAt, task.startedAt, task.finishedAt,
    );
    this.database.query("INSERT INTO events (project_id,aggregate_type,aggregate_id,aggregate_version,event_type,from_planned,to_planned,from_observed,to_observed,payload_json,occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
      task.projectId, "task", task.id, task.version, "task.added", null, task.plannedState, null, task.observedState,
      JSON.stringify({ projectId: task.projectId, title: task.title.trim(), description: task.description, initialPlannedState: task.plannedState, initialObservedState: task.observedState }), task.createdAt,
    );
  }
  private assertActive(): void { if (!this.active) throw new Error("Transaction write ports have expired."); }
}

const LOWERCASE_UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class VersionConflictError extends Error {
  constructor(readonly id: string, readonly expectedVersion: number) { super("Version conflict"); }
}

export function isVersionConflict(error: unknown): error is VersionConflictError { return error instanceof VersionConflictError; }
