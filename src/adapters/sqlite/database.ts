import { lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import { ApplicationError, applicationError } from "../../application/errors.ts";
import {
  claimDaemonDatabaseLockToken,
  type DaemonDatabaseLockToken,
} from "../../ports/instance-lock.ts";
import type {
  AttemptQueries,
  DaemonQueries,
  DefinitionQueries,
  EvidenceQueries,
  HistoryQueries,
  IdempotencyQueries,
  ProjectQueries,
  ScheduleQueries,
  StatusQueries,
  TaskQueries,
  TransactionWritePorts,
} from "../../ports/repositories.ts";
import type { UnitOfWork } from "../../ports/unit-of-work.ts";
import { migrate, readUserVersion, SUPPORTED_SCHEMA_VERSION } from "./migrate.ts";
import {
  SqliteAttemptQueries,
  SqliteDaemonQueries,
  SqliteDefinitionQueries,
  SqliteEvidenceQueries,
  SqliteHistoryQueries,
  SqliteIdempotencyQueries,
  SqliteProjectQueries,
  SqliteScheduleQueries,
  SqliteStatusQueries,
  SqliteTaskQueries,
  SqliteTransactionWriteRepositories,
} from "./repositories.ts";

export const SQLITE_BUSY_TIMEOUT_MS = 5000;
const WAL_RETRY_INTERVAL_MS = 25;

type PragmaRow = Record<string, string | number>;

export interface SqliteTransactionHooks {
  beforeBegin?(): void;
  afterBegin?(): void;
}

export interface SqliteDatabaseOpenOptions {
  hooks?: SqliteTransactionHooks;
  expectedFileIdentity?: { dev: number; ino: number };
}

export class SqliteDatabase implements UnitOfWork {
  readonly projects: ProjectQueries;
  readonly tasks: TaskQueries;
  readonly history: HistoryQueries;
  readonly definitions: DefinitionQueries;
  readonly schedules: ScheduleQueries;
  readonly attempts: AttemptQueries;
  readonly daemons: DaemonQueries;
  readonly evidence: EvidenceQueries;
  readonly idempotency: IdempotencyQueries;
  readonly status: StatusQueries;
  private closed = false;
  private activePorts: SqliteTransactionWriteRepositories | undefined;

  constructor(
    private readonly connection: Database,
    private readonly hooks: SqliteTransactionHooks | undefined,
  ) {
    this.projects = new SqliteProjectQueries(connection);
    this.tasks = new SqliteTaskQueries(connection);
    this.history = new SqliteHistoryQueries(connection);
    this.definitions = new SqliteDefinitionQueries(connection);
    this.schedules = new SqliteScheduleQueries(connection);
    this.attempts = new SqliteAttemptQueries(connection);
    this.daemons = new SqliteDaemonQueries(connection);
    this.evidence = new SqliteEvidenceQueries(connection);
    this.idempotency = new SqliteIdempotencyQueries(connection);
    this.status = new SqliteStatusQueries(connection);
  }

  execute<T>(fn: (tx: TransactionWritePorts) => T): T {
    this.assertOpen();
    if (this.activePorts) return fn({ projects: this.activePorts, tasks: this.activePorts });
    let began = false;
    let committing = false;
    let ports: SqliteTransactionWriteRepositories | undefined;
    try {
      this.hooks?.beforeBegin?.();
      this.connection.exec("BEGIN IMMEDIATE");
      began = true;
      this.hooks?.afterBegin?.();
      ports = new SqliteTransactionWriteRepositories(this.connection);
      this.activePorts = ports;
      const result = fn({ projects: ports, tasks: ports });
      if (result instanceof Promise) {
        throw applicationError("CONSTRAINT_VIOLATION", "SQLite unit-of-work callbacks must be synchronous.", { constraint: "synchronous unit of work" });
      }
      this.activePorts = undefined;
      ports.invalidate();
      committing = true;
      this.connection.exec("COMMIT");
      began = false;
      return result;
    } catch (error) {
      this.activePorts = undefined;
      ports?.invalidate();
      if (began) {
        try { this.connection.exec("ROLLBACK"); } catch { /* original error wins */ }
      }
      throw mapSqliteError(error, committing ? "commit" : "write");
    }
  }

  close(): void {
    if (this.closed) return;
    try {
      this.connection.close();
      this.closed = true;
    } catch (error) {
      throw mapSqliteError(error, "close");
    }
  }

  private assertOpen(): void {
    if (this.closed) throw applicationError("STORAGE_ERROR", "Database connection is closed.", { operation: "read" });
  }
}

export function openDaemonSqliteDatabase(
  lockToken: DaemonDatabaseLockToken,
  path: string,
  options?: SqliteDatabaseOpenOptions,
): SqliteDatabase {
  if (!claimDaemonDatabaseLockToken(lockToken)) {
    throw applicationError(
      "LOCK_CAPABILITY_UNAVAILABLE",
      "A valid, unconsumed daemon instance lock is required to open the daemon database.",
      { capability: "native_lock", reason: "missing, forged, released, or previously used lock token" },
    );
  }
  return openConfiguredSqliteDatabase(path, options);
}

/**
 * Explicitly isolated opening seam for migrations and tests. It must not be
 * used by the production daemon composition path.
 */
export function openIsolatedTestSqliteDatabase(
  path: string,
  options?: SqliteDatabaseOpenOptions,
): SqliteDatabase {
  return openConfiguredSqliteDatabase(path, options);
}

function openConfiguredSqliteDatabase(
  path: string,
  options: SqliteDatabaseOpenOptions = {},
): SqliteDatabase {
  let connection: Database | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true });
    connection = new Database(path, { create: true, strict: true });
    if (options.expectedFileIdentity !== undefined) {
      const opened = lstatSync(path);
      if (opened.isSymbolicLink() || !opened.isFile() || opened.dev !== options.expectedFileIdentity.dev || opened.ino !== options.expectedFileIdentity.ino) {
        throw applicationError("CONFIG_ERROR", "Database inode changed while opening.", { key: path });
      }
    }
    configure(connection);
    migrate(connection);
    verifyConfigured(connection);
    return new SqliteDatabase(connection, options.hooks);
  } catch (error) {
    try { connection?.close(); } catch { /* preserve opening failure */ }
    throw mapSqliteError(error, "open");
  }
}

function configure(connection: Database): void {
  try {
    connection.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
    connection.exec("PRAGMA foreign_keys = ON");
    if (pragmaNumber(connection, "foreign_keys") !== 1) throw new Error("foreign_keys was not enabled");
    const version = readUserVersion(connection);
    if (version > SUPPORTED_SCHEMA_VERSION) {
      throw applicationError("SCHEMA_TOO_NEW", "Database schema is newer than this application supports.", { supportedVersion: SUPPORTED_SCHEMA_VERSION, actualVersion: version });
    }
    const journalMode = acquireWalMode(connection);
    if (journalMode !== "wal") throw new Error("WAL mode was not enabled");
    connection.exec("PRAGMA synchronous = NORMAL");
    if (pragmaNumber(connection, "synchronous") !== 1) throw new Error("NORMAL synchronous mode was not enabled");
  } catch (error) {
    throw mapSqliteError(error, "configure");
  }
}

function acquireWalMode(connection: Database): string {
  const deadline = Date.now() + SQLITE_BUSY_TIMEOUT_MS;

  for (;;) {
    try {
      return String(
        connection.query<PragmaRow, []>("PRAGMA journal_mode = WAL").get()?.journal_mode ?? "",
      ).toLowerCase();
    } catch (error) {
      const remaining = deadline - Date.now();
      if (!isSqliteBusy(error) || remaining <= 0) throw error;
      synchronousWait(Math.min(WAL_RETRY_INTERVAL_MS, remaining));
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error && /SQLITE_BUSY|database is locked/i.test(error.message);
}

function synchronousWait(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function verifyConfigured(connection: Database): void {
  try {
    if (pragmaNumber(connection, "foreign_keys") !== 1) throw new Error("foreign_keys was not enabled");
    if (String(connection.query<PragmaRow, []>("PRAGMA journal_mode").get()?.journal_mode ?? "").toLowerCase() !== "wal") throw new Error("WAL mode was not retained");
    if (pragmaNumber(connection, "synchronous") !== 1) throw new Error("NORMAL synchronous mode was not retained");
    const version = readUserVersion(connection);
    if (version !== SUPPORTED_SCHEMA_VERSION) throw new Error("Schema version was not migrated");
  } catch (error) {
    throw mapSqliteError(error, "configure");
  }
}

function pragmaNumber(connection: Database, name: string): number {
  const row = connection.query<PragmaRow, []>(`PRAGMA ${name}`).get();
  const value = row?.[name];
  return typeof value === "number" ? value : Number(value);
}

export function mapSqliteError(error: unknown, operation: "open" | "configure" | "read" | "write" | "commit" | "close"): never {
  if (error instanceof ApplicationError) throw error;
  if (error instanceof Error && error.name === "VersionConflictError") {
    const conflict = error as Error & { id: string; expectedVersion: number };
    throw applicationError("VERSION_CONFLICT", "Task version changed unexpectedly.", { resource: "task", id: conflict.id, expectedVersion: conflict.expectedVersion, actualVersion: null });
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/SQLITE_BUSY|database is locked/i.test(message)) {
    throw applicationError("DB_BUSY", "Database is busy.", { timeoutMs: SQLITE_BUSY_TIMEOUT_MS });
  }
  if (/UNIQUE constraint failed: projects\.name/i.test(message)) {
    throw applicationError("PROJECT_CONFLICT", "A project with that name already exists.", { field: "name" });
  }
  if (/UNIQUE constraint failed: projects\.root_path/i.test(message)) {
    throw applicationError("PROJECT_CONFLICT", "A project with that root path already exists.", { field: "rootPath" });
  }
  if (/constraint failed|SQLITE_CONSTRAINT|events are immutable/i.test(message)) {
    throw applicationError("CONSTRAINT_VIOLATION", "Database constraint was violated.", { constraint: "sqlite" });
  }
  throw applicationError("STORAGE_ERROR", "Database operation failed.", { operation });
}
