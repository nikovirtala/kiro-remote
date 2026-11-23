/**
 * What happens when a turn settles and the session returns to idle.
 *
 * ONE helper, {@link TurnSettler.settled}, is called from every place the
 * consumer settles a turn (a live turn finishing, a failed turn, a catch-up
 * finishing, a launch that never provisioned). It
 *
 *  1. closes the TURN# row,
 *  2. asks the GitHub consumer to harvest the turn's events for PR links;
 *     when the turn that just completed was a post-merge wake and
 *     autoCloseOnMerge is on, the harvest message carries `autoClose` and the
 *     consumer deletes the session unless a linked PR is still open (and
 *     drains the inbox itself), so step 3 is skipped here,
 *  3. starts the session's next queued prompt (whenBusy "queue"), if any, and otherwise
 *     drains its inbox, so a wake that arrived while the turn ran becomes the next turn (or is
 *     dropped when the session failed). Queued prompts go first and in order, and an automatic
 *     close waits until none is left: it is owed (META `closeAfterQueue`) and decided again when
 *     the queue is empty.
 *
 * It never throws: the turn is already settled, and a hiccup here must not
 * make SQS redeliver the command. Pending inbox items are retried by the next
 * drain, which every later settle and every webhook runs.
 */

import {
  type CommandQueue,
  drainInbox,
  drainQueuedPrompts,
  type GithubQueue,
  openQueuedPrompts,
  type QueueDrainResult,
  type Repository,
} from "@nikovirtala/kiro-remote-core";
import type { Logger } from "./logger.ts";
import type { Metrics } from "./metrics.ts";

export type SettleOutcome = "completed" | "failed" | "session_failed";

export interface SettleDeps {
  repo: Repository;
  logger: Logger;
  metrics: Metrics;
  /** Absent when the GitHub feature is off: the hook then does nothing but close the TURN# row. */
  queue?: CommandQueue;
  githubQueue?: GithubQueue;
  now: () => number;
  newId?: () => string;
}

export class TurnSettler {
  private readonly d: SettleDeps;

  constructor(deps: SettleDeps) {
    this.d = deps;
  }

  async settled(args: {
    sessionId: string;
    turnId: string | null;
    outcome: SettleOutcome;
    stopReason?: string;
    /** META eventSeq when the turn began (the harvest scans events after it). */
    afterSeq?: number;
  }): Promise<void> {
    const { repo, logger } = this.d;
    const { sessionId, turnId, outcome } = args;
    let autoClose = false;
    try {
      if (turnId) {
        const turn = await repo.getTurn(sessionId, turnId);
        autoClose = outcome === "completed" && turn?.trigger?.autoClose === true;
        await repo.finishTurn(sessionId, turnId, {
          status: outcome === "completed" ? "completed" : "failed",
          stopReason: args.stopReason ?? null,
        });
      }
    } catch (err) {
      logger.warn("settle_turn_record_failed", { sessionId, turnId, error: String(err) });
    }

    if (!this.d.queue) {
      return;
    }

    // Prompts still queued: no automatic close (it is owed, and decided again once the queue is
    // empty), and the next prompt starts. When nothing is queued and a close is owed, it is due.
    let queued = 0;
    try {
      queued = (await openQueuedPrompts(this.d, sessionId)).length;
      if (queued > 0 && autoClose) {
        await this.oweClose(sessionId, true);
        autoClose = false;
      } else if (queued === 0 && outcome !== "session_failed" && turnId) {
        const session = await repo.getSession(sessionId);
        if (session?.closeAfterQueue === true) {
          await this.oweClose(sessionId, false);
          autoClose = true;
        }
      }
    } catch (err) {
      // Not knowing the queue, do not close: the session stays until a later turn decides.
      autoClose = false;
      logger.warn("settle_hook_failed", { sessionId, turnId, step: "queue", error: String(err) });
    }

    try {
      if (autoClose && turnId && this.d.githubQueue) {
        // Whether to close is decided after the harvest: the agent may have
        // opened a follow-up PR in this very turn, and the session must then
        // stay. The consumer drains the inbox if it keeps the session.
        await this.d.githubQueue.send({
          kind: "harvest",
          sessionId,
          turnId,
          afterSeq: args.afterSeq ?? 0,
          autoClose: true,
        });
        logger.info("auto_close_requested", { sessionId, turnId });
        return;
      }
      if (autoClose) {
        await this.autoClose(sessionId);
        return;
      }
      if (turnId && outcome !== "session_failed" && this.d.githubQueue) {
        await this.d.githubQueue.send({
          kind: "harvest",
          sessionId,
          turnId,
          afterSeq: args.afterSeq ?? 0,
        });
      }
    } catch (err) {
      logger.warn("settle_hook_failed", { sessionId, turnId, step: "harvest", error: String(err) });
    }

    if (queued > 0) {
      await this.drainQueue(sessionId);
    }
    try {
      await this.drain(sessionId);
    } catch (err) {
      logger.warn("settle_hook_failed", { sessionId, turnId, step: "drain", error: String(err) });
    }
  }

  /** Whether this consumer can send the command that starts a queued prompt (COMMAND_QUEUE_URL is set). */
  get canDrainQueue(): boolean {
    return this.d.queue !== undefined;
  }

  /** Record (or clear) that an automatic close is owed once the queue is empty. */
  private async oweClose(sessionId: string, owed: boolean): Promise<void> {
    await this.d.repo.patchSession(sessionId, { closeAfterQueue: owed });
    this.d.logger.info(owed ? "auto_close_deferred_queue" : "auto_close_due_queue_empty", {
      sessionId,
    });
  }

  /**
   * Start the session's oldest queued prompt (or fail them when the session is gone). Throws when
   * the prompt command cannot be sent, so a caller that is itself retried can retry.
   */
  async drainQueueOrThrow(sessionId: string): Promise<QueueDrainResult> {
    const { repo, queue, metrics, logger } = this.d;
    if (!queue) {
      throw new Error("no command queue configured (set COMMAND_QUEUE_URL)");
    }
    const result = await drainQueuedPrompts(
      { repo, queue, now: this.d.now, ...(this.d.newId ? { newId: this.d.newId } : {}) },
      sessionId,
    );
    switch (result.status) {
      case "delivered":
        metrics.count("QueuedPromptsDelivered", 1);
        logger.info("queued_prompt_enqueued", { sessionId, turnId: result.turnId });
        break;
      case "failed":
        metrics.count("QueuedPromptsFailed", result.failed, { reason: result.reason });
        break;
      case "busy":
      case "in_flight":
      case "contended":
        logger.info("queue_drain_deferred", { sessionId, status: result.status });
        break;
      case "empty":
        break;
    }
    return result;
  }

  /** {@link drainQueueOrThrow} for a settle: never throws, a later drain retries. */
  async drainQueue(sessionId: string): Promise<void> {
    try {
      await this.drainQueueOrThrow(sessionId);
    } catch (err) {
      this.d.logger.warn("settle_hook_failed", {
        sessionId,
        step: "queue_drain",
        error: String(err),
      });
    }
  }

  /** Drop every pending inbox item of a session (deleted, auto-closed). A no-op when the feature is off. */
  async dropPending(sessionId: string, reason: string): Promise<void> {
    if (!this.d.queue) {
      return;
    }
    try {
      const pending = await this.d.repo.queryInbox(sessionId, { status: "pending" });
      if (pending.length === 0) {
        return;
      }
      const dropped = await this.d.repo.dropInbox(
        sessionId,
        pending.map((i) => i.id),
        reason,
      );
      this.d.metrics.count("WakesDropped", dropped, { reason });
    } catch (err) {
      this.d.logger.warn("settle_hook_failed", { sessionId, step: "drop", error: String(err) });
    }
  }

  /** Drain now (used when a wake turn could not start); never throws. */
  async drainSoon(sessionId: string): Promise<void> {
    try {
      await this.drain(sessionId);
    } catch (err) {
      this.d.logger.warn("settle_hook_failed", { sessionId, step: "drain", error: String(err) });
    }
  }

  /**
   * autoCloseOnMerge without a GitHub queue to decide after the harvest (not a
   * deployed configuration; the feature always has both queues): close now.
   */
  private async autoClose(sessionId: string): Promise<void> {
    const { repo, queue, logger } = this.d;
    const session = await repo.getSession(sessionId);
    if (!queue || !session) {
      return;
    }
    await this.dropPending(sessionId, "auto_closed");
    await queue.enqueue({
      kind: "delete",
      sub: session.createdBy,
      sessionId,
      commandId: this.d.newId?.() ?? crypto.randomUUID(),
      source: "webhook",
    });
    logger.info("auto_close_on_merge", { sessionId });
  }

  private async drain(sessionId: string): Promise<void> {
    const { repo, queue, logger, metrics } = this.d;
    if (!queue) {
      return;
    }
    const result = await drainInbox(
      {
        repo,
        queue,
        now: this.d.now,
        ...(this.d.newId ? { newId: this.d.newId } : {}),
      },
      sessionId,
    );
    switch (result.status) {
      case "delivered":
        metrics.count("WakesDelivered", result.inboxIds.length);
        logger.info("wake_turn_enqueued", {
          sessionId,
          turnId: result.turnId,
          items: result.inboxIds.length,
        });
        break;
      case "dropped":
        metrics.count("WakesDropped", result.dropped, { reason: result.reason });
        break;
      case "contended":
      case "limit":
      case "busy":
      case "not_due":
      case "empty":
        if (result.status !== "empty") {
          logger.info("wake_drain_deferred", { sessionId, status: result.status });
        }
        break;
    }
  }
}
