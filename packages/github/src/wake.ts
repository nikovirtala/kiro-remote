/** Writing wake items into a session's inbox, and draining it. */

import {
  type CommandQueue,
  drainInbox,
  type FeedSource,
  type GithubQueue,
  type InboxItem,
  inboxSk,
  openQueuedPrompts,
  type Repository,
  sessionPk,
} from "@nikovirtala/kiro-remote-core";
import { ulid } from "ulid";
import type { Logger, Metrics } from "./log.ts";
import { checksPrompt, conflictPrompt } from "./render.ts";
import { type Action, type ConflictData, type FailedCheck, WAIT_WAKE_KINDS } from "./types.ts";

type WakeAction = Extract<Action, { type: "wake" }>;

export interface WakeDeps {
  repo: Repository;
  queue: CommandQueue;
  githubQueue: GithubQueue;
  metrics: Metrics;
  logger: Logger;
  now: () => number;
  newId?: () => string;
}

const INBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const isWaitKind = (kind: string): boolean => (WAIT_WAKE_KINDS as readonly string[]).includes(kind);
const isBaseMoveKind = (kind: string): boolean => kind === "pr_conflict" || kind === "pr_behind";

/**
 * Add a wake to the session's inbox. Inside the debounce window an existing
 * pending item for the same PR and kind absorbs it (failing checks are united
 * and the prompt re-rendered), so a burst of failures becomes one wake.
 *
 * A wake for a PR the session waits for is never folded (one wait, one wake), but it is held
 * together with the session's conflict wakes: a merge can make the waiter's own PR conflict, and
 * the drain folds only items that are due, so both are due at the same time and reach the session
 * as one turn. A conflict wake is never due before a pending wait wake, and a wait wake moves
 * pending conflict wakes that are due earlier to its own due time.
 */
export async function enqueueWake(
  deps: WakeDeps,
  a: WakeAction,
  opts: {
    /** What caused the wake (the change feed's `source`). Defaults to a webhook. */
    source?: FeedSource;
    /** This wake fires a wait: the wait is removed with the wake, in one transaction. */
    fires?: { reason: "merged" | "closed" | "unreadable" };
  } = {},
): Promise<{ merged: boolean; id: string; claimed: boolean }> {
  const nowMs = deps.now();
  const waitWake = isWaitKind(a.kind);
  const baseMoveWake = isBaseMoveKind(a.kind);
  let pending: InboxItem[] = [];
  if (a.debounceMs > 0 || baseMoveWake || waitWake) {
    pending = await deps.repo.queryInbox(a.sessionId, { status: "pending" });
  }
  if (a.debounceMs > 0 && !waitWake) {
    const target = pending.find(
      (i) => i.key === a.key && i.kind === a.kind && nowMs - Date.parse(i.createdAt) < a.debounceMs,
    );
    if (baseMoveWake) {
      const folded = await foldBaseMoveWake(deps, a, pending, target);
      if (folded) {
        return { ...folded, claimed: true };
      }
    } else if (target && a.kind === "checks_failed") {
      const checks = unionChecks(
        (target.data as { checks?: FailedCheck[] } | null)?.checks ?? [],
        a.data?.checks ?? [],
      );
      const deliveryIds = [...new Set([...target.deliveryIds, a.deliveryId])];
      const merged = await deps.repo.mergeInboxItem(a.sessionId, target.id, {
        deliveryIds,
        data: { checks },
        prompt: checksPrompt({
          repo: a.repo,
          number: a.number,
          checks,
          deliveryIds,
          event: "check_suite/workflow_run.completed (failure)",
        }),
      });
      if (merged) {
        return { merged: true, id: target.id, claimed: true };
      }
      // It was drained meanwhile: fall through and start a new item.
    }
  }
  let notBeforeMs = nowMs + a.debounceMs;
  if (baseMoveWake) {
    for (const i of pending) {
      if (isWaitKind(i.kind)) {
        notBeforeMs = Math.max(notBeforeMs, Date.parse(i.notBefore));
      }
    }
  }
  const id = deps.newId?.() ?? ulid(nowMs);
  const createdAt = new Date(nowMs).toISOString();
  const item: InboxItem = {
    PK: sessionPk(a.sessionId),
    SK: inboxSk(id),
    id,
    sessionId: a.sessionId,
    source: "github",
    deliveryId: a.deliveryId,
    deliveryIds: a.deliveryId ? [a.deliveryId] : [],
    kind: a.kind,
    key: a.key,
    prompt: a.prompt,
    data: a.data,
    createdAt,
    notBefore: new Date(notBeforeMs).toISOString(),
    status: "pending",
    dropReason: null,
    deliveredTurnId: null,
    autoClose: a.autoClose,
    ttl: Math.floor((nowMs + INBOX_TTL_MS) / 1000),
  };
  const source = opts.source ?? "webhook";
  if (opts.fires) {
    const fired = await deps.repo.fireWait({
      sessionId: a.sessionId,
      pr: a.key,
      reason: opts.fires.reason,
      item,
      source,
    });
    if (!fired) {
      return { merged: false, id, claimed: false };
    }
  } else {
    await deps.repo.putInboxItem(item, { source });
  }
  if (waitWake) {
    for (const i of pending) {
      if (isBaseMoveKind(i.kind) && Date.parse(i.notBefore) < notBeforeMs) {
        await deps.repo.setInboxNotBefore(a.sessionId, i.id, item.notBefore);
      }
    }
  }
  if (notBeforeMs > nowMs) {
    // A held item is not due yet; make sure something drains it when it is.
    await deps.githubQueue.send(
      { kind: "drain", sessionId: a.sessionId },
      Math.ceil((notBeforeMs - nowMs) / 1000) + 2,
    );
  }
  return { merged: false, id, claimed: true };
}

/**
 * A conflict and a behind wake for the same PR never both go out: both ask for
 * a rebase. A pending conflict item absorbs a behind wake (at any age), and a
 * conflict wake replaces a pending behind item, keeping the PRs it named.
 * Otherwise a wake folds into a pending item of its own kind inside the window.
 * Returns null when the caller should write a new item.
 */
async function foldBaseMoveWake(
  deps: WakeDeps,
  a: WakeAction,
  pending: readonly InboxItem[],
  sameKind: InboxItem | undefined,
): Promise<{ merged: true; id: string } | null> {
  const forKey = pending.filter((i) => i.key === a.key);
  if (a.kind === "pr_behind") {
    const conflict = forKey.find((i) => i.kind === "pr_conflict");
    if (conflict && (await mergeConflictItem(deps, conflict, a))) {
      return { merged: true, id: conflict.id };
    }
  } else {
    const behind = forKey.filter((i) => i.kind === "pr_behind");
    if (behind.length > 0) {
      const dropped = await deps.repo.dropInbox(
        a.sessionId,
        behind.map((i) => i.id),
        "superseded_by_conflict",
      );
      if (dropped > 0) {
        deps.metrics.count("WakesDropped", dropped, { reason: "superseded_by_conflict" });
      }
      const carried = behind.flatMap(
        (i) => (i.data as { conflict?: ConflictData } | null)?.conflict?.afterPrs ?? [],
      );
      const own = a.data?.conflict;
      if (own) {
        own.afterPrs = [...new Set([...carried, ...own.afterPrs])];
        a.prompt = conflictPrompt({
          repo: a.repo,
          number: a.number,
          data: own,
          deliveryIds: [a.deliveryId],
          kind: "pr_conflict",
        });
      }
    }
  }
  if (sameKind && (await mergeConflictItem(deps, sameKind, a))) {
    return { merged: true, id: sameKind.id };
  }
  return null;
}

/**
 * Fold another base move into a pending conflict (or behind) item: keep the newest base sha,
 * list every PR whose merge moved the base, and re-render the prompt.
 */
async function mergeConflictItem(
  deps: WakeDeps,
  target: InboxItem,
  a: WakeAction,
): Promise<boolean> {
  const old = (target.data as { conflict?: ConflictData } | null)?.conflict;
  const add = a.data?.conflict;
  if (!add) {
    return false;
  }
  const conflict: ConflictData = {
    base: add.base,
    baseSha: add.baseSha,
    afterPrs: [...new Set([...(old?.afterPrs ?? []), ...add.afterPrs])],
    afterPush: (old?.afterPush ?? false) || add.afterPush,
  };
  const deliveryIds = [...new Set([...target.deliveryIds, a.deliveryId])];
  return deps.repo.mergeInboxItem(a.sessionId, target.id, {
    deliveryIds,
    data: { conflict },
    prompt: conflictPrompt({
      repo: a.repo,
      number: a.number,
      data: conflict,
      deliveryIds,
      kind: target.kind === "pr_behind" ? "pr_behind" : "pr_conflict",
    }),
  });
}

function unionChecks(a: readonly FailedCheck[], b: readonly FailedCheck[]): FailedCheck[] {
  const seen = new Set<string>();
  const out: FailedCheck[] = [];
  for (const c of [...a, ...b]) {
    const k = `${c.name}\u0000${c.url}`;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(c);
    }
  }
  return out;
}

/**
 * autoCloseOnMerge, decided after the post-merge turn was harvested. The
 * session is deleted only when none of its linked PRs is still open (or of
 * unknown state, as a manual link starts), so a session that opened a
 * follow-up PR keeps running. A kept session gets the inbox drain the bridge
 * skipped. A session with queued prompts is never closed: the close is owed
 * (META `closeAfterQueue`) and the settle of the last queued turn asks again.
 */
export async function autoCloseIfDone(
  deps: WakeDeps,
  sessionId: string,
): Promise<"closed" | "kept" | "gone"> {
  const session = await deps.repo.getSession(sessionId);
  if (!session || session.status === "deleted") {
    return "gone";
  }
  const queued = await openQueuedPrompts(deps, sessionId);
  if (queued.length > 0) {
    await deps.repo.patchSession(sessionId, { closeAfterQueue: true });
    deps.logger.info("auto_close_deferred_queue", { sessionId, queued: queued.length });
    deps.metrics.count("AutoCloseSkipped", 1);
    return "kept";
  }
  const links = await deps.repo.queryLinks(sessionId);
  const open = links.filter((l) => l.prState === "open" || l.prState === "unknown");
  if (open.length > 0) {
    deps.logger.info("auto_close_skipped", { sessionId, openPrs: open.map((l) => l.pr) });
    deps.metrics.count("AutoCloseSkipped", 1);
    await drainAndCount(deps, sessionId);
    return "kept";
  }
  const pending = await deps.repo.queryInbox(sessionId, { status: "pending" });
  if (pending.length > 0) {
    const dropped = await deps.repo.dropInbox(
      sessionId,
      pending.map((i) => i.id),
      "auto_closed",
    );
    deps.metrics.count("WakesDropped", dropped, { reason: "auto_closed" });
  }
  await deps.queue.enqueue({
    kind: "delete",
    sub: session.createdBy,
    sessionId,
    commandId: deps.newId?.() ?? crypto.randomUUID(),
    source: "webhook",
  });
  deps.metrics.count("AutoClosed", 1);
  deps.logger.info("auto_close_on_merge", { sessionId });
  return "closed";
}

/** Drain one session's inbox and count what happened. */
export async function drainAndCount(deps: WakeDeps, sessionId: string) {
  const result = await drainInbox(
    {
      repo: deps.repo,
      queue: deps.queue,
      now: deps.now,
      ...(deps.newId ? { newId: deps.newId } : {}),
    },
    sessionId,
  );
  if (result.status === "delivered") {
    deps.metrics.count("WakesDelivered", result.inboxIds.length);
  } else if (result.status === "dropped") {
    deps.metrics.count("WakesDropped", result.dropped, { reason: result.reason });
  }
  deps.logger.info("inbox_drained", { sessionId, status: result.status });
  return result;
}
