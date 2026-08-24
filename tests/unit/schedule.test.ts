import { describe, expect, test } from "bun:test";
import { definitionForSchedule, materializeDueSchedule } from "../../src/domain/schedule.ts";
import type { ProcessDefinitionVersion, Schedule } from "../../src/domain/model.ts";

const ids = { schedule: "11111111-1111-4111-8111-111111111111", task: "22222222-2222-4222-8222-222222222222", definition: "33333333-3333-4333-8333-333333333333" };
function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return { id: ids.schedule, taskId: ids.task, definitionId: ids.definition, definitionVersion: 1, kind: "one-shot", runAt: "2026-01-01T00:00:00.000Z", intervalSeconds: null, misfirePolicy: "coalesce", nextRunAt: "2026-01-01T00:00:00.000Z", enabled: true, version: 1, createdAt: "2025-12-01T00:00:00.000Z", updatedAt: "2025-12-01T00:00:00.000Z", ...overrides };
}

describe("schedule materialization", () => {
  test.each([
    [schedule(), "2025-12-31T23:59:59.999Z"],
    [schedule({ enabled: false }), "2026-01-02T00:00:00.000Z"],
    [schedule({ nextRunAt: null }), "2026-01-02T00:00:00.000Z"],
  ])("does not materialize a non-due schedule %#", (input, now) => {
    const result = materializeDueSchedule(input, now);
    expect(result).toEqual({ kind: "not_due", schedule: input });
  });

  test("consumes a due one-shot exactly once", () => {
    const input = schedule(); const result = materializeDueSchedule(input, "2026-01-01T00:00:00.000Z");
    expect(result).toEqual({ kind: "due", scheduledFor: input.runAt, skippedMisfires: 0, schedule: { ...input, enabled: false, nextRunAt: null } });
    expect(input.enabled).toBe(true);
  });

  test.each([
    ["2026-01-01T00:00:10.000Z", "2026-01-01T00:00:10.000Z", "2026-01-01T00:00:20.000Z", 0],
    ["2026-01-01T00:00:31.000Z", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:40.000Z", 3],
    ["2026-01-01T00:01:00.000Z", "2026-01-01T00:00:00.000Z", "2026-01-01T00:01:10.000Z", 6],
  ])("coalesces interval misfires on the fixed grid %#", (now, initialNextRunAt, nextRunAt, skippedMisfires) => {
    const input = schedule({ kind: "interval", intervalSeconds: 10, nextRunAt: initialNextRunAt });
    const result = materializeDueSchedule(input, now);
    expect(result).toEqual({ kind: "due", scheduledFor: now === "2026-01-01T00:00:31.000Z" ? "2026-01-01T00:00:30.000Z" : now === "2026-01-01T00:01:00.000Z" ? "2026-01-01T00:01:00.000Z" : now, skippedMisfires, schedule: { ...input, nextRunAt } });
  });

  test.each([
    [schedule({ kind: "one-shot", intervalSeconds: 1 }), "One-shot schedules cannot have an interval"],
    [schedule({ kind: "interval", intervalSeconds: null }), "Interval schedules require positive whole seconds"],
    [schedule({ kind: "interval", intervalSeconds: 1.5 }), "Interval schedules require positive whole seconds"],
  ])("rejects impossible schedule shapes %#", (input, message) => expect(() => materializeDueSchedule(input, "2026-01-02T00:00:00.000Z")).toThrow(message));

  test.each([
    [{ taskId: ids.task, id: ids.definition, version: 1 }, true],
    [{ taskId: "other", id: ids.definition, version: 1 }, false],
    [{ taskId: ids.task, id: "other", version: 1 }, false],
    [{ taskId: ids.task, id: ids.definition, version: 2 }, false],
  ])("binds schedules only to their immutable definition version %#", (identity, valid) => {
    const definition = { ...identity, executable: "echo", args: [], cwd: null, envPolicy: { kind: "inherit" as const, allowlist: [] }, specHash: "hash", createdAt: "2026-01-01T00:00:00.000Z" } as ProcessDefinitionVersion;
    if (valid) expect(definitionForSchedule(schedule(), definition)).toBe(definition);
    else expect(() => definitionForSchedule(schedule(), definition)).toThrow("binding does not match");
  });
});
