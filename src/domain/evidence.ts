import type { CanonicalTimestamp, ObservedState, Uuid } from "./model.ts";

export interface ObservedEvidence {
  id: Uuid;
  source: string;
  evidenceId: string;
  canonicalHash: string;
  taskId: Uuid;
  attemptId: Uuid | null;
  capturedAt: CanonicalTimestamp;
  sourceSequence: number;
  targetState: ObservedState;
  createdAt: CanonicalTimestamp;
}

export interface ObservedEvidenceHead {
  taskId: Uuid;
  lastCapturedAt: CanonicalTimestamp;
  lastSourceSequence: number;
  lastSource: string;
  lastEvidenceId: string;
}

export type EvidenceOutcome = "applied" | "ignored_stale";

export interface StoredEvidence extends ObservedEvidence {
  outcome: EvidenceOutcome;
  aggregateVersion: number | null;
}

export type EvidenceIngestResult =
  | { kind: "accepted"; evidence: ObservedEvidence }
  | { kind: "duplicate"; evidence: StoredEvidence }
  | { kind: "conflict"; existing: StoredEvidence }
  | { kind: "stale"; evidence: ObservedEvidence };

/** Compares the durable per-task order specified by the evidence ledger. */
export function compareEvidenceOrder(
  evidence: Pick<ObservedEvidence, "capturedAt" | "sourceSequence" | "source" | "evidenceId">,
  head: Pick<ObservedEvidenceHead, "lastCapturedAt" | "lastSourceSequence" | "lastSource" | "lastEvidenceId">,
): number {
  const values: readonly [string | number, string | number][] = [
    [evidence.capturedAt, head.lastCapturedAt],
    [evidence.sourceSequence, head.lastSourceSequence],
    [evidence.source, head.lastSource],
    [evidence.evidenceId, head.lastEvidenceId],
  ];
  for (const [left, right] of values) {
    if (left < right) return -1;
    if (left > right) return 1;
  }
  return 0;
}

/**
 * Classifies an evidence write before persistence. Hash equality is the only
 * valid replay; a reused source/evidence id with different canonical bytes is
 * fail-closed. A non-new order is retained as stale without changing current
 * state or the head.
 */
export function classifyEvidence(
  evidence: ObservedEvidence,
  existing: StoredEvidence | null,
  head: ObservedEvidenceHead | null,
): EvidenceIngestResult {
  if (existing !== null) {
    return existing.canonicalHash === evidence.canonicalHash
      ? { kind: "duplicate", evidence: existing }
      : { kind: "conflict", existing };
  }
  if (head !== null && compareEvidenceOrder(evidence, head) <= 0) {
    return { kind: "stale", evidence };
  }
  return { kind: "accepted", evidence };
}

export function evidenceHead(evidence: ObservedEvidence): ObservedEvidenceHead {
  return {
    taskId: evidence.taskId,
    lastCapturedAt: evidence.capturedAt,
    lastSourceSequence: evidence.sourceSequence,
    lastSource: evidence.source,
    lastEvidenceId: evidence.evidenceId,
  };
}
