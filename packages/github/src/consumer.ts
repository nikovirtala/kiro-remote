/**
 * The GitHub consumer: turns a stored delivery into links, link updates, inbox
 * wake items and unmatched records, then drains the affected sessions' inboxes.
 *
 * Order for a delivery: (1) on pull_request opened/edited, accept a session
 * trailer from the PR body; (2) look up the PR's link; (3) fetch a trusted
 * reviewer's inline comments; (4) route() decides; (5) apply the actions;
 * (6) drain each touched session (it only starts a turn when the session is
 * idle; otherwise the bridge drains at the next settle).
 */

import {
  type CommandQueue,
  type GithubQueue,
  type PrLinkItem,
  type PrState,
  parseTrailer,
  prKeyOf,
  type Repository,
  sessionHasRepo,
} from "@nikovirtala/kiro-remote-core";
import type { GithubClient } from "./app-client.ts";
import { harvestTurn } from "./harvest.ts";
import type { Logger, Metrics } from "./log.ts";
import { eventPrNumbers, eventRepo, route } from "./route.ts";
import type { Action, GithubEvent, ReviewComment, RouteConfig, RouteLink } from "./types.ts";
import { autoCloseIfDone, drainAndCount, enqueueWake, type WakeDeps } from "./wake.ts";

export interface ConsumerConfig {
  /** Explicit trusted logins. Empty means: the owner of the repo the event is about. */
  trustedLogins: readonly string[];
  /** The Kiro agent's own GitHub identities. Also required to author a trailer-linked PR when set. */
  agentLogins: readonly string[];
  /** Slugs of the GitHub Apps the agent comments through (see RouteConfig.agentApps). */
  agentApps: readonly string[];
  autoCloseOnMerge: "off" | "after_turn";
  checksDebounceMs: number;
}

export interface ConsumerDeps {
  repo: Repository;
  github: Pick<GithubClient, "getPull" | "listReviewComments" | "listAppDeliveries" | "redeliver">;
  queue: CommandQueue;
  githubQueue: GithubQueue;
  config: ConsumerConfig;
  metrics: Metrics;
  logger: Logger;
  now: () => number;
  newId?: () => string;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {};

function toRouteLink(l: PrLinkItem): RouteLink {
  return {
    sessionId: l.sessionId,
    pr: l.pr,
    linkedBy: l.linkedBy,
    prState: l.prState,
    headSha: l.headSha,
  };
}

function prStateOfPayload(pr: Json): PrState {
  return pr.merged === true ? "merged" : pr.state === "closed" ? "closed" : "open";
}

function wakeDeps(deps: ConsumerDeps): WakeDeps {
  return {
    repo: deps.repo,
    queue: deps.queue,
    githubQueue: deps.githubQueue,
    metrics: deps.metrics,
    logger: deps.logger,
    now: deps.now,
    ...(deps.newId ? { newId: deps.newId } : {}),
  };
}

/**
 * Accept a `Kiro-Remote-Session: <id>` trailer from a PR body, if and only if:
 * the session exists and is not deleted, the PR's repo is one of the session's
 * repos[], the PR is not already linked, the PR was created after the session,
 * and (when agent logins are configured) the PR author is the agent. A forged
 * trailer fails one of these and is logged, never linked.
 */
export async function linkFromTrailer(deps: ConsumerDeps, event: GithubEvent): Promise<void> {
  const pr = obj(event.payload.pull_request);
  const sessionId = parseTrailer(typeof pr.body === "string" ? pr.body : null);
  const repoName = eventRepo(event);
  const number = typeof pr.number === "number" ? pr.number : null;
  if (!sessionId || !repoName || number === null) {
    return;
  }
  const key = `${repoName}#${number}`;
  const reject = (reason: string): void => {
    deps.metrics.count("LinksRejected", 1, { reason, method: "trailer" });
    deps.logger.warn("trailer_rejected", {
      pr: key,
      sessionId,
      reason,
      deliveryId: event.deliveryId,
    });
  };
  if (await deps.repo.getPrLink(key)) {
    return;
  }
  const session = await deps.repo.getSession(sessionId);
  if (!session || session.status === "deleted") {
    return reject("session_not_found");
  }
  if (!sessionHasRepo(session, repoName)) {
    return reject("repo_not_in_session");
  }
  const createdAt = typeof pr.created_at === "string" ? Date.parse(pr.created_at) : Number.NaN;
  if (!(createdAt >= Date.parse(session.createdAt))) {
    return reject("created_before_session");
  }
  const author = typeof obj(pr.user).login === "string" ? (obj(pr.user).login as string) : null;
  if (
    deps.config.agentLogins.length > 0 &&
    !deps.config.agentLogins.some((a) => a.toLowerCase() === author?.toLowerCase())
  ) {
    return reject("author_not_agent");
  }
  const created = await deps.repo.createLink({
    repo: repoName,
    number,
    sessionId,
    linkedBy: "trailer",
    prState: prStateOfPayload(pr),
    headSha: typeof obj(pr.head).sha === "string" ? (obj(pr.head).sha as string) : null,
  });
  if (created.created) {
    deps.metrics.count("LinksCreated", 1, { method: "trailer" });
    deps.logger.info("pr_linked", { pr: key, sessionId, method: "trailer" });
  }
}

export interface DeliveryOutcome {
  status: "processed" | "unmatched" | "ignored";
  actions: Action["type"][];
}

/** Process one stored delivery. Throws on transient failure so SQS retries (and the DLQ catches poison). */
export async function processDelivery(
  deps: ConsumerDeps,
  deliveryId: string,
): Promise<DeliveryOutcome | null> {
  const delivery = await deps.repo.getDelivery(deliveryId);
  if (!delivery) {
    deps.logger.warn("delivery_missing", { deliveryId });
    return null;
  }
  const payload = JSON.parse(delivery.rawBody) as Json;
  const event: GithubEvent = { name: delivery.event, deliveryId, payload };
  const action = typeof payload.action === "string" ? payload.action : null;
  const repoName = eventRepo(event);

  if (event.name === "pull_request" && (action === "opened" || action === "edited")) {
    await linkFromTrailer(deps, event);
  }

  const numbers = eventPrNumbers(event);
  const links: RouteLink[] = [];
  for (const n of numbers) {
    const link = repoName ? await deps.repo.getPrLink(`${repoName}#${n}`) : null;
    if (link) {
      links.push(toRouteLink(link));
    }
  }

  const trusted =
    deps.config.trustedLogins.length > 0
      ? deps.config.trustedLogins
      : [
          typeof obj(obj(payload.repository).owner).login === "string"
            ? (obj(obj(payload.repository).owner).login as string)
            : "",
        ].filter(Boolean);
  const routeConfig: RouteConfig = {
    trustedLogins: trusted,
    agentLogins: deps.config.agentLogins,
    agentApps: deps.config.agentApps,
    autoCloseOnMerge: deps.config.autoCloseOnMerge,
    checksDebounceMs: deps.config.checksDebounceMs,
  };

  // A trusted reviewer's inline comments are not in the webhook; fetch them.
  if (event.name === "pull_request_review" && action === "submitted" && links.length > 0) {
    const review = obj(payload.review);
    const reviewer =
      typeof obj(review.user).login === "string" ? (obj(review.user).login as string) : null;
    const installationId = Number(obj(payload.installation).id);
    if (
      reviewer &&
      trusted.some((t) => t.toLowerCase() === reviewer.toLowerCase()) &&
      typeof review.id === "number" &&
      Number.isSafeInteger(installationId) &&
      repoName
    ) {
      try {
        const comments = await deps.github.listReviewComments(
          repoName,
          numbers[0],
          review.id,
          installationId,
        );
        event.reviewComments = comments as ReviewComment[];
      } catch (err) {
        // The structured wake still goes out; only the inline comments are missing.
        deps.logger.warn("review_comments_unavailable", { deliveryId, error: String(err) });
      }
    }
  }

  const actions = route(event, links, routeConfig);
  const touched = new Set<string>();
  let unmatched = false;
  let woke = false;
  const wd = wakeDeps(deps);
  for (const a of actions) {
    switch (a.type) {
      case "updateLink":
        await deps.repo.updateLinkState(a.pr, {
          ...(a.prState ? { prState: a.prState } : {}),
          ...(a.headSha ? { headSha: a.headSha } : {}),
        });
        break;
      case "wake":
        await enqueueWake(wd, a);
        touched.add(a.sessionId);
        woke = true;
        break;
      case "unmatched":
        unmatched = true;
        deps.metrics.count("WebhooksUnmatched");
        await deps.repo.putUnmatched({
          deliveryId,
          event: event.name,
          action,
          repo: a.repo,
          number: a.number,
          sender: a.sender,
          receivedAt: new Date(deps.now()).toISOString(),
          url: a.url,
        });
        break;
      case "ignore":
        break;
    }
  }
  for (const sessionId of touched) {
    await drainAndCount(wd, sessionId);
  }
  const status = woke ? "processed" : unmatched ? "unmatched" : "ignored";
  await deps.repo.setDeliveryStatus(deliveryId, status);
  return { status, actions: actions.map((a) => a.type) };
}

/** Handle a queue message of any kind. */
export async function handleQueueMessage(
  deps: ConsumerDeps,
  message: import("@nikovirtala/kiro-remote-core").GithubQueueMessage,
): Promise<void> {
  switch (message.kind) {
    case "delivery":
      await processDelivery(deps, message.deliveryId);
      return;
    case "harvest":
      await harvestTurn(
        {
          repo: deps.repo,
          github: deps.github,
          metrics: deps.metrics,
          logger: deps.logger,
          now: deps.now,
        },
        message,
      );
      if (message.autoClose === true) {
        await autoCloseIfDone(wakeDeps(deps), message.sessionId);
      }
      return;
    case "drain":
      await drainAndCount(wakeDeps(deps), message.sessionId);
      return;
  }
}

export { prKeyOf };
