/**
 * Host-agnostic cloud-session logic, shared by BOTH the ECS bridge (the
 * long-running intake loop that drives sessions through {@link SessionManager})
 * and the future Lambda consumer (FEAT-003), WITHOUT forking, so the two
 * execution paths stay behaviorally identical.
 *
 * WHAT LIVES HERE
 * This module owns everything the cloud path needs that does NOT depend on the
 * ACP gateway:
 *  - PROVISIONING + DRIVING cloud turns through `kiro-cli chat --cloud`
 *    subprocesses (chat-only == cloud-only, for now): a launch runs
 *    `chat --cloud --repo ... --no-interactive "<prompt>"` (provision + first
 *    turn) and a follow-up turn runs `chat --resume-id <id> --no-interactive
 *    "<prompt>"` via the pure headless runners;
 *  - persisting a parsed turn's assistant text + tool activity as normalized
 *    events (persistTurnResult), via the SAME writeEvent/appendEvent path the
 *    ACP-sourced events use;
 *  - per-session idempotency bookkeeping (the `launched` flag, the
 *    `launchAlreadyIssued` durable-row check for the runtime-reset case, and the
 *    `issuedTurns` set with FIFO eviction at {@link MAX_ISSUED_TURNS});
 *  - the state-machine + durable-row transitions a cloud turn causes
 *    (provisioning -> idle/failed on launch; idle -> running -> idle/failed on a
 *    follow-up turn);
 *  - the operational metrics a cloud turn emits (SessionsLaunched, LaunchPath,
 *    TurnDuration, TimeToFirstEvent, EventsWritten, CloudLaunchFailed,
 *    CloudTurnFailed);
 *  - the decisions that reject an operation that cannot be honored for a cloud
 *    session ({@link UnsupportedCloudOperationError} for a mid-turn steer, a
 *    cancel, and a `whenBusy=queue` follow-up) and the client-visible rejection
 *    persist (recordUnsupportedRejection).
 *
 * WHAT DOES NOT LIVE HERE
 * The ACP machinery (gateway.newSession/loadSession/prompt/steer/cancel, the
 * session/update + request_permission hooks, reconnect/replay) stays in
 * {@link SessionManager}: ACP cannot drive a cloud session (session/load+prompt
 * against a real cloud id returns `Session not found`), so the cloud path never
 * touches the gateway. Keeping this module gateway-free is what lets the Lambda
 * consumer construct it with NO ACP child.
 *
 * KEY DESIGN DECISION: SYNCHRONOUS vs BACKGROUND
 * A cloud turn is effectively NON-INTERACTIVE. The code already rejects a
 * mid-turn steer/cancel and a `whenBusy=queue` follow-up as an
 * {@link UnsupportedCloudOperationError}, so nothing can interleave with a turn
 * once it starts -- it simply runs to completion. That means the turn-execution
 * + persistence primitives here can run a turn to completion SYNCHRONOUSLY.
 *
 * The two callers differ ONLY in how they wrap that completion:
 *  - the ECS bridge runs settlement as BACKGROUND work (tracked on
 *    `rt.settling` by {@link SessionManager}) so `launch`/`prompt` return
 *    promptly and intake acks the SQS FIFO message on DISPATCH, never
 *    head-of-line-blocking other sessions. This preserves its existing
 *    ack-on-dispatch behavior and tests.
 *  - the Lambda consumer (FEAT-003) will AWAIT the same settlement before
 *    returning, because a Lambda invocation holds the SQS FIFO message group
 *    until it returns -- which is the CORRECT ordering for a non-interactive
 *    cloud turn.
 * Both reuse the exact SAME {@link CloudSession.settleLaunch} /
 * {@link CloudSession.settleResume} primitives; only the sync-vs-background
 * wrapping differs, so the two paths cannot drift.
 */

import {
  Coalescer,
  type MachineState,
  type NormalizedEvent,
  ReplayDeduper,
  type Repository,
  type SessionInputs,
  type SessionMetaItem,
  transition,
} from "@nikovirtala/kiro-remote-core";
import {
  type HeadlessRunner,
  type HeadlessTurnResult,
  headlessDelete,
  headlessLaunch,
  headlessResume,
} from "./headless.ts";
import type { Logger } from "./logger.ts";
import type { Metrics } from "./metrics.ts";

/**
 * Which launch path was taken for a session. Cloud launch + follow-up turns go
 * through `kiro-cli chat --cloud` subprocesses ("headless"); adopt reconnects an
 * existing cloud id over ACP ("adopt").
 */
export type LaunchPath = "headless" | "adopt";

/**
 * A PERMANENT "this operation cannot be honored for a cloud session" rejection.
 *
 * A cloud turn runs in a detached `chat --cloud` subprocess that ACP cannot
 * drive, so a mid-turn steer/cancel (and a `whenBusy=queue` follow-up, which has
 * no drain mechanism) genuinely cannot be honored. This is NOT a transient
 * dispatch failure: redelivering the same command will reject identically every
 * time. The command intake recognizes this sentinel and treats it as
 * "log + persist a client-visible rejection + DELETE the message" rather than
 * leaving the message for SQS redelivery (which on the DLQ-less FIFO command
 * queue would head-of-line-block the session's entire command stream and loop
 * ~every visibility timeout until the turn happens to settle). Genuine transient
 * failures throw a plain Error and keep the redelivery semantics.
 */
export class UnsupportedCloudOperationError extends Error {
  /** The command kind that was rejected (for the client-visible event). */
  readonly operation: string;
  constructor(operation: string, message: string) {
    super(message);
    this.name = "UnsupportedCloudOperationError";
    this.operation = operation;
  }
}

/**
 * Cap on {@link SessionRuntime.issuedTurns}. The set exists only for follow-up
 * idempotency (dedupe a redelivered `prompt` command by turn id); a redelivery
 * is only possible within the SQS retention window, so retaining the most
 * recent ids is sufficient. Bounding the set keeps a long-lived session with
 * many turns from growing it without limit (it is otherwise freed only on
 * session delete). FIFO eviction of the oldest id is safe: an id old enough to
 * be evicted is far past any plausible redelivery.
 */
export const MAX_ISSUED_TURNS = 512;

/** Per-session runtime state held in the bridge (not the durable store). */
export interface SessionRuntime {
  id: string;
  machine: MachineState;
  coalescer: Coalescer;
  deduper: ReplayDeduper;
  inputs: SessionInputs;
  kiroSessionId: string | null;
  /** The in-flight turn id, or null. */
  activeTurnId: string | null;
  /** Timing for metrics. */
  turnStartedAt: number | null;
  firstEventAt: number | null;
  launchStartedAt: number;
  /** Pending permission requestId -> arrival time (for PermissionWait). */
  permissionStartedAt: Map<string, number>;
  /**
   * True once this runtime has issued its launch (session/new or headless) so a
   * redelivered launch command is a logged no-op rather than a second cloud
   * session / second first-turn (SQS at-least-once + visibility-timeout
   * redelivery). Set as soon as launch() begins issuing the launch path.
   */
  launched: boolean;
  /**
   * The in-flight background turn settlement promise (the part of a turn that
   * runs AFTER the session/prompt has been dispatched: awaiting the prompt
   * response, draining updates, flushing coalesced chunks, and persisting the
   * final status). Null when no turn is settling. Tracked so shutdown/tests can
   * await the turn actually completing even though the SQS ack happened on
   * dispatch, not on settlement.
   */
  settling: Promise<void> | null;
  /**
   * Follow-up turn ids this runtime has already accepted, so a redelivered
   * `prompt` command (SQS at-least-once) does NOT spawn a second
   * `chat --resume-id` turn and, if it lands mid-turn, is NOT
   * reinterpreted as a steer. A turn id is recorded the moment prompt() accepts
   * it and never removed (idempotency, not a queue).
   */
  issuedTurns: Set<string>;
}

/** Dependencies for the shared cloud-path logic (NO AcpGateway). */
export interface CloudSessionDeps {
  repo: Repository;
  logger: Logger;
  metrics: Metrics;
  headlessRunner: HeadlessRunner;
  /**
   * Maps the cloud (Kiro) session id back to our session id for update routing.
   * Shared with {@link SessionManager} so an adopted session and a cloud-launched
   * session resolve through the same map.
   */
  kiroToLocal: Map<string, string>;
  now: () => number;
}

/**
 * Build a fresh per-session runtime in the initial `provisioning` state. Shared
 * so the ECS bridge and the Lambda consumer start from identical runtime state.
 */
export function createRuntime(
  id: string,
  inputs: SessionInputs,
  now: () => number,
): SessionRuntime {
  return {
    id,
    machine: { session: "provisioning", turn: null },
    coalescer: new Coalescer(),
    deduper: new ReplayDeduper(),
    inputs,
    kiroSessionId: null,
    activeTurnId: null,
    turnStartedAt: null,
    firstEventAt: null,
    launchStartedAt: now(),
    permissionStartedAt: new Map(),
    launched: false,
    settling: null,
    issuedTurns: new Set(),
  };
}

/**
 * The host-agnostic cloud-path engine. Holds the primitives both callers reuse;
 * it operates on a {@link SessionRuntime} passed in by the caller (the caller
 * owns the runtime map and the ACP-only concerns).
 */
export class CloudSession {
  private readonly repo: Repository;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly headlessRunner: HeadlessRunner;
  private readonly kiroToLocal: Map<string, string>;
  private readonly now: () => number;

  constructor(deps: CloudSessionDeps) {
    this.repo = deps.repo;
    this.logger = deps.logger;
    this.metrics = deps.metrics;
    this.headlessRunner = deps.headlessRunner;
    this.kiroToLocal = deps.kiroToLocal;
    this.now = deps.now;
  }

  /* ------------------------------ event writes ----------------------------- */

  /**
   * Persist a single normalized event through the repository and bump the
   * EventsWritten metric, recording TimeToFirstEvent the first time an event
   * lands for the runtime. The SAME append path used by ACP-sourced events, so
   * GET /v1/sessions/{id}/events returns cloud and ACP events identically.
   */
  async writeEvent(rt: SessionRuntime, ev: NormalizedEvent, now: number): Promise<void> {
    await this.repo.appendEvent(rt.id, {
      turnId: ev.turnId ?? rt.activeTurnId,
      ts: new Date(now).toISOString(),
      type: ev.type,
      rawType: ev.rawType,
      replay: ev.replay,
      payload: ev as unknown,
    });
    this.metrics.count("EventsWritten");
    if (rt.firstEventAt === null) {
      rt.firstEventAt = now;
      this.metrics.duration("TimeToFirstEvent", now - rt.launchStartedAt);
    }
  }

  /* -------------------------------- machine -------------------------------- */

  /** Drive the pure state machine, logging (never throwing on) an illegal edge. */
  applyMachine(rt: SessionRuntime, event: Parameters<typeof transition>[1]): void {
    try {
      rt.machine = transition(rt.machine, event);
    } catch (err) {
      this.logger.warn("illegal_transition", { sessionId: rt.id, error: String(err) });
    }
  }

  /** Persist the runtime's current session status to the durable row. */
  async persistSessionStatus(rt: SessionRuntime): Promise<void> {
    const item = await this.repo.getSession(rt.id);
    if (!item) {
      return;
    }
    await this.repo.updateSession(rt.id, item.version, {
      status: rt.machine.session,
      activeTurnId: rt.activeTurnId,
      ...(rt.kiroSessionId ? { kiroSessionId: rt.kiroSessionId } : {}),
    });
  }

  /* -------------------------------- launch --------------------------------- */

  /**
   * Begin a cloud launch (provision + first turn) on the runtime: idempotency
   * guard, mark launched, set the turn id/timing, and record the launch-path
   * decision. Returns the {@link SettleLaunch} work (the subprocess + settlement)
   * as an awaitable function WITHOUT running it, so the caller decides whether to
   * run it in the BACKGROUND (ECS bridge, tracked on rt.settling) or AWAIT it
   * (Lambda consumer). Returns null when the launch is an idempotent no-op.
   */
  async beginLaunch(
    rt: SessionRuntime,
    id: string,
    args: CloudLaunchArgs,
  ): Promise<{ path: LaunchPath; settle: () => Promise<void> } | null> {
    // Idempotency: a redelivered launch (SQS at-least-once, or a visibility-
    // timeout redelivery that raced the ack) must NOT spawn a second chat
    // --cloud / create a second cloud Space / start a second first-turn. Treat
    // it as a logged success so the message is still deleted and the FIFO group
    // unblocks.
    if (await this.launchAlreadyIssued(id, rt)) {
      this.logger.info("launch_idempotent_skip", { sessionId: id });
      return null;
    }
    // Mark launched up front so a redelivery that arrives WHILE this launch is
    // still spawning the subprocess is also deduped (the in-memory runtime is
    // the authoritative guard; the durable row catches the runtime-reset case).
    rt.launched = true;
    rt.launchStartedAt = this.now();

    const path: LaunchPath = "headless";
    rt.turnStartedAt = this.now();

    this.logger.info("launch_path_decision", {
      sessionId: id,
      path,
      repoCount: args.repos.length,
    });

    return { path, settle: () => this.settleLaunch(rt, id, args) };
  }

  /**
   * Settle a chat --cloud launch: await the subprocess, parse the real cloud id
   * + assistant/tool output, persist them, and drive the machine to idle (or
   * failed, loudly). Never throws (so both the background and synchronous
   * callers can treat it as fire-and-forget / await-and-ignore).
   */
  async settleLaunch(rt: SessionRuntime, id: string, args: CloudLaunchArgs): Promise<void> {
    try {
      const result = await headlessLaunch(this.headlessRunner, this.logger, {
        prompt: args.prompt,
        repos: args.repos,
      });
      // Adopt the real cloud id parsed from the `[cloud] session <uuid>` line.
      rt.kiroSessionId = result.cloudSessionId;
      this.kiroToLocal.set(result.cloudSessionId, id);

      // Persist the assistant text + tool activity as normalized events so GET
      // /v1/sessions/{id}/events returns the turn.
      await this.persistTurnResult(rt, result);

      // provisioning -> idle.
      this.applyMachine(rt, { kind: "provisioned" });

      const item = await this.repo.getSession(id);
      if (item) {
        await this.repo.updateSession(id, item.version, {
          status: rt.machine.session,
          kiroSessionId: rt.kiroSessionId,
          model: args.model ?? item.model,
          mode: args.mode ?? item.mode,
          effort: args.effort ?? item.effort,
        });
      }
      this.metrics.count("SessionsLaunched");
      this.metrics.count("LaunchPath", 1, { path: "headless" });
      if (rt.turnStartedAt !== null) {
        this.metrics.duration("TurnDuration", this.now() - rt.turnStartedAt);
      }
      this.logger.info("session_launched", {
        sessionId: id,
        path: "headless",
        kiroSessionId: rt.kiroSessionId,
      });
    } catch (err) {
      // LOUD FAILURE: no `[cloud] session` line OR non-zero exit. Drive the
      // session to `failed`, log an error, emit the loud-failure metric. Never
      // leave a silent/idle session.
      this.applyMachine(rt, { kind: "provision_failed" });
      this.metrics.count("CloudLaunchFailed");
      this.logger.error("cloud_launch_failed", { sessionId: id, error: String(err) });
      const failed = await this.repo.getSession(id);
      if (failed) {
        await this.repo.updateSession(id, failed.version, {
          status: rt.machine.session,
          activeTurnId: null,
        });
      }
    } finally {
      rt.activeTurnId = null;
      rt.turnStartedAt = null;
      rt.settling = null;
    }
  }

  /* -------------------------- follow-up turn (resume) ---------------------- */

  /**
   * Begin a follow-up cloud turn on the runtime: dedupe a redelivered turn id,
   * record the turn id, set the turn id/timing, drive idle -> running + persist,
   * and return the settlement work WITHOUT running it (same sync-vs-background
   * split as {@link beginLaunch}). Returns null when the turn is an idempotent
   * no-op.
   */
  async beginResume(
    rt: SessionRuntime,
    id: string,
    prompt: string,
    turnId: string | undefined,
    tid: string,
  ): Promise<{ settle: () => Promise<void> } | null> {
    // Idempotency: a redelivered `prompt` command (SQS at-least-once, or a
    // visibility-timeout redelivery) must NOT spawn a second
    // `chat --resume-id` turn. When a turn id is supplied (the command carries
    // one) and we have already accepted it, this is a logged no-op -- never a
    // duplicate resume subprocess and never a mid-turn re-dispatch. A dedupe is
    // only meaningful with a stable turn id from the command; a bare prompt with
    // no id is always a fresh turn.
    if (turnId !== undefined && rt.issuedTurns.has(turnId)) {
      this.logger.info("prompt_idempotent_skip", { sessionId: id, turnId });
      return null;
    }
    this.recordIssuedTurn(rt, tid);

    rt.activeTurnId = tid;
    rt.turnStartedAt = this.now();
    this.applyMachine(rt, { kind: "prompt.sent" });
    await this.persistSessionStatus(rt);

    return { settle: () => this.settleResume(rt, id, prompt) };
  }

  /**
   * Settle a follow-up cloud turn via headlessResume: await the subprocess,
   * persist its assistant/tool output as events, and settle the turn
   * (prompt.response on success, prompt.error on failure). Never throws. Targets
   * the SAME cloud id with --resume-id.
   */
  async settleResume(rt: SessionRuntime, id: string, prompt: string): Promise<void> {
    const cloudSessionId = rt.kiroSessionId;
    try {
      if (!cloudSessionId) {
        throw new Error("no cloud session id to resume");
      }
      const result = await headlessResume(this.headlessRunner, this.logger, cloudSessionId, prompt);
      await this.persistTurnResult(rt, result);
      this.applyMachine(rt, { kind: "prompt.response", stopReason: "end_turn" });
    } catch (err) {
      // LOUD FAILURE, mirroring the launch path: a failed follow-up resume must
      // NOT be dropped on a warn alone (a client polling events would see the
      // session flip back to idle with no answer and no signal the turn failed).
      // Emit a failure metric AND persist a client-visible turn.failed event so
      // GET /v1/sessions/{id}/events surfaces the failure.
      this.metrics.count("CloudTurnFailed");
      this.logger.error("cloud_turn_failed", { sessionId: id, error: String(err) });
      await this.writeEvent(
        rt,
        {
          type: "turn.failed",
          sessionId: rt.id,
          turnId: rt.activeTurnId,
          replay: false,
          rawType: "turn_failed",
          failureReason: "error",
          payload: { source: "chat-cloud", error: String(err) },
        },
        this.now(),
      );
      this.applyMachine(rt, { kind: "prompt.error" });
    } finally {
      if (rt.turnStartedAt !== null) {
        this.metrics.duration("TurnDuration", this.now() - rt.turnStartedAt);
      }
      rt.activeTurnId = null;
      rt.turnStartedAt = null;
      await this.persistSessionStatus(rt);
      rt.settling = null;
    }
  }

  /* --------------------------- persist turn result ------------------------- */

  /**
   * Persist a chat --cloud turn's parsed output as normalized events under the
   * active turn id: a tool.call (+ tool.update when a status was observed) per
   * `[tool]` line, then the assistant's final answer as a message.chunk. Uses
   * the same writeEvent/appendEvent path as ACP-sourced events.
   */
  async persistTurnResult(rt: SessionRuntime, result: HeadlessTurnResult): Promise<void> {
    const now = this.now();
    for (const tool of result.tools) {
      const callEvent: NormalizedEvent = {
        type: "tool.call",
        sessionId: rt.id,
        turnId: rt.activeTurnId,
        replay: false,
        rawType: "tool_call",
        toolCallId: tool.id,
        title: tool.title,
        status: tool.status ?? "pending",
        payload: { source: "chat-cloud", title: tool.title },
      };
      await this.writeEvent(rt, callEvent, now);
      if (tool.status) {
        const updateEvent: NormalizedEvent = {
          type: "tool.update",
          sessionId: rt.id,
          turnId: rt.activeTurnId,
          replay: false,
          rawType: "tool_call_update",
          toolCallId: tool.id,
          status: tool.status,
          payload: { source: "chat-cloud", status: tool.status },
        };
        await this.writeEvent(rt, updateEvent, now);
      }
    }
    if (result.assistantText.length > 0) {
      const messageEvent: NormalizedEvent = {
        type: "message.chunk",
        sessionId: rt.id,
        turnId: rt.activeTurnId,
        replay: false,
        rawType: "agent_message_chunk",
        content: { type: "text", text: result.assistantText },
      };
      await this.writeEvent(rt, messageEvent, now);
    }
  }

  /* ------------------------------ idempotency ------------------------------ */

  /**
   * Record a follow-up turn id for idempotency, evicting the oldest id once the
   * set reaches {@link MAX_ISSUED_TURNS} so it never grows without bound over a
   * long-lived session. A Set preserves insertion order, so the first key is the
   * oldest.
   */
  recordIssuedTurn(rt: SessionRuntime, turnId: string): void {
    rt.issuedTurns.add(turnId);
    while (rt.issuedTurns.size > MAX_ISSUED_TURNS) {
      const oldest = rt.issuedTurns.values().next().value;
      if (oldest === undefined) {
        break;
      }
      rt.issuedTurns.delete(oldest);
    }
  }

  /**
   * Decide whether a launch for this session has ALREADY been issued, so a
   * redelivery is a no-op. True when either the in-memory runtime has already
   * launched (still-present case) OR the durable session row is past
   * 'provisioning' / already carries a kiroSessionId (runtime-reset case, e.g.
   * after a bridge restart where the row survived but the runtime map did not).
   */
  async launchAlreadyIssued(id: string, rt: SessionRuntime): Promise<boolean> {
    if (rt.launched || rt.kiroSessionId !== null) {
      return true;
    }
    const item = await this.repo.getSession(id);
    if (!item) {
      return false;
    }
    return item.status !== "provisioning" || item.kiroSessionId !== null;
  }

  /* ------------------------- unsupported operations ------------------------ */

  /**
   * Resolve a follow-up `prompt`/`steer` against a possibly-busy cloud session
   * into one of: a logged idempotent no-op (already-issued turn id), a fresh
   * prompt (idle session -> the caller should start a new turn), a quiet
   * rejection (`whenBusy=reject`), or a LOUD {@link UnsupportedCloudOperationError}
   * (mid-turn steer, or `whenBusy=queue` which has no drain). This encodes the
   * "a cloud turn is effectively non-interactive" rule in ONE place so both
   * callers reject identically. Does NOT mutate the machine.
   */
  classifySteer(
    rt: SessionRuntime,
    id: string,
    whenBusy: "steer" | "queue" | "reject",
    turnId: string | undefined,
  ): "idempotent" | "prompt" | "reject" {
    // Idempotency for a redelivered `prompt` command (which routes through
    // steer): if this turn id was already accepted, it is a logged no-op --
    // never a duplicate resume turn and never a mid-turn re-dispatch as a steer.
    // The guard runs BEFORE the busy check so a redelivery that lands mid-turn
    // is not reinterpreted as a steer. Checked here (not only in prompt()) so it
    // also covers the just-settled-into-idle case.
    if (turnId !== undefined && rt.issuedTurns.has(turnId)) {
      this.logger.info("prompt_idempotent_skip", { sessionId: id, turnId });
      return "idempotent";
    }

    const busy = rt.machine.turn === "running";
    if (!busy) {
      // Idle session: a follow-up is a new prompt (_message/send -> session/prompt).
      return "prompt";
    }
    if (whenBusy === "reject") {
      this.logger.info("steer_rejected", { sessionId: id });
      return "reject";
    }
    if (whenBusy === "queue") {
      // `whenBusy=queue` is NOT drainable on the cloud path. There is no
      // queue-drain mechanism, and a cloud turn runs in a detached subprocess
      // we cannot interleave with, so a "queued" follow-up would never actually
      // run. Reject it the SAME visible, non-state-mutating way as a mid-turn
      // steer (for now): do NOT apply `prompt.queued` (telling the client the
      // turn is queued when it will never drain is worse than a clean
      // rejection). The user should wait for the active turn to settle, then
      // send a new prompt.
      this.logger.warn("steer_queue_unsupported_cloud", { sessionId: id });
      throw new UnsupportedCloudOperationError(
        "queue",
        "queuing a follow-up turn is not supported for cloud sessions; wait for the active turn to complete, then send a new prompt",
      );
    }
    // Mid-turn steering is NOT supported on a cloud session. A cloud turn runs
    // in a detached `chat --resume-id` subprocess, and ACP cannot drive
    // a cloud session (session/load+prompt against a real cloud id returns
    // `Session not found`), so issuing gateway.steer here would silently no-op.
    // Reject LOUDLY (sentinel error -> intake logs + persists a client-visible
    // rejection event + DELETES the message) instead of firing a doomed ACP
    // request OR looping the command through SQS redelivery; the user should
    // wait for the turn to settle, then send a new prompt.
    this.logger.warn("steer_unsupported_cloud", { sessionId: id });
    throw new UnsupportedCloudOperationError(
      "steer",
      "mid-turn steering is not supported for cloud sessions; wait for the turn to complete, then send a new prompt",
    );
  }

  /**
   * Classify a cancel against a cloud session. Returns "no_active_turn" when no
   * turn is running (a logged no-op); otherwise throws a LOUD
   * {@link UnsupportedCloudOperationError} because a detached `chat --cloud`
   * subprocess cannot be cancelled (issuing gateway.cancel would silently no-op)
   * and faking a cancelling state would be worse than a clean rejection. Does
   * NOT mutate the machine; the turn settles on its own subprocess result.
   */
  classifyCancel(rt: SessionRuntime, id: string): "no_active_turn" {
    if (rt.machine.turn !== "running") {
      this.logger.info("cancel_no_active_turn", { sessionId: id });
      return "no_active_turn";
    }
    this.logger.warn("cancel_unsupported_cloud", { sessionId: id });
    throw new UnsupportedCloudOperationError(
      "cancel",
      "cancellation is not supported for cloud sessions; the in-flight turn will run to completion",
    );
  }

  /**
   * Persist a client-visible rejection for an operation that cannot be honored
   * for a cloud session (mid-turn steer/cancel, or a queued follow-up with no
   * drain). This runs OFF the command-dispatch error path (intake calls it after
   * catching an {@link UnsupportedCloudOperationError}) so a polling client sees,
   * via GET /v1/sessions/{id}/events, WHY the steer/cancel/queue did nothing
   * instead of silence -- WITHOUT turning the SQS message into a redelivery loop.
   * It does NOT mutate the state machine (the in-flight turn keeps running and
   * settles on its own subprocess result).
   */
  async recordUnsupportedRejection(
    rt: SessionRuntime,
    operation: string,
    reason: string,
  ): Promise<void> {
    await this.writeEvent(
      rt,
      {
        type: "turn.failed",
        sessionId: rt.id,
        turnId: rt.activeTurnId,
        replay: false,
        rawType: "operation_rejected",
        failureReason: "generic",
        payload: { source: "chat-cloud", operation, reason },
      },
      this.now(),
    );
  }

  /* -------------------------------- delete --------------------------------- */

  /**
   * Delete the cloud session via `kiro-cli chat --delete-session <id>`, logging
   * (never throwing on) a CLI failure so the caller can still mark the durable
   * row deleted. A no-op when there is no cloud id yet.
   */
  async deleteCloud(id: string, kiroSessionId: string | null): Promise<void> {
    if (!kiroSessionId) {
      return;
    }
    try {
      await headlessDelete(this.headlessRunner, this.logger, kiroSessionId);
    } catch (err) {
      this.logger.warn("delete_session_cli_failed", { sessionId: id, error: String(err) });
    }
  }
}

/** The launch arguments a cloud launch turn carries. */
export interface CloudLaunchArgs {
  prompt: string;
  repos: string[];
  mode?: string;
  model?: string;
  effort?: string;
}

export function stateOf(item: SessionMetaItem): MachineState {
  if (item.status === "deleted" || item.status === "failed" || item.status === "provisioning") {
    return { session: item.status, turn: null };
  }
  if (item.status === "awaiting_permission") {
    return { session: "awaiting_permission", turn: "running" };
  }
  if (item.status === "running") {
    return { session: "running", turn: "running" };
  }
  return { session: "idle", turn: null };
}
