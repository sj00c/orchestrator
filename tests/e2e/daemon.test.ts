import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DaemonClient } from "../../src/client/daemon-client.ts";
import { resolveEndpoint } from "../../src/client/endpoint.ts";
import { openIsolatedTestSqliteDatabase } from "../../src/adapters/sqlite/database.ts";

const roots: string[] = [];
const requestId = "11111111-1111-4111-8111-111111111111";
function fixture() {
  const root = mkdtempSync("/tmp/orchestrator-daemon-"); roots.push(root);
  const home = join(root, "home"); const configDirectory = join(home, "Library", "Application Support", "Orchestrator"); mkdirSync(configDirectory, { recursive: true, mode: 0o700 }); chmodSync(configDirectory, 0o700);
  const socketPath = join(root, "daemon.sock"); const configPath = join(configDirectory, "config.json"); writeFileSync(configPath, JSON.stringify({ socketPath }), { mode: 0o600 }); chmodSync(configPath, 0o600);
  return { root, home, socketPath, configPath };
}
async function daemon(f: ReturnType<typeof fixture>) {
  const child = Bun.spawn([process.execPath, resolve("src/daemon/main.ts")], { cwd: resolve("."), env: { ...process.env, HOME: f.home }, stdout: "pipe", stderr: "pipe" });
  const endpoint = await resolveEndpoint({ config: f.configPath }); const client = new DaemonClient({ endpoint });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { const health = await client.health(); if (health.data.ready) return { child, client, endpoint }; } catch { /* daemon is still starting */ }
    await Bun.sleep(25);
  }
  child.kill(); throw new Error("Daemon did not become healthy");
}
async function stop(child: ReturnType<typeof Bun.spawn>) { child.kill("SIGTERM"); await Promise.race([child.exited, Bun.sleep(5_000).then(() => { throw new Error("Daemon did not shut down"); })]); }
afterEach(async () => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("daemon UDS operational surface", () => {
  test("serves health/readiness, enforces request limits, shuts down, and recovers durable state after restart", async () => {
    const f = fixture(); const first = await daemon(f);
    expect(await first.client.health()).toMatchObject({ ok: true, data: { phase: "ready", ready: true, configFingerprint: first.endpoint.configFingerprint } });
    const created = await first.client.request<{ id: string }>("POST", "/v1/projects", { name: "Daemon", root: f.root }, new URLSearchParams(), requestId);
    expect(created.data.id).toMatch(/^[0-9a-f-]{36}$/);
    const oversizedBody = JSON.stringify({ padding: "x".repeat(1_048_577) });
    const oversized = await fetch("http://localhost/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": requestId, "idempotency-key": requestId },
      body: oversizedBody,
      unix: first.endpoint.socketPath,
    } as RequestInit);
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ ok: false, error: { code: "RESPONSE_TOO_LARGE" } });
    await stop(first.child);
    await expect(first.client.health()).rejects.toMatchObject({ code: "DAEMON_UNAVAILABLE" });
    const second = await daemon(f);
    expect(await second.client.request("GET", "/v1/projects")).toMatchObject({ data: { items: [{ id: created.data.id, name: "Daemon" }] } });
    await stop(second.child);
  });

  test("CLI has no direct database mode and requires the live daemon endpoint", () => {
    const f = fixture();
    const result = Bun.spawnSync({ cmd: [process.execPath, resolve("src/cli/main.ts"), "--config", f.configPath, "--db", join(f.root, "forbidden.db"), "--json", "project", "list"], cwd: f.root, env: { ...process.env, HOME: f.home }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(2);
    expect(new TextDecoder().decode(result.stderr)).toContain("Unknown option");
  });

  test("commits a single active attempt and drives managed execution through the daemon UDS", async () => {
    const f = fixture();
    const running = await daemon(f);
    try {
      const projectRequest = { name: "Managed", root: f.root };
      const concurrentProjects = await Promise.all(Array.from({ length: 20 }, () =>
        running.client.request<{ id: string }>("POST", "/v1/projects", projectRequest, new URLSearchParams(), requestId)));
      expect(new Set(concurrentProjects.map((response) => JSON.stringify(response.data))).size).toBe(1);
      const firstProject = concurrentProjects[0]!;
      const replayedProject = await running.client.request<{ id: string }>("POST", "/v1/projects", projectRequest, new URLSearchParams(), requestId);
      expect(replayedProject.data).toEqual(firstProject.data);
      await expect(running.client.request("POST", "/v1/projects", { ...projectRequest, name: "Changed" }, new URLSearchParams(), requestId))
        .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

      const task = await running.client.request<{ id: string }>("POST", "/v1/tasks", {
        project: firstProject.data.id,
        title: "Execute",
        description: null,
        plannedState: "ready",
      });
      const definition = await running.client.request<{ id: string; version: number }>("POST", "/v1/process-definitions", {
        taskId: task.data.id,
        executable: "/bin/sleep",
        args: ["1"],
        cwd: null,
        envPolicy: { kind: "set", values: {} },
      });
      expect(await running.client.request("GET", `/v1/process-definitions/${definition.data.id}`))
        .toMatchObject({ data: { id: definition.data.id, version: 1 } });

      const schedule = await running.client.request<{ id: string }>("POST", "/v1/schedules", {
        taskId: task.data.id,
        definitionId: definition.data.id,
        definitionVersion: 1,
        kind: "one-shot",
        runAt: "2099-01-01T00:00:00.000Z",
        enabled: true,
        misfirePolicy: "coalesce",
      });
      expect(await running.client.request("POST", `/v1/schedules/${schedule.data.id}/disable`, {}))
        .toMatchObject({ data: { id: schedule.data.id, enabled: false } });

      const attempt = await running.client.request<{ id: string }>("POST", "/v1/execution-attempts", {
        taskId: task.data.id,
        definitionId: definition.data.id,
        definitionVersion: 1,
      });
      await expect(running.client.request("POST", "/v1/execution-attempts", {
        taskId: task.data.id,
        definitionId: definition.data.id,
        definitionVersion: 1,
      })).rejects.toMatchObject({ code: "EXECUTION_CONFLICT" });
      let terminal: Record<string, unknown> | undefined;
      for (let index = 0; index < 300; index++) {
        const response = await running.client.request<Record<string, unknown>>("GET", `/v1/execution-attempts/${attempt.data.id}`);
        if (["succeeded", "failed", "lost"].includes(String(response.data.state))) {
          terminal = response.data;
          break;
        }
        await Bun.sleep(20);
      }
      expect(terminal).toMatchObject({ id: attempt.data.id, state: "succeeded", exitCode: 0 });
      expect(terminal).not.toHaveProperty("spec");
      expect(await running.client.request("GET", `/v1/tasks/${task.data.id}/execution`))
        .toMatchObject({ data: { id: attempt.data.id, state: "succeeded" } });
    } finally {
      await stop(running.child);
    }
  }, 15_000);

  test("K0: restarts queued work without duplicating its sentinel side effect", async () => {
    const f = fixture();
    const sentinel = join(f.root, "queued-restart-sentinel");
    const first = await daemon(f);
    let second: Awaited<ReturnType<typeof daemon>> | undefined;
    try {
      const { attempt } = await createSentinelAttempt(first.client, f.root, sentinel, 0);
      expect((await first.client.request<Record<string, unknown>>("GET", `/v1/execution-attempts/${attempt}`)).data.state).toBe("queued");
      first.child.kill("SIGKILL");
      await first.child.exited;
      second = await daemon(f);
      expect(await waitForAttempt(second.client, attempt, ["succeeded"], undefined, 10_000)).toMatchObject({ exitCode: 0 });
      expect(readFileSync(sentinel, "utf8")).toBe("once\n");
    } finally {
      if (first.child.exitCode === null) first.child.kill("SIGKILL");
      if (second?.child.exitCode === null) await stop(second.child);
    }
  }, 20_000);

  test("K1: recovers an expired claimed row without guessing a child existed", async () => {
    const f = fixture();
    const sentinel = join(f.root, "claimed-restart-sentinel");
    const first = await daemon(f);
    let second: Awaited<ReturnType<typeof daemon>> | undefined;
    try {
      const { attempt } = await createSentinelAttempt(first.client, f.root, sentinel, 0);
      first.child.kill("SIGKILL");
      await first.child.exited;
      const database = openIsolatedTestSqliteDatabase(join(f.home, ".local/state/orchestrator/orchestrator.db"));
      const owner = "88888888-8888-4888-8888-888888888888";
      const expiredAt = "2020-01-01T00:00:00.000Z";
      database.execute((tx) => {
        tx.projects.upsertDaemon({ instanceId: owner, version: "test", phase: "stopped", startedAt: expiredAt, heartbeatAt: expiredAt, configFingerprint: "expired" });
        const leaseToken = tx.projects.acquireLease("execution_attempt", attempt, owner, expiredAt, expiredAt);
        expect(leaseToken).toBe(1);
        if (leaseToken === null) throw new Error("claimed recovery fixture did not acquire its lease");
        expect(tx.projects.claimAttempt(attempt, { ownerInstanceId: owner, leaseToken })).not.toBeNull();
      });
      database.close();
      second = await daemon(f);
      const lost = await waitForAttempt(second.client, attempt, ["lost"], undefined, 10_000);
      expect(lost).toMatchObject({ possibleLiveChild: false, errorCode: "RUNNER_IDENTITY_MISSING" });
      const resumed = await second.client.request<{ id: string }>("POST", `/v1/execution-attempts/${attempt}/resume`, {});
      expect(await waitForAttempt(second.client, resumed.data.id, ["succeeded"], undefined, 10_000)).toMatchObject({ exitCode: 0 });
      expect(readFileSync(sentinel, "utf8")).toBe("once\n");
    } finally {
      if (first.child.exitCode === null) first.child.kill("SIGKILL");
      if (second?.child.exitCode === null) await stop(second.child);
    }
  }, 25_000);

  test("K6/K10: retains the live-running heartbeat and takes over an expired lease without repeating the child", async () => {
    const f = fixture();
    const first = await daemon(f);
    let second: Awaited<ReturnType<typeof daemon>> | undefined;
    try {
      const sentinel = join(f.root, "live-child-sentinel");
      const project = await first.client.request<{ id: string }>("POST", "/v1/projects", { name: "Recovery", root: f.root });
      const task = await first.client.request<{ id: string }>("POST", "/v1/tasks", { project: project.data.id, title: "Sleep", description: null, plannedState: "ready" });
      const definition = await first.client.request<{ id: string }>("POST", "/v1/process-definitions", {
        taskId: task.data.id,
        executable: process.execPath,
        args: ["-e", `require("node:fs").appendFileSync(${JSON.stringify(sentinel)}, "once\\n"); setTimeout(() => process.exit(0), 60_000)`],
        cwd: null,
        envPolicy: { kind: "set", values: {} },
      });
      const attempt = await first.client.request<{ id: string }>("POST", "/v1/execution-attempts", {
        taskId: task.data.id,
        definitionId: definition.data.id,
        definitionVersion: 1,
      });
      const running = await waitForAttempt(first.client, attempt.data.id, ["running"]);
      expect(running.heartbeatAt).toBe(running.execGrantedAt);
      const oldOwner = String(running.ownerInstanceId);
      const runnerPid = Number((running.runner as { pid: number }).pid);
      const childPid = Number((running.child as { pid: number }).pid);
      const lockPath = `${f.socketPath}.lock`;
      const lockInode = statSync(lockPath).ino;

      first.child.kill("SIGKILL");
      await first.child.exited;
      expect(() => process.kill(runnerPid, 0)).not.toThrow();
      expect(() => process.kill(childPid, 0)).not.toThrow();

      second = await daemon(f);
      expect(statSync(lockPath).ino).toBe(lockInode);
      const adopted = await waitForAttempt(second.client, attempt.data.id, ["running"], (value) => value.ownerInstanceId !== oldOwner, 15_000);
      expect(adopted).toMatchObject({ id: attempt.data.id, state: "running" });
      expect(Number(adopted.leaseToken)).toBeGreaterThan(Number(running.leaseToken));
      expect(readFileSync(sentinel, "utf8")).toBe("once\n");
      await second.client.request("POST", `/v1/execution-attempts/${attempt.data.id}/stop`, { graceMs: 1 });
      expect(await waitForAttempt(second.client, attempt.data.id, ["stopped", "failed"])).toHaveProperty("possibleLiveChild", false);
    } finally {
      if (first.child.exitCode === null) first.child.kill("SIGKILL");
      if (second?.child.exitCode === null) await stop(second.child);
    }
  }, 25_000);


  test("K8/K9/K11: ingests an exit-before-observation durable result after restart without repeating its sentinel side effect", async () => {
    const f = fixture();
    const sentinel = join(f.root, "durable-result-sentinel");
    const first = await daemon(f);
    let second: Awaited<ReturnType<typeof daemon>> | undefined;
    try {
      const { attempt } = await createSentinelAttempt(first.client, f.root, sentinel, 0);
      const running = await waitForAttempt(first.client, attempt, ["running"]);
      const runnerPid = Number((running.runner as { pid: number }).pid);
      await waitFor(() => {
        try { return readFileSync(sentinel, "utf8") === "once\n" && !alive(runnerPid); } catch { return false; }
      });
      expect((await first.client.request<Record<string, unknown>>("GET", `/v1/execution-attempts/${attempt}`)).data.state).toBe("running");

      first.child.kill("SIGKILL");
      await first.child.exited;
      second = await daemon(f);
      expect(await waitForAttempt(second.client, attempt, ["succeeded"], undefined, 15_000)).toMatchObject({ exitCode: 0, signal: null });
      expect(readFileSync(sentinel, "utf8")).toBe("once\n");
    } finally {
      if (first.child.exitCode === null) first.child.kill("SIGKILL");
      if (second?.child.exitCode === null) await stop(second.child);
    }
  }, 25_000);
});

async function createSentinelAttempt(client: DaemonClient, root: string, sentinel: string, delayMs: number): Promise<{ attempt: string }> {
  const project = await client.request<{ id: string }>("POST", "/v1/projects", { name: `Recovery ${delayMs}`, root });
  const task = await client.request<{ id: string }>("POST", "/v1/tasks", { project: project.data.id, title: "Sentinel", description: null, plannedState: "ready" });
  const definition = await client.request<{ id: string; version: number }>("POST", "/v1/process-definitions", {
    taskId: task.data.id,
    executable: process.execPath,
    args: ["-e", `require("node:fs").appendFileSync(${JSON.stringify(sentinel)}, "once\\n"); setTimeout(() => process.exit(0), ${delayMs})`],
    cwd: null,
    envPolicy: { kind: "set", values: {} },
  });
  const attempt = await client.request<{ id: string }>("POST", "/v1/execution-attempts", {
    taskId: task.data.id,
    definitionId: definition.data.id,
    definitionVersion: definition.data.version,
  });
  return { attempt: attempt.data.id };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for runner result barrier");
    await Bun.sleep(10);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForAttempt(
  client: DaemonClient,
  attemptId: string,
  states: string[],
  predicate: (attempt: Record<string, unknown>) => boolean = () => true,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    try {
      const attempt = (await client.request<Record<string, unknown>>("GET", `/v1/execution-attempts/${attemptId}`)).data;
      last = attempt;
      if (states.includes(String(attempt.state)) && predicate(attempt)) return attempt;
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "DAEMON_UNAVAILABLE")) throw error;
    }
    await Bun.sleep(25);
  }
  throw new Error(`Attempt ${attemptId} did not reach ${states.join("|")}: ${JSON.stringify(last)}`);
}
