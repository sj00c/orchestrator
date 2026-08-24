import { createHmac, timingSafeEqual } from "node:crypto";
import { applicationError } from "../../application/errors.ts";
import { MAX_PAGE_ROWS, MAX_RESPONSE_BYTES } from "./contract.ts";

export interface CursorPayload<Key> { key: Key; filterFingerprint: string; routeSchema: string; expiresAt: number; }
export interface PageBuildOptions<Record, Key, Data> {
  resource: string;
  records: readonly Record[];
  limit?: number;
  keyOf(record: Record): Key;
  encodeCursor(key: Key): string;
  envelope(items: readonly Record[], nextCursor: string | null): Data;
  serialize(data: Data): string;
  /** True when the supplied records are a complete repository page with a following page. */
  externalHasMore?: boolean;
  recordId?(record: Record): string | null;
  maxBytes?: number;
}
export interface BuiltPage<Record, Data> { records: Record[]; nextCursor: string | null; body: Data; serializedBytes: number; }

const encoder = new TextEncoder();

export function createCursor<Key>(payload: CursorPayload<Key>, secret: Uint8Array | string): string {
  const encoded = base64url(encoder.encode(JSON.stringify(payload)));
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function parseCursor<Key>(cursor: string, secret: Uint8Array | string, expected: Pick<CursorPayload<Key>, "filterFingerprint" | "routeSchema">, now = Date.now()): Key {
  const [encoded, signature, extra] = cursor.split(".");
  if (!encoded || !signature || extra) invalidCursor("malformed");
  const expectedSignature = createHmac("sha256", secret).update(encoded).digest();
  let receivedSignature: Buffer;
  try { receivedSignature = Buffer.from(signature, "base64url"); } catch { invalidCursor("malformed"); }
  if (receivedSignature.length !== expectedSignature.length || !timingSafeEqual(receivedSignature, expectedSignature)) invalidCursor("invalid_signature");
  let payload: CursorPayload<Key>;
  try { payload = JSON.parse(new TextDecoder().decode(fromBase64url(encoded))) as CursorPayload<Key>; } catch { invalidCursor("malformed"); }
  if (payload.filterFingerprint !== expected.filterFingerprint || payload.routeSchema !== expected.routeSchema) invalidCursor("mismatch");
  if (!Number.isSafeInteger(payload.expiresAt) || payload.expiresAt < now) invalidCursor("expired");
  return payload.key;
}

/** Builds against final serialized envelope bytes, including the final newline. */
export function buildBoundedPage<Record, Key, Data>(options: PageBuildOptions<Record, Key, Data>): BuiltPage<Record, Data> {
  const limit = options.limit ?? MAX_PAGE_ROWS;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_ROWS) throw applicationError("VALIDATION_ERROR", "Page limit must be an integer from 1 through 250.", { field: "limit", reason: "out_of_range" });
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  const included: Record[] = [];
  for (let index = 0; index < options.records.length && included.length < limit; index++) {
    const candidate = options.records[index];
    if (candidate === undefined) continue;
    const hasMore = index + 1 < options.records.length || (index + 1 === options.records.length && options.externalHasMore === true);
    const nextCursor = hasMore ? options.encodeCursor(options.keyOf(candidate)) : null;
    const body = options.envelope([...included, candidate], nextCursor);
    const actualBytes = bytes(options.serialize(body));
    if (actualBytes <= maxBytes) {
      included.push(candidate);
      continue;
    }
    if (included.length === 0) {
      throw applicationError("RESPONSE_TOO_LARGE", "A single response record exceeds the response byte limit.", {
        resource: options.resource,
        recordId: options.recordId?.(candidate) ?? null,
        maxBytes,
        actualBytes,
      });
    }
    const lastIncluded = included.at(-1);
    if (lastIncluded === undefined) throw new Error("Pagination invariant violated: no last included record.");
    const cursor = options.encodeCursor(options.keyOf(lastIncluded));
    const result = options.envelope(included, cursor);
    return { records: included, nextCursor: cursor, body: result, serializedBytes: bytes(options.serialize(result)) };
  }
  const exhausted = included.length === options.records.length && !options.externalHasMore;
  const lastIncluded = included.at(-1);
  let cursor: string | null = null;
  if (!exhausted) {
    if (lastIncluded === undefined) throw new Error("Pagination invariant violated: cursor requires an emitted record.");
    cursor = options.encodeCursor(options.keyOf(lastIncluded));
  }
  const body = options.envelope(included, cursor);
  return { records: included, nextCursor: cursor, body, serializedBytes: bytes(options.serialize(body)) };
}

function bytes(serialized: string): number { return encoder.encode(`${serialized}\n`).byteLength; }
function base64url(value: Uint8Array): string { return Buffer.from(value).toString("base64url"); }
function fromBase64url(value: string): Uint8Array { return Buffer.from(value, "base64url"); }
function invalidCursor(reason: string): never { throw applicationError("VALIDATION_ERROR", "Invalid page cursor.", { field: "cursor", reason }); }
