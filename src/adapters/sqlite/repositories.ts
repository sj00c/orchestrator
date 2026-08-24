import type { Database } from "bun:sqlite";
import type {
  EventV1,
  ObservedState,
  PlannedState,
  PlannedTransitionCommandName,
  Project,
  Task,
} from "../../domain/model.ts";
import type {
  HistoryQueries,
  ProjectQueries,
  ProjectWriteRepository,
  TaskQueries,
  TaskWriteRepository,
} from "../../ports/repositories.ts";
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
}

export class SqliteHistoryQueries implements HistoryQueries {
  constructor(private readonly database: Database) {}
  listForProject(projectId: string, since: string | null, limit: number): EventV1[] {
    return this.listEvents("SELECT * FROM events WHERE project_id = ? AND (? IS NULL OR occurred_at >= ?) ORDER BY sequence ASC LIMIT ?", [projectId, since, since, limit]);
  }
  listForTask(taskId: string, since: string | null, limit: number): EventV1[] {
    return this.listEvents("SELECT * FROM events WHERE aggregate_type = 'task' AND aggregate_id = ? AND (? IS NULL OR occurred_at >= ?) ORDER BY sequence ASC LIMIT ?", [taskId, since, since, limit]);
  }
  private listEvents(sql: string, params: [string, string | null, string | null, number]): EventV1[] {
    return read(() => this.database.query<EventRow, [string, string | null, string | null, number]>(sql).all(...params).map(toEvent));
  }
}

function read<T>(fn: () => T): T {
  try { return fn(); } catch (error) { throw mapSqliteError(error, "read"); }
}

export class SqliteTransactionWriteRepositories implements ProjectWriteRepository, TaskWriteRepository {
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
