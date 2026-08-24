import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tokenProof } from "../../src/runner/protocol.ts";

const runtimeSource = () => readFileSync(resolve("src/adapters/process/runner-runtime.ts"), "utf8");
const runnerSource = () => readFileSync(resolve("src/runner/main.ts"), "utf8");

describe("runner secret redaction boundary", () => {
  test("passes the runner token through stdin, never argv or environment", () => {
    const source = runtimeSource();
    expect(source).toContain("stdin: tokenStream");
    expect(source).not.toMatch(/Bun\.spawn\([^\n]*input\.token/);
    expect(source).not.toMatch(/env\s*:\s*[^\n]*token/i);
  });

  test("publishes a non-reversible proof rather than token text in descriptors and results", () => {
    const secret = "top-secret-token-value-that-must-not-leak";
    const proof = tokenProof(secret);
    expect(proof).toMatch(/^[0-9a-f]{64}$/);
    expect(proof).not.toContain(secret);
    const source = runnerSource();
    expect(source).toContain("tokenProof: tokenProof(token)");
    expect(source).not.toContain("token, endpoint");
  });

  test("does not serialize secret argv, environment values, or arbitrary command text into runner control artifacts", () => {
    const source = runnerSource();
    expect(source).not.toContain("process.argv.join");
    expect(source).toContain("for (const key of spec.envPolicy.allowlist)");
    expect(source).not.toContain("JSON.stringify(environment)");
    expect(source).not.toContain("JSON.stringify(token)");
    expect(source).toContain("const token = (await Bun.stdin.text()).trim()");
  });
});
