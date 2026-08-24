import { createHash } from "node:crypto";
import { link, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { applicationError } from "../application/errors.ts";
import { canonicalJson } from "../api/v1/contract.ts";

export const SOCKET_PATH_MAX_BYTES = 103;
export interface EndpointOptions { socket?: string; config?: string; uid?: number; home?: string; }
export interface ResolvedEndpoint { socketPath: string; configPath: string; databasePath: string; configFingerprint: string; source: "socket" | "explicit-config" | "default-config" | "compiled-default"; }
interface DaemonConfig { socketPath?: unknown; }

export function compiledSocketPath(uid = process.getuid?.()): string {
  if (!Number.isInteger(uid) || uid === undefined || uid < 0) throw applicationError("CONFIG_ERROR", "Unable to determine the current user ID.", { key: "uid" });
  return `/tmp/dev.gjc.orchestrator.${uid}/orchestrator.sock`;
}
export function defaultConfigPath(home = homedir()): string { return resolve(home, "Library/Application Support/Orchestrator/config.json"); }
export function defaultDatabasePath(home = homedir()): string { return resolve(home, ".local/state/orchestrator/orchestrator.db"); }

export async function resolveEndpoint(options: EndpointOptions = {}): Promise<ResolvedEndpoint> {
  const uid = options.uid ?? process.getuid?.();
  const configPath = options.config === undefined
    ? (options.home === undefined ? defaultConfigPath() : defaultConfigPath(options.home))
    : absolute(options.config, "config");
  let config: DaemonConfig = {};
  let configPresent = false;
  try {
    await verifyConfig(configPath, uid);
    config = JSON.parse(await readFile(configPath, "utf8")) as DaemonConfig;
    configPresent = true;
  } catch (error) {
    if (options.config !== undefined || !isAbsent(error)) throw configError(error, "config");
  }
  const configuredSocket = config.socketPath === undefined ? undefined : socket(config.socketPath, "socketPath");
  const explicitSocket = options.socket === undefined ? undefined : socket(options.socket, "socket");
  const socketPath = explicitSocket ?? configuredSocket ?? compiledSocketPath(uid);
  return {
    socketPath,
    configPath,
    databasePath: options.home === undefined ? defaultDatabasePath() : defaultDatabasePath(options.home),
    configFingerprint: endpointFingerprint({ socketPath }),
    source: explicitSocket ? "socket" : configuredSocket ? (options.config === undefined ? "default-config" : "explicit-config") : configPresent ? "default-config" : "compiled-default",
  };
}

/** Creates the first-run endpoint configuration without weakening normal client validation. */
export async function prepareInstallEndpoint(options: EndpointOptions = {}): Promise<ResolvedEndpoint> {
  const configPath = options.config === undefined
    ? (options.home === undefined ? defaultConfigPath() : defaultConfigPath(options.home))
    : absolute(options.config, "config");
  try {
    await lstat(configPath);
    return await resolveEndpoint(options);
  } catch (error) {
    if (!isAbsent(error)) throw error;
  }
  const uid = options.uid ?? process.getuid?.();
  const socketPath = options.socket === undefined ? compiledSocketPath(uid) : socket(options.socket, "socket");
  await ensureOwnedDirectory(dirname(configPath), uid);
  const contents = `${canonicalJson({ socketPath })}\n`;
  await createOwnedFile(configPath, contents, uid);
  return resolveEndpoint({ ...options, config: configPath });
}

export function endpointFingerprint(value: { socketPath: string }): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

async function verifyConfig(path: string, uid: number | undefined): Promise<void> {
  await secureNode(path, 0o600, uid, true);
  await secureNode(dirname(path), 0o700, uid, false);
}
async function ensureOwnedDirectory(path: string, uid: number | undefined): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await secureNode(path, 0o700, uid, false);
}
async function createOwnedFile(path: string, contents: string, uid: number | undefined): Promise<void> {
  const temporary = join(dirname(path), `.config.${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await secureNode(temporary, 0o600, uid, true);
    await link(temporary, path);
  } catch (error) {
    if (!isAbsent(error) && !(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  await verifyConfig(path, uid);
}
async function secureNode(path: string, mode: number, uid: number | undefined, file: boolean): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (file ? !info.isFile() : !info.isDirectory()) || (uid !== undefined && info.uid !== uid) || (info.mode & 0o777) !== mode) {
    throw applicationError("CONFIG_ERROR", "Insecure daemon configuration path.", { key: path });
  }
}
function socket(value: unknown, key: string): string {
  if (typeof value !== "string") throw applicationError("CONFIG_ERROR", "Socket path must be a string.", { key });
  return absolute(value, key, true);
}
function absolute(value: string, key: string, checkSocketLength = false): string {
  if (!isAbsolute(value) || value.includes("\0")) throw applicationError("CONFIG_ERROR", "Path must be absolute and contain no NUL byte.", { key });
  const normalized = resolve(value);
  if (checkSocketLength && Buffer.byteLength(normalized, "utf8") > SOCKET_PATH_MAX_BYTES) throw applicationError("CONFIG_ERROR", "Socket path exceeds the Unix socket path limit.", { key });
  return normalized;
}
function isAbsent(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
function configError(error: unknown, key: string): never { if (error instanceof Error && "code" in error) throw error; throw applicationError("CONFIG_ERROR", "Invalid daemon configuration.", { key }); }
