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
} from "@kiro-remote/core";
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
  /** The in-flight turn id, or null. */
  activeTurnId: string | null;
  /** Timing for metrics. */
  turnStartedAt: number | null;
  firstEventAt: number | null;
  launchStartedAt: number;
  /** Pending permission requestId -> arrival time (for PermissionWait). */
  permissionStartedAt: Map<string, number>;
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
      };
      this.runtimes.set(id, rt);
    }
    return rt;
  }

  /* ----------------------------- update routing ---------------------------- */

  /** Called by the gateway hook when a session/update arrives. */
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

  /** Called by the gateway hook when an agent notification we surface arrives. */
  async handleAgentNotification(method: string, params: unknown): Promise<void> {
    const p = (params ?? {}) as { sessionId?: string };
    const kiroSessionId = typeof p.sessionId === "string" ? p.sessionId : "";
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

  /** Launch a cloud session, choosing the ACP target or headless fallback. */
  async launch(
    id: string,
    args: { prompt: string; repos: string[]; mode?: string; model?: string; effort?: string },
  ): Promise<{ path: LaunchPath; kiroSessionId: string }> {
    const rt = this.runtimeFor(id);
    rt.launchStartedAt = this.now();
    const caps = this.gateway.capabilities();
    const hasCloudTarget = caps.executionTargets.includes("cloud");

    const inputs: SessionInputs = this.inputsFor({
      ...(args.mode ? { modeId: args.mode } : {}),
      ...(args.model ? { modelId: args.model } : {}),
      ...(args.effort ? { effortLevel: args.effort } : {}),
    });

    let path: LaunchPath;
    let kiroSessionId: string;
    if (hasCloudTarget) {
      path = "acp";
      const session = await this.gateway.newSession({
        ...inputs,
        // repos travel as additionalDirectories-style inputs under _meta for cloud.
        mcpServers: inputs.mcpServers,
      });
      kiroSessionId = session.sessionId;
    } else {
      // No cloud execution target advertised: headless stream-json fallback,
      // then session/load so all later interaction is over ACP.
      path = "headless";
      kiroSessionId = await headlessLaunch(this.headlessRunner, this.logger, {
        prompt: args.prompt,
        repos: args.repos,
      });
      await this.gateway.loadSession(kiroSessionId, inputs);
    }

    rt.kiroSessionId = kiroSessionId;
    rt.inputs = inputs;
    this.kiroToLocal.set(kiroSessionId, id);

    // Provisioned -> idle.
    this.applyMachine(rt, { kind: "provisioned" });

    // Record which path into META + emit metrics.
    const item = await this.repo.getSession(id);
    if (item) {
      await this.repo.updateSession(id, item.version, {
        status: rt.machine.session,
        kiroSessionId,
        model: args.model ?? item.model,
        mode: args.mode ?? item.mode,
        effort: args.effort ?? item.effort,
      });
    }
    this.metrics.count("SessionsLaunched");
    this.metrics.count("LaunchPath", 1, { path });
    this.logger.info("session_launched", { sessionId: id, path });

    // The launch command carries the first prompt; send it now (idle -> running).
    await this.prompt(id, args.prompt);

    return { path, kiroSessionId };
  }

  /* --------------------------- prompt / steer / cancel ---------------------- */

  async prompt(id: string, prompt: string, turnId?: string): Promise<void> {
    const rt = this.runtimeFor(id);
    const tid = turnId ?? ulid();
    rt.activeTurnId = tid;
    rt.turnStartedAt = this.now();
    this.applyMachine(rt, { kind: "prompt.sent" });
    await this.persistSessionStatus(rt);

    try {
      const res = await this.gateway.prompt(rt.kiroSessionId ?? id, {
        type: "text",
        text: prompt,
      });
      // The ONLY settler. turn_end updates do NOT reach here.
      this.applyMachine(rt, { kind: "prompt.response", stopReason: res.stopReason });
    } catch (err) {
      this.logger.warn("prompt_error", { sessionId: id, error: String(err) });
      this.applyMachine(rt, { kind: "prompt.error" });
    } finally {
      if (rt.turnStartedAt !== null) {
        this.metrics.duration("TurnDuration", this.now() - rt.turnStartedAt);
      }
      // Flush any coalesced chunks for the completed turn.
      for (const ev of rt.coalescer.flushAll()) {
        await this.writeEvent(rt, ev, this.now());
      }
      rt.activeTurnId = null;
      rt.turnStartedAt = null;
      await this.persistSessionStatus(rt);
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
    // During an active turn, steering keeps the `_session/` prefix.
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
    await this.gateway.answerPermission(id, requestId, answer);
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

  /** Register a runtime for a loaded (reconnected) session. */
  registerLoaded(id: string, kiroSessionId: string, inputs: SessionInputs): SessionRuntime {
    const rt = this.runtimeFor(id);
    rt.kiroSessionId = kiroSessionId;
    rt.inputs = inputs;
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
