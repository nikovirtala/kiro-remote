/**
 * The prompt queue: what a prompt sent with `whenBusy: "queue"` is, and the one function that turns
 * it into a turn.
 *
 * A cloud turn cannot be interleaved with, so a prompt for a busy session cannot be handed to the
 * agent. It is kept instead, as a durable item of the session (`QPROMPT#<turn id>`), and run as its
 * own turn when the turn in front of it has ended. The guarantees:
 *
 *  - in order: prompts run oldest first, one at a time, each as the turn id its caller was given;
 *  - once: a prompt is claimed (queued -> delivered) by exactly one drain, and its turn starts only
 *    from the claimed state (delivered -> started), so a redelivered command starts nothing;
 *  - never silently: a prompt that cannot run ends `failed` with a reason, as a `turn.failed` event
 *    on the session's event log and a `prompt.failed` annotation on the change feed.
 *
 * {@link drainQueuedPrompts} runs from the bridge whenever a turn settles and whenever a queue
 * command arrives, like {@link drainInbox} does for wakes. Prompts go ahead of wakes: a drain of the
 * inbox waits while the queue holds anything.
 */

import { QUEUED_PROMPT_CLAIM_STALE_MS } from "../config.ts";
import type { QueuedPromptItem } from "../repo/types.ts";
import type { FeedSource, PromptFailReason } from "../schemas/feed.ts";
import type { ServiceDeps } from "./index.ts";

export type QueueDrainResult =
  /** Nothing is queued. */
  | { status: "empty" }
  /** The session is not idle; the settle of the running turn drains again. */
  | { status: "busy" }
  /** A claimed prompt is on its way to the bridge; the one behind it must wait for it. */
  | { status: "in_flight"; turnId: string }
  /** Another drain claimed the prompt first. */
  | { status: "contended" }
  /** The session is failed or deleted: the queued prompts failed with the reason. */
  | { status: "failed"; failed: number; reason: PromptFailReason }
  /** The oldest queued prompt was claimed and sent to the bridge as a prompt command. */
  | { status: "delivered"; turnId: string };

export type QueueDeps = Pick<ServiceDeps, "repo" | "now" | "newId">;
export type QueueDrainDeps = QueueDeps & Pick<ServiceDeps, "queue">;

/** Prompts that have not started and have not failed: the ones a session is still to run. */
export function isOpenQueuedPrompt(item: Pick<QueuedPromptItem, "status">): boolean {
  return item.status === "queued" || item.status === "delivered";
}

export async function openQueuedPrompts(
  deps: Pick<ServiceDeps, "repo">,
  sessionId: string,
): Promise<QueuedPromptItem[]> {
  return (await deps.repo.listQueuedPrompts(sessionId)).filter(isOpenQueuedPrompt);
}

/**
 * The `turn.failed` event a failed prompt writes on the session's event log, under the turn id the
 * caller holds. Its payload names the reason and nothing the prompt said.
 */
export async function appendPromptFailedEvent(
  deps: QueueDeps,
  sessionId: string,
  args: {
    turnId: string;
    whenBusy: "queue";
    reason: PromptFailReason;
    rawType: string;
  },
): Promise<void> {
  const ts = new Date(deps.now?.() ?? Date.now()).toISOString();
  const payload = {
    type: "turn.failed",
    sessionId,
    turnId: args.turnId,
    replay: false,
    rawType: args.rawType,
    failureReason: "generic",
    payload: { source: "kiro-remote", whenBusy: args.whenBusy, reason: args.reason },
  };
  await deps.repo.appendEvent(sessionId, {
    turnId: args.turnId,
    ts,
    type: "turn.failed",
    rawType: args.rawType,
    replay: false,
    payload,
  });
}

/**
 * Fail one queued prompt: its status, `prompt.failed` on the change feed (one transaction), then
 * `turn.failed` on the event log. False when it was no longer queued or delivered (another writer
 * got there first, so that writer reports it).
 */
export async function failQueuedPrompt(
  deps: QueueDeps,
  sessionId: string,
  turnId: string,
  args: { reason: PromptFailReason; source: FeedSource },
): Promise<boolean> {
  if (!(await deps.repo.failQueuedPrompt(sessionId, turnId, args))) {
    return false;
  }
  try {
    await appendPromptFailedEvent(deps, sessionId, {
      turnId,
      whenBusy: "queue",
      reason: args.reason,
      rawType: "queued_prompt_failed",
    });
  } catch {
    // The status and the feed event are written, and GET /v1/sessions/{id} shows the failure.
    // The event log entry is the one write that can be missing, and only if the row is gone.
  }
  return true;
}

/** Fail every prompt the session still has queued or delivered. Returns how many failed. */
export async function failOpenQueuedPrompts(
  deps: QueueDeps,
  sessionId: string,
  args: { reason: PromptFailReason; source: FeedSource },
): Promise<number> {
  let failed = 0;
  for (const item of await openQueuedPrompts(deps, sessionId)) {
    if (await failQueuedPrompt(deps, sessionId, item.id, args)) {
      failed++;
    }
  }
  return failed;
}

/**
 * Start the oldest queued prompt of an idle session, if nothing else is in the way.
 *
 * - failed / deleted / missing session: every open prompt fails with the reason.
 * - not idle: nothing happens; the settle of the running turn drains again.
 * - a prompt claimed earlier is still on its way: the next one waits behind it, so order holds. A
 *   claim older than {@link QUEUED_PROMPT_CLAIM_STALE_MS} is taken back instead (its command was
 *   lost) and queues again at its place.
 * - otherwise the oldest queued prompt is claimed (one winner among concurrent drains) and enqueued
 *   as a prompt command with the same turn id and `queued: true`. If it cannot be enqueued the claim
 *   is undone and the error thrown.
 */
export async function drainQueuedPrompts(
  deps: QueueDrainDeps,
  sessionId: string,
): Promise<QueueDrainResult> {
  const nowMs = deps.now?.() ?? Date.now();
  const open = await openQueuedPrompts(deps, sessionId);
  if (open.length === 0) {
    return { status: "empty" };
  }

  const session = await deps.repo.getSession(sessionId);
  if (!session || session.status === "failed" || session.status === "deleted") {
    const reason: PromptFailReason =
      session?.status === "failed" ? "session_failed" : "session_deleted";
    const failed = await failOpenQueuedPrompts(deps, sessionId, { reason, source: "bridge" });
    return { status: "failed", failed, reason };
  }
  if (session.status !== "idle") {
    return { status: "busy" };
  }

  let head: QueuedPromptItem | undefined;
  for (const item of open) {
    if (item.status === "delivered") {
      const claimedAt = item.claimedAt ? Date.parse(item.claimedAt) : 0;
      if (nowMs - claimedAt < QUEUED_PROMPT_CLAIM_STALE_MS) {
        return { status: "in_flight", turnId: item.id };
      }
      if (!(await deps.repo.releaseQueuedPrompt(sessionId, item.id))) {
        return { status: "contended" };
      }
    }
    head ??= item;
  }
  if (!head) {
    return { status: "empty" };
  }

  if (!(await deps.repo.claimQueuedPrompt(sessionId, head.id))) {
    return { status: "contended" };
  }
  try {
    await deps.queue.enqueue({
      kind: "prompt",
      sub: session.createdBy,
      sessionId,
      commandId: deps.newId?.() ?? crypto.randomUUID(),
      turnId: head.id,
      prompt: await deps.repo.queuedPromptText(head),
      whenBusy: "reject",
      queued: true,
    });
  } catch (err) {
    await deps.repo.releaseQueuedPrompt(sessionId, head.id);
    throw err;
  }
  return { status: "delivered", turnId: head.id };
}
