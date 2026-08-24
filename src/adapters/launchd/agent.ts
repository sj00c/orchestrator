import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { applicationError } from "../../application/errors.ts";

const LAUNCHCTL = "/bin/launchctl";
const DEFAULT_READY_TIMEOUT_MS = 15_000;

export interface LaunchdInstallConfig {
  label: string;
  /** argv passed directly to launchd; the first element must be an absolute executable path. */
  programArguments: readonly string[];
  socketPath: string;
  configPath: string;
  databasePath: string;
  stdoutPath: string;
  stderrPath: string;
  launchAgentsDirectory?: string;
  readinessTimeoutMs?: number;
}
export interface LaunchdLogPaths { stdoutPath: string; stderrPath: string; }
export interface LaunchdStatus {
  state: "absent" | "present" | "degraded";
  label: string;
  plistPath: string;
  ready: boolean;
  detail: string | null;
}

/** User-domain LaunchAgent manager. It never invokes a shell. */
export class LaunchdAgent {
  async install(config: LaunchdInstallConfig): Promise<LaunchdStatus> {
    const plistPath = plistPathFor(config);
    validateConfig(config, plistPath);
    const expected = renderPlist(config);
    const domain = userDomain();
    const service = `${domain}/${config.label}`;
    const existing = await inspectCandidate(plistPath);
    const loaded = await this.launchctl(["print", service]);
    const isLoaded = loaded.ok;
    const ready = isLoaded && await healthReady(config);

    if (!isLoaded && !notLoaded(loaded)) return degraded(config, plistPath, commandDetail(loaded));
    if (existing.kind === "unsafe") throw installConflict("plist", "Existing LaunchAgent plist is not an owner-only regular file.");
    if (existing.kind === "present" && existing.hash !== hash(expected)) throw installConflict("plist", "Existing LaunchAgent plist does not match the requested daemon configuration.");
    if (isLoaded && !ready && await anyHealth(config.socketPath)) throw installConflict("runtime", "Loaded LaunchAgent endpoint does not match the requested daemon configuration.");
    if (isLoaded && existing.kind === "missing") throw installConflict("runtime", "A LaunchAgent service is loaded without the requested plist candidate.");
    if (existing.kind === "present" && isLoaded && ready) return present(config, plistPath, true);
    if (existing.kind === "present" && isLoaded && !ready) return degraded(config, plistPath, "LaunchAgent is loaded but daemon health is unavailable.");

    let candidate: Candidate | null = null;
    try {
      await preflight(config);
      if (existing.kind === "missing") candidate = await writeCandidate(plistPath, expected);
    } catch (error) {
      return this.installFailure(config, plistPath, error, candidate, false);
    }
    let bootstrapInvoked = false;
    if (!isLoaded) {
      bootstrapInvoked = true;
      try {
        const bootstrap = await this.launchctl(["bootstrap", domain, plistPath]);
        if (!bootstrap.ok) return this.installFailure(config, plistPath, commandDetail(bootstrap), candidate, true);
      } catch (error) {
        return this.installFailure(config, plistPath, error, candidate, true);
      }
    }
    const started = await this.launchctl(["kickstart", "-k", service]);
    if (!started.ok) {
      return this.installFailure(config, plistPath, commandDetail(started), candidate, bootstrapInvoked);
    }
    if (!await waitForReady(config, timeout(config))) {
      return this.installFailure(config, plistPath, "Daemon did not become healthy with the expected configuration before the readiness timeout.", candidate, bootstrapInvoked);
    }
    return present(config, plistPath, true);
  }

  async uninstall(config: LaunchdInstallConfig): Promise<LaunchdStatus> {
    const plistPath = plistPathFor(config);
    validateConfig(config, plistPath);
    const candidate = await candidateAt(plistPath);
    if (await pathExists(plistPath) && !candidate) return degraded(config, plistPath, "LaunchAgent candidate is not an owner-only regular file.");
    const service = `${userDomain()}/${config.label}`;
    let result: CommandResult;
    try {
      result = await this.launchctl(["bootout", service]);
    } catch (error) {
      return degraded(config, plistPath, `LaunchAgent bootout failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!result.ok && !notLoaded(result)) return degraded(config, plistPath, commandDetail(result));
    const verification = await this.waitForUnloaded(config, service);
    if (verification) return degraded(config, plistPath, verification);
    if (candidate && !await sameCandidate(candidate)) return degraded(config, plistPath, "LaunchAgent candidate changed before verified cleanup; retained plist.");
    if (candidate) {
      try {
        await rm(candidate.path);
      } catch (error) {
        return degraded(config, plistPath, `LaunchAgent cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { state: "absent", label: config.label, plistPath, ready: false, detail: null };
  }

  async start(config: LaunchdInstallConfig): Promise<LaunchdStatus> {
    const plistPath = plistPathFor(config);
    validateConfig(config, plistPath);
    if (!await ownedRegularFile(plistPath)) return await pathExists(plistPath)
      ? degraded(config, plistPath, "LaunchAgent candidate is not an owner-only regular file.")
      : absent(config, plistPath);
    const result = await this.launchctl(["kickstart", "-k", `${userDomain()}/${config.label}`]);
    if (!result.ok) return degraded(config, plistPath, commandDetail(result));
    if (!await waitForReady(config, timeout(config))) return degraded(config, plistPath, "Daemon did not become healthy with the expected configuration before the readiness timeout.");
    return { state: "present", label: config.label, plistPath, ready: true, detail: null };
  }

  async stop(config: LaunchdInstallConfig): Promise<LaunchdStatus> {
    const plistPath = plistPathFor(config);
    validateConfig(config, plistPath);
    if (await pathExists(plistPath) && !await ownedRegularFile(plistPath)) return degraded(config, plistPath, "LaunchAgent candidate is not an owner-only regular file.");
    const result = await this.launchctl(["bootout", `${userDomain()}/${config.label}`]);
    if (!result.ok && !notLoaded(result)) return degraded(config, plistPath, commandDetail(result));
    return await ownedRegularFile(plistPath)
      ? { state: "present", label: config.label, plistPath, ready: false, detail: null }
      : absent(config, plistPath);
  }

  async status(config: LaunchdInstallConfig): Promise<LaunchdStatus> {
    const plistPath = plistPathFor(config);
    validateConfig(config, plistPath);
    if (await pathExists(plistPath) && !await ownedRegularFile(plistPath)) return degraded(config, plistPath, "LaunchAgent candidate is not an owner-only regular file.");
    const candidateExists = await ownedRegularFile(plistPath);
    const result = await this.launchctl(["print", `${userDomain()}/${config.label}`]);
    if (result.ok) {
      if (await healthReady(config)) return { state: "present", label: config.label, plistPath, ready: true, detail: null };
      return degraded(config, plistPath, "LaunchAgent is loaded but daemon health or configuration fingerprint is unavailable.");
    }
    if (notLoaded(result)) return candidateExists
      ? { state: "present", label: config.label, plistPath, ready: false, detail: null }
      : absent(config, plistPath);
    return degraded(config, plistPath, commandDetail(result));
  }

  logs(config: LaunchdInstallConfig): Promise<LaunchdLogPaths> {
    const plistPath = plistPathFor(config);
    validateConfig(config, plistPath);
    return Promise.resolve({ stdoutPath: config.stdoutPath, stderrPath: config.stderrPath });
  }

  private async rollback(config: LaunchdInstallConfig, candidate: Candidate | null, bootstrapInvoked: boolean): Promise<string | null> {
    if (bootstrapInvoked) {
      const service = `${userDomain()}/${config.label}`;
      let printed: CommandResult;
      try {
        printed = await this.launchctl(["print", service]);
      } catch (error) {
        return `Rollback probe failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      const healthy = await anyHealth(config.socketPath);
      if (!printed.ok && !notLoaded(printed)) return `Rollback probe failed: ${commandDetail(printed)}`;
      if (printed.ok || healthy) {
        let bootout: CommandResult;
        try {
          bootout = await this.launchctl(["bootout", service]);
        } catch (error) {
          return `Rollback bootout failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (!bootout.ok && !notLoaded(bootout)) return `Rollback bootout failed: ${commandDetail(bootout)}`;
      }
      const verification = await this.waitForUnloaded(config, service);
      if (verification) return `Rollback verification failed: ${verification}`;
    }
    if (candidate && !await sameCandidate(candidate)) return "Rollback retained a changed LaunchAgent candidate.";
    if (candidate) {
      try {
        await rm(candidate.path);
      } catch (error) {
        return `Rollback cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return null;
  }

  private async installFailure(config: LaunchdInstallConfig, plistPath: string, error: unknown, candidate: Candidate | null, bootstrapped: boolean): Promise<LaunchdStatus> {
    let rollback: string | null;
    try {
      rollback = await this.rollback(config, candidate, bootstrapped);
    } catch (rollbackError) {
      rollback = `Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
    }
    const detail = error instanceof Error ? error.message : String(error);
    return degraded(config, plistPath, diagnostic(rollback ? `${detail} ${rollback}` : detail));
  }

  private async waitForUnloaded(config: LaunchdInstallConfig, service: string): Promise<string | null> {
    const deadline = Date.now() + timeout(config);
    while (Date.now() < deadline) {
      let printed: CommandResult;
      try {
        printed = await this.launchctl(["print", service]);
      } catch (error) {
        return `Unable to verify LaunchAgent unload: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (printed.ok) {
        await Bun.sleep(Math.min(50, deadline - Date.now()));
        continue;
      }
      if (!notLoaded(printed)) return `Unable to verify LaunchAgent unload: ${commandDetail(printed)}`;
      if (!await anyHealth(config.socketPath)) return null;
      await Bun.sleep(Math.min(50, deadline - Date.now()));
    }
    return "LaunchAgent remained loaded or daemon health remained available after bootout.";
  }

  private async launchctl(args: readonly string[]): Promise<CommandResult> {
    const child = Bun.spawn([LAUNCHCTL, ...args], { stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      capturedText(child.stdout),
      capturedText(child.stderr),
    ]);
    return { ok: exitCode === 0, stdout, stderr };
  }
}

interface Candidate { path: string; ino: number; hash: string; }
type CandidateState = { kind: "missing" } | { kind: "unsafe" } | { kind: "present"; hash: string };
interface CommandResult { ok: boolean; stdout: string; stderr: string; }
async function capturedText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}
async function preflight(config: LaunchdInstallConfig): Promise<void> {
  const plistPath = plistPathFor(config);
  validateConfig(config, plistPath);
  await ensureOwnedDirectory(dirname(plistPath));
  if (!await ownedRegularFile(config.configPath)) throw new Error(`Required owned file is missing or unsafe: ${config.configPath}`);
  for (const path of [dirname(config.databasePath), dirname(config.socketPath), dirname(config.stdoutPath), dirname(config.stderrPath)]) await ensureOwnedDirectory(path);
  for (const path of [config.stdoutPath, config.stderrPath]) {
    await ensureOwnedLog(path);
  }
}
function validateConfig(config: LaunchdInstallConfig, plistPath: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(config.label)) throw new RangeError("Invalid LaunchAgent label");
  if (!Array.isArray(config.programArguments) || config.programArguments.length === 0 || !isAbsolute(config.programArguments[0])) throw new RangeError("ProgramArguments must begin with an absolute executable path");
  if (config.programArguments.some((value) => typeof value !== "string" || value.length === 0 || value.includes("\0"))) throw new RangeError("Invalid ProgramArguments");
  const paths = [plistPath, config.socketPath, config.configPath, config.databasePath, config.stdoutPath, config.stderrPath];
  if (paths.some((path) => !isAbsolute(path) || path.includes("\0"))) throw new RangeError("LaunchAgent paths must be absolute");
  if (![config.socketPath, config.configPath, config.databasePath].every((path) => config.programArguments.includes(path))) throw new RangeError("ProgramArguments must contain the absolute socket, config, and database paths");
  if (config.readinessTimeoutMs !== undefined && (!Number.isInteger(config.readinessTimeoutMs) || config.readinessTimeoutMs <= 0)) throw new RangeError("Invalid readiness timeout");
}
function plistPathFor(config: LaunchdInstallConfig): string { return join(config.launchAgentsDirectory ?? join(process.env.HOME ?? "", "Library", "LaunchAgents"), `${config.label}.plist`); }
function userDomain(): string { const uid = process.getuid?.(); if (uid === undefined || uid < 0) throw new Error("User launchd domain requires a numeric uid"); return `gui/${uid}`; }
function isAbsolute(value: string): boolean { return value.startsWith("/"); }
async function ownedRegularFile(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;
  } catch { return false; }
}
async function ensureOwnedDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Directory is missing or unsafe: ${path}`);
  }
}
async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch { return false; }
}
function isAbsent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
async function inspectCandidate(path: string): Promise<CandidateState> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) return { kind: "unsafe" };
    return { kind: "present", hash: hash(await readFile(path, "utf8")) };
  } catch (error) {
    if (isAbsent(error)) return { kind: "missing" };
    throw error;
  }
}
async function ensureOwnedLog(path: string): Promise<void> {
  if (await pathExists(path)) {
    if (!await ownedRegularFile(path)) throw new Error(`Log file is missing or unsafe: ${path}`);
    return;
  }
  await writeFile(path, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
  if (!await ownedRegularFile(path)) throw new Error(`Log file is missing or unsafe: ${path}`);
}
async function writeCandidate(path: string, contents: string): Promise<Candidate> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(contents, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    if (await pathExists(path)) throw installConflict("plist", "LaunchAgent plist appeared during installation.");
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  if (!await ownedRegularFile(path)) throw new Error("LaunchAgent candidate is not owner-only");
  const stat = await lstat(path);
  return { path, ino: stat.ino, hash: hash(contents) };
}
async function sameCandidate(candidate: Candidate): Promise<boolean> {
  try {
    const stat = await lstat(candidate.path);
    return stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 && stat.ino === candidate.ino && hash(await readFile(candidate.path, "utf8")) === candidate.hash;
  } catch { return false; }
}
async function candidateAt(path: string): Promise<Candidate | null> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) return null;
    return { path, ino: stat.ino, hash: hash(await readFile(path, "utf8")) };
  } catch (error) {
    if (isAbsent(error)) return null;
    throw error;
  }
}
function renderPlist(config: LaunchdInstallConfig): string {
  const argumentsXml = config.programArguments.map((value) => `    <string>${xml(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(config.label)}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StdOutPath</key><string>${xml(config.stdoutPath)}</string>
  <key>StandardErrorPath</key><string>${xml(config.stderrPath)}</string>
</dict>
</plist>
`;
}
function xml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }
function timeout(config: LaunchdInstallConfig): number { return config.readinessTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS; }
async function waitForReady(config: LaunchdInstallConfig, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthReady(config)) return true;
    await Bun.sleep(Math.min(50, deadline - Date.now()));
  }
  return false;
}
async function healthReady(config: LaunchdInstallConfig): Promise<boolean> {
  try {
    const response = await fetch("http://localhost/v1/health", {
      headers: { Accept: "application/json", "X-Request-Id": randomUUID() },
      unix: config.socketPath,
    } as RequestInit);
    if (!response.ok) return false;
    const body = await response.json() as { ok?: unknown; data?: { ready?: unknown; configFingerprint?: unknown } };
    return body.ok === true && body.data?.ready === true && body.data.configFingerprint === configFingerprint(config);
  } catch { return false; }
}
async function anyHealth(socketPath: string): Promise<boolean> {
  try {
    const response = await fetch("http://localhost/v1/health", {
      headers: { Accept: "application/json", "X-Request-Id": randomUUID() },
      unix: socketPath,
    } as RequestInit);
    return response.ok;
  } catch { return false; }
}
function configFingerprint(config: LaunchdInstallConfig): string {
  return createHash("sha256").update(JSON.stringify({ socketPath: config.socketPath }), "utf8").digest("hex");
}
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function diagnostic(value: string): string { return value.slice(0, 512); }
function installConflict(resource: "plist" | "runtime", message: string) {
  return applicationError("INSTALL_CONFLICT", message, { resource });
}
function notLoaded(result: CommandResult): boolean { return /could not find service|no such process|service not found/i.test(`${result.stdout}\n${result.stderr}`); }
function commandDetail(result: CommandResult): string { return (result.stderr || result.stdout || "launchctl command failed").trim().slice(0, 512); }
function absent(config: LaunchdInstallConfig, plistPath: string): LaunchdStatus { return { state: "absent", label: config.label, plistPath, ready: false, detail: null }; }
function degraded(config: LaunchdInstallConfig, plistPath: string, detail: string): LaunchdStatus { return { state: "degraded", label: config.label, plistPath, ready: false, detail }; }
function present(config: LaunchdInstallConfig, plistPath: string, ready: boolean): LaunchdStatus { return { state: "present", label: config.label, plistPath, ready, detail: null }; }
