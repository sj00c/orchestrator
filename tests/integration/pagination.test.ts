import { describe, expect, test } from "bun:test";
import { MAX_RESPONSE_BYTES } from "../../src/api/v1/contract.ts";
import { buildBoundedPage } from "../../src/api/v1/pagination.ts";
import { reconstructStatus } from "../../src/client/daemon-client.ts";
import type { StatusFlatRecord } from "../../src/api/v1/contract.ts";
import type { CountsV1, TaskV1 } from "../../src/domain/model.ts";

const counts = (): CountsV1 => ({ planned: { planned: 0, ready: 0, active: 0, paused: 0, blocked: 0, done: 0, canceled: 0 }, observed: { unknown: 0, idle: 0, running: 0, succeeded: 0, failed: 0, stale: 0 } });
const envelope = (items: readonly { id: string; text: string }[], nextCursor: string | null) => ({ ok: true, data: { items, nextCursor }, meta: { command: "project list", schemaVersion: 1 } });

describe("serialized pagination and status reconstruction", () => {
  test("uses final UTF-8 envelope bytes, leaves the overflowing record for its cursor, and rejects a huge first row", () => {
    const escaped = { id: "one", text: "\\\"\n".repeat(16) };
    const first = buildBoundedPage({ resource: "project", records: [escaped, { id: "two", text: "x".repeat(100) }], maxBytes: 300, keyOf: (row) => row.id, encodeCursor: (key) => `cursor:${key}`, envelope, serialize: JSON.stringify, recordId: (row) => row.id });
    expect(first.records).toEqual([escaped]);
    expect(first.nextCursor).toBe("cursor:one");
    expect(first.serializedBytes).toBeLessThanOrEqual(300);
    expect(() => buildBoundedPage({ resource: "project", records: [{ id: "huge", text: "é".repeat(MAX_RESPONSE_BYTES) }], keyOf: (row) => row.id, encodeCursor: (key) => key, envelope, serialize: JSON.stringify, recordId: (row) => row.id })).toThrow(/single response record/i);
  });

  test("reconstructs task-flat pages without carrying a project task array in each page record", () => {
    const task = (id: string, projectId: string): TaskV1 => ({ id, projectId, title: id, description: null, plannedState: "ready", observedState: "idle", blockedReason: null, version: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", startedAt: null, finishedAt: null });
    const increment = counts(); increment.planned.ready = 1; increment.observed.idle = 1;
    const records: StatusFlatRecord[] = [
      { project: { id: "p1", name: "one", rootPath: "/tmp/one", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", version: 1 }, countsFragment: counts(), task: null, projectDone: false },
      { project: null, countsFragment: increment, task: task("t1", "p1"), projectDone: false },
      { project: null, countsFragment: increment, task: task("t2", "p1"), projectDone: true },
    ];
    const result = reconstructStatus(records);
    expect(result).toHaveLength(1);
    expect(result[0]!.tasks.map((item) => item.id)).toEqual(["t1", "t2"]);
    expect(result[0]!.counts.planned.ready).toBe(2);
    expect(() => reconstructStatus([...records, records[1]!])).toThrow(/task record before project metadata|invalid task record/);
  });
});
