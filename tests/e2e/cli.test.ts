import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const temporary: string[] = [];
function environment() { const root = mkdtempSync("/tmp/orchestrator-e2e-"); temporary.push(root); return { root, home: join(root, "home"), db: join(root, "state.db") }; }
function cli(fixture: ReturnType<typeof environment>, args: string[]) {
  const result = Bun.spawnSync({ cmd: [process.execPath, resolve("src/cli/main.ts"), "--db", fixture.db, ...args], cwd: fixture.root, env: { ...process.env, HOME: fixture.home, XDG_STATE_HOME: "", ORCHESTRATOR_DB: "" }, stdout: "pipe", stderr: "pipe" });
  return { exit: result.exitCode, out: new TextDecoder().decode(result.stdout), err: new TextDecoder().decode(result.stderr) };
}
function json(fixture: ReturnType<typeof environment>, args: string[]) { const result = cli(fixture, ["--json", ...args]); return { ...result, body: result.out ? JSON.parse(result.out) : undefined }; }
async function concurrentCli(fixture: ReturnType<typeof environment>, args: string[]) {
  const child = Bun.spawn([process.execPath, resolve("src/cli/main.ts"), "--db", fixture.db, "--json", ...args], { cwd: fixture.root, env: { ...process.env, HOME: fixture.home, XDG_STATE_HOME: "", ORCHESTRATOR_DB: "" }, stdout: "pipe", stderr: "pipe" });
  const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exit, out, err };
}
const transactionWorker = `
import { existsSync, writeFileSync } from "node:fs";
const { openSqliteDatabase } = await import(process.env.DATABASE_MODULE);
const { SystemPathCanonicalizer } = await import(process.env.PATH_MODULE);
const { OrchestratorService } = await import(process.env.SERVICE_MODULE);
const hooks = {
  beforeBegin() {
    if (process.env.ATTEMPT_FILE) writeFileSync(process.env.ATTEMPT_FILE, "attempting");
  },
  afterBegin() {
    if (!process.env.ACQUIRED_FILE) return;
    writeFileSync(process.env.ACQUIRED_FILE, "acquired");
    while (!existsSync(process.env.RELEASE_FILE)) Bun.sleepSync(5);
  },
};
const database = openSqliteDatabase(process.env.DB_PATH, { hooks });
const service = new OrchestratorService({
  projects: database.projects,
  tasks: database.tasks,
  history: database.history,
  unitOfWork: database,
  paths: new SystemPathCanonicalizer(() => process.env.CLI_ROOT),
});
writeFileSync(process.env.OPEN_FILE, "open");
while (!existsSync(process.env.START_FILE)) Bun.sleepSync(5);
try {
  const task = service.transitionTask(process.env.TASK_ID, { type: process.env.TASK_COMMAND });
  console.log(JSON.stringify({ exit: 0, task }));
} catch (error) {
  console.log(JSON.stringify({ exit: error.exitCode, code: error.code }));
} finally {
  database.close();
}
`;
function transactionCli(
  fixture: ReturnType<typeof environment>,
  label: string,
  taskId: string,
  command: "start" | "pause",
  mode: "holder" | "waiter",
) {
  const acquired = join(fixture.root, `${label}.acquired`);
  const release = join(fixture.root, `${label}.release`);
  const attempt = join(fixture.root, `${label}.attempt`);
  const open = join(fixture.root, `${label}.open`);
  const start = join(fixture.root, `${label}.start`);
  const child = Bun.spawn([process.execPath, "-e", transactionWorker], {
    cwd: fixture.root,
    env: {
      ...process.env,
      DB_PATH: fixture.db,
      CLI_ROOT: fixture.root,
      TASK_ID: taskId,
      TASK_COMMAND: command,
      DATABASE_MODULE: resolve("src/adapters/sqlite/database.ts"),
      PATH_MODULE: resolve("src/adapters/system/path.ts"),
      SERVICE_MODULE: resolve("src/application/service.ts"),
      OPEN_FILE: open,
      START_FILE: start,
      ...(mode === "holder" ? { ACQUIRED_FILE: acquired, RELEASE_FILE: release } : { ATTEMPT_FILE: attempt }),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const result = (async () => {
    const [exit, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (exit !== 0 || err) throw new Error(err || `transaction worker exited ${exit}`);
    return JSON.parse(out);
  })();
  return { open, start, acquired, release, attempt, result };
}
async function waitForMarker(path: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    if (await Bun.file(path).exists()) return;
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for transaction barrier: ${path}`);
}
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("CLI subprocess contract", () => {
  test("persists project/task lifecycle and exposes status/history JSON envelopes", () => {
    const f = environment(); const addProject = json(f, ["project", "add", "--name", "Demo", "--root", f.root]);
    expect(addProject).toMatchObject({ exit: 0, err: "", body: { ok: true, meta: { command: "project add", schemaVersion: 1 } } });
    const project = addProject.body.data.project;
    const addTask = json(f, ["task", "add", "--project", project.id, "--title", "Ship"]); const task = addTask.body.data.task;
    expect(addTask.body.data.task).toMatchObject({ plannedState: "planned", observedState: "unknown", version: 1, description: null, startedAt: null, finishedAt: null });
    for (const command of ["start", "pause", "resume", "block", "resume", "complete"]) {
      const args = command === "block" ? ["task", command, task.id, "--reason", "waiting"] : ["task", command, task.id];
      expect(json(f, args).exit).toBe(0);
    }
    const shown = json(f, ["task", "show", task.id]);
    expect(shown.body.data.task).toMatchObject({ plannedState: "done", observedState: "unknown", blockedReason: null, version: 7 });
    const status = json(f, ["status", "--project", project.id]);
    expect(status.body.data.projects[0]).toMatchObject({ project: { id: project.id }, counts: { planned: { done: 1 }, observed: { unknown: 1 } } });
    const history = json(f, ["history", "--task", task.id, "--limit", "100"]);
    expect(history.body.data.events.map((event: any) => event.eventType)).toEqual(["task.added", "task.planned_state_changed", "task.planned_state_changed", "task.planned_state_changed", "task.planned_state_changed", "task.planned_state_changed", "task.planned_state_changed"]);
    expect(history.body.data.events.map((event: any) => event.aggregateVersion)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test("supports cancel branch and keeps errors on stderr with stable JSON exits", () => {
    const f = environment(); const project = json(f, ["project", "add", "--name", "Demo", "--root", f.root]).body.data.project;
    const task = json(f, ["task", "add", "--project", project.id, "--title", "Cancel me"]).body.data.task;
    expect(json(f, ["task", "cancel", task.id]).body.data.task.plannedState).toBe("canceled");
    const invalid = json(f, ["task", "start", task.id]);
    expect(invalid).toMatchObject({ exit: 4, out: "", body: undefined });
    expect(JSON.parse(invalid.err)).toMatchObject({ ok: false, error: { code: "INVALID_TRANSITION", details: { taskId: task.id, fromState: "canceled" } } });
    const missing = json(f, ["task", "show", "11111111-1111-4111-8111-111111111111"]);
    expect(missing.exit).toBe(3); expect(JSON.parse(missing.err).error.code).toBe("NOT_FOUND");
  });

  test("honors human output, duplicate protection, and explicit DB precedence", () => {
    const f = environment(); const first = cli(f, ["project", "add", "--name", "Demo", "--root", f.root]);
    expect(first).toMatchObject({ exit: 0, err: "" }); expect(first.out).toContain("Demo");
    const duplicate = json(f, ["project", "add", "--name", "demo", "--root", f.root]);
    expect(duplicate.exit).toBe(4); expect(JSON.parse(duplicate.err).error.code).toBe("PROJECT_CONFLICT");
    const invalidLimit = json(f, ["history", "--project", "Demo", "--limit", "0"]);
    expect(invalidLimit.exit).toBe(2); expect(JSON.parse(invalidLimit.err).error.details.field).toBe("limit");
    const envDb = join(f.root, "from-env.db");
    const result = Bun.spawnSync({ cmd: [process.execPath, resolve("src/cli/main.ts"), "--db", f.db, "--json", "project", "list"], cwd: f.root, env: { ...process.env, HOME: f.home, ORCHESTRATOR_DB: envDb }, stdout: "pipe", stderr: "pipe" });
    expect(JSON.parse(new TextDecoder().decode(result.stdout))).toMatchObject({ ok: true, data: { projects: [{ name: "Demo" }] } });
  });

  test("keeps JSON error envelopes on stderr when parsing or DB location resolution fails", () => {
    const f = environment();
    const invoke = (args: string[], env: Record<string, string> = {}) => {
      const result = Bun.spawnSync({ cmd: [process.execPath, resolve("src/cli/main.ts"), ...args], cwd: f.root, env: { ...process.env, HOME: "", XDG_STATE_HOME: "", ORCHESTRATOR_DB: "", ...env }, stdout: "pipe", stderr: "pipe" });
      return { exit: result.exitCode, out: new TextDecoder().decode(result.stdout), err: new TextDecoder().decode(result.stderr) };
    };
    for (const args of [["--json", "--db"], ["--json", "project", "add", "--name"], ["--json", "--db", f.db, "nonsense"], ["--json", "project", "list"]]) {
      const result = invoke(args);
      expect(result.out).toBe("");
      expect(() => JSON.parse(result.err)).not.toThrow();
      expect(JSON.parse(result.err)).toMatchObject({ ok: false, meta: { schemaVersion: 1 } });
    }
  });

  test("two processes bootstrap an empty database exactly once", async () => {
    const f = environment();
    const [one, two] = await Promise.all([concurrentCli(f, ["project", "list"]), concurrentCli(f, ["project", "list"])]);
    for (const result of [one, two]) expect(JSON.parse(result.out)).toMatchObject({ ok: true, data: { projects: [] } });
    const verify = cli(f, ["project", "list"]);
    expect(verify.exit).toBe(0);
  });

  test("concurrent start has one commit and leaves matching current and event versions", async () => {
    const f = environment(); const project = json(f, ["project", "add", "--name", "Demo", "--root", f.root]).body.data.project;
    const task = json(f, ["task", "add", "--project", project.id, "--title", "Race"]).body.data.task;
    const results = await Promise.all([concurrentCli(f, ["task", "start", task.id]), concurrentCli(f, ["task", "start", task.id])]);
    expect(results.filter((result) => result.exit === 0)).toHaveLength(1);
    const rejected = results.find((result) => result.exit !== 0)!;
    expect([4, 5]).toContain(rejected.exit);
    expect(JSON.parse(rejected.err)).toMatchObject({ error: { code: rejected.exit === 4 ? "INVALID_TRANSITION" : "DB_BUSY" } });
    const shown = json(f, ["task", "show", task.id]).body.data.task;
    const history = json(f, ["history", "--task", task.id]).body.data.events;
    expect(shown).toMatchObject({ plannedState: "active", version: 2 });
    expect(history.map((event: any) => event.aggregateVersion)).toEqual([1, 2]);
  });

  test("serialized compatible start and pause commands observe both lock orders", async () => {
    const race = async (firstCommand: "start" | "pause", secondCommand: "start" | "pause") => {
      const f = environment();
      const project = json(f, ["project", "add", "--name", `Race-${firstCommand}`, "--root", f.root]).body.data.project;
      const task = json(f, ["task", "add", "--project", project.id, "--title", "Ordered race"]).body.data.task;
      const first = transactionCli(f, "first", task.id, firstCommand, "holder");
      const second = transactionCli(f, "second", task.id, secondCommand, "waiter");
      await Promise.all([waitForMarker(first.open), waitForMarker(second.open)]);
      await Bun.write(first.start, "start");
      await waitForMarker(first.acquired);
      await Bun.write(second.start, "start");
      await waitForMarker(second.attempt);
      await Bun.write(first.release, "release");
      const [firstResult, secondResult] = await Promise.all([first.result, second.result]);
      return { f, task, results: [firstResult, secondResult] };
    };

    const startFirst = await race("start", "pause");
    expect(startFirst.results.map((result) => result.exit)).toEqual([0, 0]);
    expect(json(startFirst.f, ["task", "show", startFirst.task.id]).body.data.task).toMatchObject({ plannedState: "paused", version: 3 });
    expect(json(startFirst.f, ["history", "--task", startFirst.task.id]).body.data.events.map((event: any) => event.aggregateVersion)).toEqual([1, 2, 3]);

    const pauseFirst = await race("pause", "start");
    expect(pauseFirst.results[0]).toMatchObject({ exit: 4, code: "INVALID_TRANSITION" });
    expect(pauseFirst.results[1]!.exit).toBe(0);
    expect(json(pauseFirst.f, ["task", "show", pauseFirst.task.id]).body.data.task).toMatchObject({ plannedState: "active", version: 2 });
    expect(json(pauseFirst.f, ["history", "--task", pauseFirst.task.id]).body.data.events.map((event: any) => event.aggregateVersion)).toEqual([1, 2]);
  });
});
