import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { constants, type Stats } from "node:fs";
import { dirname, join } from "node:path";
import type { RunnerResult } from "../ports/runner-runtime.ts";
import { validateResult } from "./protocol.ts";

export const DESCRIPTOR_FILE = "runner.json";
export const GRANT_FILE = "grant.json";
export const CHILD_FILE = "child.json";
export const RESULT_FILE = "result.json";

export type OwnedJsonReadErrorCode =
  | "ARTIFACT_UNSAFE_METADATA"
  | "ARTIFACT_PARSE_FAILED"
  | "ARTIFACT_RACED"
  | "ARTIFACT_IO_FAILED"
  | "ARTIFACT_INVALID";

export class OwnedJsonReadError extends Error {
  constructor(readonly code: OwnedJsonReadErrorCode, message: string, readonly cause?: unknown) {
    super(message);
    this.name = "OwnedJsonReadError";
  }
}

export async function ensureAttemptDirectory(attemptDirectory: string): Promise<void> {
  await mkdir(attemptDirectory, { recursive: true, mode: 0o700 });
  const details = await lstat(attemptDirectory);
  if (!details.isDirectory() || details.uid !== currentUid() || (details.mode & 0o077) !== 0) throw new Error("insecure attempt directory");
}

export async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  await ensureAttemptDirectory(dirname(path));
  const temporary = join(dirname(path), `.${process.pid}.${crypto.randomUUID()}.tmp`);
  const encoded = `${JSON.stringify(value)}\n`;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(encoded, "utf8");
    await syncFile(file);
    await file.close();
    file = undefined;
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await syncFile(directory); } finally { await closeFile(directory); }
  } finally {
    if (file !== undefined) await closeFile(file);
    await unlink(temporary).catch(() => undefined);
  }
}

export async function readOwnedJson(path: string): Promise<unknown | null> {
  let details: Awaited<ReturnType<typeof lstat>>;
  try {
    details = await lstat(path);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null;
    throw new OwnedJsonReadError("ARTIFACT_IO_FAILED", `Unable to inspect artifact: ${path}`, error);
  }
  if (!isSafeOwnedFile(details)) {
    throw new OwnedJsonReadError("ARTIFACT_UNSAFE_METADATA", `Artifact has unsafe metadata: ${path}`);
  }
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new OwnedJsonReadError("ARTIFACT_RACED", `Artifact changed before it could be opened: ${path}`, error);
  }
  try {
    const before = await file.stat();
    if (!isSafeOwnedFile(before)) {
      throw new OwnedJsonReadError("ARTIFACT_UNSAFE_METADATA", `Artifact has unsafe metadata: ${path}`);
    }
    if (details.ino !== before.ino || details.dev !== before.dev || details.size !== before.size) {
      throw new OwnedJsonReadError("ARTIFACT_RACED", `Artifact changed while being opened: ${path}`);
    }
    const text = await file.readFile({ encoding: "utf8" });
    const after = await file.stat();
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size) {
      throw new OwnedJsonReadError("ARTIFACT_RACED", `Artifact changed while being read: ${path}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new OwnedJsonReadError("ARTIFACT_PARSE_FAILED", `Artifact is not valid JSON: ${path}`, error);
    }
  } catch (error) {
    if (error instanceof OwnedJsonReadError) throw error;
    throw new OwnedJsonReadError("ARTIFACT_IO_FAILED", `Unable to read artifact: ${path}`, error);
  } finally {
    try {
      await closeFile(file);
    } catch (error) {
      throw new OwnedJsonReadError("ARTIFACT_IO_FAILED", `Unable to close artifact: ${path}`, error);
    }
  }
}

export async function writeResult(attemptDirectory: string, result: RunnerResult): Promise<void> {
  await writeAtomicJson(join(attemptDirectory, RESULT_FILE), result);
}

export async function readResult(attemptDirectory: string): Promise<RunnerResult | null> {
  const value = await readOwnedJson(join(attemptDirectory, RESULT_FILE));
  if (value === null) return null;
  if (!validateResult(value)) throw new OwnedJsonReadError("ARTIFACT_INVALID", "Result artifact is invalid");
  return value;
}

async function syncFile(file: Awaited<ReturnType<typeof open>>): Promise<void> {
  if (file.sync === undefined) throw new Error("filesystem does not support durable fsync");
  await file.sync();
}

async function closeFile(file: Awaited<ReturnType<typeof open>>): Promise<void> {
  if (file.close === undefined) throw new Error("filesystem handle cannot be closed");
  await file.close();
}

function currentUid(): number {
  const getuid = process.getuid;
  if (getuid === undefined) throw new Error("current uid is unavailable");
  return getuid.call(process);
}

function isSafeOwnedFile(details: Stats): boolean {
  return details.isFile() && details.uid === currentUid() && (details.mode & 0o077) === 0 && details.nlink === 1;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
