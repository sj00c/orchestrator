import type { Clock, ExecutionAttempt, ObservedState } from "../domain/model.ts";
import type { ObservedEvidence } from "../domain/evidence.ts";

export interface ObserverPort { readonly source: string; observe(at: string): readonly ObservedEvidence[] | Promise<readonly ObservedEvidence[]>; }
export interface EvidenceSink { ingest(evidence: ObservedEvidence): unknown | Promise<unknown>; }
export interface AttemptObservationInput { evidence: Omit<ObservedEvidence, "targetState">; attempt: Pick<ExecutionAttempt, "state">; }

/** Deterministic, asynchronous observer producer registry. */
export class ObserverRegistry {
  private readonly observers = new Map<string, ObserverPort>();
  register(observer: ObserverPort): void { if (!observer.source) throw new RangeError("Observer source is required"); if (this.observers.has(observer.source)) throw new RangeError(`Observer source is already registered: ${observer.source}`); this.observers.set(observer.source, observer); }
  unregister(source: string): boolean { return this.observers.delete(source); }
  async poll(clock: Clock, sink: EvidenceSink): Promise<number> {
    const capturedAt = clock.now(); let ingested = 0;
    for (const observer of [...this.observers.values()].sort((a, b) => a.source.localeCompare(b.source))) {
      const evidence = await observer.observe(capturedAt);
      for (const item of evidence) { if (item.source !== observer.source) throw new RangeError("Observer returned evidence for another source"); await sink.ingest(item); ingested++; }
    }
    return ingested;
  }
  async observeAttempt(input: AttemptObservationInput, sink: EvidenceSink): Promise<void> {
    const targets = observedStatesFor(input.attempt.state);
    let sourceSequence = input.evidence.sourceSequence;
    for (const [index, targetState] of targets.entries()) {
      await sink.ingest({
        ...input.evidence,
        evidenceId: targets.length === 1 ? input.evidence.evidenceId : `${input.evidence.evidenceId}:${index + 1}`,
        canonicalHash: input.evidence.canonicalHash,
        sourceSequence,
        targetState,
      });
      sourceSequence++;
    }
  }
}

function observedStatesFor(state: ExecutionAttempt["state"]): readonly ObservedState[] {
  switch (state) {
    case "running": case "stopping": return ["running"];
    case "succeeded": return ["succeeded"];
    case "failed": return ["failed"];
    case "lost": return ["stale"];
    case "stopped": return ["unknown", "idle"];
    case "queued": case "claimed": case "skipped": case "runner_launching": case "runner_ready": return [];
  }
}
