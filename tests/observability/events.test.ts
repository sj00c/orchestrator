import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { openIsolatedTestSqliteDatabase } from "../../src/adapters/sqlite/database.ts";
import { SystemPathCanonicalizer } from "../../src/adapters/system/path.ts";
import { ObservationService } from "../../src/application/observation-service.ts";
import { OrchestratorService } from "../../src/application/service.ts";
import type { ObservedEvidence } from "../../src/domain/evidence.ts";
import type { Clock } from "../../src/domain/model.ts";

const created: string[] = [];
const daemons: ReturnType<typeof Bun.spawn>[] = [];
function setup() {
  const dir = mkdtempSync("/tmp/orchestrator-events-"); created.push(dir); const path = join(dir, "state.db");
  const database = openIsolatedTestSqliteDatabase(path); let id = 0; const values = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  const clock: Clock = { now: () => "2026-01-02T03:04:05.678Z" };
  const service = new OrchestratorService({ projects: database.projects, tasks: database.tasks, history: database.history, unitOfWork: database, paths: new SystemPathCanonicalizer(() => dir), clock, ids: { next: () => values[id++] } });
  return { dir, path, database, service };
}
async function startDaemon(root: string) {
  const home = join(root, "home"); const configDirectory = join(home, "Library/Application Support/Orchestrator");
  const config = join(configDirectory, "config.json"); const socket = join(root, "daemon.sock");
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 }); chmodSync(configDirectory, 0o700);
  writeFileSync(config, JSON.stringify({ socketPath: socket })); chmodSync(config, 0o600);
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: "", ORCHESTRATOR_DB: "" };
  const daemon = Bun.spawn([process.execPath, resolve("src/daemon/main.ts")], { cwd: root, env, stdout: "ignore", stderr: "ignore" });
  daemons.push(daemon);
  for (let attempt = 0; attempt < 1_000; attempt++) {
    const result = Bun.spawnSync({ cmd: [process.execPath, resolve("src/cli/main.ts"), "--config", config, "--json", "project", "list"], cwd: root, env, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode === 0) return { config, socket, env };
    if (daemon.exitCode !== null) throw new Error(`Daemon exited during startup with ${daemon.exitCode}.`);
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for daemon readiness.");
}
afterEach(async () => {
  for (const daemon of daemons.splice(0)) {
    if (daemon.exitCode === null) daemon.kill("SIGTERM");
    await Promise.race([daemon.exited, Bun.sleep(5_000).then(() => { throw new Error("Daemon did not shut down."); })]);
  }
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("event observability", () => {
  test("records accepted and stale observer evidence without coupling planned state to observed state", () => {
    const { path, database, service } = setup();
    const project = service.addProject("Evidence", process.cwd());
    const task = service.addTask(project.id, "observed task", null);
    const observations = new ObservationService({ evidence: database.evidence, tasks: database.tasks, unitOfWork: database });
    const accepted: ObservedEvidence = {
      id: "33333333-3333-4333-8333-333333333333",
      source: "process-observer",
      evidenceId: "current",
      canonicalHash: "a".repeat(64),
      taskId: task.id,
      attemptId: null,
      capturedAt: "2026-01-02T03:04:05.678Z",
      sourceSequence: 2,
      targetState: "running",
      createdAt: "2026-01-02T03:04:05.678Z",
    };
    expect(observations.ingest(accepted)).toMatchObject({ kind: "accepted" });
    expect(observations.ingest({ ...accepted, id: "44444444-4444-4444-8444-444444444444", evidenceId: "late", canonicalHash: "b".repeat(64), capturedAt: "2026-01-02T03:04:04.678Z", sourceSequence: 1, targetState: "failed" })).toMatchObject({ kind: "stale" });
    expect(service.showTask(task.id)).toMatchObject({ plannedState: "planned", observedState: "running", version: 2 });
    expect(service.historyTask(task.id, null, 10).events.map((event) => [event.eventType, event.aggregateVersion, event.observed])).toEqual([
      ["task.added", 1, { from: null, to: "unknown" }],
      ["task.observed_state_changed", 2, { from: "unknown", to: "running" }],
    ]);
    database.close();
    const evidence = new Database(path);
    expect(evidence.query<{ outcome: string; aggregate_version: number | null }, []>("SELECT outcome, aggregate_version FROM observed_evidence ORDER BY captured_at").all()).toEqual([
      { outcome: "ignored_stale", aggregate_version: null },
      { outcome: "applied", aggregate_version: 2 },
    ]);
    evidence.close();
  });

  test("records versioned before/after transitions in stable sequence without changing observed state", () => {
    const { database, service } = setup(); const project = service.addProject("Visible name", process.cwd()); const task = service.addTask(project.id, "private title", "private description");
    service.transitionTask(task.id, { type: "start" }); service.transitionTask(task.id, { type: "block", reason: "private reason" });
    const events = service.historyTask(task.id, null, 10).events;
    expect(events.map((event) => [event.sequence, event.aggregateVersion, event.eventType])).toEqual([[2, 1, "task.added"], [3, 2, "task.planned_state_changed"], [4, 3, "task.planned_state_changed"]]);
    expect(events[0]).toMatchObject({ eventSchemaVersion: 1, planned: { from: null, to: "planned" }, observed: { from: null, to: "unknown" }, payload: { title: "private title", description: "private description" } });
    expect(events[1]).toMatchObject({ planned: { from: "planned", to: "active" }, observed: null, payload: { command: "start", blockedReason: null } });
    expect(events[2]).toMatchObject({ planned: { from: "active", to: "blocked" }, observed: null, payload: { command: "block", blockedReason: "private reason" } });
    expect(service.showTask(task.id).observedState).toBe("unknown"); database.close();
  });

  test("quiesced checkpoint, close, copy, and reopen preserve current and history snapshot", () => {
    const { dir, path, database, service } = setup(); const project = service.addProject("Snapshot", process.cwd()); const task = service.addTask(project.id, "snapshot task", null); service.transitionTask(task.id, { type: "start" });
    database.close(); const raw = new Database(path); const checkpoint = raw.query<{ busy: number; log: number; checkpointed: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get();
    expect(checkpoint?.busy).toBe(0);
    const counts = {
      projects: raw.query<{ count: number }, []>("SELECT count(*) AS count FROM projects").get()!.count,
      tasks: raw.query<{ count: number }, []>("SELECT count(*) AS count FROM tasks").get()!.count,
      events: raw.query<{ count: number }, []>("SELECT count(*) AS count FROM events").get()!.count,
    };
    raw.close(); const restored = join(dir, "restored.db"); copyFileSync(path, restored);
    const beforeOpen = new Database(restored);
    expect(beforeOpen.query("PRAGMA user_version").get()).toMatchObject({ user_version: 2 });
    expect(beforeOpen.query<{ version: number; aggregate_version: number }, []>(`
      SELECT p.version, e.aggregate_version
      FROM projects p
      JOIN events e ON e.aggregate_type='project' AND e.aggregate_id=p.id
      ORDER BY e.aggregate_version DESC LIMIT 1
    `).get()).toMatchObject({ version: 1, aggregate_version: 1 });
    beforeOpen.close();
    const reopened = openIsolatedTestSqliteDatabase(restored);
    expect(reopened.tasks.getById(task.id)).toMatchObject({ version: 2, plannedState: "active", observedState: "unknown" });
    expect(reopened.history.listForTask(task.id, null, 10).map((event) => event.aggregateVersion)).toEqual([1, 2]);
    reopened.close(); const verify = new Database(restored); expect(verify.query("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" });
    expect({
      projects: verify.query<{ count: number }, []>("SELECT count(*) AS count FROM projects").get()!.count,
      tasks: verify.query<{ count: number }, []>("SELECT count(*) AS count FROM tasks").get()!.count,
      events: verify.query<{ count: number }, []>("SELECT count(*) AS count FROM events").get()!.count,
    }).toEqual(counts);
    expect(verify.query<{ version: number }, [string]>("SELECT version FROM tasks WHERE id=?").get(task.id)?.version).toBe(2);
    expect(verify.query<{ aggregate_version: number }, [string]>("SELECT aggregate_version FROM events WHERE aggregate_type='task' AND aggregate_id=? ORDER BY sequence DESC LIMIT 1").get(task.id)?.aggregate_version).toBe(2);
    verify.close();
  });

  test("daemon-backed verbose diagnostics describe the outcome without leaking command values into stderr", async () => {
    const dir = mkdtempSync("/tmp/orchestrator-events-daemon-"); created.push(dir);
    const daemon = await startDaemon(dir);
    const result = Bun.spawnSync({ cmd: [process.execPath, resolve("src/cli/main.ts"), "--config", daemon.config, "--json", "--verbose", "project", "add", "--name", "secret project", "--root", dir], cwd: dir, env: daemon.env, stdout: "pipe", stderr: "pipe" });
    const stdout = new TextDecoder().decode(result.stdout); const stderr = new TextDecoder().decode(result.stderr);
    expect(result.exitCode).toBe(0); expect(JSON.parse(stdout)).toMatchObject({ ok: true, meta: { command: "project add" } });
    expect(JSON.parse(stderr)).toMatchObject({ command: "project add", result: "success" });
    expect(stderr).not.toContain("secret project"); expect(stderr).not.toContain(dir); expect(stderr).not.toContain("SQLITE_"); expect(stderr).not.toContain(daemon.socket);
  });
});
