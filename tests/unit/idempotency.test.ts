import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openIsolatedTestSqliteDatabase } from "../../src/adapters/sqlite/database.ts";
import { SystemPathCanonicalizer } from "../../src/adapters/system/path.ts";
import { MAX_RESPONSE_BYTES, canonicalRequestHash } from "../../src/api/v1/contract.ts";
import { IdempotencyService } from "../../src/application/idempotency-service.ts";
import { OrchestratorService } from "../../src/application/service.ts";
import { DaemonClient, TransportFailure, type DaemonTransport, type TransportRequest } from "../../src/client/daemon-client.ts";
import { createDaemonServer } from "../../src/daemon/server.ts";

const key = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const endpoint = { socketPath: "/tmp/orchestrator.sock", configPath: "/tmp/config.json", configFingerprint: "fingerprint", source: "socket" as const };
class RecordingTransport implements DaemonTransport {
  readonly requests: TransportRequest[] = [];
  constructor(private readonly reply: (request: TransportRequest) => Promise<{ status: number; headers: Record<string, string>; body: string }>) {}
  async request(_endpoint: string, request: TransportRequest) { this.requests.push(request); return this.reply(request); }
}
const success = (request: TransportRequest) => Promise.resolve({ status: 200, headers: { "x-request-id": request.headers["X-Request-Id"]! }, body: '{"ok":true,"data":{"id":"p"},"meta":{"command":"project add","schemaVersion":1}}' });

function client(transport: DaemonTransport): DaemonClient { return new DaemonClient({ endpoint, transport, ids: () => requestId }); }
function mutationRequest(data: Record<string, string>): Request {
  const body = { schemaVersion: 1, data };
  return new Request("http://daemon/v1/projects", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": key,
      "x-request-id": requestId,
      "x-request-hash": canonicalRequestHash("POST", "/v1/projects", new URLSearchParams(), data),
    },
    body: JSON.stringify(body),
  });
}

describe("mutation idempotency wire contract", () => {
  test("reuses an explicit key and identical request hash for an exact retry", async () => {
    const transport = new RecordingTransport(success); const subject = client(transport);
    await subject.request("POST", "/v1/projects", { name: "one", root: "/work" }, new URLSearchParams(), key);
    await subject.request("POST", "/v1/projects", { root: "/work", name: "one" }, new URLSearchParams(), key);
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests.map((request) => request.headers["Idempotency-Key"])).toEqual([key, key]);
    expect(transport.requests[0]!.headers["X-Request-Hash"]).toBe(transport.requests[1]!.headers["X-Request-Hash"]);
  });

  test("changes the hash when the same key is reused for a different command payload", async () => {
    const transport = new RecordingTransport(success); const subject = client(transport);
    await subject.request("POST", "/v1/projects", { name: "one", root: "/work" }, new URLSearchParams(), key);
    await subject.request("POST", "/v1/projects", { name: "two", root: "/work" }, new URLSearchParams(), key);
    expect(transport.requests[0]!.headers["Idempotency-Key"]).toBe(transport.requests[1]!.headers["Idempotency-Key"]);
    expect(transport.requests[0]!.headers["X-Request-Hash"]).not.toBe(transport.requests[1]!.headers["X-Request-Hash"]);
  });

  test.each(["IDEMPOTENCY_IN_PROGRESS", "IDEMPOTENCY_EXPIRED", "IDEMPOTENCY_CONFLICT"])("surfaces durable idempotency state %s instead of treating it as success", async (code) => {
    const transport = new RecordingTransport(async (request) => ({ status: 409, headers: { "x-request-id": request.headers["X-Request-Id"]! }, body: JSON.stringify({ ok: false, error: { code, message: "not replayable", details: { idempotencyKey: key } }, meta: { command: "project add", schemaVersion: 1 } }) }));
    await expect(client(transport).request("POST", "/v1/projects", { name: "one", root: "/work" }, new URLSearchParams(), key)).rejects.toMatchObject({ code, details: { idempotencyKey: key } });
  });

  test("reports daemon unavailable after both attempts fail before sending", async () => {
    let calls = 0;
    const transport = new RecordingTransport(async () => { calls++; throw new TransportFailure(false, "offline"); });
    await expect(client(transport).request("POST", "/v1/projects", { name: "one", root: "/work" }, new URLSearchParams(), key)).rejects.toMatchObject({ code: "DAEMON_UNAVAILABLE" });
    expect(calls).toBe(2);
  });

  test("rolls back an escape-heavy oversized outcome so the same mutation key can retry", async () => {
    const directory = mkdtempSync("/tmp/orchestrator-idempotency-");
    const db = openIsolatedTestSqliteDatabase(join(directory, "state.db"));
    const clock = { now: () => "2026-01-02T03:04:05.678Z" };
    const service = new OrchestratorService({
      projects: db.projects,
      tasks: db.tasks,
      history: db.history,
      unitOfWork: db,
      paths: new SystemPathCanonicalizer(() => directory),
      clock,
      ids: { next: () => "33333333-3333-4333-8333-333333333333" },
    });
    const idempotency = new IdempotencyService({ clock, unitOfWork: db, instanceId: "44444444-4444-4444-8444-444444444444" });
    const oversized = `${JSON.stringify({ ok: true, data: { escaped: "\\".repeat(Math.ceil(MAX_RESPONSE_BYTES / 2) + 1) } })}\n`;
    expect(new TextEncoder().encode(oversized).byteLength).toBeGreaterThan(MAX_RESPONSE_BYTES);
    let returnOversized = true;
    const server = createDaemonServer({
      health: () => ({ ready: true }),
      dispatch: ({ idempotency: context }) => {
        if (context === null) throw new Error("missing idempotency context");
        return idempotency.execute(context, () => {
          service.addProject("project", directory);
          return returnOversized ? { status: 201, bodyText: oversized } : { status: 201, bodyText: '{"ok":true}\n' };
        });
      },
    });
    try {
      const rejected = await server.fetch(mutationRequest({ name: "project", root: directory }));
      expect(rejected.status).toBe(413);
      expect(await rejected.json()).toMatchObject({ ok: false, error: { code: "RESPONSE_TOO_LARGE" } });
      expect(db.projects.list()).toEqual([]);
      expect(db.idempotency.get(key)).toBeNull();

      returnOversized = false;
      const retried = await server.fetch(mutationRequest({ name: "project", root: directory }));
      expect(retried.status).toBe(201);
      expect(db.projects.list()).toHaveLength(1);
      expect(db.idempotency.get(key)).toMatchObject({ state: "completed" });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("bounds a corrupted oversized stored outcome at the server boundary", async () => {
    const oversized = `${JSON.stringify({ ok: true, data: { escaped: "\\".repeat(Math.ceil(MAX_RESPONSE_BYTES / 2) + 1) } })}\n`;
    expect(new TextEncoder().encode(oversized).byteLength).toBeGreaterThan(MAX_RESPONSE_BYTES);
    const server = createDaemonServer({
      health: () => ({ ready: true }),
      dispatch: () => ({ status: 201, bodyText: oversized }),
    });
    const response = await server.fetch(mutationRequest({ name: "project", root: "/work" }));
    expect(response.status).toBe(413);
    const body = await response.text();
    expect(JSON.parse(body)).toMatchObject({ ok: false, error: { code: "RESPONSE_TOO_LARGE" } });
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  });
});
