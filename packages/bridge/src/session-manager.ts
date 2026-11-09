/**
 * The session manager multiplexes every cloud session over the one ACP child.
 *
 * Responsibilities:
 *  - route session/update + request_permission by sessionId;
 *  - normalize updates (core normalizer), coalesce chunk streams, dedupe replay,
 *    and append events to the DynamoDB log via the repository;
 *  - own the ACP-only concerns: adopt/loadSession, the gateway update/
 *    permission/notification hooks, reconnect/replay (registerLoaded,
 *    drainUpdates, awaitAllSettled), setConfig, and answerPermission;
 *  - DELEGATE the gateway-free cloud path -- provisioning + follow-up turns via
 *    `kiro-cli chat --cloud` subprocesses, persistTurnResult, the per-session
 *    idempotency bookkeeping, and the UnsupportedCloudOperationError decisions
 *    -- to the shared {@link CloudSession} engine (see cloud-session.ts), so the
 *    ECS bridge and the future Lambda consumer stay behaviorally identical. ACP
 *    cannot drive a cloud session (session/load+prompt against a real cloud id
 *    returns `Session not found`), so the cloud path never uses the gateway.
 *  - run the long (~30-40s) cloud subprocess's settlement as BACKGROUND work
 *    (tracked on rt.settling) so launch/prompt return promptly and intake acks
 *    the SQS message on dispatch (no head-of-line blocking); the SAME settlement
 *    primitive is awaited synchronously by the Lambda consumer. Only this
 *    sync-vs-background wrapping differs between the two hosts.
 */

import {
  type Capabilities,
  type MachineState,
  type NormalizedEvent,
  normalizeRequest,
  normalizeUpdate,
  type PermissionAnswer,
  type Repository,
  type SessionInputs,
} from "@nikovirtala/kiro-remote-core";
import { ulid } from "ulid";
import {
  type CloudLaunchArgs,
  CloudSession,
  createRuntime,
  type LaunchPath,
  type SessionRuntime,
  stateOf,
} from "./cloud-session.ts";
import type { AcpGateway } from "./gateway.ts";
import type { HeadlessRunner } from "./headless.ts";
import type { Logger } from "./logger.ts";
import type { Metrics } from "./metrics.ts";

// Re-export the shared cloud-path types/sentinel from their original location so
// intake.ts (and the future Lambda consumer) can keep importing them from
// session-manager.ts without churn, while the implementation lives in the
// gateway-free shared module.
export {
  type CloudLaunchArgs,
  type LaunchPath,
  type SessionRuntime,
  UnsupportedCloudOperationError,
} from "./cloud-session.ts";

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

export class SessionManager {
  private readonly gateway: AcpGateway;
  private readonly repo: Repository;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly workspaceRoot: string;
  private readonly additionalDirectories?: string[];
  private readonly mcpServers: unknown[];
  private readonly now: () => number;

  /**
   * The gateway-free cloud-path engine. SessionManager delegates every cloud
   * turn-execution + persistence + idempotency primitive to it so the ECS
   * bridge and the Lambda consumer (FEAT-003) share identical logic; only the
   * sync-vs-background wrapping of settlement differs (here it runs in the
   * BACKGROUND, tracked on rt.settling, to preserve ack-on-dispatch).
   */
  private readonly cloud: CloudSession;

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
    this.workspaceRoot = deps.workspaceRoot;
    this.additionalDirectories = deps.additionalDirectories;
    this.mcpServers = deps.mcpServers ?? [];
    this.now = deps.now ?? (() => Date.now());
    this.cloud = new CloudSession({
      repo: this.repo,
      logger: this.logger,
      metrics: this.metrics,
      headlessRunner: deps.headlessRunner,
      kiroToLocal: this.kiroToLocal,
      now: this.now,
    });
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
      rt = createRuntime(id, this.inputsFor(), this.now);
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
    this.cloud.applyMachine(rt, { kind: "permission.requested" });
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
      // The event append + metric path is shared with the cloud path.
      await this.cloud.writeEvent(rt, out, now);
    }
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
    args: CloudLaunchArgs,
  ): Promise<{ path: LaunchPath; kiroSessionId: string }> {
    const rt = this.runtimeFor(id);

    // Set the per-launch inputs BEFORE delegating so a replay/reconnect of this
    // runtime carries the right modeId/modelId/effort/repos.
    const inputs: SessionInputs = this.inputsFor({
      ...(args.mode ? { modeId: args.mode } : {}),
      ...(args.model ? { modelId: args.model } : {}),
      ...(args.effort ? { effortLevel: args.effort } : {}),
      ...(args.repos.length > 0 ? { repos: args.repos } : {}),
    });

    // Delegate the idempotency guard + launch-path decision to the shared
    // engine. A null result means this was an idempotent redelivery (logged
    // skip) so the message is still deleted and the FIFO group unblocks.
    const begun = await this.cloud.beginLaunch(rt, id, args);
    if (!begun) {
      return { path: "headless", kiroSessionId: rt.kiroSessionId ?? id };
    }
    rt.inputs = inputs;
    rt.activeTurnId = ulid();

    // Run the chat --cloud subprocess (provision + first turn) as BACKGROUND
    // work so launch() returns promptly and intake acks the SQS message on
    // dispatch. The SAME settlement primitive is awaited synchronously by the
    // Lambda consumer; only this background wrapping differs.
    rt.settling = begun.settle();

    return { path: begun.path, kiroSessionId: rt.kiroSessionId ?? id };
  }

  /**
   * Persist a client-visible rejection for an operation that cannot be honored
   * for a cloud session (mid-turn steer/cancel, or a queued follow-up with no
   * drain). Delegates to the shared engine so the ECS bridge and the Lambda
   * consumer persist the identical rejection event; a no-op when the runtime is
   * gone.
   */
  async recordUnsupportedRejection(id: string, operation: string, reason: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) {
      return;
    }
    await this.cloud.recordUnsupportedRejection(rt, operation, reason);
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

    this.cloud.applyMachine(rt, { kind: "provisioned" });

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

    // Delegate the idempotency guard + idle->running transition + durable-row
    // persist to the shared engine. A null result means this was an idempotent
    // redelivery (logged skip). Otherwise run the follow-up turn's settlement as
    // BACKGROUND work (tracked on rt.settling) so intake acks the SQS message on
    // dispatch; the Lambda consumer awaits the SAME settlement primitive.
    const begun = await this.cloud.beginResume(rt, id, prompt, turnId, tid);
    if (!begun) {
      return;
    }
    rt.settling = begun.settle();
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
    // The shared engine encodes the "a cloud turn is effectively non-interactive"
    // rule: an already-issued turn id is a logged no-op, an idle session takes a
    // fresh prompt, whenBusy=reject is a quiet skip, and a mid-turn steer /
    // whenBusy=queue throws UnsupportedCloudOperationError (handled here).
    const decision = this.cloud.classifySteer(rt, id, whenBusy, turnId);
    if (decision === "prompt") {
      // Idle session: a follow-up is a new prompt (_message/send -> session/prompt).
      await this.prompt(id, content, turnId);
    }
    // "idempotent" and "reject" are logged no-ops inside classifySteer.
  }

  async cancel(id: string): Promise<void> {
    const rt = this.runtimeFor(id);
    // Delegate to the shared engine: a no-op when no turn is running, otherwise
    // a LOUD UnsupportedCloudOperationError (a detached cloud turn cannot be
    // cancelled).
    this.cloud.classifyCancel(rt, id);
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
    this.cloud.applyMachine(rt, { kind: "permission.answered" });
    await this.cloud.persistSessionStatus(rt);
  }

  /* -------------------------------- delete --------------------------------- */

  async markDeleted(id: string): Promise<void> {
    const rt = this.runtimeFor(id);
    const item = await this.repo.getSession(id);
    const kiroSessionId = rt.kiroSessionId ?? item?.kiroSessionId ?? null;

    // Run `kiro-cli chat --delete-session <kiroSessionId>` first (via the shared
    // engine, which logs rather than throws on a CLI failure), then mark it.
    await this.cloud.deleteCloud(id, kiroSessionId);

    this.cloud.applyMachine(rt, { kind: "deleted" });
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
