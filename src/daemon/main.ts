import { mkdir, lstat, unlink, chmod, rm } from "node:fs/promises";
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ExecutionService, type PublicExecutionAttempt } from "../application/execution-service.ts";
import { IdempotencyService, type StoredHttpOutcome } from "../application/idempotency-service.ts";
import { ObservationService } from "../application/observation-service.ts";
import { RandomUuidGenerator, OrchestratorService, SystemClock } from "../application/service.ts";
import { SchedulingService } from "../application/scheduling-service.ts";
import { BunRunnerRuntime } from "../adapters/process/runner-runtime.ts";
import { processSpecHash } from "../domain/process-spec.ts";
import { SystemPathCanonicalizer } from "../adapters/system/path.ts";
import { FsNativeInstanceLock } from "../adapters/lock/fs-native-lock.ts";
import { openDaemonSqliteDatabase } from "../adapters/sqlite/database.ts";
import { resolveEndpoint } from "../client/endpoint.ts";
import type { EndpointOptions } from "../client/endpoint.ts";
import { ApplicationError, applicationError } from "../application/errors.ts";
import { ObserverRegistry } from "../observers/registry.ts";
import { DarwinProcessInspector } from "../adapters/process/darwin-inspector.ts";
import { ProcessObserver } from "../observers/process-observer.ts";
import { DaemonLoop } from "../scheduler/loop.ts";
import { DaemonLifecycle } from "./lifecycle.ts";
import { createDaemonServer } from "./server.ts";
import { ShutdownBarrier } from "./shutdown-barrier.ts";
import { httpError, type RouteName } from "../api/v1/routes.ts";
import type { CountsV1, ProcessDefinitionVersion, ProjectV1, Schedule, TaskV1 } from "../domain/model.ts";
import type { SqliteDatabase } from "../adapters/sqlite/database.ts";
import type { CreatedAtIdKey, DefinitionKey, EventSequenceKey, QueuedAtIdKey, StatusFlatKey } from "../ports/repositories.ts";
import type { KeysetPage } from "../ports/repositories.ts";
import type { HistoryPageData, StatusFlatRecord } from "../api/v1/contract.ts";
import { canonicalJson, successEnvelope } from "../api/v1/contract.ts";
import { createCursor, parseCursor } from "../api/v1/pagination.ts";
import { buildBoundedPage } from "../api/v1/pagination.ts";

const VERSION = "0.1.0";
const clock = new SystemClock();
const ATTEMPT_TOKEN_FILE = "daemon.token";

export interface DaemonOptions extends EndpointOptions { database?: string; }

export async function startDaemon(options: DaemonOptions = parseDaemonOptions(process.argv.slice(2))): Promise<void> {
  process.umask(0o077);
  const endpoint = await resolveEndpoint(options);
  const databasePath = options.database ?? endpoint.databasePath;
  if (!isAbsolute(databasePath)) throw applicationError("USAGE_ERROR", "Daemon database path must be absolute.", { argument: "--database" });
  const stateDirectory = dirname(databasePath);
  const attemptsDirectory = join(stateDirectory, "attempts");
  await prepareSecureDirectory(dirname(endpoint.socketPath));
  await prepareSecureDirectory(stateDirectory);
  await prepareSecureDirectory(attemptsDirectory);
  const lock = FsNativeInstanceLock.acquire(`${endpoint.socketPath}.lock`);
  let existingDatabase: { fd: number; dev: number; ino: number } | null = null;
  try {
    verifyDaemonLockPreflight(lock);
    await removeStaleSocket(endpoint.socketPath);
    existingDatabase = await prepareSecureDatabaseFile(databasePath);
    await secureSqliteSidecars(databasePath);
  } catch (error) {
    if (existingDatabase !== null) closeSync(existingDatabase.fd);
    lock.release();
    throw error;
  }
  let database: ReturnType<typeof openDaemonSqliteDatabase> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let idempotencyCompaction: ReturnType<typeof setInterval> | undefined;
  try {
    if (existingDatabase === null) throw applicationError("CONFIG_ERROR", "Database descriptor was not prepared.", { key: databasePath });
    database = openDaemonSqliteDatabase(lock.token, databasePath, { expectedFileIdentity: { dev: existingDatabase.dev, ino: existingDatabase.ino } });
    if (existingDatabase !== null) {
      closeSync(existingDatabase.fd);
      existingDatabase = null;
    }
    await chmod(databasePath, 0o600);
    await secureSqliteSidecars(databasePath);
    const daemonDatabase = database;
    const ids = new RandomUuidGenerator();
    const pageSecret = crypto.getRandomValues(new Uint8Array(32));
    const instanceId = ids.next();
    const lifecycle = new DaemonLifecycle({ clock, unitOfWork: database, instanceId, version: VERSION, configFingerprint: endpoint.configFingerprint });
    lifecycle.start();
    const runner = new BunRunnerRuntime();
    const attemptTokens = new Map<string, string>();
    const runtime = {
      attemptDirectory: (id: string) => join(attemptsDirectory, id),
      issueToken: (id: string) => {
        const existing = attemptTokens.get(id);
        if (existing) return existing;
        const directory = join(attemptsDirectory, id);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        assertSecureDirectory(directory);
        const path = join(directory, ATTEMPT_TOKEN_FILE);
        try {
          const restored = readFileSync(path, "utf8");
          if (/^[a-f0-9]{64}$/.test(restored)) { attemptTokens.set(id, restored); return restored; }
          throw applicationError("CONFIG_ERROR", "Attempt token file is invalid.", { key: path });
        } catch (error) {
          if (!isAbsent(error)) throw error;
        }
        const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
        writeFileSync(path, token, { mode: 0o600, flag: "wx" });
        chmodSync(path, 0o600);
        attemptTokens.set(id, token);
        return token;
      },
      graceMs: 5_000,
      hardStopMs: 10_000,
    };
    const execution = new ExecutionService({ clock, ids, attempts: database.attempts, unitOfWork: database, runner, runtime, instanceId, leaseSeconds: 10 });
    const idempotency = new IdempotencyService({ clock, unitOfWork: database, instanceId });
    const scheduling = new SchedulingService({ clock, ids, definitions: database.definitions, schedules: database.schedules, unitOfWork: database, enqueueScheduleOccurrence: (tx, occurrence) => execution.enqueueScheduleOccurrence(tx, occurrence) });
    const service = new OrchestratorService({ projects: database.projects, tasks: database.tasks, history: database.history, unitOfWork: database, paths: new SystemPathCanonicalizer() });
    const observations = new ObservationService({ evidence: database.evidence, tasks: database.tasks, unitOfWork: database });
    const observers = new ObserverRegistry();
    let observationKey: QueuedAtIdKey | null = null;
    observers.register({
      source: "process",
      observe: async () => {
        const page = execution.list(undefined, observationKey, 100);
        observationKey = page.nextKey;
        const observer = new ProcessObserver({
          clock,
          inspector: new DarwinProcessInspector(),
          attempts: () => page.items.map((attempt) => execution.getInternal(attempt.id)),
          task: (taskId) => daemonDatabase.tasks.getById(taskId),
        });
        return observer.poll();
      },
    });
    const loop = new DaemonLoop({ clock, timer: globalThis, scheduling, execution, observations, observers, tickSeconds: 1, dueBatchLimit: 100, claimBatchLimit: 25 });
    let healthy = false;
    const api = createDaemonServer({
      health: () => ({ ...lifecycle.snapshot(), ready: healthy }),
      dispatch: ({ route, input, idempotency: context }) => {
        const operation = () => dispatch(route.name, route.params, input, service, scheduling, execution, lifecycle, daemonDatabase, pageSecret);
        if (!route.mutation) return operation();
        if (context === null) throw applicationError("VALIDATION_ERROR", "Mutations require idempotency context.", { field: "idempotency-key", reason: "required" });
        return idempotency.execute(context, () => mutationOutcome(route.command, operation));
      },
    });
    server = Bun.serve({ unix: endpoint.socketPath, fetch: api.fetch });
    await chmod(endpoint.socketPath, 0o600);
    await verifyRunnerLockPreflight(lock, attemptsDirectory);
    await execution.recover(100);
    lifecycle.ready();
    healthy = true;
    loop.start();
    idempotencyCompaction = setInterval(() => idempotency.compactExpired(100), 60 * 60 * 1_000);
    const heartbeat = setInterval(() => lifecycle.heartbeat(), 5_000);
    const boundSocket = await lstat(endpoint.socketPath);
    const shutdown = new ShutdownBarrier({ beginDraining: () => { lifecycle.drain(); healthy = false; }, producers: [{ cancel: () => loop.stop() }, { cancel: () => { if (idempotencyCompaction !== undefined) clearInterval(idempotencyCompaction); } }], closeAdmission: api.closeAdmission, advanceGeneration: api.advanceGeneration, waitForInflight: api.waitForInflight, runner: { stopAll: (graceMs) => runner.stopAll({ graceMs, hardDeadlineMs: 10_000 }) }, runnerGraceMs: 5_000, reconcileAfterRunnerStop: () => execution.drain(), terminalHeartbeat: () => { lifecycle.stop(); }, closeDatabase: () => database?.close(), cleanupSocket: async () => { server?.stop(true); const current = await lstat(endpoint.socketPath).catch(() => null); if (current !== null && current.dev === boundSocket.dev && current.ino === boundSocket.ino) await unlink(endpoint.socketPath); lock.release(); } });
    const stop = () => {
      clearInterval(heartbeat);
      const hardExit = setTimeout(() => process.exit(1), 20_000);
      void shutdown.close().then(
        () => clearTimeout(hardExit),
        () => process.exit(1),
      );
    };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  } catch (error) {
    if (existingDatabase !== null) closeSync(existingDatabase.fd);
    if (idempotencyCompaction !== undefined) clearInterval(idempotencyCompaction);
    try { server?.stop(true); } catch { /* preserve startup error */ }
    try { database?.close(); } catch { /* preserve startup error */ }
    try { lock.release(); } catch { /* preserve startup error */ }
    throw error;
  }
}

function mutationOutcome(command: string, operation: () => unknown): StoredHttpOutcome {
  try {
    const value = operation();
    if (value instanceof Promise) {
      void Promise.resolve(value).catch(() => undefined);
      throw applicationError("CONSTRAINT_VIOLATION", "Idempotent mutation dispatch must be synchronous.", { constraint: "synchronous idempotency operation" });
    }
    return { status: 200, bodyText: `${JSON.stringify(successEnvelope(command, value))}\n` };
  } catch (error) {
    if (!(error instanceof ApplicationError)) throw error;
    if (error.code === "IDEMPOTENCY_IN_PROGRESS") throw error;
    const response = httpError(command, error);
    if (response.status < 400 || response.status >= 500) throw error;
    return { status: response.status, bodyText: `${JSON.stringify(response.body)}\n` };
  }
}

export function verifyDaemonLockPreflight(lock: FsNativeInstanceLock): void {
  lock.verifySpawnFdNoninheritance();
}
async function verifyRunnerLockPreflight(lock: FsNativeInstanceLock, attemptsDirectory: string): Promise<void> {
  const attemptId = crypto.randomUUID();
  const attemptDirectory = join(attemptsDirectory, `.lock-preflight-${attemptId}`);
  const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const runtime = new BunRunnerRuntime();
  const spec = { executable: "/bin/sleep", args: ["30"], cwd: null, envPolicy: { kind: "set" as const, values: {} } };
  const specHash = processSpecHash(spec);
  let handle: Awaited<ReturnType<BunRunnerRuntime["launch"]>> | null = null;
  try {
    const daemonDescriptors = snapshotProcessDescriptors(process.pid);
    handle = await runtime.launch({
      attemptId,
      attemptDirectory,
      token,
      leaseToken: 1,
      specHash,
      spec,
    });
    const grant = await runtime.exec({
      attemptId,
      attemptDirectory,
      token,
      leaseToken: 1,
      runner: handle.runner,
      specHash,
      spec,
    });
    assertProcessDoesNotHoldLock(handle.runner.pid, lock.path);
    assertProcessDoesNotHoldLock(grant.child.pid, lock.path);
    assertProcessDoesNotShareDaemonDescriptor(handle.runner.pid, daemonDescriptors);
    assertProcessDoesNotShareDaemonDescriptor(grant.child.pid, daemonDescriptors);
    assertRunnerDescriptorWhitelist(handle.runner.pid, handle.endpoint);
    assertChildDescriptorWhitelist(grant.child.pid);
    await runtime.stop({ attemptId, attemptDirectory, token, leaseToken: 1, runner: handle.runner, graceMs: 0 });
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (await runtime.readResult({ attemptId, attemptDirectory, token, leaseToken: 1, runner: handle.runner })) return;
      await Bun.sleep(20);
    }
    throw applicationError("LOCK_CAPABILITY_UNAVAILABLE", "Runner lock preflight did not produce a durable result.", { capability: "fd_whitelist", reason: "runner_result_missing" });
  } catch (error) {
    if (handle !== null) {
      try { process.kill(handle.runner.pid, "SIGKILL"); } catch { /* preflight process already exited */ }
    }
    if (error instanceof ApplicationError) throw error;
    throw applicationError("LOCK_CAPABILITY_UNAVAILABLE", "Runner lock preflight failed.", { capability: "fd_whitelist", reason: "runner_preflight_failed" });
  } finally {
    await rm(attemptDirectory, { recursive: true, force: true });
  }
}
function assertProcessDoesNotShareDaemonDescriptor(pid: number, daemonDescriptors: ReadonlySet<string>): void {
  const inherited = [...snapshotProcessDescriptors(pid)].some((identity) => daemonDescriptors.has(identity));
  if (inherited) {
    throw applicationError("LOCK_CAPABILITY_UNAVAILABLE", "Runner or child inherited a daemon descriptor.", { capability: "fd_whitelist", reason: "daemon_descriptor_inherited" });
  }
}
function assertRunnerDescriptorWhitelist(pid: number, controlEndpoint: string): void {
  const allowed = snapshotProcessDescriptors(pid, 0, 2);
  allowed.add(`name:${controlEndpoint}`);
  allowed.add("name:control.sock");
  const unexpected = [...snapshotProcessDescriptors(pid)].filter((identity) => !allowed.has(identity));
  if (unexpected.length !== 0) {
    throw applicationError("LOCK_CAPABILITY_UNAVAILABLE", "Runner opened a descriptor outside its explicit whitelist.", { capability: "fd_whitelist", reason: "runner_descriptor_not_whitelisted" });
  }
}
function assertChildDescriptorWhitelist(pid: number): void {
  if (snapshotProcessDescriptors(pid).size !== 0) {
    throw applicationError("LOCK_CAPABILITY_UNAVAILABLE", "User child inherited a descriptor outside stdin, stdout, and stderr.", { capability: "fd_whitelist", reason: "child_descriptor_not_whitelisted" });
  }
}
function snapshotProcessDescriptors(pid: number, minimumFd = 3, maximumFd = Number.MAX_SAFE_INTEGER): Set<string> {
  const probe = Bun.spawnSync(["/usr/sbin/lsof", "-FfDin", "-p", String(pid)], { stdout: "pipe", stderr: "pipe" });
  if (probe.exitCode !== 0) {
    throw applicationError("LOCK_CAPABILITY_UNAVAILABLE", "Unable to inspect preflight descriptors.", { capability: "fd_whitelist", reason: "descriptor_inspection_failed" });
  }
  const descriptors = new Set<string>();
  let descriptor: { fd: number; device: string | null; inode: string | null; name: string | null } | null = null;
  const collect = () => {
    if (descriptor === null || descriptor.fd < minimumFd || descriptor.fd > maximumFd) return;
    if (descriptor.device !== null && descriptor.inode !== null) {
      descriptors.add(`file:${descriptor.device}:${descriptor.inode}`);
      return;
    }
    if (descriptor.name !== null && !descriptor.name.startsWith("count=")) {
      descriptors.add(`name:${descriptor.name}`);
    }
  };
  for (const line of new TextDecoder().decode(probe.stdout).split("\n")) {
    if (line.startsWith("f")) {
      collect();
      const match = /^(\d+)/.exec(line.slice(1));
      descriptor = match === null ? null : { fd: Number(match[1]), device: null, inode: null, name: null };
    } else if (descriptor !== null && line.startsWith("D")) {
      descriptor.device = line.slice(1);
    } else if (descriptor !== null && line.startsWith("i")) {
      descriptor.inode = line.slice(1);
    } else if (descriptor !== null && line.startsWith("n")) {
      descriptor.name = line.slice(1);
    }
  }
  collect();
  return descriptors;
}
function assertProcessDoesNotHoldLock(pid: number, lockPath: string): void {
  const probe = Bun.spawnSync(["/usr/sbin/lsof", "-Fn", "-p", String(pid)], { stdout: "pipe", stderr: "pipe" });
  if (probe.exitCode !== 0) {
    throw applicationError("LOCK_CAPABILITY_UNAVAILABLE", "Unable to inspect preflight descriptors.", { capability: "fd_whitelist", reason: "descriptor_inspection_failed" });
  }
  const lockNames = new Set([lockPath, realpathSync(lockPath)]);
  const inherited = new TextDecoder().decode(probe.stdout).split("\n").some((line) => line.startsWith("n") && lockNames.has(line.slice(1)));
  if (inherited) {
    throw applicationError("LOCK_CAPABILITY_UNAVAILABLE", "Runner or child inherited the daemon lock descriptor.", { capability: "fd_whitelist", reason: "lock_descriptor_inherited" });
  }
}
async function prepareSecureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw applicationError("CONFIG_ERROR", "Socket directory is insecure.", { key: directory });
  await chmod(directory, 0o700);
}
async function prepareSecureDatabaseFile(path: string): Promise<{ fd: number; dev: number; ino: number }> {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
  } catch (error) {
    if (!isAbsent(error)) throw applicationError("CONFIG_ERROR", "Database path cannot be opened safely.", { key: path });
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  }
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.uid !== process.getuid?.()) {
    closeSync(fd);
    throw applicationError("CONFIG_ERROR", "Database path is unsafe.", { key: path });
  }
  fchmodSync(fd, 0o600);
  return { fd, dev: stat.dev, ino: stat.ino };
}
async function secureSqliteSidecars(databasePath: string): Promise<void> {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== process.getuid?.()) {
        throw applicationError("CONFIG_ERROR", "SQLite file is unsafe.", { key: path });
      }
      await chmod(path, 0o600);
    } catch (error) {
      if (!isAbsent(error)) throw error;
    }
  }
}
async function removeStaleSocket(socketPath: string): Promise<void> {
  try {
    const stat = await lstat(socketPath);
    if (stat.isSymbolicLink() || !stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw applicationError("CONFIG_ERROR", "Refusing unsafe socket path.", { key: socketPath });
    if (await socketAlive(socketPath)) throw applicationError("DAEMON_UNAVAILABLE", "Daemon is already running.", { endpoint: socketPath, reason: "connect_failed" });
    await unlink(socketPath);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}
function socketAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const timeout = setTimeout(() => done(false), 1_000);
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
function dispatch(name: RouteName, params: Record<string, string>, input: unknown, service: OrchestratorService, scheduling: SchedulingService, execution: ExecutionService, lifecycle: DaemonLifecycle, database: SqliteDatabase, pageSecret: Uint8Array): unknown | Promise<unknown> {
  const body = input as Record<string, unknown>;
  switch (name) {
    case "health": return lifecycle.snapshot();
    case "project.add": return service.addProject(body.name as string, body.root as string);
    case "project.list": return keysetPage(body, pageSecret, "project", "projects.v1", "project list", (project: ProjectV1) => ({ createdAt: project.createdAt, id: project.id }), (key, limit) => database.projects.page({ after: key, limit }));
    case "project.show": return service.showProject(params.project!);
    case "task.add": return service.addTask(body.project as string, body.title as string, body.description as string | null, body.plannedState as "planned" | "ready");
    case "task.list": return keysetPage(body, pageSecret, "task", "tasks.v1", "task list", (task: TaskV1) => ({ createdAt: task.createdAt, id: task.id }), (key, limit) => database.tasks.page({
      ...(typeof body.project === "string" ? { projectId: service.showProject(body.project).id } : {}),
      ...(typeof body.plannedState === "string" ? { plannedState: body.plannedState as never } : {}),
      ...(typeof body.observedState === "string" ? { observedState: body.observedState as never } : {}),
    }, { after: key, limit }));
    case "task.show": return service.showTask(params.task!);
    case "task.transition": return service.transitionTask(params.task!, body as never);
    case "status": return statusPage(database, body, pageSecret);
    case "history.project": return historyPage("project", service.showProject(params.project!).id, body, pageSecret, database);
    case "history.task": return historyPage("task", service.showTask(params.task!).id, body, pageSecret, database);
    case "definition.add": return scheduling.createDefinition(body as never);
    case "definition.list": return keysetPage(body, pageSecret, "process_definition", "definitions.v1", "process-definition list", (definition: ProcessDefinitionVersion) => ({ createdAt: definition.createdAt, id: definition.id, version: definition.version }), (key: DefinitionKey | null, limit) => scheduling.pageDefinitions(typeof body.taskId === "string" ? body.taskId : undefined, key, limit));
    case "definition.show": return scheduling.getDefinition(params.definition!);
    case "definition.version": return scheduling.versionDefinition(params.definition!, body as never);
    case "schedule.add": return scheduling.createSchedule(body as never);
    case "schedule.list": return keysetPage(body, pageSecret, "schedule", "schedules.v1", "schedule list", (schedule: Schedule) => ({ createdAt: schedule.createdAt, id: schedule.id }), (key: CreatedAtIdKey | null, limit) => scheduling.pageSchedules(typeof body.taskId === "string" ? body.taskId : undefined, key, limit));
    case "schedule.show": return scheduling.getSchedule(params.schedule!);
    case "schedule.disable": return scheduling.disableSchedule(params.schedule!);
    case "attempt.add": return execution.start(body.taskId as string, body.definitionId as string, body.definitionVersion as number | undefined ?? 1);
    case "attempt.list": return keysetPage(body, pageSecret, "execution_attempt", "attempts.v1", "process list", (attempt: PublicExecutionAttempt) => ({ queuedAt: attempt.queuedAt, id: attempt.id }), (key: QueuedAtIdKey | null, limit) => execution.list(typeof body.taskId === "string" ? body.taskId : undefined, key, limit));
    case "attempt.show": return execution.status(params.attempt!);
    case "attempt.stop": return execution.stop(params.attempt!, typeof body.graceMs === "number" ? body.graceMs : undefined);
    case "attempt.resume": return execution.resume(params.attempt!);
    case "task.execution": return execution.latestForTask(params.task!);
    default: throw applicationError("NOT_FOUND", "API route is not available.", { resource: routeResource(name) });
  }
}
function routeResource(name: RouteName): "schedule" | "project" | "task" | "process_definition" | "execution_attempt" {
  if (name.startsWith("definition")) return "process_definition";
  if (name.startsWith("schedule")) return "schedule";
  if (name.startsWith("attempt")) return "execution_attempt";
  if (name.startsWith("task")) return "task";
  return "project";
}
function statusPage(database: SqliteDatabase, query: Record<string, unknown>, secret: Uint8Array): { items: StatusFlatRecord[]; nextCursor: string | null } {
  const projectId = typeof query.project === "string" ? database.projects.getById(query.project)?.id ?? database.projects.getByName(query.project)?.id : undefined;
  if (typeof query.project === "string" && projectId === undefined) throw applicationError("NOT_FOUND", "Project was not found.", { resource: "project" });
  const filterFingerprint = canonicalJson(typeof query.project === "string" ? { project: query.project } : {});
  const after = typeof query.cursor === "string" ? parseCursor<StatusFlatKey>(query.cursor, secret, { filterFingerprint, routeSchema: "status.v1" }) : null;
  const page = database.status.pageTaskFlat(projectId ?? null, { after, limit: typeof query.limit === "number" ? query.limit : 250 });
  const records = page.items.map((source) => ({
    source,
    record: {
      project: source.task === null ? source.project : null,
      countsFragment: source.countsFragment.planned === null || source.countsFragment.observed === null ? zeroCounts() : countStates(source.countsFragment.planned, source.countsFragment.observed),
      task: source.task,
      projectDone: source.projectDone,
    },
  }));
  const built = buildBoundedPage({
    resource: "status",
    records,
    ...(typeof query.limit === "number" ? { limit: query.limit } : {}),
    externalHasMore: page.nextKey !== null,
    keyOf: ({ source }) => statusKey(source),
    encodeCursor: (key) => createCursor({ key, filterFingerprint, routeSchema: "status.v1", expiresAt: Date.now() + 300_000 }, secret),
    envelope: (items, nextCursor) => ({ items: items.map(({ record }) => record), nextCursor }),
    serialize: (data) => JSON.stringify(successEnvelope("status", data)),
    recordId: ({ record }) => record.task?.id ?? record.project?.id ?? null,
  });
  return built.body;
}
function historyPage(scopeType: "project" | "task", scopeId: string, query: Record<string, unknown>, secret: Uint8Array, database: SqliteDatabase): HistoryPageData {
  const since = typeof query.since === "string" ? query.since : null;
  const limit = typeof query.limit === "number" ? query.limit : 1000;
  const filterFingerprint = canonicalJson({ scope: { type: scopeType, id: scopeId }, since });
  const routeSchema = `history.${scopeType}.v1`;
  let after = typeof query.cursor === "string" ? parseCursor<EventSequenceKey>(query.cursor, secret, { filterFingerprint, routeSchema }) : null;
  const events: HistoryPageData["events"] = [];
  let hasMore = false;
  while (events.length < 250) {
    const page = scopeType === "project"
      ? database.history.pageForProject(scopeId, { after, limit: 250 })
      : database.history.pageForTask(scopeId, { after, limit: 250 });
    for (let index = 0; index < page.items.length; index++) {
      const event = page.items[index]!;
      if (since !== null && event.occurredAt < since) continue;
      events.push(event);
      if (events.length === 250) {
        hasMore = index + 1 < page.items.length || page.nextKey !== null;
        break;
      }
    }
    if (events.length === 250 || page.nextKey === null) break;
    after = page.nextKey;
  }
  return buildBoundedPage({
    resource: "history",
    records: events,
    limit: 250,
    externalHasMore: hasMore,
    keyOf: (event) => ({ sequence: event.sequence }),
    encodeCursor: (key) => createCursor({ key, filterFingerprint, routeSchema, expiresAt: Date.now() + 300_000 }, secret),
    envelope: (events, nextCursor) => ({ scope: { type: scopeType, id: scopeId }, events: [...events], query: { limit, since }, nextCursor }),
    serialize: (data) => JSON.stringify(successEnvelope("history", data)),
    recordId: (event) => String(event.sequence),
  }).body;
}
function zeroCounts(): CountsV1 {
  return { planned: { planned: 0, ready: 0, active: 0, paused: 0, blocked: 0, done: 0, canceled: 0 }, observed: { unknown: 0, running: 0, succeeded: 0, failed: 0, idle: 0, stale: 0 } };
}
function count(task: TaskV1): CountsV1 {
  const result = zeroCounts();
  result.planned[task.plannedState]++;
  result.observed[task.observedState]++;
  return result;
}
function countStates(planned: keyof CountsV1["planned"], observed: keyof CountsV1["observed"]): CountsV1 {
  const result = zeroCounts();
  result.planned[planned]++;
  result.observed[observed]++;
  return result;
}
function keysetPage<Item, Key>(
  query: Record<string, unknown>,
  secret: Uint8Array,
  resource: string,
  routeSchema: string,
  command: string,
  keyOf: (item: Item) => Key,
  page: (key: Key | null, limit: number) => KeysetPage<Item, Key>,
): { items: Item[]; nextCursor: string | null } {
  const { cursor: _cursor, limit: _limit, ...filters } = query;
  const filterFingerprint = canonicalJson(filters);
  const key = typeof query.cursor === "string" ? parseCursor<Key>(query.cursor, secret, { filterFingerprint, routeSchema }) : null;
  const result = page(key, typeof query.limit === "number" ? query.limit : 250);
  return buildBoundedPage({
    resource,
    records: result.items,
    ...(typeof query.limit === "number" ? { limit: query.limit } : {}),
    externalHasMore: result.nextKey !== null,
    keyOf,
    encodeCursor: (nextKey) => createCursor({ key: nextKey, filterFingerprint, routeSchema, expiresAt: Date.now() + 300_000 }, secret),
    envelope: (items, nextCursor) => ({ items: [...items], nextCursor }),
    serialize: (data) => JSON.stringify(successEnvelope(command, data)),
    recordId: (item) => typeof item === "object" && item !== null && "id" in item && typeof item.id === "string" ? item.id : null,
  }).body;
}

function statusKey(record: { project: { createdAt: string; id: string }; task: { createdAt: string; id: string } | null }): StatusFlatKey {
  return {
    createdAt: record.project.createdAt,
    id: record.project.id,
    taskCreatedAt: record.task?.createdAt ?? null,
    taskId: record.task?.id ?? null,
  };
}

function parseDaemonOptions(argv: string[]): DaemonOptions {
  const options: DaemonOptions = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument !== "--config" && argument !== "--socket" && argument !== "--database") {
      throw applicationError("USAGE_ERROR", "Unknown daemon option.", { argument });
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) {
      throw applicationError("USAGE_ERROR", `Option ${argument} requires a value.`, { argument });
    }
    const key = argument === "--config" ? "config" : argument === "--socket" ? "socket" : "database";
    if (options[key] !== undefined) {
      throw applicationError("USAGE_ERROR", `Option ${argument} may only be specified once.`, { argument });
    }
    options[key] = argument === "--database" ? resolve(value) : value;
  }
  return options;
}
function isAbsent(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"; }
function assertSecureDirectory(directory: string): void {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw applicationError("CONFIG_ERROR", "Attempt directory is insecure.", { key: directory });
  }
  chmodSync(directory, 0o700);
}

if (import.meta.main) await startDaemon();
