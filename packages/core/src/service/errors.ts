/**
 * Typed service errors the API layer maps to HTTP status codes.
 */

/** Launch exceeds the per-account cloud-session cap -> API maps to 429. */
export class ConcurrencyLimitError extends Error {
  readonly status = 429;
  readonly limit: number;
  readonly current: number;
  constructor(limit: number, current: number) {
    super(`cloud session limit reached (${current}/${limit})`);
    this.name = "ConcurrencyLimitError";
    this.limit = limit;
    this.current = current;
  }
}

/** A requested repo is not in the allow-list -> API maps to 403. */
export class RepoNotAllowedError extends Error {
  readonly status = 403;
  readonly repos: string[];
  constructor(repos: string[]) {
    super(`repos not permitted: ${repos.join(", ")}`);
    this.name = "RepoNotAllowedError";
    this.repos = repos;
  }
}

/** The target session does not exist or is not visible -> API maps to 404. */
export class SessionNotFoundError extends Error {
  readonly status = 404;
  constructor(id: string) {
    super(`session not found: ${id}`);
    this.name = "SessionNotFoundError";
  }
}

/** The requested state change is not valid for the session -> API maps to 409. */
export class InvalidStateError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "InvalidStateError";
  }
}

/** The PR is already linked to a different session; a link is never overwritten -> 409. */
export class LinkConflictError extends InvalidStateError {
  readonly pr: string;
  readonly existingSessionId: string;
  constructor(pr: string, existingSessionId: string) {
    super(`pull request ${pr} is already linked to another session`);
    this.name = "LinkConflictError";
    this.pr = pr;
    this.existingSessionId = existingSessionId;
  }
}
