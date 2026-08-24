import { describe, expect, test } from "bun:test";
import { classifyEvidence, compareEvidenceOrder, evidenceHead, type ObservedEvidence, type StoredEvidence } from "../../src/domain/evidence.ts";

const base: ObservedEvidence = {
  id: "11111111-1111-4111-8111-111111111111", source: "observer", evidenceId: "event-1", canonicalHash: "a".repeat(64),
  taskId: "22222222-2222-4222-8222-222222222222", attemptId: null, capturedAt: "2026-01-02T03:04:05.000Z", sourceSequence: 7, targetState: "running", createdAt: "2026-01-02T03:04:06.000Z",
};
const stored = (overrides: Partial<StoredEvidence> = {}): StoredEvidence => ({ ...base, outcome: "applied", aggregateVersion: 4, ...overrides });

describe("evidence ledger ordering", () => {
  test("accepts a new evidence identity and reconstructs its durable ordering head", () => {
    expect(classifyEvidence(base, null, null)).toEqual({ kind: "accepted", evidence: base });
    expect(evidenceHead(base)).toEqual({ taskId: base.taskId, lastCapturedAt: base.capturedAt, lastSourceSequence: 7, lastSource: "observer", lastEvidenceId: "event-1" });
  });

  test("recognizes only byte-identical replays as duplicates and fails closed on identity conflicts", () => {
    expect(classifyEvidence(base, stored(), evidenceHead(base))).toMatchObject({ kind: "duplicate", evidence: { aggregateVersion: 4 } });
    const conflict = classifyEvidence({ ...base, canonicalHash: "b".repeat(64), targetState: "failed" }, stored(), evidenceHead(base));
    expect(conflict).toMatchObject({ kind: "conflict", existing: { canonicalHash: "a".repeat(64) } });
  });

  test("retains stale evidence without allowing it to replace the head", () => {
    const head = evidenceHead(base);
    for (const evidence of [
      { ...base, id: "3", evidenceId: "event-2", capturedAt: "2026-01-02T03:04:04.999Z", sourceSequence: 99 },
      { ...base, id: "4", evidenceId: "event-2", sourceSequence: 6 },
      { ...base, id: "5", evidenceId: "event-0" },
    ]) expect(classifyEvidence(evidence, null, head)).toEqual({ kind: "stale", evidence });
  });

  test("orders capture time, source sequence, source, then evidence identity deterministically", () => {
    const head = evidenceHead(base);
    expect(compareEvidenceOrder({ ...base, capturedAt: "2026-01-02T03:04:05.001Z" }, head)).toBe(1);
    expect(compareEvidenceOrder({ ...base, sourceSequence: 8 }, head)).toBe(1);
    expect(compareEvidenceOrder({ ...base, source: "z-observer" }, head)).toBe(1);
    expect(compareEvidenceOrder({ ...base, evidenceId: "event-9" }, head)).toBe(1);
    expect(compareEvidenceOrder(base, head)).toBe(0);
  });
});
