import type { TransactionWritePorts } from "./repositories.ts";

export interface UnitOfWork {
  /** Runs fn under one serialized write transaction. The supplied ports expire on return. */
  execute<T>(fn: (tx: TransactionWritePorts) => T): T;
}
