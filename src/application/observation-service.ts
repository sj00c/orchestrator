import { applicationError } from "./errors.ts";
import { classifyEvidence, type EvidenceIngestResult, type ObservedEvidence } from "../domain/evidence.ts";
import type { Task } from "../domain/model.ts";
import type { EvidenceQueries, TaskQueries } from "../ports/repositories.ts";
import type { UnitOfWork } from "../ports/unit-of-work.ts";
import { ALLOWED_OBSERVED_TO } from "../domain/transitions.ts";

export interface ObservationDependencies {
  evidence: EvidenceQueries;
  tasks: TaskQueries;
  unitOfWork: UnitOfWork;
}

/** Ingests observer facts without coupling observed state to planned state. */
export class ObservationService {
  constructor(private readonly deps: ObservationDependencies) {}

  ingest(evidence: ObservedEvidence): EvidenceIngestResult {
    validateEvidence(evidence);
    const existing = this.deps.evidence.get(evidence.source, evidence.evidenceId);
    const head = this.deps.evidence.getHead(evidence.taskId);
    const classified = classifyEvidence(evidence, existing, head);
    if (classified.kind === "conflict") throw applicationError("EVIDENCE_CONFLICT", "Evidence identifier was reused with different content.", { source: evidence.source, evidenceId: evidence.evidenceId });
    return this.deps.unitOfWork.execute((tx) => {
      if (classified.kind !== "accepted") {
        const current = tx.tasks.getById(evidence.taskId);
        if (!current) throw applicationError("NOT_FOUND", "Task was not found.", { resource: "task" });
        return tx.projects.ingestEvidence(evidence, current, null);
      }
      const current = tx.tasks.getById(evidence.taskId);
      if (!current) throw applicationError("NOT_FOUND", "Task was not found.", { resource: "task" });
      if (!ALLOWED_OBSERVED_TO[current.observedState].includes(evidence.targetState)) {
        throw applicationError("VALIDATION_ERROR", "Observed-state transition is invalid.", { field: "targetState", reason: "invalid_transition" });
      }
      // The ledger owns the final dedupe/order decision.  An accepted fact is
      // always mapped atomically to current plus its event, even when the
      // observed value is unchanged.
      const next = observed(current, evidence.targetState, evidence.capturedAt);
      return tx.projects.ingestEvidence(evidence, current, next);
    });
  }
}

function observed(task: Task, observedState: Task["observedState"], at: string): Task {
  return { ...task, observedState, version: task.version + 1, updatedAt: at };
}
function validateEvidence(evidence: ObservedEvidence): void {
  if (!evidence.source || !evidence.evidenceId || !evidence.canonicalHash || !evidence.taskId || !Number.isInteger(evidence.sourceSequence) || evidence.sourceSequence < 0 || !Number.isFinite(Date.parse(evidence.capturedAt))) {
    throw applicationError("VALIDATION_ERROR", "Evidence is invalid.", { field: "evidence", reason: "invalid" });
  }
}
