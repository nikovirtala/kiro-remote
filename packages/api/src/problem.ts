/**
 * RFC 9457 problem+json error responses.
 *
 * Every error the API emits is an `application/problem+json` document. Typed
 * service/auth errors from @nikovirtala/kiro-remote-core map to the correct status and
 * `type` here, which is the single place that owns the HTTP error contract:
 *
 *   UnauthorizedError      -> 401 + WWW-Authenticate: Bearer resource_metadata=..., scope=...
 *   ForbiddenError         -> 403 + WWW-Authenticate: Bearer error="insufficient_scope", scope=...
 *   RepoNotAllowedError    -> 403 type=repo-not-allowed (no scope hint)
 *   ConcurrencyLimitError  -> 429 + Retry-After
 *   SessionNotFoundError   -> 404
 *   InvalidStateError      -> 409 (or 422 for a non-offered optionId)
 *   zod validation failure -> 400 type=validation-error
 *   CapabilityUnavailable  -> 501 type=capability-unavailable
 */

import {
  ConcurrencyLimitError,
  ForbiddenError,
  InvalidStateError,
  RepoNotAllowedError,
  SessionNotFoundError,
  UnauthorizedError,
  wwwAuthenticateHeader,
  z,
} from "@nikovirtala/kiro-remote-core";
import type { HttpResponse } from "./http.ts";

/** Base URI namespace for our problem `type` values. */
export const PROBLEM_TYPE_BASE = "https://kiro-remote.dev/problems";

/** An RFC 9457 problem detail document. */
export interface ProblemDetail {
  type: string;
  title: string;
  status: number;
  detail?: string;
  [key: string]: unknown;
}

/** 501 raised by a route whose required extension is not advertised. */
export class CapabilityUnavailableError extends Error {
  readonly status = 501;
  readonly method: string;
  constructor(method: string) {
    super(`capability unavailable: ${method}`);
    this.name = "CapabilityUnavailableError";
    this.method = method;
  }
}

/** 400 raised when a required header (e.g. Idempotency-Key) is missing. */
export class BadRequestError extends Error {
  readonly status = 400;
  readonly problemType: string;
  constructor(message: string, problemType = "bad-request") {
    super(message);
    this.name = "BadRequestError";
    this.problemType = problemType;
  }
}

/** 404 raised when no route matches the request path/method. */
export class NotFoundError extends Error {
  readonly status = 404;
  readonly problemType: string;
  constructor(message = "not found", problemType = "not-found") {
    super(message);
    this.name = "NotFoundError";
    this.problemType = problemType;
  }
}

/** 422 raised when a permission optionId was not among the offered options. */
export class UnprocessableError extends Error {
  readonly status = 422;
  readonly problemType: string;
  constructor(message: string, problemType = "unprocessable-entity") {
    super(message);
    this.name = "UnprocessableError";
    this.problemType = problemType;
  }
}

function typeUri(slug: string): string {
  return `${PROBLEM_TYPE_BASE}/${slug}`;
}

/** Serialize a problem document to an `application/problem+json` response. */
export function problemResponse(
  problem: ProblemDetail,
  extraHeaders: Record<string, string> = {},
): HttpResponse {
  return {
    status: problem.status,
    headers: { "content-type": "application/problem+json", ...extraHeaders },
    body: JSON.stringify(problem),
  };
}

/** Build a problem response from loose fields. */
export function problem(
  status: number,
  slug: string,
  title: string,
  detail?: string,
  extra: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {},
): HttpResponse {
  return problemResponse(
    { type: typeUri(slug), title, status, ...(detail ? { detail } : {}), ...extra },
    extraHeaders,
  );
}

function isZodError(err: unknown): err is z.ZodError {
  return err instanceof z.ZodError;
}

/**
 * Whether `err` is a KNOWN, intentional error that {@link errorToProblem} maps
 * to a specific status via an explicit branch (as opposed to falling through to
 * the generic 500). The router uses this as its "expected vs unexpected"
 * discriminator: known errors are normal control flow and are NOT error-logged;
 * anything else is an unexpected failure worth surfacing. This is the single
 * source of truth for the mapping, so adding a branch below keeps both in sync.
 */
export function isKnownProblem(err: unknown): boolean {
  return (
    err instanceof UnauthorizedError ||
    err instanceof ForbiddenError ||
    err instanceof RepoNotAllowedError ||
    err instanceof ConcurrencyLimitError ||
    err instanceof SessionNotFoundError ||
    err instanceof NotFoundError ||
    err instanceof CapabilityUnavailableError ||
    err instanceof UnprocessableError ||
    err instanceof BadRequestError ||
    err instanceof InvalidStateError ||
    isZodError(err)
  );
}

/**
 * Map ANY thrown error to an RFC 9457 problem response. Unknown errors become a
 * generic 500 with no internal detail leaked.
 */
export function errorToProblem(err: unknown): HttpResponse {
  if (err instanceof UnauthorizedError) {
    return problem(
      401,
      "unauthorized",
      "Unauthorized",
      undefined,
      {},
      {
        "www-authenticate": wwwAuthenticateHeader(err.challenge),
      },
    );
  }

  if (err instanceof ForbiddenError) {
    // A scope-based 403 carries the insufficient_scope challenge; an
    // ownership-based 403 (no neededScope) does not leak a scope hint.
    const headers: Record<string, string> = err.neededScope
      ? {
          "www-authenticate": wwwAuthenticateHeader({
            scheme: "Bearer",
            error: "insufficient_scope",
            scope: err.neededScope,
          }),
        }
      : {};
    return problem(
      403,
      "forbidden",
      "Forbidden",
      err.neededScope ? `requires scope ${err.neededScope}` : "not permitted",
      err.neededScope ? { scope: err.neededScope } : {},
      headers,
    );
  }

  if (err instanceof RepoNotAllowedError) {
    return problem(403, "repo-not-allowed", "Repository not permitted", err.message, {
      repos: err.repos,
    });
  }

  if (err instanceof ConcurrencyLimitError) {
    return problem(
      429,
      "concurrency-limit",
      "Too Many Cloud Sessions",
      err.message,
      { limit: err.limit, current: err.current },
      { "retry-after": "60" },
    );
  }

  if (err instanceof SessionNotFoundError) {
    return problem(404, "session-not-found", "Session Not Found", err.message);
  }

  if (err instanceof NotFoundError) {
    return problem(404, err.problemType, "Not Found", err.message);
  }

  if (err instanceof CapabilityUnavailableError) {
    return problem(501, "capability-unavailable", "Capability Unavailable", err.message, {
      method: err.method,
    });
  }

  if (err instanceof UnprocessableError) {
    return problem(422, err.problemType, "Unprocessable Entity", err.message);
  }

  if (err instanceof BadRequestError) {
    return problem(400, err.problemType, "Bad Request", err.message);
  }

  if (err instanceof InvalidStateError) {
    return problem(409, "invalid-state", "Conflict", err.message);
  }

  if (isZodError(err)) {
    return problem(400, "validation-error", "Validation Failed", "request did not match schema", {
      errors: err.issues.map((i) => ({ path: i.path, message: i.message, code: i.code })),
    });
  }

  return problem(500, "internal-error", "Internal Server Error");
}
