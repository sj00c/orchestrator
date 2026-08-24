import type { Database } from "bun:sqlite";
import { ApplicationError, applicationError } from "../../application/errors.ts";

export const SUPPORTED_SCHEMA_VERSION = 2;

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

const V2_SCHEMA = `
CREATE TABLE idempotency_commands (
  idempotency_key TEXT PRIMARY KEY CHECK(length(idempotency_key) > 0),
  request_hash TEXT NOT NULL CHECK(length(request_hash) > 0),
  command TEXT NOT NULL CHECK(length(command) > 0),
  state TEXT NOT NULL CHECK(state IN ('executing','completed')),
  owner_instance_id TEXT,
  request_id TEXT NOT NULL,
  lease_expires_at TEXT CHECK(lease_expires_at IS NULL OR lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', lease_expires_at)),
  http_status INTEGER,
  response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),
  outcome_digest TEXT,
  created_at TEXT NOT NULL CHECK(created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  completed_at TEXT CHECK(completed_at IS NULL OR completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', completed_at)),
  compacted_at TEXT CHECK(compacted_at IS NULL OR compacted_at = strftime('%Y-%m-%dT%H:%M:%fZ', compacted_at)),
  CHECK((state = 'executing') = (owner_instance_id IS NOT NULL AND lease_expires_at IS NOT NULL AND http_status IS NULL AND response_json IS NULL AND outcome_digest IS NULL AND completed_at IS NULL)),
  CHECK((state = 'completed') = (owner_instance_id IS NULL AND lease_expires_at IS NULL AND http_status IS NOT NULL AND response_json IS NOT NULL AND outcome_digest IS NOT NULL AND completed_at IS NOT NULL)),
  CHECK(compacted_at IS NULL OR (state = 'completed' AND compacted_at >= completed_at))
);
CREATE INDEX idx_idempotency_commands_lease ON idempotency_commands(state, lease_expires_at);
CREATE TABLE idempotency_tombstones (
  idempotency_key TEXT PRIMARY KEY CHECK(length(idempotency_key) > 0),
  request_hash TEXT NOT NULL CHECK(length(request_hash) > 0),
  command TEXT NOT NULL CHECK(length(command) > 0),
  outcome_digest TEXT NOT NULL CHECK(length(outcome_digest) > 0),
  completed_at TEXT NOT NULL CHECK(completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', completed_at)),
  compacted_at TEXT NOT NULL CHECK(compacted_at = strftime('%Y-%m-%dT%H:%M:%fZ', compacted_at)),
  CHECK(compacted_at >= completed_at)
);
CREATE INDEX idx_idempotency_tombstones_compacted ON idempotency_tombstones(compacted_at);

CREATE TABLE process_definitions (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  executable TEXT NOT NULL CHECK(length(executable) > 0 AND substr(executable, 1, 1) = '/'),
  args_json TEXT NOT NULL CHECK(json_valid(args_json) AND json_type(args_json) = 'array'),
  cwd TEXT CHECK(cwd IS NULL OR (length(cwd) > 0 AND substr(cwd, 1, 1) = '/')),
  env_policy_json TEXT NOT NULL CHECK(json_valid(env_policy_json) AND json_type(env_policy_json) = 'object'),
  spec_hash TEXT NOT NULL CHECK(length(spec_hash) > 0),
  created_at TEXT NOT NULL CHECK(created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  PRIMARY KEY(id, version)
);
CREATE INDEX idx_process_definitions_task ON process_definitions(task_id, id, version DESC);
CREATE TRIGGER process_definitions_immutable_update BEFORE UPDATE ON process_definitions BEGIN SELECT RAISE(ABORT, 'process definitions are immutable'); END;
CREATE TRIGGER process_definitions_immutable_delete BEFORE DELETE ON process_definitions BEGIN SELECT RAISE(ABORT, 'process definitions are immutable'); END;

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  definition_id TEXT NOT NULL,
  definition_version INTEGER NOT NULL CHECK(definition_version >= 1),
  kind TEXT NOT NULL CHECK(kind IN ('one-shot','interval')),
  run_at TEXT NOT NULL CHECK(run_at = strftime('%Y-%m-%dT%H:%M:%fZ', run_at)),
  interval_seconds INTEGER CHECK(interval_seconds IS NULL OR interval_seconds > 0),
  misfire_policy TEXT NOT NULL CHECK(misfire_policy = 'coalesce'),
  next_run_at TEXT CHECK(next_run_at IS NULL OR next_run_at = strftime('%Y-%m-%dT%H:%M:%fZ', next_run_at)),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  version INTEGER NOT NULL CHECK(version >= 1),
  created_at TEXT NOT NULL CHECK(created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  updated_at TEXT NOT NULL CHECK(updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  FOREIGN KEY(definition_id, definition_version) REFERENCES process_definitions(id, version) ON DELETE RESTRICT,
  CHECK((kind = 'one-shot' AND interval_seconds IS NULL) OR (kind = 'interval' AND interval_seconds IS NOT NULL)),
  CHECK((enabled = 0) = (next_run_at IS NULL)),
  CHECK(created_at <= updated_at)
);
CREATE INDEX idx_schedules_due ON schedules(enabled, next_run_at, id);
CREATE INDEX idx_schedules_task ON schedules(task_id, created_at, id);

CREATE TABLE execution_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  schedule_id TEXT REFERENCES schedules(id) ON DELETE RESTRICT,
  definition_id TEXT NOT NULL,
  definition_version INTEGER NOT NULL CHECK(definition_version >= 1),
  trigger TEXT NOT NULL CHECK(trigger IN ('manual','schedule','resume')),
  scheduled_for TEXT CHECK(scheduled_for IS NULL OR scheduled_for = strftime('%Y-%m-%dT%H:%M:%fZ', scheduled_for)),
  attempt_no INTEGER NOT NULL CHECK(attempt_no >= 1),
  spec_json TEXT NOT NULL CHECK(json_valid(spec_json) AND json_type(spec_json) = 'object'),
  spec_hash TEXT NOT NULL CHECK(length(spec_hash) > 0),
  state TEXT NOT NULL CHECK(state IN ('queued','claimed','runner_launching','runner_ready','running','stopping','succeeded','failed','stopped','skipped','lost')),
  owner_instance_id TEXT,
  lease_token INTEGER CHECK(lease_token IS NULL OR lease_token > 0),
  runner_token_hash TEXT,
  runner_pid INTEGER CHECK(runner_pid IS NULL OR runner_pid > 0),
  runner_pgid INTEGER CHECK(runner_pgid IS NULL OR runner_pgid > 0),
  runner_started_at TEXT CHECK(runner_started_at IS NULL OR runner_started_at = strftime('%Y-%m-%dT%H:%M:%fZ', runner_started_at)),
  runner_executable_identity TEXT,
  control_endpoint TEXT,
  child_pid INTEGER CHECK(child_pid IS NULL OR child_pid > 0),
  child_pgid INTEGER CHECK(child_pgid IS NULL OR child_pgid > 0),
  child_started_at TEXT CHECK(child_started_at IS NULL OR child_started_at = strftime('%Y-%m-%dT%H:%M:%fZ', child_started_at)),
  child_executable_identity TEXT,
  exec_granted_at TEXT CHECK(exec_granted_at IS NULL OR exec_granted_at = strftime('%Y-%m-%dT%H:%M:%fZ', exec_granted_at)),
  exit_code INTEGER,
  signal TEXT,
  error_code TEXT,
  possible_live_child INTEGER NOT NULL DEFAULT 0 CHECK(possible_live_child IN (0,1)),
  queued_at TEXT NOT NULL CHECK(queued_at = strftime('%Y-%m-%dT%H:%M:%fZ', queued_at)),
  started_at TEXT CHECK(started_at IS NULL OR started_at = strftime('%Y-%m-%dT%H:%M:%fZ', started_at)),
  heartbeat_at TEXT CHECK(heartbeat_at IS NULL OR heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', heartbeat_at)),
  finished_at TEXT CHECK(finished_at IS NULL OR finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', finished_at)),
  FOREIGN KEY(definition_id, definition_version) REFERENCES process_definitions(id, version) ON DELETE RESTRICT,
  FOREIGN KEY(owner_instance_id) REFERENCES daemon_instances(instance_id) ON DELETE RESTRICT,
  UNIQUE(schedule_id, scheduled_for),
  UNIQUE(task_id, attempt_no),
  CHECK((trigger = 'schedule') = (schedule_id IS NOT NULL AND scheduled_for IS NOT NULL)),
  CHECK((trigger IN ('manual','resume')) = (schedule_id IS NULL AND scheduled_for IS NULL)),
  CHECK((owner_instance_id IS NULL) = (lease_token IS NULL)),
  CHECK(
    (runner_pid IS NULL AND runner_pgid IS NULL AND runner_started_at IS NULL AND runner_executable_identity IS NULL) OR
    (runner_pid IS NOT NULL AND runner_pgid IS NOT NULL AND runner_started_at IS NOT NULL AND length(runner_executable_identity) > 0)
  ),
  CHECK(
    (child_pid IS NULL AND child_pgid IS NULL AND child_started_at IS NULL AND child_executable_identity IS NULL) OR
    (child_pid IS NOT NULL AND child_pgid IS NOT NULL AND child_started_at IS NOT NULL AND length(child_executable_identity) > 0)
  ),
  CHECK((exit_code IS NULL) OR signal IS NULL),
  CHECK((state IN ('succeeded','failed','stopped','skipped','lost')) = (finished_at IS NOT NULL))
);
CREATE UNIQUE INDEX idx_execution_attempts_one_active_task ON execution_attempts(task_id) WHERE state IN ('queued','claimed','runner_launching','runner_ready','running','stopping');
CREATE INDEX idx_execution_attempts_task_latest ON execution_attempts(task_id, attempt_no DESC);
CREATE INDEX idx_execution_attempts_claim ON execution_attempts(state, queued_at, id);
CREATE INDEX idx_execution_attempts_owner ON execution_attempts(owner_instance_id, lease_token);

CREATE TABLE daemon_instances (
  instance_id TEXT PRIMARY KEY,
  version TEXT NOT NULL CHECK(length(version) > 0),
  phase TEXT NOT NULL CHECK(phase IN ('starting','ready','draining','stopped')),
  started_at TEXT NOT NULL CHECK(started_at = strftime('%Y-%m-%dT%H:%M:%fZ', started_at)),
  heartbeat_at TEXT NOT NULL CHECK(heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ', heartbeat_at)),
  config_fingerprint TEXT NOT NULL CHECK(length(config_fingerprint) > 0),
  CHECK(started_at <= heartbeat_at)
);
CREATE INDEX idx_daemon_instances_heartbeat ON daemon_instances(heartbeat_at);
CREATE TABLE leases (
  resource_type TEXT NOT NULL CHECK(length(resource_type) > 0),
  resource_id TEXT NOT NULL CHECK(length(resource_id) > 0),
  owner_instance_id TEXT,
  token INTEGER NOT NULL DEFAULT 0 CHECK(token >= 0),
  expires_at TEXT CHECK(expires_at IS NULL OR expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', expires_at)),
  updated_at TEXT NOT NULL CHECK(updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)),
  PRIMARY KEY(resource_type, resource_id),
  FOREIGN KEY(owner_instance_id) REFERENCES daemon_instances(instance_id) ON DELETE RESTRICT,
  CHECK((owner_instance_id IS NULL) = (expires_at IS NULL))
);
CREATE INDEX idx_leases_expiry ON leases(resource_type, expires_at);

CREATE TABLE observed_evidence (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK(length(source) > 0),
  evidence_id TEXT NOT NULL CHECK(length(evidence_id) > 0),
  canonical_hash TEXT NOT NULL CHECK(length(canonical_hash) > 0),
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  attempt_id TEXT REFERENCES execution_attempts(id) ON DELETE RESTRICT,
  captured_at TEXT NOT NULL CHECK(captured_at = strftime('%Y-%m-%dT%H:%M:%fZ', captured_at)),
  source_sequence INTEGER NOT NULL,
  target_state TEXT NOT NULL CHECK(target_state IN ('unknown','idle','running','succeeded','failed','stale')),
  outcome TEXT NOT NULL CHECK(outcome IN ('applied','ignored_stale')),
  aggregate_version INTEGER,
  created_at TEXT NOT NULL CHECK(created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  UNIQUE(source, evidence_id),
  CHECK((outcome = 'applied') = (aggregate_version IS NOT NULL))
);
CREATE INDEX idx_observed_evidence_task_order ON observed_evidence(task_id, captured_at, source_sequence, source, evidence_id);
CREATE TABLE observed_heads (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE RESTRICT,
  last_captured_at TEXT NOT NULL CHECK(last_captured_at = strftime('%Y-%m-%dT%H:%M:%fZ', last_captured_at)),
  last_source_sequence INTEGER NOT NULL,
  last_source TEXT NOT NULL,
  last_evidence_id TEXT NOT NULL
);
`;

/** Safe v2-only additions also run for databases already stamped at v2. */
const V2_ADDITIVE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_projects_created_id ON projects(created_at, id);
CREATE INDEX IF NOT EXISTS idx_tasks_page_filter ON tasks(project_id, planned_state, observed_state, created_at, id);
CREATE INDEX IF NOT EXISTS idx_definitions_page ON process_definitions(task_id, created_at, id, version);
CREATE INDEX IF NOT EXISTS idx_schedules_page ON schedules(task_id, enabled, created_at, id);
CREATE INDEX IF NOT EXISTS idx_attempts_page ON execution_attempts(task_id, state, trigger, schedule_id, queued_at, id);
`;

const MIGRATIONS: Readonly<Record<number, string>> = { 1: INITIAL_SCHEMA, 2: V2_SCHEMA };

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
        database.exec(V2_ADDITIVE_INDEXES);
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
      if (next === SUPPORTED_SCHEMA_VERSION) database.exec(V2_ADDITIVE_INDEXES);
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
