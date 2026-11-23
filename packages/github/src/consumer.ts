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
  matchesAllowList,
  type PrLinkItem,
  type PrState,
  parseTrailer,
  parseWaitTrailers,
  prKeyOf,
  type Repository,
  repoOf,
  sessionHasRepo,
  type WaitCheckMessage,
} from "@nikovirtala/kiro-remote-core";
import type { GithubClient } from "./app-client.ts";
import { type ConflictDecision, decideConflict } from "./conflicts.ts";
import { harvestTurn } from "./harvest.ts";
import type { Logger, Metrics } from "./log.ts";
import { conflictPrompt, waitPrompt } from "./render.ts";
import { eventPrNumbers, eventRepo, route } from "./route.ts";
import {
  type Action,
  type GithubEvent,
  type ReviewComment,
  type RouteConfig,
  type RouteLink,
  WAIT_WAKE_KINDS,
} from "./types.ts";
import { decideWait, type RouteWait, type WaitDecision } from "./waits.ts";
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
  /** Also wake when a PR merges but is behind a base that requires up-to-date branches. */
  wakeOnBehind: boolean;
  /** ALLOWED_REPOS: the repos a wait may name (a trailer is checked against it, as the API checks a call). */
  allowedRepos: readonly string[];
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
 *
 * `Kiro-Remote-Waits-For: owner/repo#n` lines are read here too, under the same rules: they
 * count only when the session trailer is accepted. A PR that is already linked to the session
 * (by harvest, say) is checked again only when it carries such lines, so a later edit can add
 * them. Each awaited repo must also match ALLOWED_REPOS.
 */
export async function linkFromTrailer(deps: ConsumerDeps, event: GithubEvent): Promise<void> {
  const pr = obj(event.payload.pull_request);
  const body = typeof pr.body === "string" ? pr.body : null;
  const sessionId = parseTrailer(body);
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
  const waits = parseWaitTrailers(body);
  const existing = await deps.repo.getPrLink(key);
  if (existing && (waits.length === 0 || existing.sessionId !== sessionId)) {
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
  if (!existing) {
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
    } else if (created.existing.sessionId !== sessionId) {
      return; // linked to another session meanwhile: the trailer's waits are not ours to add
    }
  }
  await registerTrailerWaits(deps, event, { sessionId, key, waits });
}

/** Store the waits a PR body asked for and have each read once (the `wait_check` message). */
async function registerTrailerWaits(
  deps: ConsumerDeps,
  event: GithubEvent,
  args: { sessionId: string; key: string; waits: ReturnType<typeof parseWaitTrailers> },
): Promise<void> {
  for (const ref of args.waits) {
    const awaited = prKeyOf(ref);
    const reject = (reason: string): void => {
      deps.metrics.count("WaitsRejected", 1, { reason, source: "trailer" });
      deps.logger.warn("wait_rejected", {
        pr: args.key,
        awaited,
        sessionId: args.sessionId,
        reason,
        deliveryId: event.deliveryId,
      });
    };
    if (awaited === args.key) {
      reject("own_pull_request");
      continue;
    }
    if (!matchesAllowList(repoOf(ref), deps.config.allowedRepos)) {
      reject("repo_not_allowed");
      continue;
    }
    const created = await deps.repo.createWait({
      sessionId: args.sessionId,
      pr: awaited,
      source: "trailer",
    });
    if (created.created) {
      deps.metrics.count("WaitsRegistered", 1, { source: "trailer" });
      deps.logger.info("wait_registered", {
        pr: args.key,
        awaited,
        sessionId: args.sessionId,
        source: "trailer",
      });
      await deps.githubQueue.send({ kind: "wait_check", sessionId: args.sessionId, pr: awaited });
    }
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

  const waits = await loadWaits(deps, event, repoName, numbers[0] ?? null);

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

  const actions = route(event, links, routeConfig, waits);
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
        if (isWaitKind(a.kind)) {
          if (!(await fireWait(deps, a, "webhook"))) {
            break;
          }
        } else {
          await enqueueWake(wd, a);
        }
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

const isWaitKind = (kind: string): boolean => (WAIT_WAKE_KINDS as readonly string[]).includes(kind);

/**
 * The sessions waiting for the PR a `pull_request.closed` delivery is about. A waiter whose own
 * open PR in the same repo may now conflict (its base is the merged PR's base, or not known) is
 * held for as long as the conflict check can take, so the conflict wake and the wait wake are due
 * together and the drain folds them into one turn (see enqueueWake).
 */
async function loadWaits(
  deps: ConsumerDeps,
  event: GithubEvent,
  repoName: string | null,
  number: number | null,
): Promise<RouteWait[]> {
  const payload = event.payload;
  if (
    event.name !== "pull_request" ||
    payload.action !== "closed" ||
    !repoName ||
    number === null
  ) {
    return [];
  }
  const rows = await deps.repo.queryWaiters(`${repoName}#${number}`);
  if (rows.length === 0) {
    return [];
  }
  const pr = obj(payload.pull_request);
  const merged = pr.merged === true;
  const base = typeof obj(pr.base).ref === "string" ? (obj(pr.base).ref as string) : null;
  const out: RouteWait[] = [];
  for (const w of rows) {
    const hold = merged
      ? await holdMsFor(deps, { sessionId: w.sessionId, repo: repoName, number, base })
      : 0;
    out.push({ sessionId: w.sessionId, pr: w.pr, source: w.source, holdMs: hold });
  }
  return out;
}

/**
 * How long to hold the wake of a wait whose PR merged: the whole time the waiter's own conflict
 * check can take when the waiter has an open linked PR the merge may now conflict with (in the
 * merged PR's repo, on the same base or one not yet known), else 0. Shared by the webhook and the
 * sweep, so a wait fired by either folds into one turn with the waiter's own conflict wake.
 */
export async function holdMsFor(
  deps: ConsumerDeps,
  args: { sessionId: string; repo: string; number: number; base: string | null },
): Promise<number> {
  const own = await deps.repo.queryLinks(args.sessionId);
  const mayConflict = own.some(
    (l) =>
      (l.prState === "open" || l.prState === "unknown") &&
      l.repo === args.repo &&
      l.number !== args.number &&
      (!l.baseRef || !args.base || l.baseRef === args.base),
  );
  return mayConflict
    ? deps.config.conflictDebounceMs +
        deps.config.conflictRecheckDelaysSec.reduce((sum, d) => sum + d, 0) * 1000 +
        WAIT_HOLD_SLACK_MS
    : 0;
}

/** Slack on top of the conflict check's own timing, for SQS delay and processing time. */
const WAIT_HOLD_SLACK_MS = 30_000;

/**
 * Fire a wait: the wait is removed and the wake written in one transaction (with their events), so
 * of a webhook and a re-check that fire the same wait at once only one commits and wakes the
 * session, and a wake that cannot be written leaves the wait where it was for the retry. `source` is
 * what read GitHub: a webhook, or the check made on registration (`sweep`).
 */
async function fireWait(
  deps: ConsumerDeps,
  a: Extract<Action, { type: "wake" }>,
  source: "webhook" | "sweep",
): Promise<boolean> {
  const outcome = a.kind.slice("pr_wait_".length);
  const res = await enqueueWake(wakeDeps(deps), a, {
    source,
    fires: { reason: outcome === "gone" ? "unreadable" : (outcome as "merged" | "closed") },
  });
  if (!res.claimed) {
    deps.logger.info("wait_already_fired", { pr: a.key, sessionId: a.sessionId });
    return false;
  }
  deps.metrics.count("WaitsFired", 1, { outcome });
  deps.logger.info("wait_fired", {
    pr: a.key,
    sessionId: a.sessionId,
    kind: a.kind,
    deliveryId: a.deliveryId,
  });
  return true;
}

/**
 * Read an awaited PR once, for a wait that was just registered (or by a later sweep): merged or
 * closed fires the wait, open leaves it for the webhook. A read that fails throws, so SQS retries.
 * Returns the session to drain when a wake was written.
 */
async function checkWait(deps: ConsumerDeps, msg: WaitCheckMessage): Promise<string | null> {
  if (!(await deps.repo.getWait(msg.sessionId, msg.pr))) {
    deps.logger.info("wait_check_skipped", { pr: msg.pr, sessionId: msg.sessionId });
    return null;
  }
  const hash = msg.pr.lastIndexOf("#");
  const repoName = msg.pr.slice(0, hash);
  const number = Number(msg.pr.slice(hash + 1));
  const pull = await deps.github.getPull(repoName, number);
  const decision = decideWait(
    pull && {
      state: pull.state,
      merged: pull.merged,
      baseRef: pull.baseRef ?? null,
      mergeCommitSha: pull.mergeCommitSha ?? null,
    },
  );
  if (decision.type === "keep") {
    deps.logger.info("wait_check_open", { pr: msg.pr, sessionId: msg.sessionId });
    return null;
  }
  const fired = await fireWaitDecision(deps, {
    sessionId: msg.sessionId,
    pr: msg.pr,
    decision,
    source: "sweep",
    event:
      decision.outcome === "gone"
        ? "awaited pull request not found"
        : `awaited pull request was already ${decision.outcome === "merged" ? "merged" : "closed"} when the wait was checked`,
  });
  return fired ? msg.sessionId : null;
}

/**
 * Fire a wait whose PR was read (not delivered by a webhook): build the wake the decision means and
 * write it with the removal of the wait, through the same {@link fireWait} the webhook uses. The
 * registration check and the scheduled sweep both come here. `holdMs` holds a merge wake so it folds
 * with the waiter's own conflict wake (see {@link holdMsFor}).
 */
export async function fireWaitDecision(
  deps: ConsumerDeps,
  args: {
    sessionId: string;
    /** The awaited PR, owner/repo#n, lower-cased. */
    pr: string;
    decision: Extract<WaitDecision, { type: "fire" }>;
    source: "webhook" | "sweep";
    /** Why the turn started, for the wake's header. */
    event: string;
    holdMs?: number;
  },
): Promise<boolean> {
  const hash = args.pr.lastIndexOf("#");
  const repoName = args.pr.slice(0, hash);
  const number = Number(args.pr.slice(hash + 1));
  const { decision } = args;
  const kind =
    decision.outcome === "merged"
      ? "pr_wait_merged"
      : decision.outcome === "closed"
        ? "pr_wait_closed"
        : "pr_wait_gone";
  return fireWait(
    deps,
    {
      type: "wake",
      sessionId: args.sessionId,
      kind,
      key: args.pr,
      repo: repoName,
      number,
      deliveryId: "",
      data: null,
      debounceMs: decision.outcome === "merged" ? (args.holdMs ?? 0) : 0,
      autoClose: false,
      prompt: waitPrompt({
        repo: repoName,
        number,
        outcome: decision.outcome,
        ...(decision.outcome === "merged" ? { base: decision.base, sha: decision.sha } : {}),
        deliveryIds: [],
        event: args.event,
      }),
    },
    args.source,
  );
}

/**
 * A base branch moved: check every open linked PR on it. This is the only place
 * that fans out; each PR then runs {@link checkConflict}. The merged PR itself
 * is skipped, and so is any link known to target another branch (no read).
 * Links without a known base are read and filtered by what GitHub says.
 * Returns whether any wake was written.
 */
export async function checkBase(
  deps: ConsumerDeps,
  move: Extract<Action, { type: "checkBase" }>,
  touched: Set<string>,
  source: "webhook" | "sweep" = "webhook",
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
      ...(source === "sweep" ? { source } : {}),
    });
    if (sessionId) {
      touched.add(sessionId);
      woke = true;
    }
  }
  // A merge moved the base and every candidate was checked (or queued for a re-check): remember the
  // tip, so the scheduled sweep does not check the same move again. A push has no merge to compare
  // with what the sweep reads, so it is not recorded.
  if (move.afterPr !== null && /^[0-9a-f]{7,40}$/.test(move.baseSha)) {
    await deps.repo.putBaseTip({
      repo: move.repo,
      base: move.base,
      sha: move.baseSha,
      afterPr: move.afterPr,
    });
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
      wakeOnBehind: deps.config.wakeOnBehind,
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
      const kind = decision.state === "behind" ? "pr_behind" : "pr_conflict";
      deps.metrics.count(decision.state === "behind" ? "BehindFound" : "ConflictsFound", 1);
      const data = {
        conflict: {
          base: msg.base,
          baseSha: msg.baseSha,
          afterPrs: msg.afterPr === null ? [] : [msg.afterPr],
          afterPush: msg.afterPr === null,
        },
      };
      const wake = await enqueueWake(
        wakeDeps(deps),
        {
          type: "wake",
          sessionId: link.sessionId,
          kind,
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
            kind,
          }),
        },
        msg.source === "sweep" ? { source: "sweep" } : {},
      );
      if (!wake.merged) {
        deps.metrics.count("ConflictWakes", 1, { state: decision.state });
      }
      deps.logger.info("conflict_wake", {
        ...fields,
        state: decision.state,
        sessionId: link.sessionId,
        ...wake,
      });
      return link.sessionId;
    }
  }
}

/** Drain one session's inbox and count what happened (the sweep drains the sessions it woke). */
export async function drainSession(deps: ConsumerDeps, sessionId: string): Promise<void> {
  await drainAndCount(wakeDeps(deps), sessionId);
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
    case "wait_check": {
      const sessionId = await checkWait(deps, message);
      if (sessionId) {
        await drainAndCount(wakeDeps(deps), sessionId);
      }
      return;
    }
  }
}

export { prKeyOf };
