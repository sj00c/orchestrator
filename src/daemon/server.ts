import { canonicalRequestHash, isLowercaseUuid, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, successEnvelope } from "../api/v1/contract.ts";
import { httpError, resolveRoute, validateRouteInput, type RouteMatch } from "../api/v1/routes.ts";
import { applicationError } from "../application/errors.ts";
import { isStoredHttpOutcome, type IdempotencyContext } from "../application/idempotency-service.ts";

export interface DaemonRequestContext { route: RouteMatch; input: unknown; idempotency: IdempotencyContext | null; signal: AbortSignal; }
export interface DaemonServerDependencies {
  dispatch(context: DaemonRequestContext): Promise<unknown> | unknown;
  health(): unknown;
  requestTimeoutMs?: number;
  maxInflight?: number;
  maxQueued?: number;
}
export interface DaemonServer {
  fetch(request: Request): Promise<Response>;
  closeAdmission(): void;
  advanceGeneration(): void;
  waitForInflight(deadline: number): Promise<void>;
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const PENDING_QUEUE_WAIT_MS = 1_000;

/** HTTP policy layer for the private Unix-domain-socket API. */
export function createDaemonServer(deps: DaemonServerDependencies): DaemonServer {
  let admitting = true;
  let generation = 0;
  let inflight = 0;
  const admissionQueue: Array<(admitted: boolean) => void> = [];
  const waiters = new Set<() => void>();
  const maxInflight = deps.maxInflight ?? 64;
  const maxQueued = deps.maxQueued ?? 128;
  const timeoutMs = deps.requestTimeoutMs ?? 10_000;

  return {
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      let responseHeaders: Record<string, string> = {};
      let route: RouteMatch;
      try {
        const requestId = validRequestId(request.headers.get("x-request-id"));
        responseHeaders = { "x-request-id": requestId };
        route = resolveRoute(request.method, url.pathname);
      } catch (error) { return errorResponse("api", error, responseHeaders); }
      if (route.name === "health") return json(successEnvelope(route.command, deps.health()), 200, responseHeaders);
      if (!admitting) return errorResponse(route.command, unavailable("draining"), responseHeaders);
      if (!await acquireAdmission()) return errorResponse(route.command, unavailable("degraded"), responseHeaders);
      const requestGeneration = generation;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(unavailable("degraded")), timeoutMs);
      try {
        const body = route.mutation ? await requestBody(request) : undefined;
        const input = validateRouteInput(route, url.searchParams, body);
        const idempotency = route.mutation
          ? mutationIdempotency(request, route, url, mutationData(body))
          : null;
        const value = await raceAbort(
          Promise.resolve(deps.dispatch({ route, input, idempotency, signal: controller.signal })),
          controller.signal,
        );
        if (controller.signal.aborted) throw unavailable("degraded");
        if (requestGeneration !== generation) throw unavailable("draining");
        if (isStoredHttpOutcome(value)) return storedOutcomeResponse(value, responseHeaders);
        return json(successEnvelope(route.command, value), 200, responseHeaders);
      } catch (error) {
        return errorResponse(route.command, error, responseHeaders);
      } finally {
        clearTimeout(timer);
        releaseAdmission();
        if (inflight === 0) { for (const wake of waiters) wake(); waiters.clear(); }
      }
    },
    closeAdmission(): void {
      admitting = false;
      for (const wake of admissionQueue.splice(0)) wake(false);
    },
    advanceGeneration(): void { generation++; },
    waitForInflight(deadline: number): Promise<void> {
      if (inflight === 0) return Promise.resolve();
      const remaining = deadline - Date.now();
      if (remaining <= 0) return Promise.reject(new Error("Daemon shutdown deadline exceeded"));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiters.delete(done); reject(new Error("Daemon shutdown deadline exceeded")); }, remaining);
        const done = () => { clearTimeout(timer); resolve(); };
        waiters.add(done);
      });
    },
  };

  function acquireAdmission(): Promise<boolean> {
    if (inflight < maxInflight) {
      inflight++;
      return Promise.resolve(true);
    }
    if (maxQueued === 0 || admissionQueue.length >= maxQueued) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const index = admissionQueue.indexOf(wake);
        if (index >= 0) admissionQueue.splice(index, 1);
        resolve(false);
      }, PENDING_QUEUE_WAIT_MS);
      const wake = (admitted: boolean) => {
        clearTimeout(timeout);
        resolve(admitted);
      };
      admissionQueue.push(wake);
    });
  }

  function releaseAdmission(): void {
    const wake = admissionQueue.shift();
    if (wake) {
      wake(true);
      return;
    }
    inflight--;
  }
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  ]);
}

async function requestBody(request: Request): Promise<unknown> {
  const length = request.headers.get("content-length");
  if (length !== null) {
    if (!/^\d+$/.test(length)) throw applicationError("VALIDATION_ERROR", "Content-Length must be a decimal byte count.", { field: "content-length", reason: "invalid" });
    const declaredBytes = Number(length);
    if (!Number.isSafeInteger(declaredBytes)) throw applicationError("VALIDATION_ERROR", "Content-Length is invalid.", { field: "content-length", reason: "invalid" });
    if (declaredBytes > MAX_REQUEST_BYTES) throw tooLarge("request", declaredBytes, MAX_REQUEST_BYTES);
  }
  if (request.body === null) return undefined;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let actualBytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value === undefined) continue;
      actualBytes += chunk.value.byteLength;
      if (actualBytes > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw tooLarge("request", actualBytes, MAX_REQUEST_BYTES);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  try { return JSON.parse(text); } catch { throw applicationError("VALIDATION_ERROR", "Request body must be JSON.", { field: "body", reason: "invalid_json" }); }
}
function validIdempotencyKey(value: string | null): string {
  if (value === null) throw applicationError("VALIDATION_ERROR", "Mutations require an Idempotency-Key header.", { field: "idempotency-key", reason: "required" });
  if (!isLowercaseUuid(value)) throw applicationError("VALIDATION_ERROR", "Idempotency-Key is invalid.", { field: "idempotency-key", reason: "invalid" });
  return value;
}
function validRequestId(value: string | null): string {
  if (value === null) throw applicationError("VALIDATION_ERROR", "Requests require an X-Request-Id header.", { field: "x-request-id", reason: "required" });
  if (!isLowercaseUuid(value)) throw applicationError("VALIDATION_ERROR", "X-Request-Id is invalid.", { field: "x-request-id", reason: "invalid" });
  return value;
}
function mutationIdempotency(request: Request, route: RouteMatch, url: URL, data: unknown): IdempotencyContext {
  const requestHash = request.headers.get("x-request-hash");
  const expectedHash = canonicalRequestHash(request.method, url.pathname, url.searchParams, data);
  if (requestHash === null) throw applicationError("VALIDATION_ERROR", "Mutations require an X-Request-Hash header.", { field: "x-request-hash", reason: "required" });
  if (!/^[0-9a-f]{64}$/.test(requestHash) || requestHash !== expectedHash) {
    throw applicationError("VALIDATION_ERROR", "X-Request-Hash does not match the request.", { field: "x-request-hash", reason: "invalid" });
  }
  return {
    idempotencyKey: validIdempotencyKey(request.headers.get("idempotency-key")),
    requestId: validRequestId(request.headers.get("x-request-id")),
    requestHash,
    command: route.command,
  };
}
function mutationData(body: unknown): unknown {
  if (typeof body !== "object" || body === null || !("data" in body)) {
    throw applicationError("VALIDATION_ERROR", "Mutation body must be a v1 envelope.", { field: "body", reason: "invalid_envelope" });
  }
  return body.data;
}
function errorResponse(command: string, error: unknown, extra: Record<string, string> = {}): Response {
  const result = httpError(command, error);
  return json(result.body, result.status, { ...result.headers, ...extra });
}
function storedOutcomeResponse(outcome: { status: number; bodyText: string }, extra: Record<string, string>): Response {
  const actualBytes = new TextEncoder().encode(outcome.bodyText).byteLength;
  if (actualBytes > MAX_RESPONSE_BYTES) {
    return json(httpError("api", tooLarge("response", actualBytes, MAX_RESPONSE_BYTES)).body, 413, extra);
  }
  return new Response(outcome.bodyText, { status: outcome.status, headers: { ...JSON_HEADERS, ...extra } });
}
function json(value: unknown, status: number, extra: Record<string, string> = {}): Response {
  const serialized = JSON.stringify(value);
  const actualBytes = new TextEncoder().encode(`${serialized}\n`).byteLength;
  if (actualBytes > MAX_RESPONSE_BYTES) return new Response(JSON.stringify(httpError("api", tooLarge("response", actualBytes, MAX_RESPONSE_BYTES)).body), { status: 413, headers: { ...JSON_HEADERS, ...extra } });
  return new Response(`${serialized}\n`, { status, headers: { ...JSON_HEADERS, ...extra } });
}
function unavailable(reason: "degraded" | "draining") {
  return applicationError("DAEMON_UNAVAILABLE", "Daemon is unavailable.", { endpoint: "unix", reason });
}
function tooLarge(resource: string, actualBytes: number, maxBytes: number) {
  return applicationError("RESPONSE_TOO_LARGE", "Payload exceeds the byte limit.", { resource, recordId: null, maxBytes, actualBytes });
}
