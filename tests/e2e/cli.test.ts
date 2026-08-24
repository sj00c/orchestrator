import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DaemonClient } from "../../src/client/daemon-client.ts";
import { resolveEndpoint } from "../../src/client/endpoint.ts";

const temporary: string[] = [];
const daemons: ReturnType<typeof Bun.spawn>[] = [];

function environment() {
  const root = mkdtempSync("/tmp/orchestrator-e2e-");
  const home = join(root, "home");
  const configDirectory = join(home, "Library/Application Support/Orchestrator");
  const config = join(configDirectory, "config.json");
  const socket = join(root, "daemon.sock");
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  chmodSync(configDirectory, 0o700);
  writeFileSync(config, JSON.stringify({ socketPath: socket }));
  chmodSync(config, 0o600);
  temporary.push(root);
  return { root, home, config, socket, database: join(configDirectory, "orchestrator.sqlite") };
}

function processEnvironment(fixture: ReturnType<typeof environment>) {
  return { ...process.env, HOME: fixture.home, XDG_STATE_HOME: "", ORCHESTRATOR_DB: "" };
}

function cli(fixture: ReturnType<typeof environment>, args: string[]) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, resolve("src/cli/main.ts"), "--config", fixture.config, ...args],
    cwd: fixture.root,
    env: processEnvironment(fixture),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exit: result.exitCode, out: new TextDecoder().decode(result.stdout), err: new TextDecoder().decode(result.stderr) };
}

function json(fixture: ReturnType<typeof environment>, args: string[]) {
  const result = cli(fixture, ["--json", ...args]);
  return { ...result, body: result.out ? JSON.parse(result.out) : undefined };
}

async function startDaemon(fixture: ReturnType<typeof environment>): Promise<void> {
  const daemon = Bun.spawn([process.execPath, resolve("src/daemon/main.ts")], {
    cwd: fixture.root,
    env: processEnvironment(fixture),
    stdout: "ignore",
    stderr: "ignore",
  });
  daemons.push(daemon);
  const client = new DaemonClient({ endpoint: await resolveEndpoint({ config: fixture.config }) });
  for (let attempt = 0; attempt < 1_000; attempt++) {
    try {
      if ((await client.health()).data.ready) {
        expect(existsSync(fixture.socket)).toBe(true);
        return;
      }
    } catch {
      // The daemon has not bound its socket yet.
    }
    if (daemon.exitCode !== null) throw new Error(`Daemon exited during startup with ${daemon.exitCode}.`);
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for daemon readiness.");
}

async function stopDaemons(): Promise<void> {
  for (const daemon of daemons.splice(0)) {
    if (daemon.exitCode === null) daemon.kill("SIGTERM");
    await Promise.race([daemon.exited, Bun.sleep(5_000).then(() => { throw new Error("Daemon did not shut down."); })]);
  }
}

afterEach(async () => {
  await stopDaemons();
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CLI subprocess contract", () => {
  test("returns the intentional daemon-unavailable delta without creating a direct database", () => {
    const f = environment();
    const unavailable = json(f, ["project", "list"]);
    expect(unavailable).toMatchObject({ exit: 5, out: "", body: undefined });
    expect(JSON.parse(unavailable.err)).toMatchObject({ ok: false, error: { code: "DAEMON_UNAVAILABLE", details: { endpoint: f.socket, reason: "connect_failed" } } });
    expect(existsSync(f.database)).toBe(false);
  });

  test("uses a ready daemon for project/task lifecycle, status, and history JSON contracts", async () => {
    const f = environment(); await startDaemon(f);
    const addProject = json(f, ["project", "add", "--name", "Demo", "--root", f.root]);
    expect(addProject).toMatchObject({ exit: 0, err: "", body: { ok: true, meta: { command: "project add", schemaVersion: 1 } } });
    const project = addProject.body.data.project;
    const addTask = json(f, ["task", "add", "--project", project.id, "--title", "Ship"]); const task = addTask.body.data.task;
    expect(addTask.body.data.task).toMatchObject({ plannedState: "planned", observedState: "unknown", version: 1, description: null, startedAt: null, finishedAt: null });
    for (const command of ["start", "pause", "resume", "block", "resume", "complete"]) {
      const args = command === "block" ? ["task", command, task.id, "--reason", "waiting"] : ["task", command, task.id];
      expect(json(f, args).exit).toBe(0);
    }
    expect(json(f, ["task", "show", task.id]).body.data.task).toMatchObject({ plannedState: "done", observedState: "unknown", blockedReason: null, version: 7 });
    expect(json(f, ["status", "--project", project.id]).body.data.projects[0]).toMatchObject({ project: { id: project.id }, counts: { planned: { done: 1 }, observed: { unknown: 1 } } });
    const history = json(f, ["history", "--task", task.id, "--limit", "100"]);
    expect(history.body.data.events.map((event: any) => event.eventType)).toEqual(["task.added", "task.planned_state_changed", "task.planned_state_changed", "task.planned_state_changed", "task.planned_state_changed", "task.planned_state_changed", "task.planned_state_changed"]);
    expect(history.body.data.events.map((event: any) => event.aggregateVersion)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test("keeps human output and stable JSON error exits through the thin client", async () => {
    const f = environment(); await startDaemon(f);
    const first = cli(f, ["project", "add", "--name", "Demo", "--root", f.root]);
    expect(first).toMatchObject({ exit: 0, err: "" }); expect(first.out).toContain("Demo");
    const duplicate = json(f, ["project", "add", "--name", "demo", "--root", f.root]);
    expect(duplicate.exit).toBe(4); expect(JSON.parse(duplicate.err).error.code).toBe("PROJECT_CONFLICT");
    const invalidLimit = json(f, ["history", "--project", "Demo", "--limit", "0"]);
    expect(invalidLimit.exit).toBe(2); expect(JSON.parse(invalidLimit.err).error.details.field).toBe("limit");
    const missing = json(f, ["task", "show", "11111111-1111-4111-8111-111111111111"]);
    expect(missing.exit).toBe(3); expect(JSON.parse(missing.err).error.code).toBe("NOT_FOUND");
    const directDatabase = json(f, ["project", "list", "--db", f.database]);
    expect(directDatabase.exit).toBe(2); expect(JSON.parse(directDatabase.err)).toMatchObject({ error: { code: "USAGE_ERROR", details: { argument: "--db" } } });
  });

  test("keeps parsing errors on stderr before contacting the daemon", () => {
    const f = environment();
    for (const args of [["--json", "--config"], ["--json", "project", "add", "--name"], ["--json", "nonsense"]]) {
      const result = cli(f, args);
      expect(result.out).toBe("");
      expect(() => JSON.parse(result.err)).not.toThrow();
      expect(JSON.parse(result.err)).toMatchObject({ ok: false, meta: { schemaVersion: 1 } });
    }
  });
});
