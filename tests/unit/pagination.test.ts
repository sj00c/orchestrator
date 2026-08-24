import { describe, expect, test } from "bun:test";
import { MAX_PAGE_ROWS } from "../../src/api/v1/contract.ts";
import { buildBoundedPage, createCursor, parseCursor } from "../../src/api/v1/pagination.ts";

const page = (records: readonly { id: string; text: string }[], maxBytes: number, limit?: number) => buildBoundedPage({
  resource: "task",
  records,
  limit,
  maxBytes,
  keyOf: (record) => record.id,
  encodeCursor: (key) => `cursor:${key}`,
  envelope: (items, nextCursor) => ({ items, nextCursor }),
  serialize: JSON.stringify,
  recordId: (record) => record.id,
});
function thrown(action: () => unknown): unknown {
  try { action(); } catch (error) { return error; }
  throw new Error("Expected action to throw.");
}

describe("bounded pagination", () => {
  test("keeps a row when the final newline makes the envelope exactly the byte limit", () => {
    const record = { id: "one", text: "한" };
    const exact = new TextEncoder().encode(`${JSON.stringify({ items: [record], nextCursor: null })}\n`).byteLength;
    const result = page([record], exact);
    expect(result).toMatchObject({ records: [record], nextCursor: null, serializedBytes: exact });
  });

  test("uses UTF-8 bytes rather than JavaScript character counts and cursorizes the last emitted row", () => {
    const first = { id: "first", text: "😀" };
    const second = { id: "second", text: "é".repeat(64) };
    const oneRowBytes = new TextEncoder().encode(`${JSON.stringify({ items: [first], nextCursor: "cursor:first" })}\n`).byteLength;
    const result = page([first, second], oneRowBytes);
    expect(result.records).toEqual([first]);
    expect(result.nextCursor).toBe("cursor:first");
    expect(result.serializedBytes).toBe(oneRowBytes);
  });

  test("rejects a huge first record rather than returning an empty successful page", () => {
    const huge = { id: "huge", text: "x".repeat(1_048_577) };
    expect(thrown(() => page([huge], 1_048_576))).toMatchObject({ code: "RESPONSE_TOO_LARGE", details: { resource: "task", recordId: "huge", maxBytes: 1_048_576 } });
  });

  test("enforces row limits independently of available response bytes", () => {
    const records = Array.from({ length: MAX_PAGE_ROWS + 1 }, (_, index) => ({ id: String(index), text: "x" }));
    const result = page(records, 10_000_000, MAX_PAGE_ROWS);
    expect(result.records).toHaveLength(MAX_PAGE_ROWS);
    expect(result.nextCursor).toBe(`cursor:${MAX_PAGE_ROWS - 1}`);
  });

  test("rejects malformed, tampered, mismatched, and expired cursors", () => {
    const secret = "cursor-secret";
    const payload = { key: 3, filterFingerprint: "filter", routeSchema: "status.v1", expiresAt: 2_000 };
    const cursor = createCursor(payload, secret);
    expect(parseCursor<number>(cursor, secret, { filterFingerprint: "filter", routeSchema: "status.v1" }, 2_000)).toBe(3);
    for (const value of ["bad", `${cursor}x`]) expect(thrown(() => parseCursor(value, secret, { filterFingerprint: "filter", routeSchema: "status.v1" }, 1_000))).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(thrown(() => parseCursor(cursor, secret, { filterFingerprint: "other", routeSchema: "status.v1" }, 1_000))).toMatchObject({ details: { reason: "mismatch" } });
    expect(thrown(() => parseCursor(cursor, secret, { filterFingerprint: "filter", routeSchema: "status.v1" }, 2_001))).toMatchObject({ details: { reason: "expired" } });
  });
});
