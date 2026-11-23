/**
 * "Waits for": a session asks to be woken once when a pull request it depends on, but does not
 * own, merges or closes.
 *
 * A wait is its own record (see PrWaitItem), not a field on a link: the PR may be linked to
 * another session, to none, and may be in a repo the session does not use. It is created with
 * `attribute_not_exists`, so registering twice is a no-op.
 *
 * The API holds no GitHub credentials, so registering stores the wait and asks the GitHub
 * consumer, through the GitHub queue, to read the PR once (`wait_check`): merged or closed fires
 * the wait at once, open leaves it stored for the webhook. Storing first closes the window in
 * which the PR could merge between the read and the write.
 */

import type { Principal } from "../auth/authenticate.ts";
import { authorize } from "../auth/authorize.ts";
import { parsePrRef, prKeyOf, repoOf } from "../github/pr-ref.ts";
import type { WaitSource } from "../repo/types.ts";
import type { WaitView } from "../schemas/index.ts";
import { matchesAllowList } from "./allowlist.ts";
import {
  GithubNotEnabledError,
  InvalidStateError,
  RepoNotAllowedError,
  SessionNotFoundError,
} from "./errors.ts";
import { loadOwned, type ServiceDeps, toWaitView } from "./index.ts";

/**
 * POST /v1/sessions/{id}/waits. The PR's repo must match ALLOWED_REPOS; it may differ from the
 * session's repos (a draft session may wait for an ark PR).
 */
export async function waitForPullRequest(
  deps: ServiceDeps,
  principal: Principal,
  sessionId: string,
  input: string,
  source: Extract<WaitSource, "mcp" | "rest">,
): Promise<{ wait: WaitView; created: boolean }> {
  authorize(principal, "link");
  const session = await loadOwned(deps, principal, sessionId);
  authorize(principal, "link", { createdBy: session.createdBy });
  const ref = parsePrRef(input);
  if (!ref) {
    throw new InvalidStateError("invalid pull request reference");
  }
  const repo = repoOf(ref);
  if (!matchesAllowList(repo, deps.allowedRepos)) {
    throw new RepoNotAllowedError([repo]);
  }
  if (!deps.githubQueue) {
    throw new GithubNotEnabledError();
  }
  const pr = prKeyOf(ref);
  const result = await deps.repo.createWait({ sessionId, pr, source });
  if (!result.created) {
    return { wait: toWaitView(result.wait), created: false };
  }
  try {
    await deps.githubQueue.send({ kind: "wait_check", sessionId, pr });
  } catch (err) {
    // Without the check the wait could miss a PR that already merged: do not leave it half made.
    await deps.repo.deleteWait(sessionId, pr);
    throw err;
  }
  return { wait: toWaitView(result.wait), created: true };
}

/**
 * DELETE /v1/sessions/{id}/waits/{owner}/{repo}/{n}. Works on a deleted session too, like
 * unlinking, so a wait is never stuck behind a session that no longer exists.
 */
export async function stopWaitingForPullRequest(
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
  const removed = await deps.repo.deleteWait(sessionId, prKeyOf(ref));
  if (!removed) {
    throw new InvalidStateError(`this session is not waiting for pull request ${prKeyOf(ref)}`);
  }
}
