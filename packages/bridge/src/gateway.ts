/**
 * The ACP V3 gateway: the bridge's {@link KiroGateway} implementation over one
 * `kiro-cli acp --agent-engine=v3` child (via {@link StdioJsonRpcTransport}).
 *
 * Contract points enforced here (from the V3 migration guide):
 *  - `initialize` advertises clientInfo + clientCapabilities
 *    (`_meta.kiro.openExternalUrl: true`); the result builds {@link capabilities}.
 *  - Agent-to-client handlers (session/update, session/request_permission,
 *    _kiro/openExternalUrl) are registered BEFORE any session/new or
 *    session/load -- enforced by {@link registerHandlers}, called in start().
 *  - Every `_kiro/*` call is gated on `agentCapabilities._meta.kiro.extensionMethods`.
 *  - A turn settles ONLY on the session/prompt response/error.
 *  - Permissions are answered by the chosen optionId with canonical
 *    `_meta.kiro.consent` for allow_always/reject_always -- never synthesized.
 *  - The openExternalUrl is stored as a pending action and NEVER logged.
 */

import {
  type Capabilities,
  capabilities as deriveCapabilities,
  type GatewaySession,
  hasExtensionMethod,
  type InitializeResult,
  type KiroGateway,
  type PermissionAnswer,
  type SessionInputs,
} from "@kiro-remote/core";
import type { Logger } from "./logger.ts";
import type { StdioJsonRpcTransport } from "./transport.ts";

/** Our client identity sent on initialize. */
export const CLIENT_INFO = { name: "kiro-remote-bridge", version: "0.0.0" } as const;

/** Methods we register as agent-to-client handlers, before any session. */
export const AGENT_TO_CLIENT_METHODS = [
  "session/update",
  "session/request_permission",
  "_kiro/openExternalUrl",
] as const;

/** A permission request captured from the agent, awaiting an answer command. */
export interface PendingPermission {
  requestId: string;
  params: unknown;
  resolve: (reply: { outcome: unknown; _meta?: unknown }) => void;
}

/** A pending external-URL action (never logged). */
export interface PendingExternalUrl {
  sessionId: string | null;
  url: string;
  createdAt: number;
}

export interface GatewayEventHooks {
  /** session/update notification arrived for a session. */
  onSessionUpdate(sessionId: string, update: unknown, meta: { method: string }): void;
  /** session/request_permission arrived; the gateway holds the reply open. */
  onPermissionRequested(sessionId: string, requestId: string, params: unknown): void;
  /** An arbitrary agent-to-client notification we normalize but do not special-case. */
  onAgentNotification?(method: string, params: unknown): void;
  /** A pending openExternalUrl was stored. */
  onExternalUrl?(pending: PendingExternalUrl): void;
}

export interface AcpGatewayOptions {
  transport: StdioJsonRpcTransport;
  logger: Logger;
  hooks: GatewayEventHooks;
  now?: () => number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export class AcpGateway implements KiroGateway {
  private readonly transport: StdioJsonRpcTransport;
  private readonly logger: Logger;
  private readonly hooks: GatewayEventHooks;
  private readonly now: () => number;

  private _initializeResult: InitializeResult = {};
  private _capabilities: Capabilities = deriveCapabilities({});
  private handlersRegistered = false;

  /** Permission replies held open until an answer command arrives. */
  readonly pendingPermissions = new Map<string, PendingPermission>();
  /** The latest pending external URL (never logged). */
  readonly pendingExternalUrls: PendingExternalUrl[] = [];

  constructor(opts: AcpGatewayOptions) {
    this.transport = opts.transport;
    this.logger = opts.logger;
    this.hooks = opts.hooks;
    this.now = opts.now ?? (() => Date.now());
  }

  get initializeResult(): InitializeResult {
    return this._initializeResult;
  }

  capabilities(): Capabilities {
    return this._capabilities;
  }

  /**
   * Register all agent-to-client handlers. Call this BEFORE initialize so no
   * session/new or session/load can race ahead of handler registration (the
   * migration guide: live updates are not buffered for future subscribers).
   */
  registerHandlers(): void {
    this.transport.onNotification("session/update", (params) => {
      const p = isRecord(params) ? params : {};
      const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
      this.hooks.onSessionUpdate(sessionId, p.update, { method: "session/update" });
    });

    this.transport.onRequest("session/request_permission", (params) => {
      return this.handlePermissionRequest(params);
    });

    this.transport.onRequest("_kiro/openExternalUrl", (params) => {
      const p = isRecord(params) ? params : {};
      const url = typeof p.url === "string" ? p.url : "";
      const sessionId = typeof p.sessionId === "string" ? p.sessionId : null;
      const pending: PendingExternalUrl = { sessionId, url, createdAt: this.now() };
      this.pendingExternalUrls.push(pending);
      // NEVER log the URL; log only that a request arrived.
      this.logger.info("external_url_pending", { sessionId });
      this.hooks.onExternalUrl?.(pending);
      return {};
    });

    // mcp status + workflow + rate_limit are notifications we surface as events.
    const surface = (method: string): void => {
      this.transport.onNotification(method, (params) => {
        this.hooks.onAgentNotification?.(method, params);
      });
    };
    surface("_kiro/mcp/status");
    surface("_kiro/error/rate_limit");

    this.handlersRegistered = true;
  }

  private handlePermissionRequest(params: unknown): Promise<{ outcome: unknown; _meta?: unknown }> {
    const p = isRecord(params) ? params : {};
    const toolCall = isRecord(p.toolCall) ? p.toolCall : {};
    const requestId = String(p.requestId ?? toolCall.toolCallId ?? "");
    const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";

    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, { requestId, params, resolve });
      // The turn is blocked until the client answers. Surface to the hooks so
      // the bridge can persist the PERM item verbatim and set awaiting_permission.
      this.hooks.onPermissionRequested(sessionId, requestId, params);
    });
  }

  /**
   * Resolve a pending permission with the chosen optionId. For a persistent
   * option (allow_always/reject_always) include the canonical
   * `_meta.kiro.consent`. NEVER synthesize an option.
   */
  resolvePermission(requestId: string, answer: PermissionAnswer): boolean {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      return false;
    }
    this.pendingPermissions.delete(requestId);
    pending.resolve({
      outcome: { outcome: "selected", optionId: answer.optionId },
      ...(answer.consent ? { _meta: { kiro: { consent: answer.consent } } } : {}),
    });
    return true;
  }

  /** Expire a pending permission: drop our hold so the request falls back to Kiro. */
  expirePermission(requestId: string): boolean {
    return this.pendingPermissions.delete(requestId);
  }

  /** Run initialize, store the result, derive capabilities. Handlers first. */
  async initialize(): Promise<Capabilities> {
    if (!this.handlersRegistered) {
      this.registerHandlers();
    }
    const result = await this.transport.request<InitializeResult>("initialize", {
      protocolVersion: 1,
      clientInfo: CLIENT_INFO,
      clientCapabilities: {
        _meta: { kiro: { openExternalUrl: true } },
      },
    });
    this._initializeResult = result ?? {};
    this._capabilities = deriveCapabilities(this._initializeResult);
    return this._capabilities;
  }

  /** True when the extension method is advertised; gate every `_kiro/*` call. */
  canCall(method: string): boolean {
    return hasExtensionMethod(this._capabilities, method);
  }

  async newSession(inputs: SessionInputs): Promise<GatewaySession> {
    const result = await this.transport.request<{ sessionId?: string }>(
      "session/new",
      this.sessionParams(inputs),
    );
    return { sessionId: String(result?.sessionId ?? "") };
  }

  async loadSession(sessionId: string, inputs: SessionInputs): Promise<GatewaySession> {
    // Handlers must already be registered (start() does so); re-send inputs.
    const result = await this.transport.request<{ sessionId?: string }>("session/load", {
      sessionId,
      cwd: inputs.cwd,
      ...(inputs.additionalDirectories
        ? { additionalDirectories: inputs.additionalDirectories }
        : {}),
      mcpServers: inputs.mcpServers ?? [],
    });
    // Keep the requested id; do not depend on the load response repeating it.
    return { sessionId: String(result?.sessionId ?? sessionId) };
  }

  private sessionParams(inputs: SessionInputs): Record<string, unknown> {
    const kiro: Record<string, unknown> = {};
    if (inputs.modeId) kiro.modeId = inputs.modeId;
    if (inputs.modelId) kiro.modelId = inputs.modelId;
    if (inputs.effortLevel) kiro.effortLevel = inputs.effortLevel;
    return {
      cwd: inputs.cwd,
      ...(inputs.additionalDirectories
        ? { additionalDirectories: inputs.additionalDirectories }
        : {}),
      mcpServers: inputs.mcpServers ?? [],
      ...(Object.keys(kiro).length > 0 ? { _meta: { kiro } } : {}),
    };
  }

  async prompt(sessionId: string, content: unknown): Promise<{ stopReason?: string }> {
    // Settles ONLY when this response/error arrives -- NOT on a turn_end update.
    const result = await this.transport.request<{ stopReason?: string }>("session/prompt", {
      sessionId,
      prompt: content,
    });
    return { stopReason: result?.stopReason };
  }

  async steer(sessionId: string, content: unknown): Promise<void> {
    // _session/steer keeps its `_session/` prefix in V3.
    await this.transport.request("_session/steer", { sessionId, prompt: content });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.transport.request("session/cancel", { sessionId });
  }

  async setConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
    await this.transport.request("session/set_config_option", { sessionId, configId, value });
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.transport.request("session/set_mode", { sessionId, modeId });
  }

  async answerPermission(
    _sessionId: string,
    requestId: string,
    answer: PermissionAnswer,
  ): Promise<void> {
    const resolved = this.resolvePermission(requestId, answer);
    if (!resolved) {
      this.logger.warn("permission_answer_no_pending", { requestId });
    }
  }

  /** session/list using an advertised scope, for discovery/adopt. */
  async listSessions(scope?: string): Promise<unknown[]> {
    const result = await this.transport.request<{ sessions?: unknown[] }>("session/list", {
      ...(scope ? { scope } : {}),
    });
    return result?.sessions ?? [];
  }
}
