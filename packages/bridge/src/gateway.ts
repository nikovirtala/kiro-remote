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
 *  - The bridge issues only standard ACP methods (no outbound `_kiro/*`); any
 *    future `_kiro/*` call MUST gate on `agentCapabilities._meta.kiro.extensionMethods`
 *    via core's `hasExtensionMethod` (the same gate the API uses).
 *  - A turn settles ONLY on the session/prompt response/error.
 *  - Permissions are answered by the chosen optionId with canonical
 *    `_meta.kiro.consent` for allow_always/reject_always -- never synthesized.
 *  - The openExternalUrl is stored as a pending action and NEVER logged.
 */

import {
  type Capabilities,
  capabilities as deriveCapabilities,
  type GatewaySession,
  type InitializeResult,
  type KiroGateway,
  type PermissionAnswer,
  type SessionInputs,
} from "@nikovirtala/kiro-remote-core";
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
    // _kiro/sessions/changed may carry the REAL cloud session id (Bug A). Surface
    // it so SessionManager can adopt that id for a launched-but-unmapped session.
    surface("_kiro/sessions/changed");

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

  /**
   * Tolerantly extract the cloud session id from a session/new or session/load
   * result. The exact shape of the real ACP V3 response is NOT observable in
   * the sandbox (Docker + kiro-cli unavailable), so we read the first non-empty
   * string id from every plausible location the real agent might use:
   *   - top-level `result.sessionId`
   *   - `result.session.sessionId` / `result.session.id`
   *   - `result._meta.kiro.sessionId` / `result._meta.kiro.id`
   *   - `result.id`
   * Returns '' when none is present (NEVER throws) so SessionManager's
   * session/update-driven late adoption can still recover the real id. FEAT-002's
   * raw-RPC debug logs reveal the actual shape on the next live redeploy.
   */
  private extractSessionId(result: unknown): string {
    if (!isRecord(result)) {
      return "";
    }
    const firstString = (...vals: unknown[]): string => {
      for (const v of vals) {
        if (typeof v === "string" && v.length > 0) {
          return v;
        }
      }
      return "";
    };
    const session = isRecord(result.session) ? result.session : {};
    const meta = isRecord(result._meta) ? result._meta : {};
    const kiro = isRecord(meta.kiro) ? meta.kiro : {};
    return firstString(
      result.sessionId,
      session.sessionId,
      session.id,
      kiro.sessionId,
      kiro.id,
      result.id,
    );
  }

  /**
   * ACP `session/new` primitive. RETAINED (not called by the cloud flow): the
   * chat-only cloud path provisions via `kiro-cli chat --cloud`, and `adopt`
   * reconnects an existing id via `loadSession`, so nothing in the cloud flow
   * calls this. It is kept because AcpGateway is a general ACP V3 client (not a
   * cloud-only helper) and its tolerant `extractSessionId` fallback chain is the
   * surface a future non-cloud ACP caller would use; that extraction is covered
   * by gateway-session-id.test.ts, which asserts the null/fallback cases that
   * loadSession's `|| sessionId` default would otherwise mask.
   */
  async newSession(inputs: SessionInputs): Promise<GatewaySession> {
    const result = await this.transport.request<unknown>("session/new", this.sessionParams(inputs));
    return { sessionId: this.extractSessionId(result) };
  }

  async loadSession(sessionId: string, inputs: SessionInputs): Promise<GatewaySession> {
    // Handlers must already be registered (start() does so); re-send inputs.
    const result = await this.transport.request<unknown>("session/load", {
      sessionId,
      cwd: inputs.cwd,
      ...(inputs.additionalDirectories
        ? { additionalDirectories: inputs.additionalDirectories }
        : {}),
      mcpServers: inputs.mcpServers ?? [],
    });
    // Honor a nested id if the load response carries one; otherwise fall back to
    // the requested id (do not depend on the load response repeating it).
    return { sessionId: this.extractSessionId(result) || sessionId };
  }

  private sessionParams(inputs: SessionInputs): Record<string, unknown> {
    const kiro: Record<string, unknown> = {};
    if (inputs.modeId) kiro.modeId = inputs.modeId;
    if (inputs.modelId) kiro.modelId = inputs.modelId;
    if (inputs.effortLevel) kiro.effortLevel = inputs.effortLevel;
    // Target repos ride under _meta.kiro (the accepted Kiro-aware key). The
    // cloud launch no longer goes through session/new -- chat --cloud is the
    // only cloud path -- so no executionTarget/sessionSource is sent here (the
    // live agent rejected those params and ACP cannot drive a cloud session).
    if (inputs.repos && inputs.repos.length > 0) kiro.repos = inputs.repos;
    return {
      cwd: inputs.cwd,
      ...(inputs.additionalDirectories
        ? { additionalDirectories: inputs.additionalDirectories }
        : {}),
      mcpServers: inputs.mcpServers ?? [],
      ...(Object.keys(kiro).length > 0 ? { _meta: { kiro } } : {}),
    };
  }

  /**
   * Normalize prompt content into an ARRAY of content blocks. ACP V3's
   * session/prompt (and _session/steer) expects `prompt` to be a LIST of
   * content blocks, not a single block object -- sending the single object is
   * what the live agent rejected with "Invalid params" (Bug B). We wrap a lone
   * content-block object into a one-element array and pass an already-array
   * through unchanged. Confirmed against the real shape via FEAT-002's raw-RPC
   * request/error logs on the next live redeploy.
   */
  private toContentBlocks(content: unknown): unknown[] {
    return Array.isArray(content) ? content : [content];
  }

  async prompt(sessionId: string, content: unknown): Promise<{ stopReason?: string }> {
    // Settles ONLY when this response/error arrives -- NOT on a turn_end update.
    const result = await this.transport.request<{ stopReason?: string }>("session/prompt", {
      sessionId,
      prompt: this.toContentBlocks(content),
    });
    return { stopReason: result?.stopReason };
  }

  // steer/cancel are the ACP `_session/steer` / `session/cancel` primitives.
  // RETAINED but NOT used by the cloud flow: a cloud turn runs in a detached
  // `chat --cloud` subprocess and ACP cannot drive a cloud session, so
  // SessionManager rejects mid-turn steer/cancel on a cloud session rather than
  // issuing these. They remain for any non-cloud ACP use of this general client.
  async steer(sessionId: string, content: unknown): Promise<void> {
    // _session/steer keeps its `_session/` prefix in V3 and carries the same
    // array-of-content-blocks prompt shape as session/prompt.
    await this.transport.request("_session/steer", {
      sessionId,
      prompt: this.toContentBlocks(content),
    });
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

  /**
   * Answer a held-open permission request by its chosen optionId. Returns true
   * when a pending request was resolved, false when there was none (e.g. the
   * in-memory pendingPermissions map was cleared by a bridge restart, or the
   * requestId is unknown). A false return is a soft signal, NOT an error: the
   * caller treats it as a logged no-op so the answer command never hangs or
   * throws.
   */
  async answerPermission(
    _sessionId: string,
    requestId: string,
    answer: PermissionAnswer,
  ): Promise<boolean> {
    const resolved = this.resolvePermission(requestId, answer);
    if (!resolved) {
      this.logger.warn("permission_answer_no_pending", { requestId });
    }
    return resolved;
  }

  /** session/list using an advertised scope, for discovery/adopt. */
  async listSessions(scope?: string): Promise<unknown[]> {
    const result = await this.transport.request<{ sessions?: unknown[] }>("session/list", {
      ...(scope ? { scope } : {}),
    });
    return result?.sessions ?? [];
  }
}
