import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openIsolatedTestSqliteDatabase } from "../../src/adapters/sqlite/database.ts";
import { SystemPathCanonicalizer } from "../../src/adapters/system/path.ts";
import { OrchestratorService } from "../../src/application/service.ts";
import type { Clock } from "../../src/domain/model.ts";

const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
const dirs: string[] = [];
function fixture() {
  const dir = mkdtempSync("/tmp/orchestrator-sqlite-"); dirs.push(dir);
  const db = openIsolatedTestSqliteDatabase(join(dir, "state.db")); let index = 0;
  const clock: Clock = { now: () => "2026-01-02T03:04:05.678Z" };
  const service = new OrchestratorService({ projects: db.projects, tasks: db.tasks, history: db.history, unitOfWork: db, paths: new SystemPathCanonicalizer(() => dir), clock, ids: { next: () => ids[index++] } });
  return { dir, db, service, addProject: () => service.addProject("Example", dir) };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("SQLite adapter", () => {
  test("bootstraps the promised pragmas, schema objects, indexes, and immutable event triggers", () => {
    const { dir, db } = fixture(); db.close(); const raw = new Database(join(dir, "state.db"));
    expect(raw.query("PRAGMA user_version").get()).toMatchObject({ user_version: 2 });
    expect(raw.query("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
    // foreign_keys is connection-local; enforcement is covered through the
    // adapter and explicit raw-connection checks below.
    const schema = raw.query<{ name: string; type: string }, []>("SELECT name,type FROM sqlite_master WHERE type IN ('table','index','trigger')").all();
    for (const name of ["projects", "tasks", "events", "idempotency_commands", "process_definitions", "schedules", "execution_attempts", "daemon_instances", "leases", "observed_evidence", "observed_heads", "idx_tasks_project_created", "idx_tasks_project_planned", "idx_tasks_project_observed", "idx_events_project_sequence", "idx_events_aggregate_sequence", "idx_events_occurred", "idx_daemon_instances_heartbeat", "idx_observed_evidence_task_order", "events_immutable_update", "events_immutable_delete"]) expect(schema.some((entry) => entry.name === name)).toBe(true);
    raw.close();
  });

  test("commits current rows and matching events together, and rolls both back when callback fails", () => {
    const { db, service, addProject } = fixture(); const project = addProject();
    expect(service.historyProject(project.id, null, 10).events).toHaveLength(1);
    expect(() => db.execute((tx) => { tx.projects.add({ id: ids[1], name: "Rolled back", rootPath: "/rollback", version: 1, createdAt: "2026-01-02T03:04:05.678Z", updatedAt: "2026-01-02T03:04:05.678Z" }); throw new Error("inject rollback"); })).toThrow("Database operation failed.");
    expect(service.listProjects()).toHaveLength(1);
    expect(service.historyProject(project.id, null, 10).events).toHaveLength(1);
    db.close();
  });

  test("rolls current back when event append fails and writes no event when current update fails", () => {
    const { dir, db, service, addProject } = fixture(); const project = addProject();
    const task = service.addTask(project.id, "atomic task", null); const path = join(dir, "state.db");
    db.close();
    const raw = new Database(path);
    raw.exec("CREATE TRIGGER reject_task_update BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT, 'inject current failure'); END");
    raw.close();
    const currentFailure = openIsolatedTestSqliteDatabase(path);
    const currentService = new OrchestratorService({ projects: currentFailure.projects, tasks: currentFailure.tasks, history: currentFailure.history, unitOfWork: currentFailure, paths: new SystemPathCanonicalizer(() => dir) });
    expect(() => currentService.transitionTask(task.id, { type: "start" })).toThrow();
    expect(currentFailure.tasks.getById(task.id)).toMatchObject({ plannedState: "planned", version: 1 });
    expect(currentFailure.history.listForTask(task.id, null, 10)).toHaveLength(1);
    currentFailure.close();
    const eventRaw = new Database(path);
    eventRaw.exec("DROP TRIGGER reject_task_update; CREATE TRIGGER reject_task_event BEFORE INSERT ON events WHEN NEW.event_type = 'task.planned_state_changed' BEGIN SELECT RAISE(ABORT, 'inject event failure'); END");
    eventRaw.close();
    const eventFailure = openIsolatedTestSqliteDatabase(path);
    const eventService = new OrchestratorService({ projects: eventFailure.projects, tasks: eventFailure.tasks, history: eventFailure.history, unitOfWork: eventFailure, paths: new SystemPathCanonicalizer(() => dir) });
    expect(() => eventService.transitionTask(task.id, { type: "start" })).toThrow();
    expect(eventFailure.tasks.getById(task.id)).toMatchObject({ plannedState: "planned", version: 1 });
    expect(eventFailure.history.listForTask(task.id, null, 10)).toHaveLength(1);
    eventFailure.close();
  });

  test("enforces foreign keys, JSON event payload validity, aggregate-version uniqueness, and event immutability", () => {
    const { dir, db, addProject } = fixture(); const project = addProject(); db.close(); const raw = new Database(join(dir, "state.db")); raw.exec("PRAGMA foreign_keys=ON");
    expect(() => raw.query("INSERT INTO tasks (id,project_id,title,planned_state,observed_state,blocked_reason,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(ids[1], "33333333-3333-4333-8333-333333333333", "orphan", "planned", "unknown", null, 1, "2026-01-02T03:04:05.678Z", "2026-01-02T03:04:05.678Z")).toThrow();
    expect(() => raw.query("INSERT INTO events (project_id,aggregate_type,aggregate_id,aggregate_version,event_type,payload_json,occurred_at) VALUES (?,?,?,?,?,?,?)").run(project.id, "project", project.id, 1, "project.added", "[]", "2026-01-02T03:04:05.678Z")).toThrow();
    expect(() => raw.exec("UPDATE events SET payload_json='{}' WHERE sequence=1")).toThrow("events are immutable");
    expect(() => raw.exec("DELETE FROM events WHERE sequence=1")).toThrow("events are immutable"); raw.close();
  });

  test("invalidates write ports after the transaction callback", () => {
    const { db } = fixture(); let retained: any;
    db.execute((tx) => { retained = tx.tasks; });
    expect(() => retained.getById(ids[0])).toThrow("expired"); db.close();
  });

  test("fails closed before DDL when database schema is newer", () => {
    const { dir, db } = fixture(); db.close(); const path = join(dir, "state.db"); const raw = new Database(path); raw.exec("PRAGMA user_version=3"); raw.close();
    try { openIsolatedTestSqliteDatabase(path); throw new Error("expected schema rejection"); } catch (error: any) { expect(error.code).toBe("SCHEMA_TOO_NEW"); }
  });

  test("rolls a failed migration back without advancing user_version", () => {
    const dir = mkdtempSync("/tmp/orchestrator-migration-conflict-"); dirs.push(dir); const path = join(dir, "state.db");
    const raw = new Database(path); raw.exec("CREATE TABLE projects (conflict TEXT)"); raw.close();
    try { openIsolatedTestSqliteDatabase(path); throw new Error("expected migration failure"); } catch (error: any) { expect(error.code).toBe("MIGRATION_FAILED"); }
    const verify = new Database(path);
    expect(verify.query("PRAGMA user_version").get()).toMatchObject({ user_version: 0 });
    expect(verify.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get()).toBeNull();
    verify.close();
  });

  test("returns DB_BUSY rather than a version conflict while another connection holds the write lock", () => {
    const { dir, db } = fixture(); db.close(); const path = join(dir, "state.db");
    const contender = openIsolatedTestSqliteDatabase(path);
    const holder = new Database(path); holder.exec("BEGIN IMMEDIATE");
    try {
      let failure: unknown;
      try {
        contender.execute((tx) => tx.projects.add({
          id: ids[1],
          name: "Busy",
          rootPath: dir,
          version: 1,
          createdAt: "2026-01-02T03:04:05.678Z",
          updatedAt: "2026-01-02T03:04:05.678Z",
        }));
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "DB_BUSY", details: { timeoutMs: 5000 } });
    } finally {
      holder.exec("ROLLBACK"); holder.close(); contender.close();
    }
  }, 7000);
});
