/**
 * Idempotency-Key handling for state-changing calls.
 *
 * The first time a key is seen (per authenticated sub) the handler runs, and
 * the resulting status + body are stored for 24h via the core idempotency
 * store together with a fingerprint of the request (method, route or tool,
 * canonical input). A replay of the same key with the same fingerprint returns
 * the STORED result verbatim without re-running the handler, so a retried
 * launch never enqueues a second command. A replay with a different
 * fingerprint is refused with {@link IdempotencyKeyReuseError}.
 *
 * This is the ONE implementation: the REST routes call {@link withIdempotency}
 * with the Idempotency-Key header, and the in-process /mcp transport calls
 * {@link withIdempotentResult} (a thin JSON wrapper over it) with the tool's
 * `idempotencyKey`. The stdio MCP client sends its key as the header, so it is
 * served by the REST path.
 */

import { createHash } from "node:crypto";
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_PATTERN,
  type Repository,
} from "@nikovirtala/kiro-remote-core";
import type { HttpRequest, HttpResponse } from "./http.ts";
import { BadRequestError, UnprocessableError } from "./problem.ts";

/** 422 raised when an Idempotency-Key is replayed with a different request. */
export class IdempotencyKeyReuseError extends UnprocessableError {
  constructor() {
    super(
      "this idempotency key was already used for a different request; use a new key for a different request, or repeat the original request unchanged",
      "idempotency-key-reused",
    );
    this.name = "IdempotencyKeyReuseError";
  }
}

/** Extract the required Idempotency-Key header or throw a 400. */
export function requireIdempotencyKey(req: HttpRequest): string {
  const key = optionalIdempotencyKey(req);
  if (key === undefined) {
    throw new BadRequestError("Idempotency-Key header is required", "missing-idempotency-key");
  }
  return key;
}

/**
 * Extract the Idempotency-Key header when present (undefined when absent or
 * blank). Throws a 400 when it is longer than the limit or has characters
 * outside the allowed set.
 */
export function optionalIdempotencyKey(req: HttpRequest): string | undefined {
  const raw = req.headers["idempotency-key"]?.trim();
  if (!raw) {
    return undefined;
  }
  if (raw.length > IDEMPOTENCY_KEY_MAX_LENGTH || !IDEMPOTENCY_KEY_PATTERN.test(raw)) {
    throw new BadRequestError(
      `Idempotency-Key must be 1-${IDEMPOTENCY_KEY_MAX_LENGTH} characters from A-Z a-z 0-9 . _ ~ : -`,
      "invalid-idempotency-key",
    );
  }
  return raw;
}

/** JSON with object keys sorted recursively and `undefined` members dropped. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "null";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => sortKeys(v ?? null));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) {
        out[k] = sortKeys(v);
      }
    }
    return out;
  }
  return value;
}

/**
 * SHA-256 (hex) of a request: the method (or transport), the route or tool, and
 * the canonical input. The input must be the VALIDATED input (after zod
 * defaults), so `{}` and an explicit default fingerprint the same.
 */
export function fingerprintRequest(method: string, target: string, input: unknown): string {
  return createHash("sha256")
    .update(canonicalJson([method, target, input]))
    .digest("hex");
}

/** Fingerprint a REST request: its method, concrete path (ids included) and validated body. */
export function fingerprintRestRequest(req: HttpRequest, input: unknown = null): string {
  return fingerprintRequest(req.method, req.path, input);
}

/** The persisted shape of a prior idempotent response. */
interface StoredResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** The stored response, or a refusal when it belongs to a different request. */
function replay(
  stored: { response: Record<string, unknown>; fingerprint?: string },
  fingerprint: string,
): HttpResponse {
  // Entries stored before fingerprints existed carry none and stay valid.
  if (stored.fingerprint !== undefined && stored.fingerprint !== fingerprint) {
    throw new IdempotencyKeyReuseError();
  }
  const r = stored.response as unknown as StoredResponse;
  return { status: r.status, headers: r.headers, body: r.body };
}

/**
 * Run `fn` under idempotency protection for (sub, key). Returns the stored
 * response on replay, otherwise runs `fn`, stores its result with
 * `fingerprint`, and returns it. Throws {@link IdempotencyKeyReuseError} when
 * the key was stored with a different fingerprint.
 *
 * The store write uses a conditional put; a race that loses re-reads the
 * winner so both callers observe the same stored result.
 */
export async function withIdempotency(
  repo: Repository,
  sub: string,
  key: string,
  fingerprint: string,
  fn: () => Promise<HttpResponse>,
): Promise<HttpResponse> {
  const existing = await repo.getIdempotency(sub, key);
  if (existing) {
    return replay(existing, fingerprint);
  }

  const response = await fn();

  // Only cache successful (2xx) results; errors may be transient and should be
  // retryable with the same key.
  if (response.status >= 200 && response.status < 300) {
    try {
      await repo.putIdempotency(
        sub,
        key,
        response as unknown as Record<string, unknown>,
        fingerprint,
      );
    } catch {
      // Lost a race: re-read and return the stored winner.
      const winner = await repo.getIdempotency(sub, key);
      if (winner) {
        return replay(winner, fingerprint);
      }
    }
  }

  return response;
}

/**
 * {@link withIdempotency} for a JSON-serializable value instead of an HTTP
 * response (the in-process MCP transport). A thrown error is not stored.
 */
export async function withIdempotentResult<T>(
  repo: Repository,
  sub: string,
  key: string,
  fingerprint: string,
  fn: () => Promise<T>,
): Promise<T> {
  const res = await withIdempotency(repo, sub, key, fingerprint, async () => ({
    status: 200,
    headers: {},
    body: JSON.stringify((await fn()) ?? null),
  }));
  return JSON.parse(res.body) as T;
}
