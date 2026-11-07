/**
 * Idempotency-Key handling for POST routes.
 *
 * Every POST MUST carry an `Idempotency-Key` header. The first time a key is
 * seen (per authenticated sub) the handler runs, and the resulting status +
 * body are stored for 24h via the core idempotency store. A replay of the same
 * key returns the STORED result verbatim without re-running the handler, so a
 * retried launch never enqueues a second command.
 */

import type { Repository } from "@nikovirtala/kiro-remote-core";
import type { HttpRequest, HttpResponse } from "./http.ts";
import { BadRequestError } from "./problem.ts";

/** Extract the required Idempotency-Key header or throw a 400. */
export function requireIdempotencyKey(req: HttpRequest): string {
  const key = req.headers["idempotency-key"];
  if (!key || key.trim() === "") {
    throw new BadRequestError("Idempotency-Key header is required", "missing-idempotency-key");
  }
  return key.trim();
}

/** The persisted shape of a prior idempotent response. */
interface StoredResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Run `fn` under idempotency protection for (sub, key). Returns the stored
 * response on replay, otherwise runs `fn`, stores its result, and returns it.
 *
 * The store write uses a conditional put; a race that loses re-reads the
 * winner so both callers observe the same stored result.
 */
export async function withIdempotency(
  repo: Repository,
  sub: string,
  key: string,
  fn: () => Promise<HttpResponse>,
): Promise<HttpResponse> {
  const existing = await repo.getIdempotency(sub, key);
  if (existing) {
    const stored = existing.response as unknown as StoredResponse;
    return { status: stored.status, headers: stored.headers, body: stored.body };
  }

  const response = await fn();

  // Only cache successful (2xx) results; errors may be transient and should be
  // retryable with the same key.
  if (response.status >= 200 && response.status < 300) {
    try {
      await repo.putIdempotency(sub, key, response as unknown as Record<string, unknown>);
    } catch {
      // Lost a race: re-read and return the stored winner.
      const winner = await repo.getIdempotency(sub, key);
      if (winner) {
        const stored = winner.response as unknown as StoredResponse;
        return { status: stored.status, headers: stored.headers, body: stored.body };
      }
    }
  }

  return response;
}
