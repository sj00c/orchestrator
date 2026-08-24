import type { ObservedEvidence } from "../domain/evidence.ts";

/** Adapter-neutral source of durable, sanitized observations. */
export interface ObserverAdapter {
  readonly source: string;
  poll(): Promise<readonly ObservedEvidence[]>;
}
