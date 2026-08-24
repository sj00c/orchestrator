export interface ShutdownProducer { cancel(): void | Promise<void>; }
export interface ShutdownRunner { stopAll(graceMs: number): void | Promise<void>; }
export interface ShutdownBarrierDependencies {
  beginDraining(): void | Promise<void>;
  producers: readonly ShutdownProducer[];
  closeAdmission(): void;
  advanceGeneration(): void;
  waitForInflight(deadline: number): Promise<void>;
  runner: ShutdownRunner;
  runnerGraceMs: number;
  reconcileAfterRunnerStop(): void | Promise<void>;
  terminalHeartbeat(): void | Promise<void>;
  closeDatabase(): void | Promise<void>;
  cleanupSocket(): void | Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}

/** Serializes shutdown so no cancelled producer can commit after draining starts. */
export class ShutdownBarrier {
  private closing: Promise<void> | null = null;

  constructor(private readonly deps: ShutdownBarrierDependencies) {}

  close(): Promise<void> {
    this.closing ??= this.run();
    return this.closing;
  }

  private async run(): Promise<void> {
    const now = this.deps.now ?? Date.now;
    const deadline = now() + (this.deps.timeoutMs ?? 20_000);
    let failure: unknown;
    const attempt = async (operation: () => void | Promise<void>): Promise<void> => {
      try { await within(Promise.resolve(operation()), deadline, now); } catch (error) { failure ??= error; }
    };
    await attempt(() => this.deps.beginDraining());
    try { this.deps.closeAdmission(); } catch (error) { failure ??= error; }
    try { this.deps.advanceGeneration(); } catch (error) { failure ??= error; }
    await attempt(() => Promise.all(this.deps.producers.map((producer) => producer.cancel())).then(() => undefined));
    await attempt(() => this.deps.waitForInflight(deadline));
    await attempt(() => this.deps.runner.stopAll(Math.max(0, Math.min(this.deps.runnerGraceMs, deadline - now()))));
    await attempt(() => this.deps.reconcileAfterRunnerStop());
    await attempt(() => this.deps.terminalHeartbeat());
    await attempt(() => this.deps.closeDatabase());
    await attempt(() => this.deps.cleanupSocket());
    if (failure) throw failure;
  }
}

async function within<T>(operation: Promise<T>, deadline: number, now: () => number): Promise<T> {
  const remaining = deadline - now();
  if (remaining <= 0) throw new Error("Daemon shutdown deadline exceeded");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Daemon shutdown deadline exceeded")), remaining); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
