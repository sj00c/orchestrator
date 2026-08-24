import { createHash } from "node:crypto";
import { MAX_RESPONSE_BYTES } from "../api/v1/contract.ts";
import { applicationError } from "./errors.ts";
import type { Clock, IdempotencyCommand, Uuid } from "../domain/model.ts";
import type { UnitOfWork } from "../ports/unit-of-work.ts";

export interface IdempotencyContext {
  idempotencyKey: string;
  requestId: Uuid;
  requestHash: string;
  command: string;
}

/** The complete response persisted for an idempotent mutation. */
export interface StoredHttpOutcome {
  status: number;
  bodyText: string;
}

export interface IdempotencyServiceOptions {
  clock: Clock;
  unitOfWork: UnitOfWork;
  instanceId: Uuid;
  leaseSeconds?: number;
}

type Attempt =
  | { kind: "replay"; command: IdempotencyCommand }
  | { kind: "wait" }
  | { kind: "outcome"; outcome: StoredHttpOutcome };

const WAIT_TIMEOUT_MS = 5_000;
const WAIT_INTERVAL_MS = 50;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export function isStoredHttpOutcome(value: unknown): value is StoredHttpOutcome {
  if (!isRecord(value)) return false;
  const status = value.status;
  return typeof status === "number" && Number.isInteger(status) && status >= 200 && status <= 599
    && typeof value.bodyText === "string" && value.bodyText.endsWith("\n");
}

/** Coordinates an API mutation and its final HTTP response in one transaction. */
export class IdempotencyService {
  private readonly leaseSeconds: number;

  constructor(private readonly options: IdempotencyServiceOptions) {
    this.leaseSeconds = options.leaseSeconds ?? 30;
  }

  async execute(context: IdempotencyContext, operation: () => StoredHttpOutcome): Promise<StoredHttpOutcome> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    for (;;) {
      const attempt = this.options.unitOfWork.execute((tx): Attempt => {
        const now = this.options.clock.now();
        const command = tx.projects.getCommand(context.idempotencyKey);
        if (command !== null) {
          this.assertSameRequest(command, context);
          if (command.state === "completed") return { kind: "replay", command };
          if (command.leaseExpiresAt !== null && command.leaseExpiresAt > now) return { kind: "wait" };
          if (!tx.projects.updateCommand(command, this.executingCommand(context, now), null)) return { kind: "wait" };
        } else {
          const tombstone = tx.projects.getTombstone(context.idempotencyKey);
          if (tombstone !== null) {
            if (tombstone.command !== context.command || tombstone.requestHash !== context.requestHash) {
              throw applicationError("IDEMPOTENCY_CONFLICT", "Idempotency key is bound to a different request.", { idempotencyKey: context.idempotencyKey });
            }
            throw applicationError("IDEMPOTENCY_EXPIRED", "The idempotency response has expired.", { idempotencyKey: context.idempotencyKey });
          }
          tx.projects.addCommand(this.executingCommand(context, now), null);
        }

        const outcome = operation();
        if (outcome instanceof Promise) {
          void Promise.resolve(outcome).catch(() => undefined);
          throw applicationError("CONSTRAINT_VIOLATION", "Idempotency operations must be synchronous.", { constraint: "synchronous idempotency operation" });
        }
        if (!isStoredHttpOutcome(outcome)) {
          throw applicationError("CONSTRAINT_VIOLATION", "Idempotency operations must return a final HTTP outcome.", { constraint: "idempotency HTTP outcome" });
        }
        const responseBytes = new TextEncoder().encode(outcome.bodyText).byteLength;
        if (responseBytes > MAX_RESPONSE_BYTES) {
          throw applicationError("RESPONSE_TOO_LARGE", "Payload exceeds the byte limit.", {
            resource: "response",
            recordId: null,
            maxBytes: MAX_RESPONSE_BYTES,
            actualBytes: responseBytes,
          });
        }
        this.complete(tx.projects.getCommand(context.idempotencyKey), outcome, now, tx.projects);
        return { kind: "outcome", outcome };
      });
      if (attempt.kind === "outcome") return attempt.outcome;
      if (attempt.kind === "replay") return this.replay(attempt.command);
      if (Date.now() >= deadline) {
        throw applicationError("IDEMPOTENCY_IN_PROGRESS", "The idempotent request is still executing.", { idempotencyKey: context.idempotencyKey, retryAfterSeconds: 1 });
      }
      await sleep(Math.min(WAIT_INTERVAL_MS, deadline - Date.now()));
    }
  }

  compactExpired(limit: number): number {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Compaction limit must be a positive whole number.");
    const now = this.options.clock.now();
    const cutoff = new Date(Date.parse(now) - RETENTION_MS).toISOString();
    return this.options.unitOfWork.execute((tx) => {
      const commands = tx.projects.listCompletedCommandsOlderThan(cutoff, limit);
      for (const command of commands) tx.projects.compactCommand({ ...command, compactedAt: now });
      return commands.length;
    });
  }

  private complete(command: IdempotencyCommand | null, outcome: StoredHttpOutcome, completedAt: string, repository: { updateCommand(previous: IdempotencyCommand, next: IdempotencyCommand, responseJson: string | null): boolean }): void {
    if (command === null) throw applicationError("STORAGE_ERROR", "Idempotency claim disappeared.", { operation: "write" });
    const completed: IdempotencyCommand = {
      ...command,
      state: "completed",
      ownerInstanceId: null,
      leaseExpiresAt: null,
      httpStatus: outcome.status,
      responseJson: outcome.bodyText,
      outcomeDigest: createHash("sha256").update(outcome.bodyText, "utf8").digest("hex"),
      completedAt,
    };
    if (!repository.updateCommand(command, completed, outcome.bodyText)) {
      throw applicationError("IDEMPOTENCY_IN_PROGRESS", "The idempotent request is still executing.", { idempotencyKey: command.idempotencyKey, retryAfterSeconds: 1 });
    }
  }

  private assertSameRequest(command: IdempotencyCommand, context: IdempotencyContext): void {
    if (command.command !== context.command || command.requestHash !== context.requestHash) {
      throw applicationError("IDEMPOTENCY_CONFLICT", "Idempotency key is bound to a different request.", { idempotencyKey: context.idempotencyKey });
    }
  }

  private replay(command: IdempotencyCommand): StoredHttpOutcome {
    if (command.responseJson === null || command.httpStatus === null || command.outcomeDigest === null) {
      throw applicationError("STORAGE_ERROR", "Completed idempotency command has no replay response.", { operation: "read" });
    }
    const digest = createHash("sha256").update(command.responseJson, "utf8").digest("hex");
    if (digest !== command.outcomeDigest) throw applicationError("STORAGE_ERROR", "Completed idempotency response digest does not match.", { operation: "read" });
    const outcome = { status: command.httpStatus, bodyText: command.responseJson };
    if (!isStoredHttpOutcome(outcome)) throw applicationError("STORAGE_ERROR", "Completed idempotency response is invalid.", { operation: "read" });
    return outcome;
  }

  private executingCommand(context: IdempotencyContext, now: string): IdempotencyCommand {
    return { idempotencyKey: context.idempotencyKey, requestHash: context.requestHash, command: context.command, state: "executing", ownerInstanceId: this.options.instanceId, requestId: context.requestId, leaseExpiresAt: new Date(Date.parse(now) + this.leaseSeconds * 1_000).toISOString(), httpStatus: null, responseJson: null, outcomeDigest: null, createdAt: now, completedAt: null, compactedAt: null };
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
