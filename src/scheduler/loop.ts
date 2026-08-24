import type { Clock } from "../domain/model.ts";
import type { ExecutionService } from "../application/execution-service.ts";
import type { ObservationService } from "../application/observation-service.ts";
import type { SchedulingService } from "../application/scheduling-service.ts";
import type { ObserverRegistry } from "../observers/registry.ts";

export interface TimerPort { setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(handle: unknown): void; }
export interface DaemonLoopDependencies { clock: Clock; timer: TimerPort; scheduling: SchedulingService; execution: ExecutionService; observations: ObservationService; observers: ObserverRegistry; tickSeconds: number; dueBatchLimit: number; claimBatchLimit: number; monotonicNow?: () => number; jitterMs?: () => number; }

/** Fixed-grid, generation-fenced producer loop with explicit drain completion. */
export class DaemonLoop {
  private handle: unknown | null = null;
  private nextGridMillis: number | null = null;
  private generation = 0;
  private active: Promise<void> = Promise.resolve();
  private wallMillis: number | null = null;
  private monotonicMillis: number | null = null;
  constructor(private readonly deps: DaemonLoopDependencies) { if (!Number.isInteger(deps.tickSeconds) || deps.tickSeconds <= 0 || !Number.isInteger(deps.dueBatchLimit) || deps.dueBatchLimit <= 0 || !Number.isInteger(deps.claimBatchLimit) || deps.claimBatchLimit <= 0) throw new RangeError("Invalid loop configuration"); }
  start(): void { if (this.handle !== null || this.nextGridMillis !== null) return; const now = this.wallNow(); this.nextGridMillis = now; this.wallMillis = now; this.monotonicMillis = this.monotonicNow(); const generation = ++this.generation; this.run(generation, true); }
  async stop(): Promise<void> { ++this.generation; if (this.handle !== null) this.deps.timer.clearTimeout(this.handle); this.handle = null; this.nextGridMillis = null; await this.active; await this.deps.execution.drain(); }
  completion(): Promise<void> { return this.active; }
  async tick(): Promise<void> { await this.produce(this.generation, false); }
  private run(generation: number, recover: boolean): void { this.active = this.produce(generation, recover).finally(() => { if (generation === this.generation && this.nextGridMillis !== null) this.schedule(generation); }); }
  private async produce(generation: number, recover: boolean): Promise<void> {
    if (generation !== this.generation) return;
    const wall = this.wallNow(); const monotonic = this.monotonicNow();
    const gap = this.wallMillis !== null && this.monotonicMillis !== null && Math.abs((wall - this.wallMillis) - (monotonic - this.monotonicMillis)) > 2_000;
    this.wallMillis = wall; this.monotonicMillis = monotonic;
    if (recover || gap) await this.deps.execution.recover(this.deps.claimBatchLimit);
    for (let batch = 0; batch < 10 && generation === this.generation; batch++) {
      const due = this.deps.scheduling.tick(Math.min(100, this.deps.dueBatchLimit));
      await this.deps.execution.dispatch(Math.min(100, this.deps.claimBatchLimit));
      await this.deps.execution.reconcile(Math.min(100, this.deps.claimBatchLimit));
      if (batch === 0) await this.deps.observers.poll(this.deps.clock, this.deps.observations);
      if (due < Math.min(100, this.deps.dueBatchLimit)) break;
      await this.yieldWithJitter();
    }
  }
  private schedule(generation: number): void { if (this.nextGridMillis === null) return; const now = this.wallNow(); const interval = this.deps.tickSeconds * 1_000; while (this.nextGridMillis <= now) this.nextGridMillis += interval; this.handle = this.deps.timer.setTimeout(() => { this.handle = null; if (generation === this.generation) this.run(generation, false); }, Math.max(0, this.nextGridMillis - now)); }
  private wallNow(): number { const value = Date.parse(this.deps.clock.now()); if (!Number.isFinite(value)) throw new RangeError("Clock returned an invalid timestamp"); return value; }
  private monotonicNow(): number { const value = this.deps.monotonicNow?.() ?? performance.now(); if (!Number.isFinite(value)) throw new RangeError("Monotonic clock returned an invalid time"); return value; }
  private async yieldWithJitter(): Promise<void> { const delay = Math.max(0, this.deps.jitterMs?.() ?? 0); await new Promise<void>((resolve) => { this.deps.timer.setTimeout(resolve, delay); }); }
}
