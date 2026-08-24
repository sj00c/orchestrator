import type {
  CanonicalTimestamp,
  EventV1,
  PlannedState,
  PlannedTransitionCommandName,
  Project,
  Task,
  Uuid,
} from "../domain/model.ts";

export interface ProjectQueries {
  getById(id: Uuid): Project | null;
  getByName(name: string): Project | null;
  list(): Project[];
}

export interface TaskQueries {
  getById(id: Uuid): Task | null;
  listByProject(projectId: Uuid): Task[];
}

export interface HistoryQueries {
  listForProject(projectId: Uuid, since: CanonicalTimestamp | null, limit: number): EventV1[];
  listForTask(taskId: Uuid, since: CanonicalTimestamp | null, limit: number): EventV1[];
}

export interface ProjectWriteRepository {
  /** Reads the current project by its exact lowercase UUID inside this transaction. */
  getProjectById(id: Uuid): Project | null;
  /** Reads the current project by its case-insensitive exact name inside this transaction. */
  getProjectByName(name: string): Project | null;
  /**
   * Resolves a project reference without trimming: an existing lowercase UUID wins;
   * otherwise the same input is looked up as a case-insensitive exact name.
   */
  resolveProjectReference(reference: string): Project | null;
  /** Inserts version-one current state and its project.added event atomically. */
  add(project: Project): void;
}

export interface TaskWriteRepository {
  getById(id: Uuid): Task | null;
  /** Inserts version-one current state and its task.added event atomically. */
  add(task: Task): void;
  /** Updates current state with a defensive version guard and appends its exact event. */
  applyPlannedTransition(
    previous: Task,
    next: Task,
    command: PlannedTransitionCommandName,
  ): void;
}

/** Write capabilities valid only for the dynamic extent of UnitOfWork.execute. */
export interface TransactionWritePorts {
  readonly projects: ProjectWriteRepository;
  readonly tasks: TaskWriteRepository;
}
