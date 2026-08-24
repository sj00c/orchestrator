import type { Clock, Daemon, DaemonPhase, Uuid } from "../domain/model.ts";
import type { UnitOfWork } from "../ports/unit-of-work.ts";

export interface DaemonLifecycleDependencies {
  clock: Clock;
  unitOfWork: UnitOfWork;
  instanceId: Uuid;
  version: string;
  configFingerprint: string;
}

/** Durable lifecycle record used by health checks and crash recovery. */
export class DaemonLifecycle {
  private phase: DaemonPhase = "starting";
  private started = false;
  private startedAt: string | null = null;

  constructor(private readonly deps: DaemonLifecycleDependencies) {}

  start(): Daemon {
    if (this.started) return this.snapshot();
    this.started = true;
    this.startedAt = this.deps.clock.now();
    this.persist("starting");
    return this.snapshot();
  }

  ready(): Daemon {
    this.requireStarted();
    this.persist("ready");
    return this.snapshot();
  }

  drain(): Daemon {
    this.requireStarted();
    this.persist("draining");
    return this.snapshot();
  }

  stop(): Daemon {
    if (!this.started) return this.snapshot();
    this.persist("stopped");
    return this.snapshot();
  }

  heartbeat(): Daemon {
    this.requireStarted();
    const at = this.deps.clock.now();
    this.deps.unitOfWork.execute((tx) => {
      if (!tx.projects.heartbeat(this.deps.instanceId, at)) tx.projects.upsertDaemon(this.record(at));
    });
    return this.snapshot(at);
  }

  snapshot(at = this.deps.clock.now()): Daemon {
    return this.record(at);
  }

  private persist(phase: DaemonPhase): void {
    this.phase = phase;
    const at = this.deps.clock.now();
    this.deps.unitOfWork.execute((tx) => tx.projects.upsertDaemon(this.record(at)));
  }

  private record(at: string): Daemon {
    return { instanceId: this.deps.instanceId, version: this.deps.version, phase: this.phase, startedAt: this.startedAt ?? at, heartbeatAt: at, configFingerprint: this.deps.configFingerprint };
  }

  private requireStarted(): void {
    if (!this.started) throw new Error("Daemon lifecycle has not started");
  }
}
