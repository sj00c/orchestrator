import type {
  CanonicalTimestamp,
  ProcessDefinitionVersion,
  Schedule,
} from "./model.ts";

export type ScheduleDueResult =
  | { kind: "not_due"; schedule: Schedule }
  | {
      kind: "due";
      schedule: Schedule;
      scheduledFor: CanonicalTimestamp;
      skippedMisfires: number;
    };

function timestampMillis(timestamp: CanonicalTimestamp): number {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) {
    throw new RangeError(`Invalid canonical timestamp: ${timestamp}`);
  }
  return value;
}

function canonicalTimestamp(millis: number): CanonicalTimestamp {
  return new Date(millis).toISOString();
}

function assertScheduleShape(schedule: Schedule): void {
  if (schedule.kind === "one-shot" && schedule.intervalSeconds !== null) {
    throw new RangeError("One-shot schedules cannot have an interval");
  }
  if (schedule.kind === "interval") {
    const intervalSeconds = schedule.intervalSeconds;
    if (
      intervalSeconds === null ||
      !Number.isInteger(intervalSeconds) ||
      intervalSeconds <= 0
    ) {
      throw new RangeError("Interval schedules require positive whole seconds");
    }
  }
}

/**
 * Advances a schedule without side effects. An interval materializes only its
 * newest due grid point and reports older missed points as coalesced.
 */
export function materializeDueSchedule(
  schedule: Schedule,
  now: CanonicalTimestamp,
): ScheduleDueResult {
  assertScheduleShape(schedule);
  if (!schedule.enabled || schedule.nextRunAt === null) {
    return { kind: "not_due", schedule };
  }

  const nowMillis = timestampMillis(now);
  const nextMillis = timestampMillis(schedule.nextRunAt);
  if (nextMillis > nowMillis) {
    return { kind: "not_due", schedule };
  }

  if (schedule.kind === "one-shot") {
    return {
      kind: "due",
      scheduledFor: schedule.nextRunAt,
      skippedMisfires: 0,
      schedule: { ...schedule, enabled: false, nextRunAt: null },
    };
  }

  const intervalMillis = schedule.intervalSeconds! * 1_000;
  const dueCount = Math.floor((nowMillis - nextMillis) / intervalMillis) + 1;
  const scheduledMillis = nextMillis + (dueCount - 1) * intervalMillis;
  return {
    kind: "due",
    scheduledFor: canonicalTimestamp(scheduledMillis),
    skippedMisfires: dueCount - 1,
    schedule: {
      ...schedule,
      nextRunAt: canonicalTimestamp(nextMillis + dueCount * intervalMillis),
    },
  };
}

/** Ensures a schedule can only bind the exact immutable definition it names. */
export function definitionForSchedule(
  schedule: Schedule,
  definition: ProcessDefinitionVersion,
): ProcessDefinitionVersion {
  if (
    schedule.taskId !== definition.taskId ||
    schedule.definitionId !== definition.id ||
    schedule.definitionVersion !== definition.version
  ) {
    throw new RangeError("Schedule definition binding does not match");
  }
  return definition;
}
