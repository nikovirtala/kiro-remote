/**
 * The KiroGateway interface: the abstraction over one `kiro-cli acp
 * --agent-engine=v3` child process. The bridge package implements it; core
 * only defines the contract so the service layer and tests can depend on it
 * without pulling in process/transport code.
 */

import type { Capabilities, InitializeResult } from "./capabilities.ts";

/** Inputs sent on session/new and re-sent on session/load. */
export interface SessionInputs {
  cwd: string;
  additionalDirectories?: string[];
  mcpServers?: unknown[];
  modeId?: string;
  modelId?: string;
  effortLevel?: string;
  /**
   * Target GitHub repositories for a cloud execution target. Carried on
   * session/new under `_meta.kiro.repos` alongside modeId/modelId/effortLevel
   * (the V3 migration guide shows Kiro-aware initial values travel there; it
   * does not name a dedicated top-level repos field, so this is the most
   * faithful documented placement). The headless fallback passes the same
   * repos via the `--repo` flag.
   */
  repos?: string[];
  /**
   * The selected cloud EXECUTION TARGET sent on session/new so the agent
   * provisions a real cloud Space (visible in app.kiro.dev) instead of
   * defaulting to source='local' and running inside the bridge container.
   * Resolved from the advertisement (or an env override) by
   * {@link resolveCloudTarget}. Sent TOLERANTLY in both plausible locations
   * (under `_meta.kiro.executionTarget` and as a top-level param) because the
   * real ACP V3 field name/shape is not observable in-sandbox; the exact field
   * is confirmed via the redacted raw-RPC logs on the next live redeploy.
   */
  executionTarget?: string;
  /**
   * The selected SESSION SOURCE (e.g. 'remote') sent on session/new alongside
   * {@link executionTarget}, for the same reason and with the same tolerant
   * placement (`_meta.kiro.sessionSource` and a top-level param); the real v3
   * field name is confirmed via live raw-RPC logs.
   */
  sessionSource?: string;
}

/** Result of creating or loading a session. */
export interface GatewaySession {
  sessionId: string;
}

/** Outcome of answering a permission request. */
export interface PermissionAnswer {
  optionId: string;
  consent?: {
    scope: string;
    resource: string;
    workspaceRoot: string;
  };
}

/**
 * Abstraction over a single ACP V3 connection. All optional/extension methods
 * must be gated on {@link capabilities}; implementations answer unknown
 * agent-to-client requests with a JSON-RPC error.
 */
export interface KiroGateway {
  /** The raw initialize result, as negotiated. */
  readonly initializeResult: InitializeResult;

  /** Normalized, queryable capabilities derived from {@link initializeResult}. */
  capabilities(): Capabilities;

  /** Create a new session. */
  newSession(inputs: SessionInputs): Promise<GatewaySession>;

  /**
   * Load an existing session. Callers MUST register the update handler before
   * calling this (replay arrives during load) and MUST re-send client-owned
   * inputs. Never auto-resends a prompt.
   */
  loadSession(sessionId: string, inputs: SessionInputs): Promise<GatewaySession>;

  /** Start a turn. Resolves only when the prompt response/error arrives. */
  prompt(sessionId: string, content: unknown): Promise<{ stopReason?: string }>;

  /** Steer an active turn (keeps the `_session/steer` method name). */
  steer(sessionId: string, content: unknown): Promise<void>;

  /** Cancel the active turn. */
  cancel(sessionId: string): Promise<void>;

  /** Change an advertised config option (model/effortLevel). */
  setConfigOption(sessionId: string, configId: string, value: string): Promise<void>;

  /** Change the active mode. */
  setMode(sessionId: string, modeId: string): Promise<void>;

  /**
   * Answer a pending permission request, matched by requestId/toolCallId.
   * Resolves to true when a held-open request was resolved, false when there
   * was no pending request (e.g. a bridge restart cleared the in-memory state,
   * or the requestId is unknown). A false result is a soft signal, NOT an
   * error: callers treat it as a logged no-op so the answer never hangs/throws.
   */
  answerPermission(
    sessionId: string,
    requestId: string,
    answer: PermissionAnswer,
  ): Promise<boolean>;
}

export * from "./capabilities.ts";
