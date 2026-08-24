import type { Database } from "bun:sqlite";
import { ApplicationError, applicationError } from "../../application/errors.ts";

export const SUPPORTED_SCHEMA_VERSION = 1;

const INITIAL_SCHEMA = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY CHECK(id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK(length(trim(name)) > 0),
  root_path TEXT NOT NULL UNIQUE CHECK(length(root_path) > 0),
  version INTEGER NOT NULL CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  updated_at TEXT NOT NULL CHECK(updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  CHECK(created_at <= updated_at)
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY CHECK(id GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-4[0-9a-f][0-9a-f][0-9a-f]-[89ab][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK(length(trim(title)) > 0),
  description TEXT,
  planned_state TEXT NOT NULL CHECK(planned_state IN ('planned','ready','active','paused','blocked','done','canceled')),
  observed_state TEXT NOT NULL DEFAULT 'unknown' CHECK(observed_state IN ('unknown','idle','running','succeeded','failed','stale')),
  blocked_reason TEXT,
  version INTEGER NOT NULL CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  updated_at TEXT NOT NULL CHECK(updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  started_at TEXT CHECK(started_at IS NULL OR started_at = strftime('%Y-%m-%dT%H:%M:%fZ', started_at)),
  finished_at TEXT CHECK(finished_at IS NULL OR finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', finished_at)),
  CHECK((planned_state = 'blocked') = (blocked_reason IS NOT NULL AND length(trim(blocked_reason)) > 0)),
  CHECK(created_at <= updated_at),
  CHECK(started_at IS NULL OR (created_at <= started_at AND started_at <= updated_at)),
  CHECK((planned_state IN ('done','canceled')) = (finished_at IS NOT NULL)),
  CHECK(finished_at IS NULL OR (created_at <= finished_at AND finished_at = updated_at))
);
CREATE INDEX idx_tasks_project_created ON tasks(project_id, created_at, id);
CREATE INDEX idx_tasks_project_planned ON tasks(project_id, planned_state, created_at, id);
CREATE INDEX idx_tasks_project_observed ON tasks(project_id, observed_state, created_at, id);
CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  aggregate_type TEXT NOT NULL CHECK(aggregate_type IN ('project','task')),
  aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL CHECK(aggregate_version >= 1),
  event_schema_version INTEGER NOT NULL DEFAULT 1 CHECK(event_schema_version = 1),
  event_type TEXT NOT NULL CHECK(event_type IN ('project.added','task.added','task.planned_state_changed','task.observed_state_changed')),
  from_planned TEXT CHECK(from_planned IS NULL OR from_planned IN ('planned','ready','active','paused','blocked','done','canceled')),
  to_planned TEXT CHECK(to_planned IS NULL OR to_planned IN ('planned','ready','active','paused','blocked','done','canceled')),
  from_observed TEXT CHECK(from_observed IS NULL OR from_observed IN ('unknown','idle','running','succeeded','failed','stale')),
  to_observed TEXT CHECK(to_observed IS NULL OR to_observed IN ('unknown','idle','running','succeeded','failed','stale')),
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND json_type(payload_json) = 'object'),
  occurred_at TEXT NOT NULL CHECK(occurred_at = strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at)),
  UNIQUE(aggregate_type, aggregate_id, aggregate_version),
  CHECK(
    (event_type = 'project.added' AND aggregate_type = 'project' AND project_id = aggregate_id AND from_planned IS NULL AND to_planned IS NULL AND from_observed IS NULL AND to_observed IS NULL) OR
    (event_type = 'task.added' AND aggregate_type = 'task' AND from_planned IS NULL AND to_planned IN ('planned','ready') AND from_observed IS NULL AND to_observed = 'unknown') OR
    (event_type = 'task.planned_state_changed' AND aggregate_type = 'task' AND from_planned IS NOT NULL AND to_planned IS NOT NULL AND from_observed IS NULL AND to_observed IS NULL) OR
    (event_type = 'task.observed_state_changed' AND aggregate_type = 'task' AND from_planned IS NULL AND to_planned IS NULL AND from_observed IS NOT NULL AND to_observed IS NOT NULL)
  )
);
CREATE INDEX idx_events_project_sequence ON events(project_id, sequence);
CREATE INDEX idx_events_aggregate_sequence ON events(aggregate_type, aggregate_id, sequence);
CREATE INDEX idx_events_occurred ON events(sequence, occurred_at);
CREATE TRIGGER events_immutable_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are immutable'); END;
CREATE TRIGGER events_immutable_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are immutable'); END;
`;

const MIGRATIONS: Readonly<Record<number, string>> = { 1: INITIAL_SCHEMA };

export function readUserVersion(database: Database): number {
  const row = database.query<{ user_version: number }, []>("PRAGMA user_version").get();
  return row?.user_version ?? 0;
}

export function migrate(database: Database): void {
  for (;;) {
    database.exec("BEGIN IMMEDIATE");
    let committed = false;
    let current = 0;
    try {
      current = readUserVersion(database);
      if (current > SUPPORTED_SCHEMA_VERSION) {
        throw applicationError("SCHEMA_TOO_NEW", "Database schema is newer than this application supports.", {
          supportedVersion: SUPPORTED_SCHEMA_VERSION,
          actualVersion: current,
        });
      }
      if (current === SUPPORTED_SCHEMA_VERSION) {
        database.exec("COMMIT");
        committed = true;
        return;
      }
      const next = current + 1;
      const ddl = MIGRATIONS[next];
      if (ddl === undefined) {
        throw applicationError("MIGRATION_FAILED", "Database migration path is incomplete.", {
          fromVersion: current,
          toVersion: next,
        });
      }
      database.exec(ddl);
      database.exec(`PRAGMA user_version = ${next}`);
      database.exec("COMMIT");
      committed = true;
    } catch (error) {
      if (!committed) {
        try { database.exec("ROLLBACK"); } catch { /* preserve original failure */ }
      }
      if (error instanceof ApplicationError) throw error;
      if (error instanceof Error && /SQLITE_BUSY|database is locked/i.test(error.message)) throw error;
      throw applicationError("MIGRATION_FAILED", "Database migration failed.", {
        fromVersion: current,
        toVersion: current + 1,
      });
    }
  }
}
