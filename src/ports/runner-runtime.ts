import type { ProcessIdentity, ProcessSpec } from "../domain/model.ts";

export type RunnerRuntimeErrorCode =
  | "RUNNER_DESCRIPTOR_INVALID"
  | "RUNNER_CONTROL_DISCONNECTED"
  | "RUNNER_CONTROL_AUTH"
  | "RUNNER_CONTROL_FENCE"
  | "RUNNER_CONTROL_REJECTED"
  | "RUNNER_CONTROL_INVALID_RESPONSE"
  | "RUNNER_RESULT_INVALID";

export class RunnerRuntimeError extends Error {
  constructor(readonly code: RunnerRuntimeErrorCode, message: string, readonly cause?: unknown) {
    super(message);
    this.name = "RunnerRuntimeError";
  }
}

/** The daemon-facing boundary for a per-attempt process supervisor. It never opens SQLite. */
export interface RunnerRuntime {
  launch(input: RunnerLaunchInput): Promise<RunnerHandle>;
  discover(input: RunnerDiscoveryInput): Promise<RunnerHandle | null>;
  adopt(input: RunnerAdoptionInput): Promise<RunnerHandle | null>;
  exec(input: RunnerExecInput): Promise<RunnerExecOutcome>;
  stop(input: RunnerStopInput): Promise<RunnerStopOutcome>;
  stopAll(options?: RunnerShutdownOptions): Promise<void>;
  readResult(input: RunnerResultRequest): Promise<RunnerResult | null>;
}

export interface RunnerShutdownOptions {
  graceMs: number;
  hardDeadlineMs: number;
}

export interface RunnerLaunchInput {
  attemptId: string;
  attemptDirectory: string;
  token: string;
  leaseToken: number;
  specHash: string;
  spec: ProcessSpec;
}

/** Finds an already-published runner without creating a process. */
export interface RunnerDiscoveryInput {
  attemptId: string;
  attemptDirectory: string;
  token: string;
  leaseToken: number;
  specHash: string;
  spec: ProcessSpec;
}

export interface RunnerAdoptionInput {
  attemptId: string;
  attemptDirectory: string;
  token: string;
  leaseToken: number;
  previousLeaseToken?: number;
  specHash: string;
  runner: ProcessIdentity;
}

export interface RunnerHandle {
  attemptId: string;
  endpoint: string;
  runner: ProcessIdentity;
  tokenProof: string;
  leaseToken: number;
}

export interface RunnerExecInput {
  attemptId: string;
  attemptDirectory: string;
  token: string;
  leaseToken: number;
  runner: ProcessIdentity;
  specHash: string;
  spec: ProcessSpec;
}

export interface RunnerExecOutcome {
  attemptId: string;
  tokenProof: string;
  leaseToken: number;
  runner: ProcessIdentity;
  child: ProcessIdentity;
  grantedAt: string;
}

export interface RunnerStopInput {
  attemptId: string;
  attemptDirectory: string;
  token: string;
  leaseToken: number;
  runner: ProcessIdentity;
  graceMs: number;
}

export interface RunnerStopOutcome {
  attemptId: string;
  tokenProof: string;
  leaseToken: number;
  runner: ProcessIdentity;
  accepted: boolean;
  alreadyFinished: boolean;
}

export interface RunnerResultRequest {
  attemptId: string;
  attemptDirectory: string;
  token: string;
  leaseToken: number;
  previousLeaseToken?: number;
  runner: ProcessIdentity;
}

export interface RunnerResult {
  attemptId: string;
  tokenProof: string;
  leaseToken: number;
  runner: ProcessIdentity;
  child: ProcessIdentity | null;
  exitCode: number | null;
  signal: string | null;
  finishedAt: string;
  sequence: number;
  resultHash: string;
}
