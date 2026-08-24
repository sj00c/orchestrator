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
} as const;

export type ApplicationErrorCode = keyof typeof ERROR_EXIT_CODES;
export type ApplicationExitCode = (typeof ERROR_EXIT_CODES)[ApplicationErrorCode];

export interface ErrorDetailsByCode {
  USAGE_ERROR: { argument: string | null };
  CONFIG_ERROR: { key: string };
  VALIDATION_ERROR: { field: string; reason: string };
  PROJECT_CONFLICT: { field: "name" | "rootPath" };
  NOT_FOUND: { resource: "project" | "task" };
  INVALID_TRANSITION: {
    taskId: string;
    command: string;
    fromState: PlannedState;
    allowedFrom: PlannedState[];
  };
  VERSION_CONFLICT: {
    resource: "project" | "task";
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
