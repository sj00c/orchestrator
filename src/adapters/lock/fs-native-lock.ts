import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { dlopen, FFIType, read, type Pointer } from "bun:ffi";
import {
  createDaemonDatabaseLockToken,
  InstanceLockContendedError,
  LockCapabilityUnavailableError,
  revokeDaemonDatabaseLockToken,
  type DaemonDatabaseLockToken,
  type InstanceLock,
  type InstanceLockPort,
} from "../../ports/instance-lock.ts";

const FILE_MODE = 0o600;
const PERMISSION_MASK = 0o777;
const O_CLOEXEC = 0x1000000;
const F_GETFD = 1;
const FD_CLOEXEC = 1;
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;
const EWOULDBLOCK = 35;
const EAGAIN = 35;

type NativeLockSymbols = {
  flock(fd: number, operation: number): number;
  fcntl(fd: number, command: number): number;
  __error(): Pointer;
};

let nativeLockSymbols: NativeLockSymbols | undefined;

export class FsNativeInstanceLock implements InstanceLock {
  readonly token: DaemonDatabaseLockToken;
  private released = false;

  private constructor(
    readonly path: string,
    private readonly fd: number,
  ) {
    this.token = createDaemonDatabaseLockToken();
  }

  static acquire(path: string): FsNativeInstanceLock {
    assertOpenCapabilities();
    const native = loadNativeLockSymbols();
    if (path.length === 0) throw new LockCapabilityUnavailableError("lock-file path");

    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | O_CLOEXEC, FILE_MODE);
      assertSafeLockFile(fd);
      assertCloseOnExec(native, fd);
      acquireExclusiveLock(native, fd, path);
      assertSafeLockFile(fd);

      const lock = new FsNativeInstanceLock(path, fd);
      lock.verifySpawnFdNoninheritance();
      return lock;
    } catch (error) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* opening error wins */ }
      }
      if (error instanceof InstanceLockContendedError || error instanceof LockCapabilityUnavailableError) throw error;
      throw new LockCapabilityUnavailableError("secure native instance lock", error);
    }
  }

  verifySpawnFdNoninheritance(): void {
    this.assertActive();
    assertCloseOnExec(loadNativeLockSymbols(), this.fd);
    const identity = fstatSync(this.fd);
    const probe = Bun.spawnSync([
      process.execPath,
      "-e",
      "import {fstatSync} from 'node:fs'; const [fd,dev,ino]=process.argv.slice(1); try { const s=fstatSync(Number(fd)); process.exit(s.dev===Number(dev)&&s.ino===Number(ino)?1:0); } catch { process.exit(0); }",
      String(this.fd),
      String(identity.dev),
      String(identity.ino),
    ], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    if (probe.exitCode !== 0) {
      throw new LockCapabilityUnavailableError("lock descriptor non-inheritance");
    }
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    revokeDaemonDatabaseLockToken(this.token);

    let failure: unknown;
    try {
      if (loadNativeLockSymbols().flock(this.fd, LOCK_UN) !== 0) {
        failure = new Error(`flock(LOCK_UN) failed with errno ${readErrno(loadNativeLockSymbols())}`);
      }
    } catch (error) {
      failure = error;
    }
    try {
      closeSync(this.fd);
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw new LockCapabilityUnavailableError("native lock release", failure);
  }

  private assertActive(): void {
    if (this.released) throw new LockCapabilityUnavailableError("active native lock");
  }
}

export const fsNativeInstanceLock: InstanceLockPort = {
  acquire: FsNativeInstanceLock.acquire,
};

export function acquireFsNativeInstanceLock(path: string): InstanceLock {
  return FsNativeInstanceLock.acquire(path);
}

function loadNativeLockSymbols(): NativeLockSymbols {
  if (process.platform !== "darwin") {
    throw new LockCapabilityUnavailableError("macOS libSystem flock/fcntl");
  }
  if (nativeLockSymbols) return nativeLockSymbols;
  try {
    nativeLockSymbols = dlopen("/usr/lib/libSystem.B.dylib", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      __error: { args: [], returns: FFIType.ptr },
    }).symbols as NativeLockSymbols;
    return nativeLockSymbols;
  } catch (error) {
    throw new LockCapabilityUnavailableError("macOS libSystem flock/fcntl", error);
  }
}

function assertOpenCapabilities(): void {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new LockCapabilityUnavailableError("O_NOFOLLOW");
  }
  if (typeof process.getuid !== "function") {
    throw new LockCapabilityUnavailableError("lock-file owner verification");
  }
}

function assertSafeLockFile(fd: number): void {
  const stat = fstatSync(fd);
  if (!stat.isFile()) throw new LockCapabilityUnavailableError("regular lock file");
  if (stat.uid !== process.getuid!()) throw new LockCapabilityUnavailableError("lock-file owner verification");
  if ((stat.mode & PERMISSION_MASK) !== FILE_MODE) {
    throw new LockCapabilityUnavailableError("lock-file mode 0600");
  }
  if (stat.nlink !== 1) throw new LockCapabilityUnavailableError("single-link lock file");
}

function assertCloseOnExec(native: NativeLockSymbols, fd: number): void {
  const descriptorFlags = native.fcntl(fd, F_GETFD);
  if (descriptorFlags === -1 || (descriptorFlags & FD_CLOEXEC) === 0) {
    throw new LockCapabilityUnavailableError("close-on-exec lock descriptor");
  }
}

function acquireExclusiveLock(native: NativeLockSymbols, fd: number, path: string): void {
  if (native.flock(fd, LOCK_EX | LOCK_NB) === 0) return;
  const errno = readErrno(native);
  if (errno === EWOULDBLOCK || errno === EAGAIN) throw new InstanceLockContendedError(path);
  throw new LockCapabilityUnavailableError("nonblocking exclusive BSD lock", new Error(`flock failed with errno ${errno}`));
}

function readErrno(native: NativeLockSymbols): number {
  const pointer = native.__error();
  if (!pointer) return -1;
  return read.i32(pointer);
}
