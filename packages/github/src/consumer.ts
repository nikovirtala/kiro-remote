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
  type ConflictCheckMessage,
  type GithubQueue,
  type PrLinkItem,
  type PrState,
  parseTrailer,
  prKeyOf,
  type Repository,
  sessionHasRepo,
} from "@nikovirtala/kiro-remote-core";
import type { GithubClient } from "./app-client.ts";
import { type ConflictDecision, decideConflict } from "./conflicts.ts";
import { harvestTurn } from "./harvest.ts";
import type { Logger, Metrics } from "./log.ts";
import { conflictPrompt } from "./render.ts";
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
  /** Debounce for conflict wakes: several base moves in a row give one wake. */
  conflictDebounceMs: number;
  /**
   * Seconds to wait before each re-check when GitHub has not computed
   * mergeability yet. N delays mean N + 1 tries in total.
   */
  conflictRecheckDelaysSec: readonly number[];
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
    baseRef: l.baseRef ?? null,
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
    baseRef: typeof obj(pr.base).ref === "string" ? (obj(pr.base).ref as string) : null,
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
          ...(a.baseRef ? { baseRef: a.baseRef } : {}),
        });
        break;
      case "checkBase":
        if (await checkBase(deps, a, touched)) {
          woke = true;
        }
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

/**
 * A base branch moved: check every open linked PR on it. This is the only place
 * that fans out; each PR then runs {@link checkConflict}. The merged PR itself
 * is skipped, and so is any link known to target another branch (no read).
 * Links without a known base are read and filtered by what GitHub says.
 * Returns whether any wake was written.
 */
async function checkBase(
  deps: ConsumerDeps,
  move: Extract<Action, { type: "checkBase" }>,
  touched: Set<string>,
): Promise<boolean> {
  const links = await deps.repo.queryOpenLinks(move.repo);
  let woke = false;
  for (const link of links) {
    if (link.number === move.afterPr || (link.baseRef && link.baseRef !== move.base)) {
      continue;
    }
    const sessionId = await checkConflict(deps, {
      kind: "conflict_check",
      repo: link.repo,
      number: link.number,
      base: move.base,
      baseSha: move.baseSha,
      afterPr: move.afterPr,
      deliveryId: move.deliveryId,
      attempt: 1,
      headSha: null,
    });
    if (sessionId) {
      touched.add(sessionId);
      woke = true;
    }
  }
  return woke;
}

/**
 * One try of the mergeability check for one linked PR. Reads the PR, decides
 * (see conflicts.ts), and acts: write a wake, schedule a re-check, or stop.
 * Returns the session to drain when a wake was written.
 *
 * The re-check is a delayed message on the GitHub queue (SQS DelaySeconds): it
 * needs no schedule or table, survives a Lambda restart, and a failed try is
 * retried by SQS itself. A try that cannot read GitHub is also scheduled again,
 * counted as one of the tries.
 */
async function checkConflict(
  deps: ConsumerDeps,
  msg: ConflictCheckMessage,
): Promise<string | null> {
  const key = `${msg.repo}#${msg.number}`;
  const delays = deps.config.conflictRecheckDelaysSec;
  const maxAttempts = delays.length + 1;
  const fields = { pr: key, base: msg.base, attempt: msg.attempt, deliveryId: msg.deliveryId };
  const link = await deps.repo.getPrLink(key);
  if (!link || (link.prState !== "open" && link.prState !== "unknown")) {
    deps.metrics.count("ConflictChecksSkipped", 1, { reason: "closed" });
    deps.logger.info("conflict_check_skipped", { ...fields, reason: "closed" });
    return null;
  }
  deps.metrics.count(msg.attempt > 1 ? "ConflictRechecks" : "ConflictChecks", 1);

  let decision: ConflictDecision;
  try {
    const pull = await deps.github.getPull(msg.repo, msg.number);
    decision = decideConflict({
      pull: pull && {
        state: pull.state,
        merged: pull.merged,
        headSha: pull.headSha,
        baseRef: pull.baseRef ?? null,
        mergeable: pull.mergeable ?? null,
        mergeableState: pull.mergeableState ?? null,
      },
      base: msg.base,
      attempt: msg.attempt,
      maxAttempts,
      baselineHeadSha: msg.headSha,
    });
  } catch (err) {
    deps.logger.warn("conflict_check_read_failed", { ...fields, error: String(err) });
    decision =
      msg.attempt >= maxAttempts
        ? { type: "gave_up", reason: "read_failed" }
        : { type: "recheck", headSha: msg.headSha ?? "" };
  }

  switch (decision.type) {
    case "skip":
      deps.metrics.count("ConflictChecksSkipped", 1, { reason: decision.reason });
      deps.logger.info("conflict_check_skipped", { ...fields, reason: decision.reason });
      return null;
    case "done":
      deps.logger.info("conflict_check_done", { ...fields, state: decision.state });
      return null;
    case "gave_up":
      deps.metrics.count("ConflictChecksGaveUp", 1, { reason: decision.reason });
      deps.logger.warn("conflict_check_gave_up", { ...fields, reason: decision.reason });
      return null;
    case "recheck": {
      const delay = delays[msg.attempt - 1] ?? delays[delays.length - 1] ?? 30;
      await deps.githubQueue.send(
        { ...msg, attempt: msg.attempt + 1, headSha: decision.headSha || msg.headSha },
        delay,
      );
      deps.logger.info("conflict_recheck_scheduled", { ...fields, delaySeconds: delay });
      return null;
    }
    case "wake": {
      deps.metrics.count("ConflictsFound", 1);
      const data = {
        conflict: {
          base: msg.base,
          baseSha: msg.baseSha,
          afterPrs: msg.afterPr === null ? [] : [msg.afterPr],
          afterPush: msg.afterPr === null,
        },
      };
      const wake = await enqueueWake(wakeDeps(deps), {
        type: "wake",
        sessionId: link.sessionId,
        kind: "pr_conflict",
        key: link.pr,
        repo: msg.repo,
        number: msg.number,
        deliveryId: msg.deliveryId,
        data,
        debounceMs: deps.config.conflictDebounceMs,
        autoClose: false,
        prompt: conflictPrompt({
          repo: msg.repo,
          number: msg.number,
          data: data.conflict,
          deliveryIds: [msg.deliveryId],
        }),
      });
      if (!wake.merged) {
        deps.metrics.count("ConflictWakes", 1);
      }
      deps.logger.info("conflict_wake", { ...fields, sessionId: link.sessionId, ...wake });
      return link.sessionId;
    }
  }
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
    case "conflict_check": {
      const sessionId = await checkConflict(deps, message);
      if (sessionId) {
        await drainAndCount(wakeDeps(deps), sessionId);
      }
      return;
    }
  }
}

export { prKeyOf };
