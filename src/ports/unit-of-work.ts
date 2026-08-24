import type { TransactionWritePorts } from "./repositories.ts";

export interface UnitOfWork {
  /**
   * Runs fn under one serialized write transaction. The supplied ports expire
   * on return; callers must combine current/event/evidence/head/occurrence
   * changes in this callback rather than using independent writes.
   */
  execute<T>(fn: (tx: TransactionWritePorts) => T): T;
}
