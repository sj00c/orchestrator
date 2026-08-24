import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FsNativeInstanceLock } from "../../src/adapters/lock/fs-native-lock.ts";

const dirs: string[] = [];
function tempDir(): string { const value = mkdtempSync("/tmp/orchestrator-lock-"); dirs.push(value); return value; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("native daemon instance lock", () => {
  test("contends, is close-on-exec, and releases after an explicit release", () => {
    const path = join(tempDir(), "daemon.lock");
    const first = FsNativeInstanceLock.acquire(path);
    expect(() => FsNativeInstanceLock.acquire(path)).toThrow("holds the lock");
    expect(() => first.verifySpawnFdNoninheritance()).not.toThrow();
    first.release();
    const replacement = FsNativeInstanceLock.acquire(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    replacement.release();
  });

  test.if(process.platform === "darwin")("releases a lock after a daemon crash on macOS", async () => {
    // This is Darwin-only: the production O_CLOEXEC/native-lock contract uses
    // Darwin flags and must be observed through a real process exit.
    const home = tempDir();
    const configDirectory = join(home, "Library", "Application Support", "Orchestrator");
    mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
    const socketPath = join(home, "daemon.sock");
    writeFileSync(join(configDirectory, "config.json"), JSON.stringify({ socketPath }), { mode: 0o600 });
    const daemon = Bun.spawn([process.execPath, "src/daemon/main.ts"], { cwd: process.cwd(), env: { ...process.env, HOME: home }, stdout: "ignore", stderr: "ignore" });
    const lockPath = `${socketPath}.lock`;
    try {
      await waitFor(() => { try { statSync(lockPath); return true; } catch { return false; } });
      expect(() => FsNativeInstanceLock.acquire(lockPath)).toThrow("holds the lock");
      daemon.kill("SIGKILL");
      await daemon.exited;
      const recovered = FsNativeInstanceLock.acquire(lockPath);
      recovered.release();
    } finally {
      if (daemon.exitCode === null) daemon.kill("SIGKILL");
    }
  }, 10_000);

  test("rejects an unsafe pre-existing lock file instead of weakening ownership checks", () => {
    const path = join(tempDir(), "unsafe.lock");
    writeFileSync(path, "not a lock", { mode: 0o644 });
    chmodSync(path, 0o644);
    expect(() => FsNativeInstanceLock.acquire(path)).toThrow("lock-file mode 0600");
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for deterministic process barrier");
    await Bun.sleep(20);
  }
}
