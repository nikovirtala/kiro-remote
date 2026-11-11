/** Writing wake items into a session's inbox, and draining it. */

import {
  type CommandQueue,
  drainInbox,
  type GithubQueue,
  type InboxItem,
  inboxSk,
  type Repository,
  sessionPk,
} from "@nikovirtala/kiro-remote-core";
import { ulid } from "ulid";
import type { Logger, Metrics } from "./log.ts";
import { checksPrompt } from "./render.ts";
import type { Action, FailedCheck } from "./types.ts";

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

/**
 * Add a wake to the session's inbox. Inside the debounce window an existing
 * pending item for the same PR and kind absorbs it (failing checks are united
 * and the prompt re-rendered), so a burst of failures becomes one wake.
 */
export async function enqueueWake(
  deps: WakeDeps,
  a: WakeAction,
): Promise<{ merged: boolean; id: string }> {
  const nowMs = deps.now();
  if (a.debounceMs > 0) {
    const pending = await deps.repo.queryInbox(a.sessionId, { status: "pending" });
    const target = pending.find(
      (i) => i.key === a.key && i.kind === a.kind && nowMs - Date.parse(i.createdAt) < a.debounceMs,
    );
    if (target) {
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
        return { merged: true, id: target.id };
      }
      // It was drained meanwhile: fall through and start a new item.
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
    deliveryIds: [a.deliveryId],
    kind: a.kind,
    key: a.key,
    prompt: a.prompt,
    data: a.data,
    createdAt,
    notBefore: new Date(nowMs + a.debounceMs).toISOString(),
    status: "pending",
    dropReason: null,
    deliveredTurnId: null,
    autoClose: a.autoClose,
    ttl: Math.floor((nowMs + INBOX_TTL_MS) / 1000),
  };
  await deps.repo.putInboxItem(item);
  if (a.debounceMs > 0) {
    // A debounced item is not due yet; make sure something drains it when it is.
    await deps.githubQueue.send(
      { kind: "drain", sessionId: a.sessionId },
      Math.ceil(a.debounceMs / 1000) + 2,
    );
  }
  return { merged: false, id };
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
