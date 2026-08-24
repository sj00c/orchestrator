import { applicationError } from "./errors.ts";
import type { Clock, CountsV1, PlannedState, PlannedTransitionCommand, Project, ProjectV1, StatusProjectV1, Task, TaskV1 } from "../domain/model.ts";
import { OBSERVED_STATES, PLANNED_STATES } from "../domain/model.ts";
import { transitionPlanned } from "../domain/transitions.ts";
import type { HistoryQueries, ProjectQueries, TaskQueries } from "../ports/repositories.ts";
import type { UnitOfWork } from "../ports/unit-of-work.ts";

export interface IdGenerator { next(): string; }
export interface PathCanonicalizer { canonicalizeRoot(value: string): string; }
export class SystemClock implements Clock { now(): string { return new Date().toISOString(); } }
export class RandomUuidGenerator implements IdGenerator { next(): string { return crypto.randomUUID(); } }
export interface ApplicationDependencies { projects: ProjectQueries; tasks: TaskQueries; history: HistoryQueries; unitOfWork: UnitOfWork; paths: PathCanonicalizer; clock?: Clock; ids?: IdGenerator; }
export interface TaskListFilter { project?: string; plannedState?: PlannedState; observedState?: (typeof OBSERVED_STATES)[number]; }

export class OrchestratorService {
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  constructor(private readonly deps: ApplicationDependencies) {
    this.clock = deps.clock ?? new SystemClock();
    this.ids = deps.ids ?? new RandomUuidGenerator();
  }

  addProject(name: string, root: string): ProjectV1 {
    const normalizedName = required(name, "name");
    const rootPath = this.deps.paths.canonicalizeRoot(root);
    const now = this.clock.now();
    const project: Project = { id: this.ids.next(), name: normalizedName, rootPath, version: 1, createdAt: now, updatedAt: now };
    this.deps.unitOfWork.execute((tx) => tx.projects.add(project));
    return project;
  }
  listProjects(): ProjectV1[] { return this.deps.projects.list(); }
  showProject(reference: string): ProjectV1 { return this.resolveProject(reference); }

  addTask(projectReference: string, title: string, description: string | null, plannedState: "planned" | "ready" = "planned"): TaskV1 {
    if (projectReference.length === 0) throw applicationError("VALIDATION_ERROR", "Project reference is required.", { field: "project", reason: "required" });
    const normalizedTitle = required(title, "title");
    return this.deps.unitOfWork.execute((tx) => {
      const project = tx.projects.resolveProjectReference(projectReference);
      if (!project) throw applicationError("NOT_FOUND", "Project was not found.", { resource: "project" });
      const now = this.clock.now();
      const task: Task = { id: this.ids.next(), projectId: project.id, title: normalizedTitle, description, plannedState, observedState: "unknown", blockedReason: null, version: 1, createdAt: now, updatedAt: now, startedAt: null, finishedAt: null };
      tx.tasks.add(task);
      return task;
    });
  }
  listTasks(filter: TaskListFilter = {}): TaskV1[] {
    const projectId = filter.project === undefined ? undefined : this.resolveProject(filter.project).id;
    const tasks = projectId === undefined ? this.deps.projects.list().flatMap((project) => this.deps.tasks.listByProject(project.id)) : this.deps.tasks.listByProject(projectId);
    return tasks
      .filter((task) => (filter.plannedState === undefined || task.plannedState === filter.plannedState) && (filter.observedState === undefined || task.observedState === filter.observedState))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }
  showTask(id: string): TaskV1 { return this.requireTask(id); }
  transitionTask(id: string, command: PlannedTransitionCommand): TaskV1 {
    validateTaskId(id);
    return this.deps.unitOfWork.execute((tx) => {
      const task = tx.tasks.getById(id);
      if (!task) throw applicationError("NOT_FOUND", "Task was not found.", { resource: "task" });
      const result = transitionPlanned(task, command, this.clock);
      if (!result.ok) throw applicationError("INVALID_TRANSITION", "Task cannot make that planned-state transition.", { taskId: result.taskId, command: result.command, fromState: result.fromState, allowedFrom: [...result.allowedFrom] });
      const next: Task = { ...task, ...result.next };
      tx.tasks.applyPlannedTransition(task, next, result.command);
      return next;
    });
  }
  status(projectReference?: string): StatusProjectV1[] {
    const projects = projectReference === undefined ? this.deps.projects.list() : [this.resolveProject(projectReference)];
    return projects.map((project) => {
      const tasks = this.deps.tasks.listByProject(project.id);
      return { project, counts: counts(tasks), tasks };
    });
  }
  historyProject(reference: string, since: string | null, limit: number) {
    const project = this.resolveProject(reference);
    return { scope: { type: "project" as const, id: project.id }, events: this.deps.history.listForProject(project.id, since, limit), query: { limit, since } };
  }
  historyTask(id: string, since: string | null, limit: number) {
    const task = this.requireTask(id);
    return { scope: { type: "task" as const, id: task.id }, events: this.deps.history.listForTask(task.id, since, limit), query: { limit, since } };
  }
  private resolveProject(reference: string): Project {
    if (reference.length === 0) throw applicationError("VALIDATION_ERROR", "Project reference is required.", { field: "project", reason: "required" });
    const byId = isUuid(reference) ? this.deps.projects.getById(reference) : null;
    const project = byId ?? this.deps.projects.getByName(reference);
    if (!project) throw applicationError("NOT_FOUND", "Project was not found.", { resource: "project" });
    return project;
  }
  private requireTask(id: string): Task {
    validateTaskId(id);
    const task = this.deps.tasks.getById(id);
    if (!task) throw applicationError("NOT_FOUND", "Task was not found.", { resource: "task" });
    return task;
  }
}

function required(value: string, field: string): string { const result = value.trim(); if (!result) throw applicationError("VALIDATION_ERROR", `${field} is required.`, { field, reason: "required" }); return result; }
function isUuid(value: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value); }
function validateTaskId(id: string): void { if (!isUuid(id)) throw applicationError("VALIDATION_ERROR", "Task id must be a lowercase UUID v4.", { field: "task", reason: "invalid_uuid" }); }
function counts(tasks: Task[]): CountsV1 { const planned = Object.fromEntries(PLANNED_STATES.map((state) => [state, 0])) as CountsV1["planned"]; const observed = Object.fromEntries(OBSERVED_STATES.map((state) => [state, 0])) as CountsV1["observed"]; for (const task of tasks) { planned[task.plannedState]++; observed[task.observedState]++; } return { planned, observed }; }
