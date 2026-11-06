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

  /** Answer a pending permission request, matched by requestId/toolCallId. */
  answerPermission(sessionId: string, requestId: string, answer: PermissionAnswer): Promise<void>;
}

export * from "./capabilities.ts";
