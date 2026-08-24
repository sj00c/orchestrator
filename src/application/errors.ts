import type { PlannedState } from "../domain/model.ts";

export const ERROR_EXIT_CODES = {
  USAGE_ERROR: 2,
  CONFIG_ERROR: 2,
  VALIDATION_ERROR: 2,
  PROJECT_CONFLICT: 4,
  NOT_FOUND: 3,
  INVALID_TRANSITION: 4,
  VERSION_CONFLICT: 4,
  DB_BUSY: 5,
  CONSTRAINT_VIOLATION: 5,
  MIGRATION_FAILED: 5,
  SCHEMA_TOO_NEW: 5,
  STORAGE_ERROR: 5,
  DAEMON_UNAVAILABLE: 5,
  UNKNOWN_OUTCOME: 5,
  LOCK_CAPABILITY_UNAVAILABLE: 5,
  RESPONSE_TOO_LARGE: 5,
  IDEMPOTENCY_CONFLICT: 4,
  IDEMPOTENCY_IN_PROGRESS: 4,
  IDEMPOTENCY_EXPIRED: 4,
  EXECUTION_CONFLICT: 4,
  EVIDENCE_CONFLICT: 4,
  INSTALL_CONFLICT: 4,
} as const;

export type ApplicationErrorCode = keyof typeof ERROR_EXIT_CODES;
export type ApplicationExitCode = (typeof ERROR_EXIT_CODES)[ApplicationErrorCode];

export interface ErrorDetailsByCode {
  USAGE_ERROR: { argument: string | null };
  CONFIG_ERROR: { key: string };
  VALIDATION_ERROR: { field: string; reason: string };
  PROJECT_CONFLICT: { field: "name" | "rootPath" };
  NOT_FOUND: {
    resource:
      | "project"
      | "task"
      | "process_definition"
      | "schedule"
      | "execution_attempt";
  };
  INVALID_TRANSITION: {
    taskId: string;
    command: string;
    fromState: PlannedState;
    allowedFrom: PlannedState[];
  };
  VERSION_CONFLICT: {
    resource: "project" | "task" | "process_definition" | "schedule";
    id: string;
    expectedVersion: number;
    actualVersion: number | null;
  };
  DB_BUSY: { timeoutMs: 5000 };
  CONSTRAINT_VIOLATION: { constraint: string };
  MIGRATION_FAILED: { fromVersion: number; toVersion: number };
  SCHEMA_TOO_NEW: { supportedVersion: number; actualVersion: number };
  STORAGE_ERROR: {
    operation: "open" | "configure" | "read" | "write" | "commit" | "close";
  };
  DAEMON_UNAVAILABLE: {
    endpoint: string;
    reason: "connect_failed" | "health_failed" | "degraded" | "draining";
  };
  UNKNOWN_OUTCOME: {
    idempotencyKey: string;
    requestId: string;
    command: string;
  };
  LOCK_CAPABILITY_UNAVAILABLE: {
    capability: "native_lock" | "close_on_exec" | "fd_whitelist";
    reason: string;
  };
  RESPONSE_TOO_LARGE: {
    resource: string;
    recordId: string | null;
    maxBytes: number;
    actualBytes: number;
  };
  IDEMPOTENCY_CONFLICT: { idempotencyKey: string };
  IDEMPOTENCY_IN_PROGRESS: { idempotencyKey: string; retryAfterSeconds: 1 };
  IDEMPOTENCY_EXPIRED: { idempotencyKey: string };
  EXECUTION_CONFLICT: {
    taskId: string;
    attemptId: string | null;
    reason:
      | "TASK_BUSY"
      | "INVALID_STATE"
      | "FENCE_MISMATCH"
      | "LEASE_MISMATCH"
      | "RUNNER_IDENTITY_MISMATCH"
      | "RESULT_INVALID"
      | "POSSIBLE_LIVE_CHILD"
      | "RESUME_NOT_ALLOWED";
  };
  EVIDENCE_CONFLICT: {
    source: string;
    evidenceId: string;
  };
  INSTALL_CONFLICT: { resource: "plist" | "config" | "runtime" };
}

export class ApplicationError<Code extends ApplicationErrorCode> extends Error {
  readonly exitCode: (typeof ERROR_EXIT_CODES)[Code];

  constructor(
    readonly code: Code,
    message: string,
    readonly details: ErrorDetailsByCode[Code],
  ) {
    super(message);
    this.name = "ApplicationError";
    this.exitCode = ERROR_EXIT_CODES[code];
  }
}

export type AnyApplicationError = {
  [Code in ApplicationErrorCode]: ApplicationError<Code>;
}[ApplicationErrorCode];

export function applicationError<Code extends ApplicationErrorCode>(
  code: Code,
  message: string,
  details: ErrorDetailsByCode[Code],
): ApplicationError<Code> {
  return new ApplicationError(code, message, details);
}

export function exitCodeFor(error: ApplicationErrorCode): ApplicationExitCode {
  return ERROR_EXIT_CODES[error];
}

export interface ErrorEnvelopeV1<Code extends ApplicationErrorCode = ApplicationErrorCode> {
  ok: false;
  error: {
    code: Code;
    message: string;
    details: ErrorDetailsByCode[Code];
  };
  meta: { command: string; schemaVersion: 1 };
}

export function errorEnvelope<Code extends ApplicationErrorCode>(
  command: string,
  error: ApplicationError<Code>,
): ErrorEnvelopeV1<Code> {
  return {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      details: error.details,
    },
    meta: { command, schemaVersion: 1 },
  };
}
