/**
 * Cloud-session state and rejection primitives used by the Lambda consumer
 * ({@link LambdaConsumer} in lambda-consumer.ts).
 *
 * WHAT LIVES HERE
 * Everything the consumer needs that does NOT depend on the engine process:
 *  - the per-session runtime ({@link SessionRuntime}, {@link createRuntime})
 *    and the durable-row -> machine mapping ({@link stateOf});
 *  - event writes through the repository (writeEvent), with the EventsWritten
 *    and TimeToFirstEvent metrics;
 *  - the state-machine + durable-row transitions a turn causes
 *    (applyMachine, persistSessionStatus, beginResume);
 *  - per-session idempotency bookkeeping (the `launched` flag, the
 *    `launchAlreadyIssued` durable-row check for the runtime-reset case, and the
 *    `issuedTurns` set with FIFO eviction at {@link MAX_ISSUED_TURNS});
 *  - the decisions that reject an operation that cannot be honored for a cloud
 *    session ({@link UnsupportedCloudOperationError} for a mid-turn steer, a
 *    cancel, and a `whenBusy=queue` follow-up) and the client-visible rejection
 *    persist (recordUnsupportedRejection).
 *
 * The engine itself (initialize, session/new, session/load, session/prompt,
 * session/delete) is driven by the consumer through {@link KasEngine}; keeping
 * this module engine-free lets its rules be tested without a child process.
 *
 * A cloud turn is effectively NON-INTERACTIVE: it runs in Kiro's cloud sandbox
 * and the short-lived engine only relays its updates, so nothing can interleave
 * with a turn once it starts. That is why mid-turn steer, cancel and
 * `whenBusy=queue` are rejected rather than forwarded.
 */

import {
  Coalescer,
  type MachineState,
  type NormalizedEvent,
  type Repository,
  type SessionInputs,
  type SessionMetaItem,
  transition,
} from "@nikovirtala/kiro-remote-core";
import type { Logger } from "./logger.ts";
import type { Metrics } from "./metrics.ts";

/**
 * A PERMANENT "this operation cannot be honored for a cloud session" rejection.
 *
 * A cloud turn runs in Kiro's cloud sandbox and the short-lived engine only
 * relays it, so a mid-turn steer/cancel (and a `whenBusy=queue` follow-up, which
 * has no drain mechanism) genuinely cannot be honored. This is NOT a transient
 * dispatch failure: redelivering the same command will reject identically every
 * time. The consumer recognizes this sentinel and treats it as
 * "log + persist a client-visible rejection + ack the message" rather than
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
  inputs: SessionInputs;
  kiroSessionId: string | null;
  /** The in-flight turn id, or null. */
  activeTurnId: string | null;
  /** Timing for metrics. */
  turnStartedAt: number | null;
  firstEventAt: number | null;
  launchStartedAt: number;
  /**
   * True once this runtime has issued its launch (session/new) so a
   * redelivered launch command is a logged no-op rather than a second cloud
   * session / second first-turn (SQS at-least-once + visibility-timeout
   * redelivery). Set as soon as the launch begins.
   */
  launched: boolean;
  /**
   * Follow-up turn ids this runtime has already accepted, so a redelivered
   * `prompt` command (SQS at-least-once) does NOT start a second turn and, if it
   * lands mid-turn, is NOT reinterpreted as a steer. A turn id is recorded the
   * moment the prompt is accepted (idempotency, not a queue).
   */
  issuedTurns: Set<string>;
}

/** Dependencies for the cloud-session primitives (no engine process). */
export interface CloudSessionDeps {
  repo: Repository;
  logger: Logger;
  metrics: Metrics;
  now: () => number;
}

/** Build a fresh per-session runtime in the initial `provisioning` state. */
export function createRuntime(
  id: string,
  inputs: SessionInputs,
  now: () => number,
): SessionRuntime {
  return {
    id,
    machine: { session: "provisioning", turn: null },
    coalescer: new Coalescer(),
    inputs,
    kiroSessionId: null,
    activeTurnId: null,
    turnStartedAt: null,
    firstEventAt: null,
    launchStartedAt: now(),
    launched: false,
    issuedTurns: new Set(),
  };
}

/**
 * The cloud-session primitives. It operates on a {@link SessionRuntime} passed
 * in by the caller (the caller owns the runtime map and the engine).
 */
export class CloudSession {
  private readonly repo: Repository;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly now: () => number;

  constructor(deps: CloudSessionDeps) {
    this.repo = deps.repo;
    this.logger = deps.logger;
    this.metrics = deps.metrics;
    this.now = deps.now;
  }

  /* ------------------------------ event writes ----------------------------- */

  /**
   * Persist a single normalized event through the repository and bump the
   * EventsWritten metric, recording TimeToFirstEvent the first time an event
   * lands for the runtime. GET /v1/sessions/{id}/events reads what this writes.
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

  /* -------------------------- follow-up turn (resume) ---------------------- */

  /**
   * Begin a follow-up cloud turn on the runtime: dedupe a redelivered turn id,
   * record the turn id, set the turn id/timing, and drive idle -> running +
   * persist. Returns false when the turn is an idempotent no-op, true once the
   * turn has begun (the caller then runs it on the engine).
   */
  async beginResume(
    rt: SessionRuntime,
    id: string,
    turnId: string | undefined,
    tid: string,
  ): Promise<boolean> {
    // Idempotency: a redelivered `prompt` command (SQS at-least-once, or a
    // visibility-timeout redelivery) must NOT start a second turn. When a turn
    // id is supplied (the command carries one) and we have already accepted it,
    // this is a logged no-op -- never a duplicate turn and never a mid-turn
    // re-dispatch. A dedupe is only meaningful with a stable turn id from the
    // command; a bare prompt with no id is always a fresh turn.
    if (turnId !== undefined && rt.issuedTurns.has(turnId)) {
      this.logger.info("prompt_idempotent_skip", { sessionId: id, turnId });
      return false;
    }
    this.recordIssuedTurn(rt, tid);

    rt.activeTurnId = tid;
    rt.turnStartedAt = this.now();
    this.applyMachine(rt, { kind: "prompt.sent" });
    await this.persistSessionStatus(rt);
    return true;
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
   * a fresh Lambda container where the row survived but the runtime map did not).
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
   * "a cloud turn is effectively non-interactive" rule in ONE place. Does NOT
   * mutate the machine.
   */
  classifySteer(
    rt: SessionRuntime,
    id: string,
    whenBusy: "steer" | "queue" | "reject",
    turnId: string | undefined,
  ): "idempotent" | "prompt" | "reject" {
    // Idempotency for a redelivered `prompt` command (which routes through
    // steer): if this turn id was already accepted, it is a logged no-op --
    // never a duplicate turn and never a mid-turn re-dispatch as a steer.
    // The guard runs BEFORE the busy check so a redelivery that lands mid-turn
    // is not reinterpreted as a steer. Checked here (not only in beginResume) so
    // it also covers the just-settled-into-idle case.
    if (turnId !== undefined && rt.issuedTurns.has(turnId)) {
      this.logger.info("prompt_idempotent_skip", { sessionId: id, turnId });
      return "idempotent";
    }

    const busy = rt.machine.turn === "running";
    if (!busy) {
      // Idle session: a follow-up is a new prompt (session/prompt).
      return "prompt";
    }
    if (whenBusy === "reject") {
      this.logger.info("steer_rejected", { sessionId: id });
      return "reject";
    }
    if (whenBusy === "queue") {
      // `whenBusy=queue` is NOT drainable on a cloud session. There is no
      // queue-drain mechanism, and a cloud turn runs in Kiro's sandbox where we
      // cannot interleave with it, so a "queued" follow-up would never actually
      // run. Reject it the SAME visible, non-state-mutating way as a mid-turn
      // steer: do NOT apply `prompt.queued` (telling the client the turn is
      // queued when it will never drain is worse than a clean rejection). The
      // user should wait for the active turn to settle, then send a new prompt.
      this.logger.warn("steer_queue_unsupported_cloud", { sessionId: id });
      throw new UnsupportedCloudOperationError(
        "queue",
        "queuing a follow-up turn is not supported for cloud sessions; wait for the active turn to complete, then send a new prompt",
      );
    }
    // Mid-turn steering is NOT supported on a cloud session: the turn runs in
    // Kiro's sandbox and the engine that started it may already be gone (a
    // detached turn), so there is nothing to steer. Reject LOUDLY (sentinel
    // error -> the consumer logs + persists a client-visible rejection event +
    // acks the message) instead of looping the command through SQS redelivery;
    // the user should wait for the turn to settle, then send a new prompt.
    this.logger.warn("steer_unsupported_cloud", { sessionId: id });
    throw new UnsupportedCloudOperationError(
      "steer",
      "mid-turn steering is not supported for cloud sessions; wait for the turn to complete, then send a new prompt",
    );
  }

  /**
   * Classify a cancel against a cloud session. Returns "no_active_turn" when no
   * turn is running (a logged no-op); otherwise throws a LOUD
   * {@link UnsupportedCloudOperationError} because a turn running in Kiro's
   * sandbox cannot be cancelled from here, and faking a cancelling state would
   * be worse than a clean rejection. Does NOT mutate the machine; the turn
   * settles on its own.
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
   * for a cloud session (mid-turn steer/cancel, a queued follow-up with no
   * drain, or adopt). This runs OFF the command-dispatch error path (the
   * consumer calls it after catching an {@link UnsupportedCloudOperationError})
   * so a polling client sees, via GET /v1/sessions/{id}/events, WHY the
   * operation did nothing instead of silence -- WITHOUT turning the SQS message
   * into a redelivery loop. It does NOT mutate the state machine (an in-flight
   * turn keeps running and settles on its own). `payload.source` stays
   * "chat-cloud" because clients already read these events.
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
