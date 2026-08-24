import type { CanonicalTimestamp } from "../domain/model.ts";

/** A process identity observed by an operating-system adapter. */
export interface ProcessIdentity {
  pid: number;
  pgid: number;
  startedAt: CanonicalTimestamp;
  executable?: string;
}

/**
 * OS-neutral process inspection boundary. Implementations must never treat a
 * PID as an identity: start time and process group are part of the fence.
 */
export interface ProcessInspector {
  inspect(pid: number): Promise<ProcessIdentity | null>;
  matches(expected: ProcessIdentity): Promise<boolean>;
  signal(expected: ProcessIdentity, signal: NodeJS.Signals): Promise<void>;
}
