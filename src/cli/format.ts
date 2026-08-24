import { errorEnvelope, type AnyApplicationError } from "../application/errors.ts";
import type { SuccessEnvelopeV1 } from "../domain/model.ts";

export function success<Data>(command: string, data: Data): SuccessEnvelopeV1<Data> { return { ok: true, data, meta: { command, schemaVersion: 1 } }; }
export function json(value: unknown): string { return `${JSON.stringify(value)}\n`; }
export function humanSuccess(command: string, data: Record<string, unknown>): string {
  if ("status" in data && command.startsWith("daemon ")) {
    const status = data.status as Record<string, unknown>;
    const logs = data.logs as Record<string, unknown> | undefined;
    const state = status.state ?? (status.installed === false ? "absent" : status.running ? "present" : "stopped");
    return logs ? `${state}\n${logs.stdoutPath ?? logs.stdout}\n${logs.stderrPath ?? logs.stderr}` : `${state}${status.detail ? ` ${status.detail}` : ""}`;
  }
  if ("project" in data) return projectLine(data.project as Record<string, unknown>);
  if ("processDefinition" in data) return definitionLine(data.processDefinition as Record<string, unknown>);
  if ("processDefinitions" in data) return (data.processDefinitions as Array<Record<string, unknown>>).map(definitionLine).join("\n");
  if ("schedule" in data) return scheduleLine(data.schedule as Record<string, unknown>);
  if ("schedules" in data) return (data.schedules as Array<Record<string, unknown>>).map(scheduleLine).join("\n");
  if ("attempt" in data) return attemptLine(data.attempt as Record<string, unknown>);
  if ("attempts" in data) return (data.attempts as Array<Record<string, unknown>>).map(attemptLine).join("\n");
  if ("task" in data) return taskLine(data.task as Record<string, unknown>);
  if ("projects" in data && command === "status") return (data.projects as Array<Record<string, unknown>>).map((item) => { const project = item.project as Record<string, unknown>; const counts = item.counts as { planned: Record<string, number>; observed: Record<string, number> }; return `${projectLine(project)}\nplanned ${Object.entries(counts.planned).map(([key, value]) => `${key}=${value}`).join(" ")}\nobserved ${Object.entries(counts.observed).map(([key, value]) => `${key}=${value}`).join(" ")}\n${(item.tasks as Array<Record<string, unknown>>).map(taskLine).join("\n")}`; }).join("\n");
  if ("projects" in data) return (data.projects as Array<Record<string, unknown>>).map(projectLine).join("\n");
  if ("tasks" in data) return (data.tasks as Array<Record<string, unknown>>).map(taskLine).join("\n");
  if ("events" in data) return (data.events as Array<Record<string, unknown>>).map((event) => `${event.sequence} ${event.occurredAt} ${event.eventType} ${event.aggregateId}`).join("\n");
  return "";
}
export function humanError(error: AnyApplicationError): string { return `${error.code}: ${error.message}\n`; }
export function formattedError(command: string, error: AnyApplicationError, jsonOutput: boolean): string { return jsonOutput ? json(errorEnvelope(command, error)) : humanError(error); }
function projectLine(project: Record<string, unknown>): string { return `${project.id} ${project.name} ${project.rootPath}`; }
function taskLine(task: Record<string, unknown>): string { return `${task.id} ${task.projectId} ${task.plannedState}/${task.observedState} ${task.title}`; }
function definitionLine(definition: Record<string, unknown>): string { return `${definition.id} ${definition.taskId} ${definition.version}`; }
function scheduleLine(schedule: Record<string, unknown>): string { return `${schedule.id} ${schedule.taskId} ${schedule.kind} ${schedule.enabled}`; }
function attemptLine(attempt: Record<string, unknown>): string { return `${attempt.id} ${attempt.taskId} ${attempt.state}`; }
