import { applicationError } from "./errors.ts";
import type { IdGenerator } from "./service.ts";
import { enqueueExecutionAttempt, resumeExecutionAttempt, transitionExecutionAttempt, type AttemptFence } from "../domain/execution.ts";
import type { Clock, ExecutionAttempt, ProcessIdentity, Uuid } from "../domain/model.ts";
import type { AttemptQueries, KeysetPage, QueuedAtIdKey, TransactionWritePorts } from "../ports/repositories.ts";
import type { UnitOfWork } from "../ports/unit-of-work.ts";
import { RunnerRuntimeError, type RunnerHandle, type RunnerResult, type RunnerRuntime } from "../ports/runner-runtime.ts";
import { tokenProof } from "../runner/protocol.ts";
import { OwnedJsonReadError } from "../runner/result-store.ts";
import type { ScheduleOccurrence } from "./scheduling-service.ts";

export interface AttemptRuntimeConfig { attemptDirectory(attemptId: Uuid): string; issueToken(attemptId: Uuid): string; graceMs: number; hardStopMs: number; }
export interface ExecutionDependencies { clock: Clock; ids: IdGenerator; attempts: AttemptQueries; unitOfWork: UnitOfWork; runner: RunnerRuntime; runtime: AttemptRuntimeConfig; instanceId: Uuid; leaseSeconds: number; }
export type PublicExecutionAttempt = Omit<ExecutionAttempt, "spec" | "runnerTokenHash" | "controlEndpoint">;
export type PublicExecutionAttemptPage = KeysetPage<PublicExecutionAttempt, QueuedAtIdKey>;

/** Durable coordinator: database state is committed before every runner side effect. */
export class ExecutionService {
  private readonly backgroundEffects = new Set<Promise<void>>();
  private readonly activeOperations = new Set<Promise<unknown>>();
  private generation = 0;
  private acceptingEffects = true;
  constructor(private readonly deps: ExecutionDependencies) { if (!Number.isInteger(deps.leaseSeconds) || deps.leaseSeconds <= 0 || deps.runtime.graceMs < 0 || deps.runtime.hardStopMs < deps.runtime.graceMs) throw new RangeError("Invalid execution timing configuration"); }
  enqueueScheduleOccurrence(tx: TransactionWritePorts, occurrence: ScheduleOccurrence): void { this.enqueue(tx, makeAttempt(this.deps.ids.next(), occurrence.definition, occurrence.taskId, "schedule", occurrence.queuedAt, occurrence.scheduleId, occurrence.scheduledFor, this.nextAttemptNo(occurrence.taskId))); }
  start(taskId: Uuid, definitionId: Uuid, definitionVersion: number): PublicExecutionAttempt { const now = this.deps.clock.now(); return publicAttempt(this.deps.unitOfWork.execute((tx) => { const definition = tx.projects.getDefinition(definitionId, definitionVersion); if (!definition || definition.taskId !== taskId) throw applicationError("NOT_FOUND", "Process definition was not found.", { resource: "process_definition" }); const attempt = makeAttempt(this.deps.ids.next(), definition, taskId, "manual", now, null, null, this.nextAttemptNo(taskId)); this.enqueue(tx, attempt); return attempt; })); }
  resume(attemptId: Uuid): PublicExecutionAttempt { const now = this.deps.clock.now(); return publicAttempt(this.deps.unitOfWork.execute((tx) => { const prior = tx.projects.getAttempt(attemptId); if (!prior) throw notFound(); const result = resumeExecutionAttempt(prior, { id: this.deps.ids.next(), attemptNo: this.nextAttemptNo(prior.taskId), queuedAt: now }); if (!result.ok) throw conflict(prior.taskId, prior.id, result.reason); this.enqueue(tx, result.attempt); return result.attempt; })); }
  status(attemptId: Uuid): PublicExecutionAttempt { return publicAttempt(this.getInternal(attemptId)); }
  getInternal(attemptId: Uuid): ExecutionAttempt { const attempt = this.deps.attempts.getById(attemptId); if (!attempt) throw notFound(); return attempt; }
  list(taskId?: Uuid, pageKey: QueuedAtIdKey | null = null, limit = 100): PublicExecutionAttemptPage { validateLimit(limit); const page = this.deps.attempts.page(taskId === undefined ? {} : { taskId }, { after: pageKey, limit }); return { items: page.items.map(publicAttempt), nextKey: page.nextKey }; }
  latestForTask(taskId: Uuid): PublicExecutionAttempt | null { const attempt = this.deps.attempts.getLatestForTask(taskId); return attempt === null ? null : publicAttempt(attempt); }
  stop(attemptId: Uuid, graceMs?: number): PublicExecutionAttempt {
    const stopping = this.deps.unitOfWork.execute((tx) => { const current = tx.projects.getAttempt(attemptId); if (!current) throw notFound(); const attemptFence: AttemptFence | null = fenceFor(current); if (!attemptFence) throw conflict(current.taskId, current.id, "FENCE_MISMATCH"); const result = transitionExecutionAttempt(current, { type: "stop", fence: attemptFence, requestedAt: this.deps.clock.now() }); if (!result.ok || !tx.projects.updateAttempt(current, result.attempt)) throw conflict(current.taskId, current.id, result.ok ? "FENCE_MISMATCH" : result.reason); return result.attempt; });
    const attemptFence: AttemptFence = fenceFor(stopping)!;
    const requestedGrace = clampGrace(graceMs, this.deps.runtime);
    if (this.acceptingEffects) this.trackStop(stopping, attemptFence, requestedGrace, this.generation);
    return publicAttempt(stopping);
  }
  dispatch(limit: number): Promise<number> { return this.track(this.dispatchWork(limit)); }
  private async dispatchWork(limit: number): Promise<number> { validateLimit(limit); let count = 0; for (const queued of this.deps.attempts.listClaimable(limit)) if (await this.launch(queued.id)) count++; return count; }
  /** Startup and periodic reconciliation; never creates a replacement attempt. */
  async recover(limit = 100): Promise<number> { return this.reconcile(limit); }
  reconcile(limit = 100): Promise<number> { return this.track(this.reconcileWork(limit)); }
  private async reconcileWork(limit = 100): Promise<number> {
    validateLimit(limit);
    let count = 0;
    for (const attempt of this.deps.attempts.listClaimable(limit)) {
      if (await this.reconcileAttempt(attempt, this.generation, this.acceptingEffects)) count++;
    }
    for (const attempt of this.deps.attempts.listRecoverable(limit)) {
      if (await this.reconcileAttempt(attempt, this.generation, this.acceptingEffects)) count++;
    }
    return count;
  }
  async drain(): Promise<void> {
    this.acceptingEffects = false;
    ++this.generation;
    await Promise.allSettled([...this.backgroundEffects, ...this.activeOperations]);
    await this.reconcileWork(100);
    await Promise.allSettled([...this.backgroundEffects, ...this.activeOperations]);
  }
  private async launch(id: Uuid, generation = this.generation): Promise<boolean> {
    const launching = this.deps.unitOfWork.execute((tx) => { const claimed = this.claim(tx, id); if (!claimed) return null; const currentFence = fenceFor(claimed)!; const result = transitionExecutionAttempt(claimed, { type: "launch_runner", fence: currentFence, runnerTokenHash: tokenProof(this.deps.runtime.issueToken(claimed.id)) }); return result.ok && tx.projects.updateAttempt(claimed, result.attempt) ? result.attempt : null; });
    if (!launching) return false;
    const currentFence = fenceFor(launching)!; const token = this.deps.runtime.issueToken(launching.id);
    let ready: RunnerHandle;
    try {
      ready = await this.deps.runner.launch({ attemptId: launching.id, attemptDirectory: this.deps.runtime.attemptDirectory(launching.id), token, leaseToken: currentFence.leaseToken, specHash: launching.specHash, spec: launching.spec });
    } catch (error) {
      if (generation === this.generation) this.markLost(launching.id, currentFence, proofErrorCode(error) ?? "RUNNER_LAUNCH_FAILED", false);
      return false;
    }
    if (generation !== this.generation) return false;
    const readyAttempt = this.persistReady(launching.id, ready.runner, ready.endpoint, ready.tokenProof);
    if (!readyAttempt) return false;
    return this.executeReady(readyAttempt, currentFence, token, ready.runner, generation);
  }
  private trackStop(attempt: ExecutionAttempt, attemptFence: AttemptFence, graceMs: number, generation: number): void {
    const effect = this.deps.runner.stop({ attemptId: attempt.id, attemptDirectory: this.deps.runtime.attemptDirectory(attempt.id), token: this.deps.runtime.issueToken(attempt.id), leaseToken: attemptFence.leaseToken, runner: attempt.runner!, graceMs })
      .then(() => undefined)
      .catch((error) => { if (generation === this.generation) this.markLost(attempt.id, attemptFence, proofErrorCode(error) ?? "RUNNER_STOP_FAILED", possibleLiveChild(attempt)); });
    this.backgroundEffects.add(effect);
    void effect.then(() => this.backgroundEffects.delete(effect), () => this.backgroundEffects.delete(effect));
  }
  private track<T>(operation: Promise<T>): Promise<T> {
    this.activeOperations.add(operation);
    void operation.then(() => this.activeOperations.delete(operation), () => this.activeOperations.delete(operation));
    return operation;
  }
  private persistReady(id: Uuid, runner: ProcessIdentity, endpoint: string, proof: string): ExecutionAttempt | null { return this.deps.unitOfWork.execute((tx) => { const current = tx.projects.getAttempt(id); const currentFence = current && fenceFor(current); if (!current || !currentFence || current.runnerTokenHash !== proof) return null; const result = transitionExecutionAttempt(current, { type: "runner_ready", input: { ...currentFence, runner, controlEndpoint: endpoint } }); return result.ok && tx.projects.updateAttempt(current, result.attempt) ? result.attempt : null; }); }
  private persistRunning(id: Uuid, runner: ProcessIdentity, child: ProcessIdentity, grantedAt: string, proof: string): boolean { return this.deps.unitOfWork.execute((tx) => { const current = tx.projects.getAttempt(id); const currentFence = current && fenceFor(current); if (!current || !currentFence || current.runnerTokenHash !== proof) return false; const result = transitionExecutionAttempt(current, { type: "running", input: { ...currentFence, runner, child, grantedAt } }); return result.ok && tx.projects.updateAttempt(current, result.attempt); }); }
  private async reconcileAttempt(snapshot: ExecutionAttempt, generation: number, allowLaunch: boolean): Promise<boolean> {
    if (snapshot.state === "queued") return allowLaunch ? this.launch(snapshot.id, generation) : false;
    const previousLeaseToken = snapshot.ownerInstanceId === this.deps.instanceId ? undefined : snapshot.leaseToken;
    const claimed = snapshot.ownerInstanceId === this.deps.instanceId ? snapshot : this.takeover(snapshot);
    if (!claimed || generation !== this.generation) return false;
    const currentFence = fenceFor(claimed); if (!currentFence) return false;
    if (!this.renew(claimed)) return false;
    const token = this.deps.runtime.issueToken(claimed.id); const directory = this.deps.runtime.attemptDirectory(claimed.id);
    if (claimed.state === "runner_launching" && claimed.runner === null) {
      let handle: RunnerHandle | null;
      try {
        handle = await this.deps.runner.discover({ attemptId: claimed.id, attemptDirectory: directory, token, leaseToken: currentFence.leaseToken, specHash: claimed.specHash, spec: claimed.spec });
      } catch (error) {
        if (generation === this.generation) this.markLost(claimed.id, currentFence, proofErrorCode(error) ?? "RUNNER_DISCOVERY_FAILED", false);
        return true;
      }
      if (generation !== this.generation) return false;
      if (handle === null) {
        this.markLost(claimed.id, currentFence, "RUNNER_DESCRIPTOR_MISSING", false);
        return true;
      }
      const readyAttempt = this.persistReady(claimed.id, handle.runner, handle.endpoint, handle.tokenProof);
      return readyAttempt === null ? false : this.executeReady(readyAttempt, currentFence, token, handle.runner, generation);
    }
    if (claimed.runner === null) { this.markLost(claimed.id, currentFence, "RUNNER_IDENTITY_MISSING", possibleLiveChild(claimed)); return true; }
    let result: RunnerResult | null;
    try {
      result = await this.deps.runner.readResult({ attemptId: claimed.id, attemptDirectory: directory, token, leaseToken: currentFence.leaseToken, ...(previousLeaseToken === null || previousLeaseToken === undefined ? {} : { previousLeaseToken }), runner: claimed.runner });
    } catch (error) {
      if (generation === this.generation) this.markLost(claimed.id, currentFence, proofErrorCode(error) ?? "RUNNER_RESULT_READ_FAILED", possibleLiveChild(claimed));
      return true;
    }
    if (generation !== this.generation) return false;
    if (result !== null) return this.persistResult(claimed.id, currentFence, result.runner, result.finishedAt, result.resultHash, result.exitCode, result.signal);
    let handle: RunnerHandle | null;
    try {
      handle = await this.deps.runner.adopt({ attemptId: claimed.id, attemptDirectory: directory, token, leaseToken: currentFence.leaseToken, ...(previousLeaseToken === null || previousLeaseToken === undefined ? {} : { previousLeaseToken }), specHash: claimed.specHash, runner: claimed.runner });
    } catch (error) {
      if (generation === this.generation) this.markLost(claimed.id, currentFence, proofErrorCode(error) ?? "RUNNER_ADOPTION_FAILED", possibleLiveChild(claimed));
      return true;
    }
    if (handle === null) {
      const delayedResult = await this.waitForResult(claimed, currentFence, token, directory, previousLeaseToken, generation);
      if (delayedResult) return true;
      this.markLost(claimed.id, currentFence, "RUNNER_UNAVAILABLE", possibleLiveChild(claimed));
      return true;
    }
    if (claimed.state === "runner_ready") {
      return this.executeReady(claimed, currentFence, token, handle.runner, generation);
    }
    return true;
  }
  private async executeReady(attempt: ExecutionAttempt, fence: AttemptFence, token: string, runner: ProcessIdentity, generation: number): Promise<boolean> {
    try {
      const granted = await this.deps.runner.exec({ attemptId: attempt.id, attemptDirectory: this.deps.runtime.attemptDirectory(attempt.id), token, leaseToken: fence.leaseToken, runner, specHash: attempt.specHash, spec: attempt.spec });
      return generation === this.generation && this.persistRunning(attempt.id, granted.runner, granted.child, granted.grantedAt, granted.tokenProof);
    } catch (error) {
      if (error instanceof RunnerRuntimeError && (error.code === "RUNNER_CONTROL_DISCONNECTED" || error.code === "RUNNER_CONTROL_INVALID_RESPONSE")) {
        return false;
      }
      if (generation === this.generation) this.markLost(attempt.id, fence, proofErrorCode(error) ?? "RUNNER_EXEC_FAILED", true);
      return true;
    }
  }
  private async waitForResult(attempt: ExecutionAttempt, fence: AttemptFence, token: string, directory: string, previousLeaseToken: number | null | undefined, generation: number): Promise<boolean> {
    if (attempt.runner === null) return false;
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && generation === this.generation) {
      let result: RunnerResult | null;
      try {
        result = await this.deps.runner.readResult({ attemptId: attempt.id, attemptDirectory: directory, token, leaseToken: fence.leaseToken, ...(previousLeaseToken === null || previousLeaseToken === undefined ? {} : { previousLeaseToken }), runner: attempt.runner });
      } catch (error) {
        if (generation === this.generation) this.markLost(attempt.id, fence, proofErrorCode(error) ?? "RUNNER_RESULT_READ_FAILED", possibleLiveChild(attempt));
        return true;
      }
      if (result !== null) return this.persistResult(attempt.id, fence, result.runner, result.finishedAt, result.resultHash, result.exitCode, result.signal);
      await Bun.sleep(25);
    }
    return false;
  }
  private renew(attempt: ExecutionAttempt): boolean { const currentFence = fenceFor(attempt); if (!currentFence) return false; const now = this.deps.clock.now(); return this.deps.unitOfWork.execute((tx) => tx.projects.renewLease("execution_attempt", attempt.id, currentFence.ownerInstanceId, currentFence.leaseToken, addSeconds(now, this.deps.leaseSeconds), now)); }
  private takeover(snapshot: ExecutionAttempt): ExecutionAttempt | null {
    const now = this.deps.clock.now();
    return this.deps.unitOfWork.execute((tx) => {
      const previousFence = fenceFor(snapshot);
      if (!previousFence) return null;
      const current = tx.projects.getAttempt(snapshot.id);
      if (!current || !isRecoverableState(current.state)) return null;
      const currentFence = fenceFor(current);
      if (!currentFence || currentFence.ownerInstanceId !== previousFence.ownerInstanceId || currentFence.leaseToken !== previousFence.leaseToken) return null;
      const leaseToken = tx.projects.acquireLease("execution_attempt", snapshot.id, this.deps.instanceId, addSeconds(now, this.deps.leaseSeconds), now);
      if (leaseToken === null) return null;
      const nextFence = { ownerInstanceId: this.deps.instanceId, leaseToken };
      const taken = tx.projects.takeoverAttempt(snapshot.id, previousFence, nextFence);
      if (taken === null) tx.projects.releaseLease("execution_attempt", snapshot.id, nextFence.ownerInstanceId, nextFence.leaseToken, now);
      return taken;
    });
  }
  private persistResult(id: Uuid, currentFence: AttemptFence, runner: NonNullable<ExecutionAttempt["runner"]>, finishedAt: string, resultHash: string, exitCode: number | null, signal: string | null): boolean { return this.deps.unitOfWork.execute((tx) => { const current = tx.projects.getAttempt(id); if (!current) return false; const result = transitionExecutionAttempt(current, { type: "complete", input: { ...currentFence, runner, finishedAt, resultHash, exitCode, signal } }); if (!result.ok || !tx.projects.updateAttempt(current, result.attempt)) return false; tx.projects.releaseLease("execution_attempt", id, currentFence.ownerInstanceId, currentFence.leaseToken, finishedAt); return true; }); }
  private claim(tx: TransactionWritePorts, id: Uuid): ExecutionAttempt | null { const now = this.deps.clock.now(); const lease = tx.projects.acquireLease("execution_attempt", id, this.deps.instanceId, addSeconds(now, this.deps.leaseSeconds), now); return lease === null ? null : tx.projects.claimAttempt(id, { ownerInstanceId: this.deps.instanceId, leaseToken: lease }); }
  private markLost(id: Uuid, currentFence: AttemptFence, errorCode: string, possibleLiveChild: boolean): void { this.deps.unitOfWork.execute((tx) => { const current = tx.projects.getAttempt(id); if (!current) return; const result = transitionExecutionAttempt(current, { type: "lost", fence: currentFence, finishedAt: this.deps.clock.now(), possibleLiveChild, errorCode }); if (result.ok && tx.projects.updateAttempt(current, result.attempt)) tx.projects.releaseLease("execution_attempt", id, currentFence.ownerInstanceId, currentFence.leaseToken, this.deps.clock.now()); }); }
  private nextAttemptNo(taskId: Uuid): number { return (this.deps.attempts.getLatestForTask(taskId)?.attemptNo ?? 0) + 1; }
  private enqueue(tx: TransactionWritePorts, attempt: ExecutionAttempt): void { const result = enqueueExecutionAttempt(attempt, tx.projects.getActiveAttempt(attempt.taskId)); if (result.ok) tx.projects.addAttempt(result.attempt); else if (result.skippedAttempt) tx.projects.addAttempt(result.skippedAttempt); else throw conflict(attempt.taskId, null, result.reason); }
}
function makeAttempt(id: Uuid, definition: { id: Uuid; version: number; specHash: string; executable: string; args: readonly string[]; cwd: string | null; envPolicy: ExecutionAttempt["spec"]["envPolicy"] }, taskId: Uuid, trigger: ExecutionAttempt["trigger"], queuedAt: string, scheduleId: Uuid | null, scheduledFor: string | null, attemptNo: number): ExecutionAttempt { return { id, taskId, scheduleId, definitionId: definition.id, definitionVersion: definition.version, trigger, scheduledFor, attemptNo, spec: { executable: definition.executable, args: [...definition.args], cwd: definition.cwd, envPolicy: definition.envPolicy }, specHash: definition.specHash, state: "queued", ownerInstanceId: null, leaseToken: null, runnerTokenHash: null, runner: null, controlEndpoint: null, child: null, execGrantedAt: null, exitCode: null, signal: null, errorCode: null, possibleLiveChild: false, queuedAt, startedAt: null, heartbeatAt: null, finishedAt: null }; }
function fenceFor(attempt: ExecutionAttempt): AttemptFence | null { return attempt.ownerInstanceId !== null && attempt.leaseToken !== null ? { ownerInstanceId: attempt.ownerInstanceId, leaseToken: attempt.leaseToken } : null; }
function addSeconds(value: string, seconds: number): string { return new Date(Date.parse(value) + seconds * 1000).toISOString(); }
function validateLimit(value: number): void { if (!Number.isInteger(value) || value <= 0) throw new RangeError("Batch limit must be positive"); }
function clampGrace(value: number | undefined, runtime: AttemptRuntimeConfig): number { if (value === undefined) return runtime.graceMs; if (!Number.isFinite(value)) throw new RangeError("Stop grace must be finite"); return Math.min(runtime.hardStopMs, Math.max(0, value)); }
function possibleLiveChild(attempt: ExecutionAttempt): boolean { return attempt.state === "runner_ready" || attempt.state === "running" || attempt.state === "stopping"; }
function isRecoverableState(state: ExecutionAttempt["state"]): boolean {
  return state === "claimed" || state === "runner_launching" || state === "runner_ready" || state === "running" || state === "stopping";
}
function proofErrorCode(error: unknown): string | null {
  if (error instanceof OwnedJsonReadError || error instanceof RunnerRuntimeError) return error.code;
  return null;
}
function publicAttempt(attempt: ExecutionAttempt): PublicExecutionAttempt { const { spec: _, runnerTokenHash: __, controlEndpoint: ___, ...publicValue } = attempt; return publicValue; }
function notFound() { return applicationError("NOT_FOUND", "Execution attempt was not found.", { resource: "execution_attempt" }); }
function conflict(taskId: Uuid, attemptId: Uuid | null, reason: "TASK_BUSY" | "INVALID_STATE" | "FENCE_MISMATCH" | "LEASE_MISMATCH" | "RUNNER_IDENTITY_MISMATCH" | "RESULT_INVALID" | "POSSIBLE_LIVE_CHILD" | "RESUME_NOT_ALLOWED") { return applicationError("EXECUTION_CONFLICT", "Execution attempt conflicts with its current state.", { taskId, attemptId, reason }); }
