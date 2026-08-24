declare const daemonDatabaseLockTokenBrand: unique symbol;

export interface DaemonDatabaseLockToken {
  readonly [daemonDatabaseLockTokenBrand]: "daemon-database-lock";
}

export interface InstanceLock {
  readonly path: string;
  readonly token: DaemonDatabaseLockToken;
  verifySpawnFdNoninheritance(): void;
  release(): void;
}

export interface InstanceLockPort {
  acquire(path: string): InstanceLock;
}

export class InstanceLockContendedError extends Error {
  readonly code = "INSTANCE_LOCK_CONTENDED";

  constructor(readonly path: string) {
    super(`Another daemon instance holds the lock at ${path}.`);
    this.name = "InstanceLockContendedError";
  }
}

export class LockCapabilityUnavailableError extends Error {
  readonly code = "LOCK_CAPABILITY_UNAVAILABLE";

  constructor(readonly capability: string, readonly cause?: unknown) {
    super(`Required lock capability is unavailable: ${capability}.`);
    this.name = "LockCapabilityUnavailableError";
  }
}

interface TokenState {
  active: boolean;
  claimed: boolean;
}

const tokenStates = new WeakMap<object, TokenState>();

export function createDaemonDatabaseLockToken(): DaemonDatabaseLockToken {
  const token = {} as DaemonDatabaseLockToken;
  tokenStates.set(token, { active: true, claimed: false });
  return token;
}

export function claimDaemonDatabaseLockToken(token: DaemonDatabaseLockToken): boolean {
  const state = tokenStates.get(token);
  if (!state || !state.active || state.claimed) return false;
  state.claimed = true;
  return true;
}

export function revokeDaemonDatabaseLockToken(token: DaemonDatabaseLockToken): void {
  const state = tokenStates.get(token);
  if (state) state.active = false;
}
