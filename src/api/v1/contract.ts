import { createHash } from "node:crypto";
import type { ErrorEnvelopeV1 } from "../../application/errors.ts";
import type { CountsV1, EventV1, ProjectV1, StatusProjectV1, SuccessEnvelopeV1, TaskV1 } from "../../domain/model.ts";

export const API_VERSION = 1 as const;
export const MAX_REQUEST_BYTES = 1_048_576;
export const MAX_RESPONSE_BYTES = 1_048_576;
export const MAX_PAGE_ROWS = 250;
export const CONNECT_TIMEOUT_MS = 1_000;
export const REQUEST_TIMEOUT_MS = 10_000;
export const HEALTH_TIMEOUT_MS = 2_000;

export type ApiEnvelope<Data> = SuccessEnvelopeV1<Data> | ErrorEnvelopeV1;
export interface MutationBody<Data> { schemaVersion: 1; data: Data; }
export interface PageData<Item> { items: Item[]; nextCursor: string | null; }
export interface StatusFlatRecord {
  /** Present only for the first record of a project; subsequent task records stay task-flat. */
  project: ProjectV1 | null;
  countsFragment: CountsV1;
  task: TaskV1 | null;
  projectDone: boolean;
}
export type StatusPageData = PageData<StatusFlatRecord>;
export interface HistoryPageData {
  scope: { type: "project" | "task"; id: string };
  events: EventV1[];
  query: { limit: number; since: string | null };
  nextCursor: string | null;
}
export interface HealthV1 {
  instanceId: string;
  version: string;
  phase: "starting" | "ready" | "draining" | "stopped";
  heartbeatAt: string;
  configFingerprint: string;
  ready: boolean;
}
export type LegacyStatusData = { projects: StatusProjectV1[] };

export function successEnvelope<Data>(command: string, data: Data): SuccessEnvelopeV1<Data> {
  return { ok: true, data, meta: { command, schemaVersion: 1 } };
}

/** RFC 8785-compatible canonical JSON for the JSON values accepted by the API. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string": return JSON.stringify(value);
    case "boolean": return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("Canonical JSON does not permit non-finite numbers.");
      return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      {
        const object = value as Record<string, unknown>;
        const keys = Object.keys(object).sort();
        return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
      }
    default: throw new TypeError("Canonical JSON permits only JSON values.");
  }
}

export function encodeQueryComponent(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function normalizedQuery(query: URLSearchParams | Iterable<readonly [string, string]>): string {
  const pairs = [...query].map(([key, value]) => [encodeQueryComponent(key), encodeQueryComponent(value)] as const);
  pairs.sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
  return pairs.map(([key, value]) => `${key}=${value}`).join("&");
}

export function canonicalRequestHash(method: string, normalizedPath: string, query: URLSearchParams | Iterable<readonly [string, string]>, data: unknown): string {
  const input = `${method.toUpperCase()}\n${normalizedPath}\n${normalizedQuery(query)}\n1\n${canonicalJson(data)}`;
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function isLowercaseUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
