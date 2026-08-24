import { errorEnvelope, type AnyApplicationError } from "../application/errors.ts";
import type { SuccessEnvelopeV1 } from "../domain/model.ts";

export function success(command: string, data: SuccessEnvelopeV1["data"]): SuccessEnvelopeV1 { return { ok: true, data, meta: { command, schemaVersion: 1 } }; }
export function json(value: unknown): string { return `${JSON.stringify(value)}\n`; }
export function humanSuccess(command: string, data: Record<string, unknown>): string {
  if ("project" in data) return projectLine(data.project as Record<string, unknown>);
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
