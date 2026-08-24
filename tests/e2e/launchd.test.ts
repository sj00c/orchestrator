import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { LaunchdAgent, type LaunchdInstallConfig } from "../../src/adapters/launchd/agent.ts";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync("/tmp/orchestrator-launchd-"); roots.push(root);
  const agents = join(root, "LaunchAgents"); const state = join(root, "state"); mkdirSync(agents, { recursive: true, mode: 0o700 }); mkdirSync(state, { recursive: true, mode: 0o700 });
  const configPath = join(state, "config.json"); const databasePath = join(state, "orchestrator.sqlite"); writeFileSync(configPath, "{}", { mode: 0o600 }); writeFileSync(databasePath, "", { mode: 0o600 }); chmodSync(configPath, 0o600); chmodSync(databasePath, 0o600);
  const socketPath = join(state, "daemon.sock");
  const config: LaunchdInstallConfig = { label: "test.gjc.orchestrator", programArguments: [process.execPath, "/tmp/daemon<&>.ts", "--socket", socketPath, "--config", configPath, "--database", databasePath], socketPath, configPath, databasePath, stdoutPath: join(state, "daemon.out"), stderrPath: join(state, "daemon.err"), launchAgentsDirectory: agents, readinessTimeoutMs: 100 };
  return { root, config, plistPath: join(agents, "test.gjc.orchestrator.plist") };
}
function controlledAgent(results: { ok: boolean; stdout: string; stderr: string }[]) {
  const calls: string[][] = []; const agent = new LaunchdAgent();
  (agent as unknown as { launchctl(args: readonly string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> }).launchctl = async (args) => { calls.push([...args]); return results.shift() ?? { ok: true, stdout: "", stderr: "" }; };
  return { agent, calls };
}
async function listeningSocket(path: string): Promise<Server> {
  const fingerprint = await import("node:crypto").then(({ createHash }) => createHash("sha256").update(JSON.stringify({ socketPath: path }), "utf8").digest("hex"));
  const body = JSON.stringify({ ok: true, data: { ready: true, configFingerprint: fingerprint }, meta: { command: "daemon status", schemaVersion: 1 } });
  const server = createServer((socket) => {
    socket.once("data", () => socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  return server;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("isolated LaunchAgent adapter", () => {
  test("installs an owner-only plist with escaped arguments and KeepAlive without touching the user LaunchAgents directory", async () => {
    const f = fixture(); const socket = await listeningSocket(f.config.socketPath); const { agent, calls } = controlledAgent([{ ok: false, stdout: "Could not find service", stderr: "" }, { ok: true, stdout: "", stderr: "" }, { ok: true, stdout: "", stderr: "" }]);
    const result = await agent.install(f.config); socket.close();
    expect(result).toMatchObject({ state: "present", plistPath: f.plistPath, ready: true });
    expect(calls.map((call) => call[0])).toEqual(["print", "bootstrap", "kickstart"]);
    const plist = readFileSync(f.plistPath, "utf8");
    expect(plist).toContain("<key>KeepAlive</key><true/>"); expect(plist).toContain("<key>RunAtLoad</key><true/>"); expect(plist).toContain("daemon&lt;&amp;&gt;.ts");
  });

  test("rolls back the isolated candidate only after verified absence", async () => {
    for (const { results, expectBootout } of [
      { results: [{ ok: false, stdout: "Could not find service", stderr: "" }, { ok: false, stdout: "", stderr: "bootstrap failed" }, { ok: false, stdout: "Could not find service", stderr: "" }, { ok: false, stdout: "Could not find service", stderr: "" }], expectBootout: false },
      { results: [{ ok: false, stdout: "Could not find service", stderr: "" }, { ok: true, stdout: "", stderr: "" }, { ok: false, stdout: "", stderr: "kickstart failed" }, { ok: true, stdout: "", stderr: "" }, { ok: true, stdout: "", stderr: "" }, { ok: false, stdout: "Could not find service", stderr: "" }], expectBootout: true },
      { results: [{ ok: false, stdout: "Could not find service", stderr: "" }, { ok: true, stdout: "", stderr: "" }, { ok: true, stdout: "", stderr: "" }, { ok: true, stdout: "", stderr: "" }, { ok: true, stdout: "", stderr: "" }, { ok: false, stdout: "Could not find service", stderr: "" }], expectBootout: true },
    ]) {
      const f = fixture(); const { agent, calls } = controlledAgent(results);
      const result = await agent.install(f.config);
      expect(result).toMatchObject({ state: "degraded", ready: false });
      expect(() => readFileSync(f.plistPath)).toThrow();
      expect(calls.some((call) => call[0] === "bootout")).toBe(expectBootout);
    }
  });

  test("boots out a partially loaded service after bootstrap reports failure", async () => {
    const f = fixture();
    const { agent, calls } = controlledAgent([
      { ok: false, stdout: "Could not find service", stderr: "" },
      { ok: false, stdout: "", stderr: "bootstrap failed" },
      { ok: true, stdout: "", stderr: "" },
      { ok: true, stdout: "", stderr: "" },
      { ok: false, stdout: "Could not find service", stderr: "" },
    ]);
    const result = await agent.install(f.config);
    expect(result).toMatchObject({ state: "degraded", ready: false });
    expect(() => readFileSync(f.plistPath)).toThrow();
    expect(calls.map((call) => call[0])).toEqual(["print", "bootstrap", "print", "bootout", "print"]);
  });

  test("retains the bootstrap candidate when rollback bootout fails", async () => {
    const f = fixture();
    const { agent, calls } = controlledAgent([
      { ok: false, stdout: "Could not find service", stderr: "" },
      { ok: true, stdout: "", stderr: "" },
      { ok: false, stdout: "", stderr: "kickstart failed" },
      { ok: true, stdout: "", stderr: "" },
      { ok: false, stdout: "", stderr: "bootout failed" },
    ]);
    const result = await agent.install(f.config);
    expect(result).toMatchObject({ state: "degraded", ready: false });
    expect(result.detail).toContain("Rollback bootout failed: bootout failed");
    expect(readFileSync(f.plistPath, "utf8")).toContain("<key>Label</key>");
    expect(calls.map((call) => call[0])).toEqual(["print", "bootstrap", "kickstart", "print", "bootout"]);
  });

  test("retains the bootstrap candidate when health remains after unload verification", async () => {
    const f = fixture(); const socket = await listeningSocket(f.config.socketPath);
    const { agent } = controlledAgent([
      { ok: false, stdout: "Could not find service", stderr: "" },
      { ok: true, stdout: "", stderr: "" },
      { ok: false, stdout: "", stderr: "kickstart failed" },
      { ok: true, stdout: "", stderr: "" },
      { ok: true, stdout: "", stderr: "" },
      { ok: false, stdout: "Could not find service", stderr: "" },
    ]);
    const result = await agent.install(f.config); socket.close();
    expect(result).toMatchObject({ state: "degraded", ready: false });
    expect(result.detail).toContain("Rollback verification failed");
    expect(readFileSync(f.plistPath, "utf8")).toContain("<key>Label</key>");
  });

  test("reports isolated status and bootouts idempotently without host service mutation", async () => {
    const f = fixture(); writeFileSync(f.plistPath, "plist", { mode: 0o600 }); chmodSync(f.plistPath, 0o600);
    const { agent, calls } = controlledAgent([{ ok: false, stdout: "Could not find service", stderr: "" }, { ok: false, stdout: "No such process", stderr: "" }, { ok: false, stdout: "Could not find service", stderr: "" }]);
    expect(await agent.status(f.config)).toMatchObject({ state: "present", ready: false });
    expect(await agent.uninstall(f.config)).toMatchObject({ state: "absent", ready: false });
    expect(calls.map((call) => call[0])).toEqual(["print", "bootout", "print"]);
    expect(() => readFileSync(f.plistPath)).toThrow();
  });
});
