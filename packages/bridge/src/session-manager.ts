/**
 * The session manager multiplexes every cloud session over the one ACP child.
 *
 * Responsibilities:
 *  - route session/update + request_permission by sessionId;
 *  - normalize updates (core normalizer), coalesce chunk streams, dedupe replay,
 *    and append events to the DynamoDB log via the repository;
 *  - drive the pure state machine (core transition) -- the ONLY place a turn
 *    or session changes status; a turn settles ONLY on the prompt response;
 *  - select the launch path (ACP cloud target vs headless stream-json fallback)
 *    and record which path into META + the LaunchPath metric;
 *  - prompt/steer/cancel/config/permission commands against the gateway;
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
import { type HeadlessRunner, headlessDelete, headlessLaunch } from "./headless.ts";
import type { Logger } from "./logger.ts";
import type { Metrics } from "./metrics.ts";

/** Which launch path was taken for a session. */
export type LaunchPath = "acp" | "headless";

/** Per-session runtime state held in the bridge (not the durable store). */
interface SessionRuntime {
  id: string;
  machine: MachineState;
  coalescer: Coalescer;
  deduper: ReplayDeduper;
  inputs: SessionInputs;
  kiroSessionId: string | null;
  /**
   * True while this runtime launched via the ACP path but session/new did NOT
   * return a usable cloud id, so we are waiting for the FIRST session/update
   * (or _kiro/sessions/changed) to reveal the real sess_ id (Bug A). Cleared
   * once a real id is adopted. The headless path and adopt() know the id up
   * front, so this stays false for them.
   */
  awaitingCloudId: boolean;
  /**
   * Resolves once the real cloud id has been adopted (used by launch() to settle
   * the id with a bounded wait before sending the first prompt). Null when not
   * awaiting.
   */
  cloudIdResolve: (() => void) | null;
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
  /**
   * Bounded wait (ms) for the real cloud id to be adopted before the first
   * prompt when session/new returned no id (Bug A). Defaults to a few seconds;
   * tests shrink it to keep the suite fast.
   */
  cloudIdSettleMs?: number;
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
  private readonly cloudIdSettleMs: number;

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
    this.cloudIdSettleMs = deps.cloudIdSettleMs ?? SessionManager.CLOUD_ID_SETTLE_MS;
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
        awaitingCloudId: false,
        cloudIdResolve: null,
        activeTurnId: null,
        turnStartedAt: null,
        firstEventAt: null,
        launchStartedAt: this.now(),
        permissionStartedAt: new Map(),
        launched: false,
        settling: null,
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
   * Late-binding adoption (Bug A): the live agent routes session/update and
   * _kiro/sessions/changed under a FRESH cloud id (e.g. sess_f0140707-...) that
   * session/new never returned. When an id arrives with no kiroToLocal mapping,
   * attach it to the single runtime that launched via ACP and is still awaiting
   * its real id. Only adopts when UNAMBIGUOUS (exactly one pending ACP runtime);
   * otherwise returns null so the caller logs update_for_unknown_session.
   * Returns the bound runtime (and persists the real kiroSessionId) on success.
   */
  private async adoptCloudId(kiroSessionId: string): Promise<SessionRuntime | null> {
    if (!kiroSessionId || this.kiroToLocal.has(kiroSessionId)) {
      return null;
    }
    const pending = [...this.runtimes.values()].filter((rt) => rt.awaitingCloudId);
    if (pending.length !== 1) {
      return null;
    }
    const rt = pending[0];
    if (!rt) {
      return null;
    }
    this.kiroToLocal.set(kiroSessionId, rt.id);
    rt.kiroSessionId = kiroSessionId;
    rt.awaitingCloudId = false;
    this.logger.info("cloud_session_id_adopted", { sessionId: rt.id, kiroSessionId });
    // Persist the now-known real id so reconnect/load keys on it too.
    await this.persistSessionStatus(rt);
    // Release launch()'s bounded settling wait so the first prompt uses the id.
    if (rt.cloudIdResolve) {
      const resolve = rt.cloudIdResolve;
      rt.cloudIdResolve = null;
      resolve();
    }
    return rt;
  }

  /** Called by the gateway hook when a session/update arrives. */
  async handleUpdate(kiroSessionId: string, update: unknown): Promise<void> {
    const localId = this.kiroToLocal.get(kiroSessionId) ?? kiroSessionId;
    let rt = this.runtimes.get(localId);
    if (!rt) {
      // No mapping yet: try to adopt this as the real cloud id for a launched
      // ACP session that is still awaiting one.
      rt = (await this.adoptCloudId(kiroSessionId)) ?? undefined;
    }
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
    let rt = this.runtimes.get(localId);
    if (!rt && kiroSessionId) {
      // _kiro/sessions/changed may carry the real cloud id for a launched-but-
      // unmapped ACP session: adopt it (benign; never fails the session).
      rt = (await this.adoptCloudId(kiroSessionId)) ?? undefined;
    }
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

  /** Launch a cloud session, choosing the ACP target or headless fallback. */
  async launch(
    id: string,
    args: { prompt: string; repos: string[]; mode?: string; model?: string; effort?: string },
  ): Promise<{ path: LaunchPath; kiroSessionId: string }> {
    const rt = this.runtimeFor(id);

    // Idempotency: a redelivered launch (SQS at-least-once, or a visibility-
    // timeout redelivery that raced the ack) must NOT issue a second session/new
    // / create a second cloud session / start a second first-turn. Treat it as a
    // logged success so the message is still deleted and the FIFO group unblocks.
    if (await this.launchAlreadyIssued(id, rt)) {
      this.logger.info("launch_idempotent_skip", { sessionId: id });
      return { path: "acp", kiroSessionId: rt.kiroSessionId ?? "" };
    }
    // Mark launched up front so a redelivery that arrives WHILE this launch is
    // still issuing session/new is also deduped (the in-memory runtime is the
    // authoritative guard; the durable row catches the runtime-reset case).
    rt.launched = true;

    rt.launchStartedAt = this.now();
    const caps = this.gateway.capabilities();
    // Prefer the ACP cloud path whenever cloud/remote execution is genuinely
    // advertised (derived resiliently in core, not from a single literal
    // target). Headless stream-json is a true last resort.
    const hasCloudTarget = caps.cloudExecution;
    // Redaction-safe decision log: records the driving signals so the next live
    // run shows exactly WHY a path was chosen. We log only non-secret capability
    // shapes plus a COUNT of extension methods (method names are not secrets but
    // we keep the line compact).
    this.logger.info("launch_path_decision", {
      sessionId: id,
      path: hasCloudTarget ? "acp" : "headless",
      cloudExecution: caps.cloudExecution,
      executionTargets: caps.executionTargets,
      sessionSources: caps.sessionSources,
      listScopes: caps.listScopes,
      extensionMethodCount: caps.extensionMethods.length,
    });

    const inputs: SessionInputs = this.inputsFor({
      ...(args.mode ? { modeId: args.mode } : {}),
      ...(args.model ? { modelId: args.model } : {}),
      ...(args.effort ? { effortLevel: args.effort } : {}),
      ...(args.repos.length > 0 ? { repos: args.repos } : {}),
    });

    let path: LaunchPath;
    let kiroSessionId: string;
    rt.inputs = inputs;
    if (hasCloudTarget) {
      path = "acp";
      // The cloud execution target learns its repos from session/new inputs
      // (carried under _meta.kiro.repos by the gateway); the headless fallback
      // passes the same repos via the --repo flag.
      const session = await this.gateway.newSession(inputs);
      kiroSessionId = session.sessionId;
      if (kiroSessionId) {
        // session/new returned a usable id: map it directly (today's behavior).
        rt.kiroSessionId = kiroSessionId;
        rt.awaitingCloudId = false;
        this.kiroToLocal.set(kiroSessionId, id);
      } else {
        // Bug A: session/new did NOT return a usable id. The real sess_ id only
        // arrives via the first session/update (or _kiro/sessions/changed). Mark
        // this runtime as awaiting it; do NOT put a bogus '' key in kiroToLocal.
        rt.kiroSessionId = null;
        rt.awaitingCloudId = true;
      }
    } else {
      // No cloud execution target advertised: headless stream-json fallback,
      // then session/load so all later interaction is over ACP.
      path = "headless";
      kiroSessionId = await headlessLaunch(this.headlessRunner, this.logger, {
        prompt: args.prompt,
        repos: args.repos,
      });
      await this.gateway.loadSession(kiroSessionId, inputs);
      rt.kiroSessionId = kiroSessionId;
      rt.awaitingCloudId = false;
      this.kiroToLocal.set(kiroSessionId, id);
    }

    // Provisioned -> idle.
    this.applyMachine(rt, { kind: "provisioned" });

    // Record which path into META + emit metrics. persistSessionStatus/
    // updateSession only write kiroSessionId when it is a real (truthy) value,
    // so an awaiting-id runtime does not persist a bogus id here.
    const item = await this.repo.getSession(id);
    if (item) {
      await this.repo.updateSession(id, item.version, {
        status: rt.machine.session,
        ...(rt.kiroSessionId ? { kiroSessionId: rt.kiroSessionId } : {}),
        model: args.model ?? item.model,
        mode: args.mode ?? item.mode,
        effort: args.effort ?? item.effort,
      });
    }
    this.metrics.count("SessionsLaunched");
    this.metrics.count("LaunchPath", 1, { path });
    this.logger.info("session_launched", { sessionId: id, path });

    // If we are still awaiting the real cloud id, give the first session/update
    // (or _kiro/sessions/changed) a brief, BOUNDED window to adopt it before the
    // first prompt goes out -- the live timeline shows session_launched then the
    // prompt ~50ms later, so the prompt could otherwise race ahead with the wrong
    // id. We NEVER hang the launch: after the timeout we fall back to whatever id
    // is known (the returned id or, failing that, the local id) and proceed.
    if (rt.awaitingCloudId) {
      await this.settleCloudId(rt);
    }

    // The launch command carries the first prompt; DISPATCH it now (idle ->
    // running) but do NOT await the turn settling. prompt() returns once
    // session/prompt has been sent and the turn is tracked as a background task;
    // settlement (prompt.response -> drainUpdates/flush/persist) continues via
    // the gateway hooks + the background settle promise. This is the deadlock
    // fix: launch() returns promptly so intake deletes the SQS message, which
    // unblocks the FIFO group so a later answerPermission in the same group is
    // delivered and can resolve the held-open permission request.
    await this.prompt(id, args.prompt);

    return { path, kiroSessionId: rt.kiroSessionId ?? kiroSessionId };
  }

  /**
   * Decide whether a launch for this session has ALREADY been issued, so a
   * redelivery is a no-op. True when either the in-memory runtime has already
   * launched (still-present case) OR the durable session row is past
   * 'provisioning' / already carries a kiroSessionId (runtime-reset case, e.g.
   * after a bridge restart where the row survived but the runtime map did not).
   */
  private async launchAlreadyIssued(id: string, rt: SessionRuntime): Promise<boolean> {
    if (rt.launched || rt.kiroSessionId !== null || rt.awaitingCloudId) {
      return true;
    }
    const item = await this.repo.getSession(id);
    if (!item) {
      return false;
    }
    return item.status !== "provisioning" || item.kiroSessionId !== null;
  }

  /** Default bounded wait (ms) for the real cloud id to be adopted post-launch. */
  private static readonly CLOUD_ID_SETTLE_MS = 3000;

  /**
   * Wait (bounded) for the real cloud id to be adopted via the first
   * session/update or _kiro/sessions/changed. Resolves as soon as adoption fires
   * (adoptCloudId invokes rt.cloudIdResolve) or after a conservative timeout --
   * it never hangs the launch indefinitely. If the id already arrived before we
   * got here, awaitingCloudId is already false and we return immediately.
   */
  private async settleCloudId(rt: SessionRuntime): Promise<void> {
    if (!rt.awaitingCloudId) {
      return;
    }
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        rt.cloudIdResolve = null;
        resolve();
      };
      rt.cloudIdResolve = finish;
      const timer = setTimeout(() => {
        // The real id did not arrive via sessions/changed in time. We stop
        // BLOCKING the launch and let prompt() fall back to the local id, but we
        // keep awaitingCloudId = true so the FIRST session/update (which the
        // prompt itself triggers) can still adopt the real id. FEAT-002's live
        // logs reveal the real shape so this path can be tightened on redeploy.
        if (rt.awaitingCloudId) {
          this.logger.warn("cloud_session_id_settle_timeout", { sessionId: rt.id });
        }
        finish();
      }, this.cloudIdSettleMs);
    });
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
    rt.activeTurnId = tid;
    rt.turnStartedAt = this.now();
    this.applyMachine(rt, { kind: "prompt.sent" });
    await this.persistSessionStatus(rt);

    // Dispatch the request NOW. transport.request() writes the session/prompt
    // line synchronously before returning its promise, so by the time this call
    // returns the prompt is on the wire. Construct the single text content
    // block; the gateway wraps it into the array of content blocks ACP V3's
    // session/prompt requires (Bug B).
    const responsePromise = this.gateway.prompt(rt.kiroSessionId ?? id, {
      type: "text",
      text: prompt,
    });

    // Settle in the background: the prompt response is the sole settler.
    rt.settling = this.settleTurn(rt, id, responsePromise);
  }

  /**
   * Await the prompt response and run turn settlement. Runs OFF the dispatch
   * path (as a background task started by {@link prompt}); never throws (a
   * failed prompt settles the turn as errored). Preserves exactly the behavior
   * that used to live in prompt()'s finally: TurnDuration metric, drainUpdates
   * (so late cloud-id adoption lands before the status write persists
   * kiroSessionId), coalescer.flushAll, clearing activeTurnId, and the final
   * persistSessionStatus.
   */
  private async settleTurn(
    rt: SessionRuntime,
    id: string,
    responsePromise: Promise<{ stopReason?: string }>,
  ): Promise<void> {
    try {
      const res = await responsePromise;
      // The ONLY settler. turn_end updates do NOT reach here.
      this.applyMachine(rt, { kind: "prompt.response", stopReason: res.stopReason });
    } catch (err) {
      this.logger.warn("prompt_error", { sessionId: id, error: String(err) });
      this.applyMachine(rt, { kind: "prompt.error" });
    } finally {
      if (rt.turnStartedAt !== null) {
        this.metrics.duration("TurnDuration", this.now() - rt.turnStartedAt);
      }
      // Drain in-flight updates so any late cloud-id adoption (Bug A) has landed
      // on the runtime before the final status write persists kiroSessionId.
      await this.drainUpdates();
      // Flush any coalesced chunks for the completed turn.
      for (const ev of rt.coalescer.flushAll()) {
        await this.writeEvent(rt, ev, this.now());
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

  async steer(id: string, content: string, whenBusy: "steer" | "queue" | "reject"): Promise<void> {
    const rt = this.runtimeFor(id);
    const busy = rt.machine.turn === "running";
    if (!busy) {
      // Idle session: a follow-up is a new prompt (_message/send -> session/prompt).
      await this.prompt(id, content);
      return;
    }
    if (whenBusy === "reject") {
      this.logger.info("steer_rejected", { sessionId: id });
      return;
    }
    if (whenBusy === "queue") {
      this.applyMachine(rt, { kind: "prompt.queued" });
      this.logger.info("steer_queued", { sessionId: id });
    }
    // During an active turn, steering keeps the `_session/` prefix. Pass the
    // single text content block; the gateway wraps it into the array of content
    // blocks ACP V3 requires (same shape as session/prompt, Bug B).
    await this.gateway.steer(rt.kiroSessionId ?? id, { type: "text", text: content });
  }

  async cancel(id: string): Promise<void> {
    const rt = this.runtimeFor(id);
    if (rt.machine.turn !== "running") {
      this.logger.info("cancel_no_active_turn", { sessionId: id });
      return;
    }
    this.applyMachine(rt, { kind: "cancel.requested" });
    // session/cancel then WAIT for the prompt response (the prompt() promise is
    // what marks the turn settled). We only request cancellation here.
    await this.gateway.cancel(rt.kiroSessionId ?? id);
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
