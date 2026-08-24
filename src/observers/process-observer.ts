import { createHash } from "node:crypto";
import type { ObservedEvidence } from "../domain/evidence.ts";
import type { Clock, ExecutionAttempt, ObservedState, ProcessIdentity as StoredProcessIdentity, Task } from "../domain/model.ts";
import type { ProcessIdentity, ProcessInspector } from "../ports/process-inspector.ts";
import type { ObserverAdapter } from "../ports/observer.ts";

export interface ProcessObserverDependencies {
  clock: Clock;
  inspector: Pick<ProcessInspector, "inspect">;
  attempts(): readonly ExecutionAttempt[] | Promise<readonly ExecutionAttempt[]>;
  task(taskId: string): Pick<Task, "observedState"> | null | Promise<Pick<Task, "observedState"> | null>;
  source?: string;
}

/**
 * Converts durable attempt records and OS process identities into evidence.
 * It deliberately records only state and opaque identity fingerprints: process
 * argv and environment are neither read nor included in evidence.
 */
export class ProcessObserver implements ObserverAdapter {
  readonly source: string;

  constructor(private readonly deps: ProcessObserverDependencies) {
    this.source = deps.source ?? "process";
    if (!this.source) throw new RangeError("Observer source is required");
  }

  async poll(): Promise<readonly ObservedEvidence[]> {
    const capturedAt = this.deps.clock.now();
    const attempts = await this.deps.attempts();
    const evidence: ObservedEvidence[] = [];
    for (const attempt of [...attempts].sort((left, right) => left.id.localeCompare(right.id))) {
      const observations = await this.observeAttempt(attempt);
      for (const [index, observation] of observations.entries()) {
        const canonical = canonicalObservation(attempt, observation);
        const canonicalHash = digest(canonical);
        evidence.push({
          id: `process:${canonicalHash}`,
          source: this.source,
          evidenceId: `attempt:${attempt.id}:${observation.state}:${canonicalHash.slice(0, 24)}`,
          canonicalHash,
          taskId: attempt.taskId,
          attemptId: attempt.id,
          capturedAt,
          sourceSequence: attempt.attemptNo * 100 + stateRank(attempt.state) * 2 + index,
          targetState: observation.state,
          createdAt: capturedAt,
        });
      }
    }
    return evidence;
  }

  private async observeAttempt(attempt: ExecutionAttempt): Promise<AttemptObservation[]> {
    if (attempt.state === "succeeded") return [{ state: "succeeded", runner: "not_checked", child: "not_checked" }];
    if (attempt.state === "failed") return [{ state: "failed", runner: "not_checked", child: "not_checked" }];
    if (attempt.state === "lost") return [{ state: "stale", runner: "not_checked", child: "not_checked" }];
    if (attempt.state === "stopped") return [
      { state: "unknown", runner: "not_checked", child: "not_checked" },
      { state: "idle", runner: "not_checked", child: "not_checked" },
    ];
    if (attempt.state === "queued" || attempt.state === "claimed" || attempt.state === "skipped" || attempt.state === "runner_ready") return [];

    const [runner, child] = await Promise.all([this.identityState(attempt.runner), this.identityState(attempt.child)]);
    if (runner === "match" || child === "match") {
      const task = await this.deps.task(attempt.taskId);
      if (attempt.state === "running" && (task?.observedState === "succeeded" || task?.observedState === "failed")) {
        return [{ state: "stale", runner, child }, { state: "running", runner, child }];
      }
      return [{ state: "running", runner, child }];
    }
    if (runner === "unavailable" || child === "unavailable") return [{ state: "unknown", runner, child }];
    return [{ state: "stale", runner, child }];
  }

  private async identityState(expected: StoredProcessIdentity | null): Promise<IdentityState> {
    if (expected === null) return "absent";
    try {
      const actual = await this.deps.inspector.inspect(expected.pid);
      return actual !== null && matchesStoredIdentity(expected, actual) ? "match" : "mismatch";
    } catch {
      return "unavailable";
    }
  }
}

type IdentityState = "absent" | "match" | "mismatch" | "unavailable" | "not_checked";
interface AttemptObservation { state: ObservedState; runner: IdentityState; child: IdentityState; }

function matchesStoredIdentity(expected: StoredProcessIdentity, actual: ProcessIdentity): boolean {
  return expected.pid === actual.pid
    && expected.pgid === actual.pgid
    && secondTimestamp(expected.startedAt) === secondTimestamp(actual.startedAt)
    && actual.executable !== undefined
    && digest(expected.executableIdentity) === digest(actual.executable);
}
function secondTimestamp(value: string): string | null {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(Math.floor(milliseconds / 1000) * 1000).toISOString() : null;
}
function canonicalObservation(attempt: ExecutionAttempt, observation: AttemptObservation): string {
  return JSON.stringify({
    attemptId: attempt.id,
    attemptState: attempt.state,
    child: observation.child,
    childIdentity: attempt.child === null ? null : digest(attempt.child.executableIdentity),
    runner: observation.runner,
    runnerIdentity: attempt.runner === null ? null : digest(attempt.runner.executableIdentity),
    state: observation.state,
    taskId: attempt.taskId,
  });
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function stateRank(state: ExecutionAttempt["state"]): number {
  switch (state) {
    case "queued": return 0;
    case "claimed": return 1;
    case "runner_launching": return 2;
    case "runner_ready": return 3;
    case "running": return 4;
    case "stopping": return 5;
    case "succeeded": return 6;
    case "failed": return 7;
    case "stopped": return 8;
    case "skipped": return 9;
    case "lost": return 10;
  }
}
