import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { openSqliteDatabase } from "../../src/adapters/sqlite/database.ts";
import { SystemPathCanonicalizer } from "../../src/adapters/system/path.ts";
import { OrchestratorService } from "../../src/application/service.ts";
import type { Clock } from "../../src/domain/model.ts";

const created: string[] = [];
function setup() {
  const dir = mkdtempSync("/tmp/orchestrator-events-"); created.push(dir); const path = join(dir, "state.db");
  const database = openSqliteDatabase(path); let id = 0; const values = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  const clock: Clock = { now: () => "2026-01-02T03:04:05.678Z" };
  const service = new OrchestratorService({ projects: database.projects, tasks: database.tasks, history: database.history, unitOfWork: database, paths: new SystemPathCanonicalizer(() => dir), clock, ids: { next: () => values[id++] } });
  return { dir, path, database, service };
}
afterEach(() => { for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("event observability", () => {
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
    expect(beforeOpen.query("PRAGMA user_version").get()).toMatchObject({ user_version: 1 });
    expect(beforeOpen.query<{ version: number; aggregate_version: number }, []>(`
      SELECT p.version, e.aggregate_version
      FROM projects p
      JOIN events e ON e.aggregate_type='project' AND e.aggregate_id=p.id
      ORDER BY e.aggregate_version DESC LIMIT 1
    `).get()).toMatchObject({ version: 1, aggregate_version: 1 });
    beforeOpen.close();
    const reopened = openSqliteDatabase(restored);
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

  test("verbose diagnostics describe the outcome without leaking command values into stderr", () => {
    const { dir, path } = setup();
    const result = Bun.spawnSync({ cmd: [process.execPath, resolve("src/cli/main.ts"), "--db", path, "--json", "--verbose", "project", "add", "--name", "secret project", "--root", dir], stdout: "pipe", stderr: "pipe" });
    const stdout = new TextDecoder().decode(result.stdout); const stderr = new TextDecoder().decode(result.stderr);
    expect(result.exitCode).toBe(0); expect(JSON.parse(stdout)).toMatchObject({ ok: true, meta: { command: "project add" } });
    expect(JSON.parse(stderr)).toMatchObject({ command: "project add", result: "success" });
    expect(stderr).not.toContain("secret project"); expect(stderr).not.toContain(dir); expect(stderr).not.toContain("SQLITE_");
  });
});
