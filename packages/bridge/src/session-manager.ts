/**
 * The session manager multiplexes every cloud session over the one ACP child.
 *
 * Responsibilities:
 *  - route session/update + request_permission by sessionId;
 *  - normalize updates (core normalizer), coalesce chunk streams, dedupe replay,
 *    and append events to the DynamoDB log via the repository;
 *  - drive the pure state machine (core transition) -- the ONLY place a turn
 *    or session changes status;
 *  - PROVISION and DRIVE cloud sessions entirely through `kiro-cli chat
 *    --cloud` subprocesses (chat-only == cloud-only, for now): launch runs
 *    `chat --cloud --repo ... --no-interactive "<prompt>"` and follow-up turns
 *    run `chat --resume-id <id> --no-interactive "<prompt>"` (NO --cloud/--repo
 *    on resume -- kiro-cli rejects those combined with --resume-id). ACP cannot
 *    drive a cloud session (session/load+prompt against a real cloud id returns
 *    `Session not found`), so the cloud path never uses gateway.newSession/
 *    prompt;
 *  - run the long (~30-40s) subprocess as BACKGROUND work so launch returns
 *    promptly and intake acks the SQS message on dispatch (no head-of-line
 *    blocking);
 *  - record the launch path into the LaunchPath metric;
 *  - emit the operational metrics.
 */

import {
  type Capabilities,
  Coalescer,
  type MachineState,
  type NormalizedEvent,
  normalizeRequest,
  normalizeUpdate,
  type PermissionAnswer,
  ReplayDeduper,
  type Repository,
  type SessionInputs,
  type SessionMetaItem,
  transition,
} from "@nikovirtala/kiro-remote-core";
import { ulid } from "ulid";
import type { AcpGateway } from "./gateway.ts";
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
 * time. {@link CommandIntake} recognizes this sentinel and treats it as
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
const MAX_ISSUED_TURNS = 512;

/** Per-session runtime state held in the bridge (not the durable store). */
interface SessionRuntime {
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

export interface SessionManagerDeps {
  gateway: AcpGateway;
  repo: Repository;
  logger: Logger;
  metrics: Metrics;
  headlessRunner: HeadlessRunner;
  /** Workspace root/cwd for cloud sessions. */
  workspaceRoot: string;
  /** Additional directories to send on new/load. */
  additionalDirectories?: string[];
  /** MCP server definitions (V3 does NOT persist these; re-sent on load). */
  mcpServers?: unknown[];
  now?: () => number;
}

function stateOf(item: SessionMetaItem): MachineState {
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

export class SessionManager {
  private readonly gateway: AcpGateway;
  private readonly repo: Repository;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly headlessRunner: HeadlessRunner;
  private readonly workspaceRoot: string;
  private readonly additionalDirectories?: string[];
  private readonly mcpServers: unknown[];
  private readonly now: () => number;

  private readonly runtimes = new Map<string, SessionRuntime>();
  /** Maps the cloud (Kiro) session id back to our session id for update routing. */
  private readonly kiroToLocal = new Map<string, string>();
  /**
   * In-flight update/notification processing promises. The gateway hooks
   * fire-and-forget into handleUpdate/handleAgentNotification/
   * handlePermissionRequested; tracking them here lets the supervisor await
   * replay actually draining after session/load before it settles an
   * in-flight turn, instead of racing an un-landed completion event.
   */
  private readonly inFlightUpdates = new Set<Promise<void>>();

  constructor(deps: SessionManagerDeps) {
    this.gateway = deps.gateway;
    this.repo = deps.repo;
    this.logger = deps.logger;
    this.metrics = deps.metrics;
    this.headlessRunner = deps.headlessRunner;
    this.workspaceRoot = deps.workspaceRoot;
    this.additionalDirectories = deps.additionalDirectories;
    this.mcpServers = deps.mcpServers ?? [];
    this.now = deps.now ?? (() => Date.now());
  }

  capabilities(): Capabilities {
    return this.gateway.capabilities();
  }

  private inputsFor(inputs?: Partial<SessionInputs>): SessionInputs {
    return {
      cwd: this.workspaceRoot,
      ...(this.additionalDirectories ? { additionalDirectories: this.additionalDirectories } : {}),
      mcpServers: this.mcpServers,
      ...(inputs ?? {}),
    };
  }

  private runtimeFor(id: string): SessionRuntime {
    let rt = this.runtimes.get(id);
    if (!rt) {
      rt = {
        id,
        machine: { session: "provisioning", turn: null },
        coalescer: new Coalescer(),
        deduper: new ReplayDeduper(),
        inputs: this.inputsFor(),
        kiroSessionId: null,
        activeTurnId: null,
        turnStartedAt: null,
        firstEventAt: null,
        launchStartedAt: this.now(),
        permissionStartedAt: new Map(),
        launched: false,
        settling: null,
        issuedTurns: new Set(),
      };
      this.runtimes.set(id, rt);
    }
    return rt;
  }

  /* ----------------------------- update routing ---------------------------- */

  /**
   * Register a fire-and-forget hook promise so {@link drainUpdates} can await
   * it. The gateway hooks call this instead of awaiting; it never throws.
   */
  track(work: Promise<void>): void {
    const tracked = work
      .catch((err) => {
        this.logger.warn("update_processing_error", { error: String(err) });
      })
      .finally(() => {
        this.inFlightUpdates.delete(tracked);
      });
    this.inFlightUpdates.add(tracked);
  }

  /**
   * Resolve once every currently-tracked update/notification has been
   * persisted. Called after session/load so a reconnect settles an in-flight
   * turn only after replay has actually drained. Loops because draining one
   * batch can enqueue more (e.g. a flush that writes additional events).
   */
  async drainUpdates(): Promise<void> {
    while (this.inFlightUpdates.size > 0) {
      await Promise.all([...this.inFlightUpdates]);
    }
  }

  /**
   * Called by the gateway hook when a session/update arrives. Cloud turns are
   * driven by `chat --cloud` subprocesses, not the ACP child, so these updates
   * are only expected for sessions adopted (reconnected) over ACP. An update for
   * an unmapped id is a benign debug no-op.
   */
  async handleUpdate(kiroSessionId: string, update: unknown): Promise<void> {
    const localId = this.kiroToLocal.get(kiroSessionId) ?? kiroSessionId;
    const rt = this.runtimes.get(localId);
    if (!rt) {
      this.logger.debug("update_for_unknown_session", { kiroSessionId });
      return;
    }
    const ev = normalizeUpdate(localId, update, {
      turnId: rt.activeTurnId,
      hooks: { onUnmapped: () => this.metrics.count("RawEventsUnmapped") },
    });
    await this.persistEvent(rt, ev);
  }

  /**
   * Defensively read the cloud session id out of an agent notification's params.
   * _kiro/sessions/changed may expose the id as a top-level `sessionId` or inside
   * a `sessions` array as `sessionId` / `id`. The exact field is not observable
   * in-sandbox; FEAT-002's live logs confirm it on redeploy.
   */
  private sessionIdFromNotification(params: unknown): string {
    const p = (params ?? {}) as {
      sessionId?: unknown;
      sessions?: Array<{ sessionId?: unknown; id?: unknown }>;
    };
    if (typeof p.sessionId === "string" && p.sessionId.length > 0) {
      return p.sessionId;
    }
    if (Array.isArray(p.sessions)) {
      for (const s of p.sessions) {
        if (s && typeof s.sessionId === "string" && s.sessionId.length > 0) {
          return s.sessionId;
        }
        if (s && typeof s.id === "string" && s.id.length > 0) {
          return s.id;
        }
      }
    }
    return "";
  }

  /** Called by the gateway hook when an agent notification we surface arrives. */
  async handleAgentNotification(method: string, params: unknown): Promise<void> {
    const kiroSessionId = this.sessionIdFromNotification(params);
    const localId = this.kiroToLocal.get(kiroSessionId) ?? kiroSessionId;
    const rt = this.runtimes.get(localId);
    const ev = normalizeRequest(localId, method, params, {
      turnId: rt?.activeTurnId ?? null,
      hooks: { onUnmapped: () => this.metrics.count("RawEventsUnmapped") },
    });
    if (rt) {
      await this.persistEvent(rt, ev);
    }
  }

  /** Called by the gateway hook when session/request_permission arrives. */
  async handlePermissionRequested(
    kiroSessionId: string,
    requestId: string,
    params: unknown,
  ): Promise<void> {
    const localId = this.kiroToLocal.get(kiroSessionId) ?? kiroSessionId;
    const rt = this.runtimes.get(localId);
    if (!rt) {
      return;
    }
    const ev = normalizeRequest(localId, "session/request_permission", params, {
      turnId: rt.activeTurnId,
    });
    if (ev.type !== "permission.requested") {
      return;
    }

    // Store the PERM item with options[] VERBATIM; never synthesize.
    await this.repo.putPermission(localId, {
      requestId,
      toolCallId: ev.toolCallId,
      toolCall: ev.toolCall,
      options: ev.options,
      consent: ev.consent ?? null,
    });
    rt.permissionStartedAt.set(requestId, this.now());

    // Drive the machine to awaiting_permission.
    this.applyMachine(rt, { kind: "permission.requested" });
    await this.persistEvent(rt, ev);
  }

  private async persistEvent(rt: SessionRuntime, ev: NormalizedEvent): Promise<void> {
    const now = this.now();
    const emitted = ev.replay ? [ev] : rt.coalescer.push(ev, now);
    // When a non-chunk event flushed buffered chunks, those come first.
    for (const out of emitted) {
      if (out.replay && !rt.deduper.accept(out)) {
        // Deduped replay event; skip persisting a duplicate.
        continue;
      }
      await this.writeEvent(rt, out, now);
    }
  }

  private async writeEvent(rt: SessionRuntime, ev: NormalizedEvent, now: number): Promise<void> {
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

  private applyMachine(rt: SessionRuntime, event: Parameters<typeof transition>[1]): void {
    try {
      rt.machine = transition(rt.machine, event);
    } catch (err) {
      this.logger.warn("illegal_transition", { sessionId: rt.id, error: String(err) });
    }
  }

  private async persistSessionStatus(rt: SessionRuntime): Promise<void> {
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

  /* --------------------------------- launch -------------------------------- */

  /**
   * Launch a cloud session via the ONLY cloud path: a `kiro-cli chat --cloud`
   * subprocess (chat-only == cloud-only, for now). The subprocess PROVISIONS a
   * real cloud Space (visible in app.kiro.dev) and runs the FIRST turn in one
   * shot: `chat --cloud --repo ... --no-interactive "<prompt>"`.
   *
   * The subprocess is long (~30-40s), so it runs as BACKGROUND work (tracked on
   * rt.settling, mirroring the turn-settlement pattern): launch() marks the
   * runtime launched + provisioning and returns PROMPTLY so intake acks the SQS
   * message on dispatch and never head-of-line-blocks other sessions. In the
   * background we await the subprocess, parse the real cloud id from the
   * `[cloud] session <uuid>` line, adopt it as rt.kiroSessionId + persist it on
   * the durable row, persist the assistant text + tool activity as events, and
   * drive the machine provisioned -> idle. On failure (no `[cloud] session` line
   * OR non-zero exit) the session is driven to `failed` with an error log and
   * the CloudLaunchFailed metric -- never a silent/idle session.
   */
  async launch(
    id: string,
    args: { prompt: string; repos: string[]; mode?: string; model?: string; effort?: string },
  ): Promise<{ path: LaunchPath; kiroSessionId: string }> {
    const rt = this.runtimeFor(id);

    // Idempotency: a redelivered launch (SQS at-least-once, or a visibility-
    // timeout redelivery that raced the ack) must NOT spawn a second chat
    // --cloud / create a second cloud Space / start a second first-turn. Treat
    // it as a logged success so the message is still deleted and the FIFO group
    // unblocks.
    if (await this.launchAlreadyIssued(id, rt)) {
      this.logger.info("launch_idempotent_skip", { sessionId: id });
      return { path: "headless", kiroSessionId: rt.kiroSessionId ?? id };
    }
    // Mark launched up front so a redelivery that arrives WHILE this launch is
    // still spawning the subprocess is also deduped (the in-memory runtime is
    // the authoritative guard; the durable row catches the runtime-reset case).
    rt.launched = true;
    rt.launchStartedAt = this.now();

    const inputs: SessionInputs = this.inputsFor({
      ...(args.mode ? { modeId: args.mode } : {}),
      ...(args.model ? { modelId: args.model } : {}),
      ...(args.effort ? { effortLevel: args.effort } : {}),
      ...(args.repos.length > 0 ? { repos: args.repos } : {}),
    });
    rt.inputs = inputs;

    const path: LaunchPath = "headless";
    const turnId = ulid();
    rt.activeTurnId = turnId;
    rt.turnStartedAt = this.now();

    this.logger.info("launch_path_decision", {
      sessionId: id,
      path,
      repoCount: args.repos.length,
    });

    // Run the chat --cloud subprocess (provision + first turn) as BACKGROUND
    // work so launch() returns promptly and intake acks the SQS message on
    // dispatch. Settlement (parse cloud id, persist events, idle/failed) runs on
    // rt.settling exactly like turn settlement does.
    rt.settling = this.settleLaunch(rt, id, args);

    return { path, kiroSessionId: rt.kiroSessionId ?? id };
  }

  /**
   * Background settlement for a chat --cloud launch: await the subprocess, parse
   * the real cloud id + assistant/tool output, persist them, and drive the
   * machine to idle (or failed, loudly). Never throws (mirrors settleTurn).
   */
  private async settleLaunch(
    rt: SessionRuntime,
    id: string,
    args: { prompt: string; repos: string[]; mode?: string; model?: string; effort?: string },
  ): Promise<void> {
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

  /**
   * Persist a chat --cloud turn's parsed output as normalized events under the
   * active turn id: a tool.call (+ tool.update when a status was observed) per
   * `[tool]` line, then the assistant's final answer as a message.chunk. Uses
   * the same writeEvent/appendEvent path as ACP-sourced events.
   */
  private async persistTurnResult(rt: SessionRuntime, result: HeadlessTurnResult): Promise<void> {
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

  /**
   * Record a follow-up turn id for idempotency, evicting the oldest id once the
   * set reaches {@link MAX_ISSUED_TURNS} so it never grows without bound over a
   * long-lived session. A Set preserves insertion order, so the first key is the
   * oldest.
   */
  private recordIssuedTurn(rt: SessionRuntime, turnId: string): void {
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
   * Persist a client-visible rejection for an operation that cannot be honored
   * for a cloud session (mid-turn steer/cancel, or a queued follow-up with no
   * drain). This runs OFF the command-dispatch error path (intake calls it after
   * catching an {@link UnsupportedCloudOperationError}) so a polling client sees,
   * via GET /v1/sessions/{id}/events, WHY the steer/cancel/queue did nothing
   * instead of silence -- WITHOUT turning the SQS message into a redelivery loop.
   * It does NOT mutate the state machine (the in-flight turn keeps running and
   * settles on its own subprocess result).
   */
  async recordUnsupportedRejection(id: string, operation: string, reason: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) {
      return;
    }
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

  /**
   * Decide whether a launch for this session has ALREADY been issued, so a
   * redelivery is a no-op. True when either the in-memory runtime has already
   * launched (still-present case) OR the durable session row is past
   * 'provisioning' / already carries a kiroSessionId (runtime-reset case, e.g.
   * after a bridge restart where the row survived but the runtime map did not).
   */
  private async launchAlreadyIssued(id: string, rt: SessionRuntime): Promise<boolean> {
    if (rt.launched || rt.kiroSessionId !== null) {
      return true;
    }
    const item = await this.repo.getSession(id);
    if (!item) {
      return false;
    }
    return item.status !== "provisioning" || item.kiroSessionId !== null;
  }

  /**
   * Adopt an EXISTING Kiro cloud session into this control-plane session.
   *
   * Unlike {@link launch} there is no first prompt: we register the update
   * handler (already done at construction) and session/load the existing id,
   * re-sending the client-owned inputs per the V3 reconnect contract, then
   * move the session to idle. Never auto-sends a prompt.
   */
  async adopt(id: string, kiroSessionId: string): Promise<{ kiroSessionId: string }> {
    const rt = this.runtimeFor(id);
    rt.launchStartedAt = this.now();
    const inputs: SessionInputs = this.inputsFor({});
    await this.gateway.loadSession(kiroSessionId, inputs);

    rt.kiroSessionId = kiroSessionId;
    rt.inputs = inputs;
    this.kiroToLocal.set(kiroSessionId, id);

    this.applyMachine(rt, { kind: "provisioned" });

    const item = await this.repo.getSession(id);
    if (item) {
      await this.repo.updateSession(id, item.version, {
        status: rt.machine.session,
        kiroSessionId,
      });
    }
    this.metrics.count("SessionsLaunched");
    this.metrics.count("LaunchPath", 1, { path: "adopt" });
    this.logger.info("session_adopted", { sessionId: id, kiroSessionId });
    return { kiroSessionId };
  }

  /* --------------------------- prompt / steer / cancel ---------------------- */

  /**
   * Start a turn. The session/prompt request is DISPATCHED (sent to the agent)
   * and the machine moves idle -> running + persists; this method then returns
   * WITHOUT waiting for the turn to settle. The settlement -- awaiting the
   * prompt response (the ONLY settler), draining updates, flushing coalesced
   * chunks, and persisting the final status -- runs as a background task tracked
   * on rt.settling. This is what lets intake ack (delete) the launch/prompt SQS
   * message on dispatch rather than on settlement, so a later answerPermission
   * in the same FIFO group is delivered while this turn is parked on a
   * permission. The turn still settles ONLY on the prompt response.
   */
  async prompt(id: string, prompt: string, turnId?: string): Promise<void> {
    const rt = this.runtimeFor(id);
    const tid = turnId ?? ulid();

    // Idempotency: a redelivered `prompt` command (SQS at-least-once, or a
    // visibility-timeout redelivery) must NOT spawn a second
    // `chat --resume-id` turn. When a turn id is supplied (the command
    // carries one) and we have already accepted it, this is a logged no-op --
    // never a duplicate resume subprocess and never a mid-turn re-dispatch. A
    // dedupe is only meaningful with a stable turn id from the command; a bare
    // prompt with no id is always a fresh turn.
    if (turnId !== undefined && rt.issuedTurns.has(turnId)) {
      this.logger.info("prompt_idempotent_skip", { sessionId: id, turnId });
      return;
    }
    this.recordIssuedTurn(rt, tid);

    rt.activeTurnId = tid;
    rt.turnStartedAt = this.now();
    this.applyMachine(rt, { kind: "prompt.sent" });
    await this.persistSessionStatus(rt);

    // A follow-up turn on a cloud session is driven by a NEW `kiro-cli chat
    // --resume-id <cloudSessionId> --no-interactive "<prompt>"` subprocess
    // (NO --cloud/--repo on resume) -- ACP CANNOT drive a cloud session
    // (session/load+prompt
    // against a real cloud id returns `Session not found`), so the gateway
    // prompt path is never used for cloud. Run the subprocess as BACKGROUND work
    // (tracked on rt.settling), exactly like the launch turn, so intake acks the
    // SQS message on dispatch.
    rt.settling = this.settleResume(rt, id, prompt);
  }

  /**
   * Background settlement for a follow-up cloud turn via headlessResume: await
   * the subprocess, persist its assistant/tool output as events, and settle the
   * turn (prompt.response on success, prompt.error on failure). Never throws
   * (mirrors settleTurn). Targets the SAME cloud id with --resume-id.
   */
  private async settleResume(rt: SessionRuntime, id: string, prompt: string): Promise<void> {
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

  /**
   * Resolve once the session's in-flight background turn (if any) has settled.
   * Used by tests to await a turn that completes off the dispatch path.
   */
  async awaitTurnSettled(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    while (rt?.settling) {
      await rt.settling;
    }
  }

  /**
   * Await every runtime's in-flight background settlement (rt.settling) up to a
   * BOUNDED timeout, then return regardless. Called on SIGTERM shutdown so a
   * turn that is actively settling (prompt response has/will arrive, draining
   * and persisting the final status) gets a chance to finish persisting before
   * the transport is stopped -- the SQS message was already deleted on dispatch,
   * so there is no redelivery to re-drive it.
   *
   * The timeout is a hard cap and MUST always win if settlement does not: a turn
   * parked on an UNANSWERED permission never settles on its own (recovery there
   * relies on reconnect/replay after restart), so this must never hang shutdown.
   */
  async awaitAllSettled(timeoutMs: number): Promise<void> {
    const settling = [...this.runtimes.values()]
      .map((rt) => rt.settling)
      .filter((p): p is Promise<void> => p !== null);
    if (settling.length === 0) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      // Promise.all over the settling promises cannot reject (settleTurn never
      // throws), but race against the timer so an unsettleable (parked) turn
      // does not hang shutdown.
      await Promise.race([Promise.all(settling).then(() => undefined), timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  async steer(
    id: string,
    content: string,
    whenBusy: "steer" | "queue" | "reject",
    turnId?: string,
  ): Promise<void> {
    const rt = this.runtimeFor(id);

    // Idempotency for a redelivered `prompt` command (which routes through
    // steer): if this turn id was already accepted, it is a logged no-op --
    // never a duplicate resume turn and never a mid-turn re-dispatch as a steer.
    // The guard runs BEFORE the busy check so a redelivery that lands mid-turn
    // is not reinterpreted as a steer. Checked here (not only in prompt()) so it
    // also covers the just-settled-into-idle case.
    if (turnId !== undefined && rt.issuedTurns.has(turnId)) {
      this.logger.info("prompt_idempotent_skip", { sessionId: id, turnId });
      return;
    }

    const busy = rt.machine.turn === "running";
    if (!busy) {
      // Idle session: a follow-up is a new prompt (_message/send -> session/prompt).
      await this.prompt(id, content, turnId);
      return;
    }
    if (whenBusy === "reject") {
      this.logger.info("steer_rejected", { sessionId: id });
      return;
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

  async cancel(id: string): Promise<void> {
    const rt = this.runtimeFor(id);
    if (rt.machine.turn !== "running") {
      this.logger.info("cancel_no_active_turn", { sessionId: id });
      return;
    }
    // Cancellation is NOT supported for a cloud turn. The turn runs in a
    // detached `chat --cloud` subprocess and ACP cannot drive a cloud session
    // (session/load+cancel against a real cloud id returns `Session not found`),
    // so issuing gateway.cancel would silently no-op while the subprocess runs
    // to completion. Reject LOUDLY rather than firing a doomed ACP request and
    // DO NOT mutate the machine (a swallowed cancel must not fake a cancelling
    // state); the turn settles on its own subprocess result.
    this.logger.warn("cancel_unsupported_cloud", { sessionId: id });
    throw new UnsupportedCloudOperationError(
      "cancel",
      "cancellation is not supported for cloud sessions; the in-flight turn will run to completion",
    );
  }

  /* --------------------------------- config -------------------------------- */

  async setConfig(
    id: string,
    args: { model?: string; effort?: string; mode?: string },
  ): Promise<void> {
    const rt = this.runtimeFor(id);
    const caps = this.gateway.capabilities();
    const sid = rt.kiroSessionId ?? id;

    if (args.model !== undefined) {
      if (!this.optionAllows(caps, "model", args.model)) {
        throw new Error(`model not advertised: ${args.model}`);
      }
      await this.gateway.setConfigOption(sid, "model", args.model);
    }
    if (args.effort !== undefined) {
      if (!this.optionAllows(caps, "effortLevel", args.effort)) {
        throw new Error(`effortLevel not advertised: ${args.effort}`);
      }
      await this.gateway.setConfigOption(sid, "effortLevel", args.effort);
    }
    if (args.mode !== undefined) {
      if (!caps.modes.some((m) => m.modeId === args.mode)) {
        throw new Error(`mode not advertised: ${args.mode}`);
      }
      await this.gateway.setMode(sid, args.mode);
    }
  }

  private optionAllows(caps: Capabilities, configId: string, value: string): boolean {
    const opt = caps.configOptions.find((o) => o.configId === configId);
    return Array.isArray(opt?.values) && opt.values.includes(value);
  }

  /* ------------------------------ permissions ------------------------------ */

  async answerPermission(id: string, requestId: string, answer: PermissionAnswer): Promise<void> {
    const rt = this.runtimeFor(id);
    // Resolve the held-open agent request with the chosen optionId + consent.
    // A false return means there was no pending in-memory request (e.g. the
    // bridge restarted and lost pendingPermissions, or the requestId is
    // unknown). That is a clean, logged no-op -- do NOT hang, throw, or force a
    // machine transition / PERM-row write that would not match reality.
    const resolved = await this.gateway.answerPermission(id, requestId, answer);
    if (!resolved) {
      this.logger.info("permission_answer_soft_fail", { sessionId: id, requestId });
      return;
    }
    await this.repo.answerPermission(id, requestId, {
      optionId: answer.optionId,
      ...(answer.consent ? { consent: answer.consent } : {}),
    });
    const started = rt.permissionStartedAt.get(requestId);
    if (started !== undefined) {
      this.metrics.duration("PermissionWait", this.now() - started);
      rt.permissionStartedAt.delete(requestId);
    }
    this.applyMachine(rt, { kind: "permission.answered" });
    await this.persistSessionStatus(rt);
  }

  /* -------------------------------- delete --------------------------------- */

  async markDeleted(id: string): Promise<void> {
    const rt = this.runtimeFor(id);
    const item = await this.repo.getSession(id);
    const kiroSessionId = rt.kiroSessionId ?? item?.kiroSessionId ?? null;

    // Run `kiro-cli chat --delete-session <kiroSessionId>` first, then mark it.
    if (kiroSessionId) {
      try {
        await headlessDelete(this.headlessRunner, this.logger, kiroSessionId);
      } catch (err) {
        this.logger.warn("delete_session_cli_failed", { sessionId: id, error: String(err) });
      }
    }

    this.applyMachine(rt, { kind: "deleted" });
    if (item) {
      await this.repo.updateSession(id, item.version, { status: "deleted", activeTurnId: null });
    }
    this.runtimes.delete(id);
    if (rt.kiroSessionId) {
      this.kiroToLocal.delete(rt.kiroSessionId);
    }
  }

  /* ------------------------- reconnect / supervision ----------------------- */

  /**
   * Register a runtime for a loaded (reconnected) session. When the session had
   * an in-flight turn, pass its id so replayed updates are attributed to it (the
   * reconnect settlement keys the transport_lost decision on that turn).
   */
  registerLoaded(
    id: string,
    kiroSessionId: string,
    inputs: SessionInputs,
    activeTurnId?: string | null,
  ): SessionRuntime {
    const rt = this.runtimeFor(id);
    rt.kiroSessionId = kiroSessionId;
    rt.inputs = inputs;
    if (activeTurnId !== undefined) {
      rt.activeTurnId = activeTurnId;
    }
    this.kiroToLocal.set(kiroSessionId, id);
    return rt;
  }

  runtime(id: string): SessionRuntime | undefined {
    return this.runtimes.get(id);
  }

  machineState(id: string): MachineState | undefined {
    return this.runtimes.get(id)?.machine;
  }

  static stateFromItem = stateOf;
}
