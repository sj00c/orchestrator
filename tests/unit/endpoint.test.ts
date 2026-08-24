import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationError } from "../../src/application/errors.ts";
import { SOCKET_PATH_MAX_BYTES, compiledSocketPath, endpointFingerprint, resolveEndpoint } from "../../src/client/endpoint.ts";
import { parseCommand } from "../../src/cli/contract.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function config(contents: string, mode = 0o600): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orchestrator-endpoint-")); roots.push(root);
  await chmod(root, 0o700);
  const path = join(root, "config.json"); await writeFile(path, contents); await chmod(path, mode);
  return path;
}
async function expectConfigError(action: () => Promise<unknown>, key: string): Promise<void> {
  await expect(action()).rejects.toBeInstanceOf(ApplicationError);
  try { await action(); } catch (error) { expect(error).toMatchObject({ code: "CONFIG_ERROR", details: { key } }); }
}

describe("daemon endpoint resolution", () => {
  test("accepts an absolute database override only on daemon install", () => {
    const parsed = parseCommand(["daemon", "install", "--db", "/tmp/owner-only/orchestrator.db"]);
    expect(parsed.command).toBe("daemon install");
    expect(parsed.flags.get("--db")).toBe("/tmp/owner-only/orchestrator.db");
    expect(() => parseCommand(["project", "list", "--db", "/tmp/forbidden.db"])).toThrow("Unknown option");
  });

  test.each([
    [{ socket: "/tmp/explicit.sock", config: "CONFIG" }, "/tmp/explicit.sock", "socket"],
    [{ config: "CONFIG" }, "/tmp/from-config.sock", "explicit-config"],
  ] as const)("uses documented source precedence %#", async (options, socketPath, source) => {
    const path = await config(JSON.stringify({ socketPath: "/tmp/from-config.sock" }));
    const result = await resolveEndpoint({ ...options, config: options.config === "CONFIG" ? path : options.config, uid: 501 });
    expect(result).toMatchObject({ socketPath, configPath: path, source });
  });

  test("uses compiled fallback only when an optional default configuration is absent", async () => {
    const home = await mkdtemp(join(tmpdir(), "orchestrator-home-")); roots.push(home);
    const result = await resolveEndpoint({ home, uid: 501 });
    expect(result).toMatchObject({ socketPath: "/tmp/dev.gjc.orchestrator.501/orchestrator.sock", source: "compiled-default" });
  });

  test("fingerprints the canonical endpoint rather than configuration file bytes", () => {
    expect(endpointFingerprint({ socketPath: "/tmp/orchestrator.sock" })).toBe("e3cd7ff9b6010d8ca3ffb5de51a9be474460881aaf2ae6badfe4a39f1921477e");
    expect(endpointFingerprint({ socketPath: "/tmp/orchestrator.sock" })).not.toBe(endpointFingerprint({ socketPath: "/tmp/other.sock" }));
  });

  test.each([
    [-1, "uid"],
    [1.5, "uid"],
  ])("rejects unusable compiled uid %#", (uid, key) => {
    try { compiledSocketPath(uid); } catch (error) { expect(error).toMatchObject({ code: "CONFIG_ERROR", details: { key } }); return; }
    throw new Error("expected configuration error");
  });

  test("rejects insecure configuration permissions before reading its socket", async () => {
    const path = await config('{"socketPath":"/tmp/ignored.sock"}', 0o644);
    await expectConfigError(() => resolveEndpoint({ config: path, uid: process.getuid?.() }), path);
  });

  test.each([
    [{ socketPath: "relative.sock" }, "socketPath"],
    [{ socketPath: "/tmp/has\u0000nul.sock" }, "socketPath"],
    [{ socketPath: "/tmp/" + "a".repeat(SOCKET_PATH_MAX_BYTES) }, "socketPath"],
    [{ socketPath: 42 }, "socketPath"],
  ])("rejects unsafe configured socket %#", async (contents, key) => {
    const path = await config(JSON.stringify(contents));
    await expectConfigError(() => resolveEndpoint({ config: path, uid: process.getuid?.() }), key);
  });
});
