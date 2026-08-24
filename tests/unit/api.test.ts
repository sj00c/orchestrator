import { describe, expect, test } from "bun:test";
import { ApplicationError, applicationError } from "../../src/application/errors.ts";
import { canonicalJson, canonicalRequestHash, isLowercaseUuid, normalizedQuery } from "../../src/api/v1/contract.ts";
import { HTTP_STATUS, httpError, resolveRoute, validateMutationBody, validateRouteInput } from "../../src/api/v1/routes.ts";
import { DaemonClient, TransportFailure, type DaemonTransport } from "../../src/client/daemon-client.ts";

function validation(action: () => unknown, field: string, reason: string): void {
  expect(action).toThrow(ApplicationError);
  try { action(); } catch (error) {
    expect(error).toMatchObject({ code: "VALIDATION_ERROR", details: { field, reason } });
  }
}

describe("v1 API validation and canonical request hashing", () => {
  test.each([
    [{ schemaVersion: 1, data: {} }, {}],
    [{ schemaVersion: 1, data: { title: "x" } }, { title: "x" }],
  ])("accepts exact mutation envelope %p", (body, expected) => {
    expect(validateMutationBody(body)).toEqual(expected);
  });

  test.each([
    [{}, "body", "invalid_envelope"],
    [{ schemaVersion: 2, data: {} }, "body", "invalid_envelope"],
    [{ schemaVersion: 1, data: null }, "body", "invalid_envelope"],
    [{ schemaVersion: 1, data: {}, extra: true }, "body", "invalid_envelope"],
  ])("rejects malformed mutation envelope %#", (body, field, reason) => validation(() => validateMutationBody(body), field, reason));

  test.each([
    ["project.add", new URLSearchParams(), { schemaVersion: 1, data: { name: " ", root: "/work" } }, "name", "required"],
    ["task.transition", new URLSearchParams(), { schemaVersion: 1, data: { type: "block", reason: "" } }, "reason", "required"],
    ["schedule.add", new URLSearchParams(), { schemaVersion: 1, data: { taskId: "t", definitionId: "d", definitionVersion: 1, kind: "interval", runAt: "2026-01-01T00:00:00.000Z" } }, "intervalSeconds", "required_for_interval"],
    ["task.list", new URLSearchParams("limit=0"), undefined, "limit", "out_of_range"],
    ["task.list", new URLSearchParams("limit=1&limit=2"), undefined, "limit", "duplicate"],
    ["task.list", new URLSearchParams("unexpected=x"), undefined, "unexpected", "unknown_query_parameter"],
    ["task.list", new URLSearchParams("plannedState=donee"), undefined, "plannedState", "invalid_value"],
  ] as const)("rejects invalid route input %#", (name, query, body, field, reason) => {
    const route = resolveRoute(name === "task.list" ? "GET" : "POST", name === "task.list" ? "/v1/tasks" : name === "project.add" ? "/v1/projects" : name === "task.transition" ? "/v1/tasks/t/transitions" : "/v1/schedules");
    validation(() => validateRouteInput(route, query, body), field, reason);
  });

  test("normalizes query order and hashes canonical data bytes", () => {
    expect(normalizedQuery([["z", "two words"], ["a", "!"]])).toBe("a=%21&z=two%20words");
    expect(canonicalJson({ z: 1, a: ["x", null] })).toBe('{"a":["x",null],"z":1}');
    expect(canonicalRequestHash("post", "/v1/projects", [["z", "two words"], ["a", "!"]], { z: 1, a: ["x", null] })).toBe("7624383ebeae08faed9dcf67e0f73486ad0915ecc66b3b64900aece129383464");
    expect(canonicalRequestHash("POST", "/v1/tasks", [], { title: "café", project: "p" })).toBe("9165393501554c9da841906b3bfa8d62f68fb623734474d0a9511e69640a6549");
    expect(() => canonicalJson(Number.NaN)).toThrow("non-finite");
  });

  test("maps application and unknown errors to externally stable HTTP responses", () => {
    for (const [code, status] of Object.entries(HTTP_STATUS)) {
      const error = applicationError(code as keyof typeof HTTP_STATUS, "x", {} as never);
      expect(httpError("command", error).status).toBe(status);
    }
    expect(httpError("command", applicationError("IDEMPOTENCY_IN_PROGRESS", "x", { idempotencyKey: "k", retryAfterSeconds: 1 })).headers).toEqual({ "Retry-After": "1" });
    expect(httpError("command", new Error("internal"))).toMatchObject({ status: 500, body: { ok: false, error: { code: "STORAGE_ERROR" } } });
    const nativeWithCode = Object.assign(new Error("native"), { code: "NOT_FOUND" });
    expect(httpError("command", nativeWithCode)).toMatchObject({ status: 500, body: { ok: false, error: { code: "STORAGE_ERROR" } } });
    const invalidApplicationError = applicationError("NOT_FOUND", "x", { resource: "project" });
    Object.assign(invalidApplicationError, { code: "not-a-code" });
    expect(httpError("command", invalidApplicationError)).toMatchObject({ status: 500, body: { ok: false, error: { code: "STORAGE_ERROR" } } });
  });

  test.each([
    [false, "DAEMON_UNAVAILABLE", 2],
    [true, "UNKNOWN_OUTCOME", 1],
  ])("maps a final mutation transport failure sent=%s to %s", async (sent, code, expectedCalls) => {
    let calls = 0;
    const transport: DaemonTransport = { request: async () => { calls++; throw new TransportFailure(sent, "offline"); } };
    const client = new DaemonClient({
      endpoint: { socketPath: "/tmp/orchestrator.sock", configPath: "/tmp/config.json", configFingerprint: "fingerprint", source: "socket" },
      transport,
      ids: () => "11111111-1111-4111-8111-111111111111",
    });
    await expect(client.request("POST", "/v1/projects", { name: "one", root: "/work" })).rejects.toMatchObject({ code });
    expect(calls).toBe(expectedCalls);
  });

  test.each(["11111111-1111-4111-8111-111111111111", "11111111-1111-4111-b111-111111111111"])("accepts lowercase UUIDv4 key %s", (value) => expect(isLowercaseUuid(value)).toBe(true));
  test.each(["11111111-1111-5111-8111-111111111111", "11111111-1111-4111-7111-111111111111", "11111111-1111-4111-8111-11111111111A"])("rejects non-v4 lowercase UUID key %s", (value) => expect(isLowercaseUuid(value)).toBe(false));
});
