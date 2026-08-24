import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveEndpoint } from "../../src/client/endpoint.ts";
import { createDaemonServer } from "../../src/daemon/server.ts";

const uuid = "11111111-1111-4111-8111-111111111111";

function request(path = "/v1/projects"): Request {
  return new Request(`http://unix${path}`, { headers: { "x-request-id": uuid } });
}

describe("daemon UDS admission and endpoint safety", () => {
  test("rejects symlinked or non-owner-only configuration before choosing its socket", async () => {
    const home = mkdtempSync("/tmp/orchestrator-uds-");
    const configDirectory = join(home, "Library/Application Support/Orchestrator");
    mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
    const target = join(home, "target.json");
    writeFileSync(target, JSON.stringify({ socketPath: "/tmp/orchestrator-test.sock" }), { mode: 0o600 });
    const config = join(configDirectory, "config.json");
    symlinkSync(target, config);
    await expect(resolveEndpoint({ home, uid: process.getuid?.() })).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    rmSync(config);
    writeFileSync(config, JSON.stringify({ socketPath: "/tmp/orchestrator-test.sock" }), { mode: 0o600 });
    chmodSync(config, 0o644);
    await expect(resolveEndpoint({ home, uid: process.getuid?.() })).rejects.toMatchObject({ code: "CONFIG_ERROR" });
    rmSync(home, { recursive: true, force: true });
  });

  test("enforces request deadline and the 64-request admission ceiling while health remains available", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const server = createDaemonServer({
      requestTimeoutMs: 10,
      maxInflight: 64,
      maxQueued: 0,
      health: () => ({ ready: true }),
      dispatch: async () => { await blocked; return []; },
    });
    const active = Array.from({ length: 64 }, () => server.fetch(request()));
    await Promise.resolve();
    const overflow = await server.fetch(request());
    expect(overflow.status).toBe(503);
    expect((await server.fetch(request("/v1/health"))).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(active[0]!).resolves.toHaveProperty("status", 503);
    release();
    await Promise.all(active.slice(1));
  });
});
