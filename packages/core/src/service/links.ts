/**
 * Manual PR <-> session links, and the unmatched-delivery listing.
 *
 * A link is never created from a guess: there is no branch-name or title
 * matching anywhere. A PR links to at most one session; a second link is
 * refused ({@link LinkConflictError}), never overwritten.
 */

import type { Principal } from "../auth/authenticate.ts";
import { authorize } from "../auth/authorize.ts";
import { parsePrRef, prKeyOf, repoOf } from "../github/pr-ref.ts";
import type { LinkView, UnmatchedDeliveryView } from "../schemas/index.ts";
import { matchesAllowList } from "./allowlist.ts";
import {
  InvalidStateError,
  LinkConflictError,
  RepoNotAllowedError,
  SessionNotFoundError,
} from "./errors.ts";
import { loadOwned, type ServiceDeps } from "./index.ts";

function toLinkView(l: {
  pr: string;
  repo: string;
  number: number;
  linkedBy: LinkView["linkedBy"];
  linkedAt: string;
  prState: LinkView["prState"];
  headSha: string | null;
}): LinkView {
  return {
    pr: l.pr,
    repo: l.repo,
    number: l.number,
    linkedBy: l.linkedBy,
    linkedAt: l.linkedAt,
    prState: l.prState,
    headSha: l.headSha,
  };
}

/** True when `repo` (owner/name) is one of the session's repos, compared case-insensitively. */
export function sessionHasRepo(session: { repos: string[] }, repo: string): boolean {
  const want = repo.toLowerCase();
  return session.repos.some((r) => r.toLowerCase() === want);
}

/**
 * POST /v1/sessions/{id}/links. The PR's repo must be one of the session's
 * repos. The PR is not looked up on GitHub (the API holds no GitHub
 * credentials), so `prState` starts as `unknown` and the next webhook fills it.
 */
export async function linkPullRequest(
  deps: ServiceDeps,
  principal: Principal,
  sessionId: string,
  input: string,
): Promise<{ link: LinkView; created: boolean }> {
  authorize(principal, "link");
  const session = await loadOwned(deps, principal, sessionId);
  authorize(principal, "link", { createdBy: session.createdBy });
  const ref = parsePrRef(input);
  if (!ref) {
    throw new InvalidStateError("invalid pull request reference");
  }
  const repo = repoOf(ref);
  if (!sessionHasRepo(session, repo) || !matchesAllowList(repo, deps.allowedRepos)) {
    throw new RepoNotAllowedError([repo]);
  }
  const result = await deps.repo.createLink({
    repo,
    number: ref.number,
    sessionId,
    linkedBy: "manual",
    prState: "unknown",
    headSha: null,
  });
  if (result.created) {
    return { link: toLinkView(result.link), created: true };
  }
  if (result.existing.sessionId !== sessionId) {
    throw new LinkConflictError(prKeyOf(ref), result.existing.sessionId);
  }
  return { link: toLinkView(result.existing), created: false };
}

/**
 * DELETE /v1/sessions/{id}/links/{owner}/{repo}/{n}. Works on a deleted
 * session too, so a PR is never stuck behind a session that no longer exists.
 */
export async function unlinkPullRequest(
  deps: ServiceDeps,
  principal: Principal,
  sessionId: string,
  input: string,
): Promise<void> {
  authorize(principal, "link");
  const session = await deps.repo.getSession(sessionId);
  if (!session || session.createdBy !== principal.sub) {
    throw new SessionNotFoundError(sessionId);
  }
  const ref = parsePrRef(input);
  if (!ref) {
    throw new InvalidStateError("invalid pull request reference");
  }
  const removed = await deps.repo.deleteLink(prKeyOf(ref), sessionId);
  if (!removed) {
    throw new InvalidStateError(`pull request ${prKeyOf(ref)} is not linked to this session`);
  }
}

/**
 * GET /v1/github/unmatched: recent deliveries for repos matching the
 * allow-list that no session claimed, so they can be linked by hand.
 */
export async function listUnmatchedDeliveries(
  deps: ServiceDeps,
  principal: Principal,
  args: { limit: number },
): Promise<{ deliveries: UnmatchedDeliveryView[] }> {
  authorize(principal, "read");
  // Over-fetch: rows for repos outside the allow-list are filtered out below.
  const rows = await deps.repo.listUnmatched(Math.min(args.limit * 5, 500));
  const deliveries = rows
    .filter((r) => matchesAllowList(r.repo, deps.allowedRepos))
    .slice(0, args.limit)
    .map((r) => ({
      deliveryId: r.deliveryId,
      event: r.event,
      action: r.action,
      repo: r.repo,
      number: r.number,
      sender: r.sender,
      receivedAt: r.receivedAt,
      url: r.url,
    }));
  return { deliveries };
}
