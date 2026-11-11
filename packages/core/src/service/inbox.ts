/**
 * The generic wake path: an inbox of typed wake items per session, and the one
 * function that turns them into a turn.
 *
 * Producers (GitHub today; schedules, Slack, ... later) only WRITE inbox items.
 * {@link drainInbox} is the only code that starts a turn from them. A cloud
 * session cannot take a mid-turn steer or a queued prompt, so a wake never
 * enqueues anything into a busy session: it waits as `pending` until a drain
 * finds the session idle. Drains run from the producer's consumer and from the
 * bridge whenever a turn settles.
 */

import { MAX_CLOUD_SESSIONS } from "../config.ts";
import { ConcurrentModificationError } from "../repo/repository.ts";
import type { InboxItem } from "../repo/types.ts";
import type { ServiceDeps } from "./index.ts";

export type DrainResult =
  /** Nothing pending. */
  | { status: "empty" }
  /** The session is not idle; items stay pending until the running turn settles. */
  | { status: "busy" }
  /** Items are pending but none is due yet (debounce). */
  | { status: "not_due"; nextDueAt: string }
  /** The optimistic lock on META (or the item claim) was lost to a concurrent writer. */
  | { status: "contended" }
  /** The caller already has the maximum number of running sessions. */
  | { status: "limit"; running: number; limit: number }
  /** The session is failed or deleted: pending items were dropped. */
  | { status: "dropped"; dropped: number; reason: string }
  /** One prompt turn was enqueued for the claimed items. */
  | {
      status: "delivered";
      turnId: string;
      inboxIds: string[];
      deliveryIds: string[];
      autoClose: boolean;
    };

export type DrainDeps = Pick<ServiceDeps, "repo" | "queue" | "now" | "newId"> & {
  /** Cap on the owner's concurrently running sessions. Defaults to MAX_CLOUD_SESSIONS. */
  maxCloudSessions?: number;
};

const RUNNING_STATUSES = new Set(["provisioning", "running", "awaiting_permission"]);

/**
 * Fold the session's due pending inbox items into ONE prompt turn.
 *
 * - failed / deleted session: pending items are dropped with the reason.
 * - not idle: nothing happens; the settle of the running turn drains again.
 * - idle: takes every due item, oldest first, claims them for a fresh turn id
 *   under an optimistic lock on META (a concurrent manual prompt bumps the same
 *   version, so it wins and this drain runs again after that turn), then
 *   enqueues the prompt with `whenBusy: "reject"` and the trigger recorded.
 * - a wake turn is a launch-class turn: when the owner already has
 *   MAX_CLOUD_SESSIONS sessions running, the items stay pending.
 *
 * Safe to call from several places at once; the claim is the only winner.
 */
export async function drainInbox(deps: DrainDeps, sessionId: string): Promise<DrainResult> {
  const nowMs = deps.now?.() ?? Date.now();
  const session = await deps.repo.getSession(sessionId);
  const pending = await deps.repo.queryInbox(sessionId, { status: "pending" });
  if (pending.length === 0) {
    return { status: "empty" };
  }

  if (!session || session.status === "failed" || session.status === "deleted") {
    const reason = !session ? "session_missing" : `session_${session.status}`;
    const dropped = await deps.repo.dropInbox(
      sessionId,
      pending.map((i) => i.id),
      reason,
    );
    return { status: "dropped", dropped, reason };
  }

  if (session.status !== "idle") {
    return { status: "busy" };
  }

  const due = pending.filter((i) => Date.parse(i.notBefore) <= nowMs);
  if (due.length === 0) {
    const next = pending.map((i) => i.notBefore).sort()[0];
    return { status: "not_due", nextDueAt: next };
  }

  const limit = deps.maxCloudSessions ?? MAX_CLOUD_SESSIONS;
  const { items: owned } = await deps.repo.listSessionsByUser(session.createdBy, { limit: 100 });
  const running = owned.filter((s) => s.id !== sessionId && RUNNING_STATUSES.has(s.status)).length;
  if (running >= limit) {
    return { status: "limit", running, limit };
  }

  // The optimistic lock: bump META's version from the value we read. Anything
  // that changed the session since (a turn starting, a manual prompt) wins.
  try {
    await deps.repo.updateSession(sessionId, session.version, {});
  } catch (err) {
    if (err instanceof ConcurrentModificationError) {
      return { status: "contended" };
    }
    throw err;
  }

  const turnId = deps.newId?.() ?? crypto.randomUUID();
  const claimedIds = new Set(
    await deps.repo.claimInbox(
      sessionId,
      due.map((i) => i.id),
      turnId,
    ),
  );
  if (claimedIds.size === 0) {
    return { status: "contended" };
  }
  const claimed = due.filter((i) => claimedIds.has(i.id));
  const deliveryIds = [...new Set(claimed.flatMap((i) => i.deliveryIds))];
  const autoClose = claimed.some((i) => i.autoClose);
  const inboxIds = claimed.map((i) => i.id);

  try {
    await deps.queue.enqueue({
      kind: "prompt",
      sub: session.createdBy,
      sessionId,
      commandId: deps.newId?.() ?? crypto.randomUUID(),
      turnId,
      prompt: foldPrompts(claimed),
      whenBusy: "reject",
      trigger: { source: "github", deliveryIds, inboxIds, ...(autoClose ? { autoClose } : {}) },
    });
  } catch (err) {
    // The wake turn will never start: put the items back for the next drain.
    await deps.repo.releaseInbox(sessionId, inboxIds, turnId);
    throw err;
  }
  return { status: "delivered", turnId, inboxIds, deliveryIds, autoClose };
}

/** One prompt from several items, oldest first. Every item already starts with its own source header. */
export function foldPrompts(items: readonly Pick<InboxItem, "prompt">[]): string {
  return items.map((i) => i.prompt).join("\n\n---\n\n");
}
