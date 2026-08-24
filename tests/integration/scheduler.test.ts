import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openIsolatedTestSqliteDatabase } from "../../src/adapters/sqlite/database.ts";
import { SystemPathCanonicalizer } from "../../src/adapters/system/path.ts";
import { ExecutionService } from "../../src/application/execution-service.ts";
import { OrchestratorService } from "../../src/application/service.ts";
import { SchedulingService } from "../../src/application/scheduling-service.ts";
import { BunRunnerRuntime } from "../../src/adapters/process/runner-runtime.ts";

const dirs: string[] = [];
const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("materializes one due occurrence atomically, coalesces missed intervals, and cannot duplicate it", () => {
  const dir = mkdtempSync("/tmp/orchestrator-scheduler-"); dirs.push(dir);
  const path = join(dir, "state.sqlite"); const db = openIsolatedTestSqliteDatabase(path);
  let now = "2026-01-01T00:00:00.000Z"; let index = 0;
  const clock = { now: () => now }; const generator = { next: () => ids[index++]! };
  const service = new OrchestratorService({ projects: db.projects, tasks: db.tasks, history: db.history, unitOfWork: db, paths: new SystemPathCanonicalizer(() => dir), clock, ids: generator });
  const execution = new ExecutionService({ clock, ids: generator, attempts: db.attempts, unitOfWork: db, runner: new BunRunnerRuntime(), runtime: { attemptDirectory: (id) => join(dir, id), issueToken: () => "a".repeat(64), graceMs: 0, hardStopMs: 1 }, instanceId: "55555555-5555-4555-8555-555555555555", leaseSeconds: 30 });
  const scheduling = new SchedulingService({ clock, ids: generator, definitions: db.definitions, schedules: db.schedules, unitOfWork: db, enqueueScheduleOccurrence: (tx, occurrence) => execution.enqueueScheduleOccurrence(tx, occurrence) });
  const project = service.addProject("scheduler", dir); const task = service.addTask(project.id, "due", null);
  const definition = scheduling.createDefinition({ taskId: task.id, executable: "/usr/bin/true", args: [], cwd: null, envPolicy: { kind: "set", values: {} } });
  const schedule = scheduling.createSchedule({ taskId: task.id, definitionId: definition.id, definitionVersion: definition.version, kind: "interval", runAt: now, intervalSeconds: 60 });
  now = "2026-01-01T00:03:15.000Z";
  expect(scheduling.tick(10)).toBe(1);
  expect(scheduling.tick(10)).toBe(0);
  expect(db.schedules.getById(schedule.id)).toMatchObject({ nextRunAt: "2026-01-01T00:04:00.000Z" });
  db.close();
  const raw = new Database(path);
  expect(raw.query("SELECT schedule_id,scheduled_for,state FROM execution_attempts").all()).toMatchObject([{ schedule_id: schedule.id, scheduled_for: "2026-01-01T00:03:00.000Z", state: "queued" }]);
  expect(() => raw.query("INSERT INTO execution_attempts (id,task_id,schedule_id,definition_id,definition_version,trigger,scheduled_for,attempt_no,spec_json,spec_hash,state,possible_live_child,queued_at) SELECT '66666666-6666-4666-8666-666666666666',task_id,schedule_id,definition_id,definition_version,trigger,scheduled_for,2,spec_json,spec_hash,'queued',0,queued_at FROM execution_attempts").run()).toThrow();
  raw.close();
});

test("leases fence concurrent claimers and advance their token only after expiry", () => {
  const dir = mkdtempSync("/tmp/orchestrator-scheduler-"); dirs.push(dir);
  const db = openIsolatedTestSqliteDatabase(join(dir, "state.sqlite"));
  const owner = "77777777-7777-4777-8777-777777777777";
  const successor = "88888888-8888-4888-8888-888888888888";
  const at = "2026-01-01T00:00:00.000Z";
  db.execute((tx) => {
    tx.projects.upsertDaemon({ instanceId: owner, version: "test", phase: "ready", startedAt: at, heartbeatAt: at, configFingerprint: "owner" });
    tx.projects.upsertDaemon({ instanceId: successor, version: "test", phase: "ready", startedAt: at, heartbeatAt: at, configFingerprint: "successor" });
    expect(tx.projects.acquireLease("execution_attempt", "resource", owner, "2026-01-01T00:00:30.000Z", at)).toBe(1);
    expect(tx.projects.acquireLease("execution_attempt", "resource", successor, "2026-01-01T00:00:30.000Z", at)).toBeNull();
    expect(tx.projects.acquireLease("execution_attempt", "resource", successor, "2026-01-01T00:01:00.000Z", "2026-01-01T00:00:31.000Z")).toBe(2);
  });
  db.close();
});
