import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DaemonClient } from "../../src/client/daemon-client.ts";
import { resolveEndpoint } from "../../src/client/endpoint.ts";
import { createDaemonServer } from "../../src/daemon/server.ts";

const RUNS = 3;
const WARMUP_MS = 10_000;
const SAMPLE_MS = 60_000;
const HEALTH_CLIENTS = 100;
const MAX_INFLIGHT = 64;
const MAX_QUEUE = 128;
const MAX_RSS_GROWTH = 128 * 1024 * 1024;

function request(path: string): Request { return new Request(`http://unix${path}`, { headers: { "x-request-id": crypto.randomUUID() } }); }
function percentile(values: number[], p: number): number { return [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] ?? 0; }
function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : String(error);
}
function fixture() {
  const root = mkdtempSync("/tmp/orchestrator-daemon-load-");
  const home = join(root, "home");
  const configDirectory = join(home, "Library", "Application Support", "Orchestrator");
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
  chmodSync(configDirectory, 0o700);
  const socketPath = join(root, "daemon.sock");
  const configPath = join(configDirectory, "config.json");
  writeFileSync(configPath, JSON.stringify({ socketPath }), { mode: 0o600 });
  chmodSync(configPath, 0o600);
  return { root, home, configPath };
}
async function daemon(f: ReturnType<typeof fixture>) {
  const child = Bun.spawn([process.execPath, resolve("src/daemon/main.ts")], { cwd: resolve("."), env: { ...process.env, HOME: f.home }, stdout: "pipe", stderr: "pipe" });
  const client = new DaemonClient({ endpoint: await resolveEndpoint({ config: f.configPath }) });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await client.health()).data.ready) return { child, client }; } catch { /* daemon is still starting */ }
    await Bun.sleep(25);
  }
  child.kill();
  throw new Error("Daemon did not become healthy");
}
async function stop(child: ReturnType<typeof Bun.spawn>) {
  child.kill("SIGTERM");
  await Promise.race([child.exited, Bun.sleep(5_000).then(() => { throw new Error("Daemon did not shut down"); })]);
}
function rssBytes(pid: number): number {
  const result = Bun.spawnSync({ cmd: ["ps", "-o", "rss=", "-p", String(pid)], stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`ps could not sample daemon RSS: ${new TextDecoder().decode(result.stderr)}`);
  const kib = Number(new TextDecoder().decode(result.stdout).trim());
  if (!Number.isFinite(kib)) throw new Error("ps returned no daemon RSS sample");
  return kib * 1024;
}

describe("daemon fixed load profile", () => {
  test("admission microprofile holds 64 active requests, queues 128, then rejects the next request without dispatching it", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let dispatched = 0;
    const server = createDaemonServer({
      maxInflight: MAX_INFLIGHT,
      maxQueued: MAX_QUEUE,
      health: () => ({ ready: true }),
      dispatch: async () => { dispatched++; await blocked; return []; },
    } as any);
    const active = Array.from({ length: MAX_INFLIGHT }, () => server.fetch(request("/v1/projects")));
    const queued = Array.from({ length: MAX_QUEUE }, () => server.fetch(request("/v1/projects")));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dispatched).toBe(MAX_INFLIGHT);
    const overflow = await server.fetch(request("/v1/projects"));
    expect([429, 503]).toContain(overflow.status);
    release();
    await Promise.all([...active, ...queued]);
  });

  test("spawned daemon UDS and SQLite profile keeps 100 reads and 10 idempotent mutations within latency, RSS, and DB_BUSY gates", async () => {
    const runs: { p95: number; rssGrowth: number; errors: number; dbBusy: number; rejected: number }[] = [];
    for (let run = 0; run < RUNS; run++) {
      const f = fixture();
      const running = await daemon(f);
      try {
        const projectRoots = ["first", "second", "idempotent"].map((name) => {
          const path = join(f.root, name);
          mkdirSync(path, { mode: 0o700 });
          return path;
        });
        const seeded = await Promise.all(["first", "second"].map((name, index) => running.client.request<{ id: string }>("POST", "/v1/projects", { name, root: projectRoots[index]! })));
        const firstPage = await running.client.request<{ items: { id: string }[]; nextCursor: string | null }>("GET", "/v1/projects", undefined, new URLSearchParams({ limit: "1" }));
        expect(firstPage.data.items).toHaveLength(1);
        expect(firstPage.data.nextCursor).not.toBeNull();
        const pageQuery = new URLSearchParams({ limit: "1", cursor: firstPage.data.nextCursor! });
        const mutationKey = crypto.randomUUID();
        const mutation = { name: "idempotent", root: projectRoots[2]! };
        const warmupUntil = Date.now() + WARMUP_MS;
        while (Date.now() < warmupUntil) await running.client.health();
        const rssBefore = rssBytes(running.child.pid);
        const latencies: number[] = [];
        let errors = 0;
        let dbBusy = 0;
        let rejected = 0;
        const sampleUntil = Date.now() + SAMPLE_MS;
        while (Date.now() < sampleUntil) {
          await Promise.all([
            ...Array.from({ length: HEALTH_CLIENTS }, async (_, index) => {
              const started = performance.now();
              try {
                if (index % 2 === 0) await running.client.health();
                else await running.client.request("GET", "/v1/projects", undefined, pageQuery);
              } catch (error) {
                errors++;
                const code = errorCode(error);
                if (code === "DB_BUSY") dbBusy++;
                if (code === "RATE_LIMIT" || code === "DAEMON_UNAVAILABLE") rejected++;
              } finally {
                if (latencies.length < 100_000) latencies.push(performance.now() - started);
              }
            }),
            ...Array.from({ length: 10 }, async () => {
              try { await running.client.request("POST", "/v1/projects", mutation, new URLSearchParams(), mutationKey); }
              catch (error) {
                errors++;
                const code = errorCode(error);
                if (code === "DB_BUSY") dbBusy++;
                if (code === "RATE_LIMIT" || code === "DAEMON_UNAVAILABLE") rejected++;
              }
            }),
          ]);
          await Bun.sleep(10);
        }
        const projects = await running.client.request<{ items: { id: string }[] }>("GET", "/v1/projects", undefined, new URLSearchParams({ limit: "10" }));
        expect(projects.data.items.filter((project) => project.id === seeded[0]!.data.id)).toHaveLength(1);
        expect(projects.data.items.filter((project) => project.id === seeded[1]!.data.id)).toHaveLength(1);
        expect(projects.data.items).toHaveLength(3);
        runs.push({ p95: percentile(latencies, 0.95), rssGrowth: Math.max(0, rssBytes(running.child.pid) - rssBefore), errors, dbBusy, rejected });
      } finally {
        if (running.child.exitCode === null) await stop(running.child);
        rmSync(f.root, { recursive: true, force: true });
      }
    }
    const p95s = runs.map((run) => run.p95);
    expect(percentile(p95s, 0.5)).toBeLessThanOrEqual(100);
    expect(Math.max(...runs.map((run) => run.rssGrowth))).toBeLessThanOrEqual(MAX_RSS_GROWTH);
    expect(Math.max(...runs.map((run) => run.errors))).toBe(0);
    expect(Math.max(...runs.map((run) => run.dbBusy))).toBe(0);
    expect(Math.max(...runs.map((run) => run.rejected))).toBe(0);
    expect(MAX_INFLIGHT).toBe(64);
    expect(MAX_QUEUE).toBe(128);
  }, RUNS * (WARMUP_MS + SAMPLE_MS) + 30_000);
});
