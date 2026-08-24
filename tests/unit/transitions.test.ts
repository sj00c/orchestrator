import { describe, expect, test } from "bun:test";
import { transitionPlanned } from "../../src/domain/transitions.ts";
import type { PlannedTransitionTask } from "../../src/domain/transitions.ts";
import type { Clock, ObservedState, PlannedTransitionCommand } from "../../src/domain/model.ts";
import { parseSince } from "../../src/cli/contract.ts";

const at = "2026-01-02T03:04:05.678Z";
function task(state: PlannedTransitionTask["plannedState"], overrides: Partial<PlannedTransitionTask> = {}): PlannedTransitionTask {
  return { id: "11111111-1111-4111-8111-111111111111", plannedState: state, observedState: "running", blockedReason: null, version: 4, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", startedAt: null, finishedAt: null, ...overrides };
}
function clock(): Clock & { calls: number } { return { calls: 0, now() { this.calls++; return at; } }; }

const matrix: Array<[PlannedTransitionTask["plannedState"], PlannedTransitionCommand, PlannedTransitionTask["plannedState"]]> = [
  ["planned", { type: "start" }, "active"], ["ready", { type: "start" }, "active"],
  ["active", { type: "pause" }, "paused"], ["paused", { type: "resume" }, "active"], ["blocked", { type: "resume" }, "active"],
  ["planned", { type: "block", reason: " waiting " }, "blocked"], ["ready", { type: "block", reason: "waiting" }, "blocked"], ["active", { type: "block", reason: "waiting" }, "blocked"], ["paused", { type: "block", reason: "waiting" }, "blocked"],
  ["active", { type: "complete" }, "done"], ["paused", { type: "complete" }, "done"], ["blocked", { type: "complete" }, "done"],
  ["planned", { type: "cancel" }, "canceled"], ["ready", { type: "cancel" }, "canceled"], ["active", { type: "cancel" }, "canceled"], ["paused", { type: "cancel" }, "canceled"], ["blocked", { type: "cancel" }, "canceled"],
];

describe("planned transition matrix", () => {
  test.each(matrix)("%s %p becomes %s", (from, command, to) => {
    const fake = clock(); const input = task(from); const result = transitionPlanned(input, command, fake);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.next).toMatchObject({ plannedState: to, version: 5, updatedAt: at, observedState: "running" });
    expect(result.occurredAt).toBe(at); expect(fake.calls).toBe(1);
    expect(input).toEqual(task(from));
  });

  test("rejects the exhaustive forbidden planned-transition matrix without sampling time", () => {
    const commands: PlannedTransitionCommand[] = [{ type: "start" }, { type: "pause" }, { type: "resume" }, { type: "block", reason: "x" }, { type: "complete" }, { type: "cancel" }];
    const states: PlannedTransitionTask["plannedState"][] = ["planned", "ready", "active", "paused", "blocked", "done", "canceled"];
    const permitted = new Set(matrix.map(([state, command]) => `${state}:${command.type}`));
    for (const command of commands) for (const state of states) {
      if (permitted.has(`${state}:${command.type}`)) continue;
      const fake = clock(); const result = transitionPlanned(task(state), command, fake);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("invalid_from_state");
      expect(fake.calls).toBe(0);
    }
  });

  test("trims only a block reason and preserves every observed-state value", () => {
    const observedStates: ObservedState[] = ["unknown", "idle", "running", "succeeded", "failed", "stale"];
    for (const observedState of observedStates) {
      const original = task("active", { observedState, startedAt: "2026-01-01T01:00:00.000Z" });
      const result = transitionPlanned(original, { type: "block", reason: "  dependency unavailable  " }, clock());
      expect(result.ok && result.next).toMatchObject({ blockedReason: "dependency unavailable", observedState, startedAt: original.startedAt, finishedAt: null });
    }
  });

  test("applies timestamp lifecycle effects and clears reason leaving blocked", () => {
    const start = transitionPlanned(task("planned"), { type: "start" }, clock());
    expect(start.ok && start.next.startedAt).toBe(at);
    const resume = transitionPlanned(task("blocked", { blockedReason: "x", startedAt: null }), { type: "resume" }, clock());
    expect(resume.ok && resume.next).toMatchObject({ blockedReason: null, startedAt: at });
    const done = transitionPlanned(task("blocked", { blockedReason: "x" }), { type: "complete" }, clock());
    expect(done.ok && done.next).toMatchObject({ blockedReason: null, finishedAt: at });
    const rejected = transitionPlanned(task("planned"), { type: "block", reason: " \t " }, clock());
    expect(rejected.ok).toBe(false); if (!rejected.ok) expect(rejected.reason).toBe("empty_block_reason");
  });

  test("accepts only real RFC3339 instants with an explicit UTC offset", () => {
    expect(parseSince("2026-01-02T03:04:05.678Z")).toBe("2026-01-02T03:04:05.678Z");
    expect(parseSince("2026-01-02T12:04:05+09:00")).toBe("2026-01-02T03:04:05.000Z");
    for (const invalid of ["2026-01-02", "2026-02-30T00:00:00Z", "2026-01-02T03:04:05", "2026-01-02T03:04:05+25:00"]) {
      expect(() => parseSince(invalid)).toThrow();
    }
  });
});
