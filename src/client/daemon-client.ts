import { applicationError, type ErrorEnvelopeV1 } from "../application/errors.ts";
import { request as httpRequest } from "node:http";
import type { CountsV1, StatusProjectV1, SuccessEnvelopeV1, TaskV1 } from "../domain/model.ts";
import { canonicalRequestHash, isLowercaseUuid, type ApiEnvelope, type HealthV1, type MutationBody, type StatusFlatRecord } from "../api/v1/contract.ts";
import { resolveRoute } from "../api/v1/routes.ts";
import { CONNECT_TIMEOUT_MS, HEALTH_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from "../api/v1/contract.ts";
import type { ResolvedEndpoint } from "./endpoint.ts";

export interface TransportRequest { method: string; path: string; headers: Record<string, string>; body?: string; timeoutMs: number; connectTimeoutMs: number; }
export interface TransportResponse { status: number; headers: Headers | Record<string, string | undefined>; body: string; }
export interface DaemonTransport { request(endpoint: string, request: TransportRequest): Promise<TransportResponse>; }
export class TransportFailure extends Error { constructor(readonly sent: boolean, message: string, readonly cause?: unknown) { super(message); } }

/** The only production transport; callers never open the product database. */
export class UdsHttpTransport implements DaemonTransport {
  request(endpoint: string, request: TransportRequest): Promise<TransportResponse> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let connected = false;
      let sent = false;
      let responseStarted = false;
      let client: ReturnType<typeof httpRequest>;
      const fail = (error: unknown, forceSent?: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        clearTimeout(overallTimer);
        client.removeAllListeners();
        client.destroy();
        const didSend = forceSent ?? sent;
        reject(new TransportFailure(didSend, didSend ? "Daemon request did not complete." : "Unable to connect to daemon.", error));
      };
      const connectTimer = setTimeout(() => fail(new Error("Daemon connection timed out."), sent), request.connectTimeoutMs);
      const overallTimer = setTimeout(() => fail(new Error("Daemon request timed out."), sent), request.timeoutMs);
      client = httpRequest({
        socketPath: endpoint,
        method: request.method,
        path: request.path,
        headers: request.headers,
      }, (response) => {
        responseStarted = true;
        clearTimeout(connectTimer);
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer | Uint8Array) => {
          const value = Buffer.from(chunk);
          bytes += value.byteLength;
          if (bytes > 1_048_576) {
            response.destroy();
            fail(new Error("Daemon response exceeds the byte limit."), true);
            return;
          }
          chunks.push(value);
        });
        response.once("error", (error) => fail(error, true));
        response.once("end", () => {
          if (settled) return;
          settled = true;
          clearTimeout(overallTimer);
          client.removeAllListeners();
          resolve({ status: response.statusCode ?? 0, headers: responseHeaders(response.headers), body: Buffer.concat(chunks).toString("utf8") });
        });
      });
      client.once("socket", (socket) => {
        const onConnected = () => {
          connected = true;
          if (client.writableFinished) sent = true;
          clearTimeout(connectTimer);
        };
        if (socket.connecting) socket.once("connect", onConnected);
        else onConnected();
      });
      client.once("finish", () => {
        if (connected) sent = true;
      });
      client.once("error", (error) => {
        if (!responseStarted) fail(error, sent);
      });
      if (request.body === undefined) client.end();
      else client.end(request.body);
    });
  }
}

export interface DaemonClientOptions { endpoint: ResolvedEndpoint; transport?: DaemonTransport; ids?: () => string; }
export class DaemonClient {
  private readonly transport: DaemonTransport;
  private readonly ids: () => string;
  constructor(private readonly options: DaemonClientOptions) { this.transport = options.transport ?? new UdsHttpTransport(); this.ids = options.ids ?? (() => crypto.randomUUID()); }

  async health(): Promise<SuccessEnvelopeV1<HealthV1>> {
    const requestId = this.nextId("request ID");
    let response: TransportResponse;
    try {
      response = await this.send("GET", "/v1/health", { Accept: "application/json", "X-Request-Id": requestId }, undefined, HEALTH_TIMEOUT_MS);
    } catch (error) {
      throw unavailable(this.options.endpoint.socketPath, error);
    }
    if (header(response.headers, "x-request-id") !== requestId) {
      throw unavailable(this.options.endpoint.socketPath, new Error("Daemon did not echo X-Request-Id."));
    }
    const envelope = parseEnvelope<HealthV1>(response.body);
    if (!envelope.ok) throwRemote(envelope);
    if (envelope.data.configFingerprint !== this.options.endpoint.configFingerprint) throw applicationError("DAEMON_UNAVAILABLE", "Daemon endpoint fingerprint does not match configuration.", { endpoint: this.options.endpoint.socketPath, reason: "health_failed" });
    return envelope;
  }

  async request<Data>(method: "GET" | "POST", path: string, data?: unknown, query: URLSearchParams = new URLSearchParams(), idempotencyKey?: string): Promise<SuccessEnvelopeV1<Data>> {
    const route = resolveRoute(method, path);
    const fullPath = query.size ? `${path}?${query.toString()}` : path;
    const mutation = method === "POST";
    const requestId = this.nextId("request ID");
    const key = mutation ? (idempotencyKey ?? this.nextId("idempotency key")) : undefined;
    if (key !== undefined && !isLowercaseUuid(key)) throw applicationError("VALIDATION_ERROR", "Idempotency key must be a lowercase UUID v4.", { field: "idempotency-key", reason: "invalid_uuid" });
    const body: MutationBody<unknown> | undefined = mutation ? { schemaVersion: 1, data } : undefined;
    const headers: Record<string, string> = { Accept: "application/json", "X-Request-Id": requestId };
    if (body) { headers["Content-Type"] = "application/json"; headers["Idempotency-Key"] = key!; headers["X-Request-Hash"] = canonicalRequestHash(method, path, query, data); }
    let response: TransportResponse;
    try { response = await this.send(method, fullPath, headers, body === undefined ? undefined : JSON.stringify(body), REQUEST_TIMEOUT_MS); }
    catch (error) {
      if (mutation && error instanceof TransportFailure && error.sent) throw applicationError("UNKNOWN_OUTCOME", "Mutation outcome is unknown; retry using the same idempotency key.", { idempotencyKey: key!, requestId, command: route.command });
      throw unavailable(this.options.endpoint.socketPath, error);
    }
    const echoedRequestId = header(response.headers, "x-request-id");
    if (echoedRequestId !== requestId) throw unavailable(this.options.endpoint.socketPath, new Error("Daemon did not echo X-Request-Id."));
    const envelope = parseEnvelope<Data>(response.body);
    if (!envelope.ok) throwRemote(envelope);
    return envelope;
  }

  async status(query = new URLSearchParams()): Promise<SuccessEnvelopeV1<{ projects: StatusProjectV1[] }>> {
    const records: StatusFlatRecord[] = [];
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    do {
      const pageQuery = new URLSearchParams(query);
      if (cursor) pageQuery.set("cursor", cursor);
      const page = await this.request<{ items: StatusFlatRecord[]; nextCursor: string | null }>("GET", "/v1/status", undefined, pageQuery);
      records.push(...page.data.items);
      const nextCursor = page.data.nextCursor;
      if (nextCursor !== null && (page.data.items.length === 0 || nextCursor === cursor || seenCursors.has(nextCursor))) throw new Error("Status pagination did not make progress.");
      if (nextCursor !== null) seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor !== null);
    return { ok: true, data: { projects: reconstructStatus(records) }, meta: { command: "status", schemaVersion: 1 } };
  }

  private nextId(label: string): string { const value = this.ids(); if (!isLowercaseUuid(value)) throw new Error(`Generated ${label} is not a lowercase UUID v4.`); return value; }
  private async send(method: string, path: string, headers: Record<string, string> | undefined, body: string | undefined, timeoutMs: number): Promise<TransportResponse> {
    const request: TransportRequest = {
      method,
      path,
      headers: headers ?? { Accept: "application/json" },
      timeoutMs,
      connectTimeoutMs: CONNECT_TIMEOUT_MS,
      ...(body === undefined ? {} : { body }),
    };
    try { return await this.transport.request(this.options.endpoint.socketPath, request); }
    catch (error) {
      if (error instanceof TransportFailure && !error.sent) return this.transport.request(this.options.endpoint.socketPath, request);
      throw error;
    }
  }
}

export function reconstructStatus(records: readonly StatusFlatRecord[]): StatusProjectV1[] {
  const projects: StatusProjectV1[] = [];
  let current: StatusProjectV1 | undefined;
  const completedProjectIds = new Set<string>();
  for (const record of records) {
    if (record.project) {
      if (current) throw new Error("Status protocol started a project before the preceding project was complete.");
      if (completedProjectIds.has(record.project.id)) throw new Error("Status protocol contains duplicate project metadata.");
      if (record.task || !sameCounts(record.countsFragment, zeroCounts())) throw new Error("Status protocol project metadata record is not standalone.");
      current = { project: record.project, counts: zeroCounts(), tasks: [] };
      projects.push(current);
    } else if (!record.task) {
      throw new Error("Status protocol task record is missing its task.");
    }
    if (!current) throw new Error("Status protocol emitted a task record before project metadata.");
    addCounts(current.counts, record.countsFragment);
    if (record.task) {
      if (record.task.projectId !== current.project.id || current.tasks.some((task) => task.id === record.task!.id)) throw new Error("Status protocol contains an invalid task record.");
      current.tasks.push(record.task);
    }
    if (record.projectDone) {
      if (!sameCounts(current.counts, countTasks(current.tasks))) throw new Error("Status protocol counts do not match task records.");
      completedProjectIds.add(current.project.id);
      current = undefined;
    }
  }
  if (current) throw new Error("Status protocol ended before projectDone.");
  return projects;
}

function parseEnvelope<Data>(body: string): ApiEnvelope<Data> { try { const parsed = JSON.parse(body) as ApiEnvelope<Data>; if (!parsed || typeof parsed !== "object" || typeof parsed.ok !== "boolean" || !parsed.meta || parsed.meta.schemaVersion !== 1) throw new Error(); return parsed; } catch { throw new Error("Daemon returned an invalid API envelope."); } }
function throwRemote<Code extends ErrorEnvelopeV1["error"]["code"]>(envelope: ErrorEnvelopeV1<Code>): never {
  throw applicationError(envelope.error.code, envelope.error.message, envelope.error.details);
}
function unavailable(endpoint: string, _error: unknown): ReturnType<typeof applicationError> { return applicationError("DAEMON_UNAVAILABLE", "Daemon is unavailable.", { endpoint, reason: "connect_failed" }); }
function responseHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value]));
}
function header(headers: TransportResponse["headers"], key: string): string | undefined { return headers instanceof Headers ? headers.get(key) ?? undefined : headers[key] ?? headers[key.toLowerCase()]; }
function zeroCounts(): CountsV1 { return { planned: { planned: 0, ready: 0, active: 0, paused: 0, blocked: 0, done: 0, canceled: 0 }, observed: { unknown: 0, idle: 0, running: 0, succeeded: 0, failed: 0, stale: 0 } }; }
function addCounts(target: CountsV1, addition: CountsV1): void { for (const key of Object.keys(target.planned) as (keyof CountsV1["planned"])[]) target.planned[key] += addition.planned[key]; for (const key of Object.keys(target.observed) as (keyof CountsV1["observed"])[]) target.observed[key] += addition.observed[key]; }
function sameCounts(left: CountsV1, right: CountsV1): boolean {
  return (Object.keys(left.planned) as (keyof CountsV1["planned"])[]).every((key) => left.planned[key] === right.planned[key])
    && (Object.keys(left.observed) as (keyof CountsV1["observed"])[]).every((key) => left.observed[key] === right.observed[key]);
}
function countTasks(tasks: readonly TaskV1[]): CountsV1 { const counts = zeroCounts(); for (const task of tasks) { counts.planned[task.plannedState]++; counts.observed[task.observedState]++; } return counts; }
