import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openIsolatedTestSqliteDatabase } from "../../src/adapters/sqlite/database.ts";
import { SUPPORTED_SCHEMA_VERSION } from "../../src/adapters/sqlite/migrate.ts";
import type { ExecutionAttempt } from "../../src/domain/model.ts";

const dirs: string[] = [];
function databasePath(): string { const dir = mkdtempSync("/tmp/orchestrator-migration-"); dirs.push(dir); return join(dir, "state.sqlite"); }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("SQLite v1 to v2 migration", () => {
  test("preserves populated v1 rows while adding v2 durable scheduling and lease tables", () => {
    const path = databasePath();
    const initial = openIsolatedTestSqliteDatabase(path);
    initial.close();
    const raw = new Database(path);
    raw.exec("INSERT INTO projects (id,name,root_path,version,created_at,updated_at) VALUES ('11111111-1111-4111-8111-111111111111','Populated','/tmp/populated',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')");
    raw.exec("DROP TABLE idempotency_tombstones; DROP TABLE idempotency_commands; DROP TABLE observed_heads; DROP TABLE observed_evidence; DROP TABLE leases; DROP TABLE daemon_instances; DROP TABLE execution_attempts; DROP TABLE schedules; DROP TABLE process_definitions; PRAGMA user_version=1");
    raw.close();
    const migrated = openIsolatedTestSqliteDatabase(path);
    expect(migrated.projects.list()).toMatchObject([{ name: "Populated", rootPath: "/tmp/populated" }]);
    migrated.close();
    const verified = new Database(path);
    expect(verified.query("PRAGMA user_version").get()).toMatchObject({ user_version: SUPPORTED_SCHEMA_VERSION });
    expect(verified.query("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_attempts'").get()).not.toBeNull();
    const attemptColumns = verified.query<{ name: string }, []>("PRAGMA table_info(execution_attempts)").all().map((column) => column.name);
    expect(attemptColumns).toEqual(expect.arrayContaining(["runner_pgid", "runner_executable_identity", "child_pgid", "child_executable_identity"]));
    expect(attemptColumns).not.toContain("executable_identity");
    expect(() => verified.query("INSERT INTO execution_attempts (id,task_id,definition_id,definition_version,trigger,attempt_no,spec_json,spec_hash,state,runner_pid,runner_started_at,runner_executable_identity,possible_live_child,queued_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("22222222-2222-4222-8222-222222222222", "orphan-task", "orphan-definition", 1, "manual", 1, "{}", "spec-hash", "queued", 1, "2026-01-01T00:00:00.000Z", "/usr/bin/runner", 0, "2026-01-01T00:00:00.000Z")).toThrow();
    verified.close();
  });

  test("rolls back all v2 DDL and leaves v1 version untouched on a fault", () => {
    const path = databasePath();
    const initial = openIsolatedTestSqliteDatabase(path);
    initial.close();
    const raw = new Database(path);
    raw.exec("DROP TABLE idempotency_tombstones; DROP TABLE idempotency_commands; DROP TABLE observed_heads; DROP TABLE observed_evidence; DROP TABLE leases; DROP TABLE daemon_instances; DROP TABLE execution_attempts; DROP TABLE schedules; DROP TABLE process_definitions; PRAGMA user_version=1; CREATE TABLE process_definitions (fault TEXT)");
    raw.close();
    expect(() => openIsolatedTestSqliteDatabase(path)).toThrow("Database migration failed.");
    const verified = new Database(path);
    expect(verified.query("PRAGMA user_version").get()).toMatchObject({ user_version: 1 });
    expect(verified.query("PRAGMA table_info(process_definitions)").all()).toMatchObject([{ name: "fault" }]);
    verified.close();
  });

  test("fails closed before migration when a database is too new", () => {
    const path = databasePath();
    const raw = new Database(path);
    raw.exec(`PRAGMA user_version=${SUPPORTED_SCHEMA_VERSION + 1}`);
    raw.close();
    try { openIsolatedTestSqliteDatabase(path); throw new Error("expected too-new rejection"); } catch (error: any) {
      expect(error.code).toBe("SCHEMA_TOO_NEW");
      expect(error.details).toMatchObject({ supportedVersion: SUPPORTED_SCHEMA_VERSION, actualVersion: SUPPORTED_SCHEMA_VERSION + 1 });
    }
  });

  test("round-trips distinct complete runner and child identities", () => {
    const path = databasePath();
    const database = openIsolatedTestSqliteDatabase(path);
    const at = "2026-01-01T00:00:00.000Z";
    const attempt: ExecutionAttempt = {
      id: "44444444-4444-4444-8444-444444444444",
      taskId: "22222222-2222-4222-8222-222222222222",
      scheduleId: null,
      definitionId: "33333333-3333-4333-8333-333333333333",
      definitionVersion: 1,
      trigger: "manual",
      scheduledFor: null,
      attemptNo: 1,
      spec: { executable: "/usr/bin/true", args: [], cwd: null, envPolicy: { kind: "set", values: {} } },
      specHash: "spec-hash",
      state: "queued",
      ownerInstanceId: null,
      leaseToken: null,
      runnerTokenHash: null,
      runner: { pid: 101, pgid: 100, startedAt: at, executableIdentity: "/usr/local/bin/orchestrator-runner" },
      controlEndpoint: null,
      child: { pid: 102, pgid: 100, startedAt: "2026-01-01T00:00:01.000Z", executableIdentity: "/usr/bin/true" },
      execGrantedAt: null,
      exitCode: null,
      signal: null,
      errorCode: null,
      possibleLiveChild: false,
      queuedAt: at,
      startedAt: null,
      heartbeatAt: null,
      finishedAt: null,
    };
    database.execute((tx) => {
      tx.projects.add({ id: "11111111-1111-4111-8111-111111111111", name: "Identity test", rootPath: "/tmp/identity-test", version: 1, createdAt: at, updatedAt: at });
      tx.tasks.add({ id: attempt.taskId, projectId: "11111111-1111-4111-8111-111111111111", title: "Identity task", description: null, plannedState: "planned", observedState: "unknown", blockedReason: null, version: 1, createdAt: at, updatedAt: at, startedAt: null, finishedAt: null });
      tx.tasks.addDefinition({ id: attempt.definitionId, version: 1, taskId: attempt.taskId, executable: attempt.spec.executable, args: attempt.spec.args, cwd: attempt.spec.cwd, envPolicy: attempt.spec.envPolicy, specHash: attempt.specHash, createdAt: at });
      tx.tasks.addAttempt(attempt);
    });
    const updated = {
      ...attempt,
      runner: { ...attempt.runner!, executableIdentity: "/usr/local/bin/replaced-runner" },
      child: { ...attempt.child!, executableIdentity: "/usr/bin/replaced-child" },
    };
    database.execute((tx) => expect(tx.tasks.updateAttempt(attempt, updated)).toBe(true));
    expect(database.attempts.getById(attempt.id)).toMatchObject({
      runner: updated.runner,
      child: updated.child,
    });
    database.close();
  });
});
