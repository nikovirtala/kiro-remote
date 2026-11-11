/**
 * What happens when a turn settles and the session returns to idle.
 *
 * ONE helper, {@link TurnSettler.settled}, is called from every place the
 * consumer settles a turn (a live turn finishing, a failed turn, a catch-up
 * finishing, a launch that never provisioned). It
 *
 *  1. closes the TURN# row,
 *  2. deletes the session when the turn that just completed was a post-merge
 *     wake and autoCloseOnMerge is on,
 *  3. asks the GitHub consumer to harvest the turn's events for PR links,
 *  4. drains the session's inbox, so a wake that arrived while the turn ran
 *     becomes the next turn (or is dropped when the session failed).
 *
 * It never throws: the turn is already settled, and a hiccup here must not
 * make SQS redeliver the command. Pending inbox items are retried by the next
 * drain, which every later settle and every webhook runs.
 */

import {
  type CommandQueue,
  drainInbox,
  type GithubQueue,
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

    try {
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

    try {
      await this.drain(sessionId);
    } catch (err) {
      logger.warn("settle_hook_failed", { sessionId, turnId, step: "drain", error: String(err) });
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

  /** autoCloseOnMerge: the post-merge turn is done, so free the session slot. */
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
