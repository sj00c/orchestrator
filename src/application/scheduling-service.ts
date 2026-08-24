import { applicationError } from "./errors.ts";
import type { IdGenerator } from "./service.ts";
import { definitionForSchedule, materializeDueSchedule } from "../domain/schedule.ts";
import { normalizeProcessSpec, processSpecHash, ProcessSpecValidationError } from "../domain/process-spec.ts";
import type { Clock, ProcessDefinitionVersion, ProcessSpec, Schedule, Uuid } from "../domain/model.ts";
import type { CreatedAtIdKey, DefinitionKey, DefinitionQueries, KeysetPage, ScheduleQueries, TransactionWritePorts } from "../ports/repositories.ts";
import type { UnitOfWork } from "../ports/unit-of-work.ts";

export interface SchedulingDependencies {
  clock: Clock;
  ids: IdGenerator;
  definitions: DefinitionQueries;
  schedules: ScheduleQueries;
  unitOfWork: UnitOfWork;
  enqueueScheduleOccurrence(tx: TransactionWritePorts, input: ScheduleOccurrence): void;
}

export interface ScheduleOccurrence {
  scheduleId: Uuid;
  taskId: Uuid;
  definition: ProcessDefinitionVersion;
  scheduledFor: string;
  queuedAt: string;
}

export interface CreateDefinitionInput extends ProcessSpec { taskId: Uuid; definitionId?: Uuid; }
export interface CreateScheduleInput {
  taskId: Uuid;
  definitionId: Uuid;
  definitionVersion: number;
  kind: "one-shot" | "interval";
  runAt: string;
  intervalSeconds?: number;
  scheduleId?: Uuid;
  enabled?: boolean;
}
export interface VersionDefinitionInput extends ProcessSpec { expectedVersion: number; }

/** Owns immutable definition versions and durable schedule materialization. */
export class SchedulingService {
  constructor(private readonly deps: SchedulingDependencies) {}

  createDefinition(input: CreateDefinitionInput): ProcessDefinitionVersion {
    const spec = validateSpec(input);
    const now = this.deps.clock.now();
    return this.deps.unitOfWork.execute((tx) => {
      const versions = this.deps.definitions.listForTask(input.taskId);
      const id = input.definitionId ?? this.deps.ids.next();
      const version = versions.filter((item) => item.id === id).reduce((max, item) => Math.max(max, item.version), 0) + 1;
      const definition: ProcessDefinitionVersion = { id, version, taskId: input.taskId, ...spec, specHash: processSpecHash(spec), createdAt: now };
      tx.projects.addDefinition(definition);
      return definition;
    });
  }

  pageDefinitions(taskId?: Uuid, key: DefinitionKey | null = null, limit = 100): KeysetPage<ProcessDefinitionVersion, DefinitionKey> {
    validateLimit(limit);
    return this.deps.definitions.page(taskId === undefined ? {} : { taskId }, { after: key, limit });
  }

  getDefinition(id: Uuid, version?: number): ProcessDefinitionVersion {
    const definition = version === undefined ? this.deps.definitions.getLatest(id) : this.deps.definitions.get(id, version);
    if (!definition) throw applicationError("NOT_FOUND", "Process definition was not found.", { resource: "process_definition" });
    return definition;
  }

  versionDefinition(id: Uuid, input: VersionDefinitionInput): ProcessDefinitionVersion {
    const spec = validateSpec(input);
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion <= 0) throw applicationError("VALIDATION_ERROR", "Definition version is invalid.", { field: "expectedVersion", reason: "invalid" });
    const now = this.deps.clock.now();
    return this.deps.unitOfWork.execute((tx) => {
      const current = tx.projects.getDefinition(id, input.expectedVersion);
      if (!current) {
        const latest = this.deps.definitions.getLatest(id);
        if (!latest) throw applicationError("NOT_FOUND", "Process definition was not found.", { resource: "process_definition" });
        throw versionConflict("process_definition", id, input.expectedVersion, latest.version);
      }
      const latest = this.deps.definitions.getLatest(id);
      if (!latest || latest.version !== input.expectedVersion) throw versionConflict("process_definition", id, input.expectedVersion, latest?.version ?? null);
      const definition: ProcessDefinitionVersion = { id, version: current.version + 1, taskId: current.taskId, ...spec, specHash: processSpecHash(spec), createdAt: now };
      tx.projects.addDefinition(definition);
      return definition;
    });
  }

  pageSchedules(taskId?: Uuid, key: CreatedAtIdKey | null = null, limit = 100): KeysetPage<Schedule, CreatedAtIdKey> {
    validateLimit(limit);
    return this.deps.schedules.page(taskId === undefined ? {} : { taskId }, { after: key, limit });
  }

  getSchedule(id: Uuid): Schedule {
    const schedule = this.deps.schedules.getById(id);
    if (!schedule) throw applicationError("NOT_FOUND", "Schedule was not found.", { resource: "schedule" });
    return schedule;
  }

  disableSchedule(id: Uuid): Schedule {
    const now = this.deps.clock.now();
    return this.deps.unitOfWork.execute((tx) => {
      const current = tx.projects.getSchedule(id);
      if (!current) throw applicationError("NOT_FOUND", "Schedule was not found.", { resource: "schedule" });
      const next: Schedule = { ...current, enabled: false, nextRunAt: null, version: current.version + 1, updatedAt: now };
      if (!tx.projects.updateSchedule(current, next)) {
        const actual = this.deps.schedules.getById(id);
        throw versionConflict("schedule", id, current.version, actual?.version ?? null);
      }
      return next;
    });
  }

  createSchedule(input: CreateScheduleInput): Schedule {
    validateScheduleInput(input);
    const now = this.deps.clock.now();
    return this.deps.unitOfWork.execute((tx) => {
      const definition = tx.projects.getDefinition(input.definitionId, input.definitionVersion);
      if (!definition || definition.taskId !== input.taskId) throw applicationError("NOT_FOUND", "Process definition was not found.", { resource: "process_definition" });
      const schedule: Schedule = {
        id: input.scheduleId ?? this.deps.ids.next(), taskId: input.taskId, definitionId: input.definitionId, definitionVersion: input.definitionVersion,
        kind: input.kind, runAt: input.runAt, intervalSeconds: input.kind === "interval" ? input.intervalSeconds! : null, misfirePolicy: "coalesce", nextRunAt: input.enabled === false ? null : input.runAt,
        enabled: input.enabled ?? true, version: 1, createdAt: now, updatedAt: now,
      };
      tx.projects.addSchedule(schedule);
      return schedule;
    });
  }

  tick(limit: number): number {
    if (!Number.isInteger(limit) || limit <= 0) throw new RangeError("Schedule batch limit must be positive");
    const now = this.deps.clock.now();
    const due = this.deps.schedules.listDue(now, limit);
    let materialized = 0;
    for (const candidate of due) {
      const occurrence = this.deps.unitOfWork.execute((tx) => {
        const current = tx.projects.getSchedule(candidate.id);
        if (!current) return null;
        const dueResult = materializeDueSchedule(current, now);
        if (dueResult.kind !== "due") return null;
        const definition = tx.projects.getDefinition(current.definitionId, current.definitionVersion);
        if (!definition) throw applicationError("NOT_FOUND", "Process definition was not found.", { resource: "process_definition" });
        definitionForSchedule(current, definition);
        const next = { ...dueResult.schedule, version: current.version + 1, updatedAt: now };
        if (!tx.projects.updateSchedule(current, next)) return null;
        const occurrence = { scheduleId: current.id, taskId: current.taskId, definition, scheduledFor: dueResult.scheduledFor, queuedAt: now };
        this.deps.enqueueScheduleOccurrence(tx, occurrence);
        return occurrence;
      });
      if (occurrence) {
        materialized++;
      }
    }
    return materialized;
  }
}

function validateSpec(spec: ProcessSpec): ProcessSpec {
  try {
    return normalizeProcessSpec({ executable: spec.executable, args: spec.args, cwd: spec.cwd, envPolicy: spec.envPolicy });
  } catch (error) {
    if (error instanceof ProcessSpecValidationError) throw applicationError("VALIDATION_ERROR", "Process specification is invalid.", { field: "process", reason: error.reason });
    throw error;
  }
}
function validateScheduleInput(input: CreateScheduleInput): void {
  if (!Number.isFinite(Date.parse(input.runAt))) throw applicationError("VALIDATION_ERROR", "Schedule time is invalid.", { field: "runAt", reason: "invalid" });
  if (input.kind === "interval" && (!Number.isInteger(input.intervalSeconds) || input.intervalSeconds! <= 0)) throw applicationError("VALIDATION_ERROR", "Interval must be a positive whole number of seconds.", { field: "intervalSeconds", reason: "invalid" });
  if (input.kind === "one-shot" && input.intervalSeconds !== undefined && input.intervalSeconds !== null) throw applicationError("VALIDATION_ERROR", "One-shot schedules cannot have an interval.", { field: "intervalSeconds", reason: "invalid" });
}
function validateLimit(limit: number): void { if (!Number.isInteger(limit) || limit <= 0) throw applicationError("VALIDATION_ERROR", "Page limit is invalid.", { field: "limit", reason: "invalid" }); }
function versionConflict(resource: "process_definition" | "schedule", id: Uuid, expectedVersion: number, actualVersion: number | null) { return applicationError("VERSION_CONFLICT", "Resource version does not match.", { resource, id, expectedVersion, actualVersion }); }
