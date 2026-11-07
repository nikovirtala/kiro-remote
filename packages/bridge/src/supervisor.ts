/**
 * Child supervision & reconnect.
 *
 * On child death or task restart the bridge: restarts the child, RE-INITIALIZES,
 * RE-REGISTERS the agent-to-client handlers, THEN `session/load`s every non-idle
 * session re-sending cwd/additionalDirectories/mcpServers (V3 does not persist
 * mcpServers). Replay is NOT suppressed (no noReplay for remote); replay is
 * deduped by toolCallId+content. A prompt is NEVER auto-resent; an in-flight
 * turn is marked failed with reason `transport_lost` UNLESS replay shows it
 * completed.
 *
 * The declarative, side-effect-free plan comes from core's {@link planReconnect};
 * this module executes it in the required order.
 */

import {
  planReconnect,
  type Repository,
  type SessionInputs,
  type SessionMetaItem,
} from "@kiro-remote/core";
import type { AcpGateway } from "./gateway.ts";
import type { Logger } from "./logger.ts";
import type { Metrics } from "./metrics.ts";
import type { SessionManager } from "./session-manager.ts";

/** Reason recorded on a turn lost across a transport drop. */
export const TRANSPORT_LOST_REASON = "transport_lost";

/** Bounded window to wait for a replayed turn completion to land after load. */
export const REPLAY_SETTLE_WINDOW_MS = 2000;
/** Poll interval while waiting for replay to drain. */
const REPLAY_POLL_MS = 10;

const NON_IDLE_STATUSES = new Set(["running", "awaiting_permission"]);

export interface SupervisorDeps {
  gateway: AcpGateway;
  manager: SessionManager;
  repo: Repository;
  logger: Logger;
  metrics: Metrics;
  /** Session inputs to re-send on load (cwd/additionalDirectories/mcpServers). */
  inputsFor(session: SessionMetaItem): SessionInputs;
  /** Lists the sessions to consider for reconnect (owned, non-deleted). */
  listSessions(): Promise<SessionMetaItem[]>;
  /** Clock, injectable for tests. */
  now?: () => number;
}

export class Supervisor {
  private readonly deps: SupervisorDeps;
  private readonly now: () => number;

  constructor(deps: SupervisorDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Run the full reconnect sequence. The transport must already have been
   * restarted by the caller; this re-initializes, re-registers handlers, then
   * loads sessions. Returns the set of reconnected session ids.
   */
  async reconnect(): Promise<string[]> {
    const { gateway, logger, metrics } = this.deps;

    // 1. Re-register handlers BEFORE initialize/load (replay arrives on load).
    gateway.registerHandlers();
    // 2. Re-initialize to refresh capabilities.
    await gateway.initialize();
    metrics.count("AcpRestarts");
    logger.info("acp_reconnected");

    // 3. session/load every non-idle session.
    const sessions = await this.deps.listSessions();
    const reconnected: string[] = [];
    for (const session of sessions) {
      if (!NON_IDLE_STATUSES.has(session.status) || !session.kiroSessionId) {
        continue;
      }
      await this.reconnectSession(session);
      reconnected.push(session.id);
    }
    return reconnected;
  }

  private async reconnectSession(session: SessionMetaItem): Promise<void> {
    const { gateway, manager, logger } = this.deps;
    const inputs = this.deps.inputsFor(session);

    // Pure plan: handler-first, re-send inputs, no noReplay, never resend prompt.
    const plan = planReconnect({ inputs, source: "remote" });
    logger.info("reconnect_plan", {
      sessionId: session.id,
      registerUpdateHandlerFirst: plan.registerUpdateHandlerFirst,
      noReplay: plan.noReplay,
      resendPrompt: plan.resendPrompt,
    });

    // Handlers are already registered (reconnect() did it before load). Register
    // the runtime so replayed updates route and dedupe correctly, carrying the
    // in-flight turn id so a replayed completion is attributed to it.
    manager.registerLoaded(
      session.id,
      session.kiroSessionId as string,
      plan.loadInputs,
      session.activeTurnId,
    );

    // session/load re-sending cwd/additionalDirectories/mcpServers.
    await gateway.loadSession(session.kiroSessionId as string, plan.loadInputs);

    // An in-flight turn is marked failed transport_lost UNLESS replay shows it
    // completed. We decide from the event log only AFTER replay has drained.
    if (session.status === "running" && session.activeTurnId) {
      await this.settleInFlightTurn(session);
    }
  }

  /** After replay, mark an in-flight turn transport_lost unless replay completed it. */
  private async settleInFlightTurn(session: SessionMetaItem): Promise<void> {
    const { repo, logger } = this.deps;
    const turnId = session.activeTurnId as string;
    // Replay arrives as session/update notifications processed asynchronously by
    // the manager AFTER session/load resolves; a bare synchronous read here can
    // race an un-landed completion and misclassify it transport_lost. Wait for
    // the completion to be persisted, polling a bounded window and draining the
    // manager's in-flight update processing each pass so the decision keys on a
    // real signal (the completion event actually landing), not a fixed delay.
    const completed = await this.waitForTurnCompletion(session.id, turnId);
    const turn = await repo.getTurn(session.id, turnId);
    if (!turn) {
      return;
    }
    if (completed) {
      logger.info("inflight_turn_replay_completed", { sessionId: session.id, turnId });
      return;
    }
    // NEVER auto-resend the prompt; mark the lost turn failed/transport_lost.
    const item = await repo.getSession(session.id);
    if (item) {
      await repo.updateSession(session.id, item.version, {
        status: "idle",
        activeTurnId: null,
      });
    }
    await repo.putTurn({
      ...turn,
      prompt: typeof turn.prompt === "string" ? turn.prompt : "",
      status: "failed",
      stopReason: TRANSPORT_LOST_REASON,
      endedAt: new Date().toISOString(),
    });
    logger.warn("inflight_turn_transport_lost", { sessionId: session.id, turnId });
  }

  /**
   * Return true once a replayed completion for {@link turnId} is persisted, or
   * false if none lands within {@link REPLAY_SETTLE_WINDOW_MS}. Each pass drains
   * the manager's in-flight update processing so an already-delivered update is
   * observed immediately; the window only bounds how long we wait for a replay
   * update that is still in flight on the transport.
   */
  private async waitForTurnCompletion(sessionId: string, turnId: string): Promise<boolean> {
    const { repo, manager } = this.deps;
    const deadline = this.now() + REPLAY_SETTLE_WINDOW_MS;
    for (;;) {
      await manager.drainUpdates();
      const events = await repo.queryEvents(sessionId, 0, { limit: 1000 });
      const completed = events.some(
        (e) =>
          e.turnId === turnId && (e.type === "turn.completed" || e.rawType === "turn_completion"),
      );
      if (completed || this.now() >= deadline) {
        return completed;
      }
      await new Promise((resolve) => setTimeout(resolve, REPLAY_POLL_MS));
    }
  }
}
