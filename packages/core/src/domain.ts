/**
 * Domain types for the kiro-remote control plane.
 *
 * All "enums" are union literal types because `erasableSyntaxOnly` forbids TS
 * enums. These types describe the session/turn lifecycle and the normalized
 * event union that the rest of the system consumes.
 */

/** Lifecycle status of a cloud session. */
export type SessionStatus =
  | "provisioning"
  | "running"
  | "idle"
  | "awaiting_permission"
  | "failed"
  | "deleted";

export const SESSION_STATUSES: readonly SessionStatus[] = [
  "provisioning",
  "running",
  "idle",
  "awaiting_permission",
  "failed",
  "deleted",
];

/** Lifecycle status of a single turn (one prompt and its response). */
export type TurnStatus = "queued" | "running" | "completed" | "failed" | "refused" | "cancelled";

export const TURN_STATUSES: readonly TurnStatus[] = [
  "queued",
  "running",
  "completed",
  "failed",
  "refused",
  "cancelled",
];

/** Reason a tool call or turn failed, mapped from `_meta.kiro.failureReason`. */
export type FailureReason = "cancelled" | "denied" | "error" | "generic";

/** Persistence scope for a persistent permission consent. */
export type ConsentScope = "once" | "session" | "workspace" | "global";

/**
 * Canonical consent payload returned for a persistent permission choice and
 * stored on PERM# items. Mirrors `_meta.kiro.consent`.
 */
export interface Consent {
  scope: string;
  resource: string;
  workspaceRoot: string;
}

/**
 * MCP tool annotations are display-only, untrusted hints. We must preserve the
 * difference between an omitted field and an explicit `false`, so every field
 * is optional and never defaulted.
 */
export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** Host-resolved MCP tool identity (version 1 envelope). */
export interface McpToolEnvelope {
  version: 1;
  identity: {
    serverName: string;
    toolName: string;
  };
  annotations?: McpToolAnnotations;
}

/** A permission option as supplied verbatim by the agent. */
export interface PermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

/** Content block (text/image/etc.) carried by a chunk or message. */
export interface ContentBlock {
  type: string;
  [key: string]: unknown;
}

/* -------------------------------------------------------------------------- */
/* Normalized event union                                                     */
/* -------------------------------------------------------------------------- */

/** Fields present on every normalized event. */
export interface NormalizedEventBase {
  /** Session this event belongs to (Kiro session id or our id as routed). */
  sessionId: string;
  /** Turn id when the event is attributable to a turn, else null. */
  turnId: string | null;
  /** True when the source ACP update carried `_meta.kiro.replay: true`. */
  replay: boolean;
  /** Original ACP `sessionUpdate` discriminator (or request method), for audit. */
  rawType: string;
  /** Preserved `_meta` from the source update, if any. */
  meta?: Record<string, unknown>;
}

export interface UserMessageEvent extends NormalizedEventBase {
  type: "user.message";
  content: ContentBlock;
}

export interface MessageChunkEvent extends NormalizedEventBase {
  type: "message.chunk";
  content: ContentBlock;
}

export interface ThoughtChunkEvent extends NormalizedEventBase {
  type: "thought.chunk";
  content: ContentBlock;
}

export interface ToolCallEvent extends NormalizedEventBase {
  type: "tool.call";
  toolCallId: string;
  title: string;
  status: string;
  payload: Record<string, unknown>;
}

export interface ToolUpdateEvent extends NormalizedEventBase {
  type: "tool.update";
  toolCallId: string;
  status: string;
  failureReason?: FailureReason;
  payload: Record<string, unknown>;
}

export interface PermissionRequestedEvent extends NormalizedEventBase {
  type: "permission.requested";
  requestId: string;
  toolCallId: string;
  toolCall: Record<string, unknown>;
  options: PermissionOption[];
  consent?: Record<string, unknown>;
  mcpTool?: McpToolEnvelope;
}

export interface PermissionResolvedEvent extends NormalizedEventBase {
  type: "permission.resolved";
  requestId: string;
  toolCallId: string;
  optionId: string;
  consent?: Consent;
}

export interface ModeChangedEvent extends NormalizedEventBase {
  type: "mode.changed";
  modeId: string;
}

export interface ConfigChangedEvent extends NormalizedEventBase {
  type: "config.changed";
  payload: Record<string, unknown>;
}

export interface CommandsChangedEvent extends NormalizedEventBase {
  type: "commands.changed";
  commands: unknown[];
}

export interface SessionInfoEvent extends NormalizedEventBase {
  type: "session.info";
  /** The `_meta.kiro.kind` that dispatched this info update. */
  kind: string;
  payload: Record<string, unknown>;
}

export interface McpStatusEvent extends NormalizedEventBase {
  type: "mcp.status";
  /** Full snapshot; replace prior state by server name. */
  servers: unknown[];
}

export interface WorkflowStatusEvent extends NormalizedEventBase {
  type: "workflow.status";
  payload: Record<string, unknown>;
}

export interface TurnCompletedEvent extends NormalizedEventBase {
  type: "turn.completed";
  stopReason?: string;
  payload: Record<string, unknown>;
}

export interface TurnFailedEvent extends NormalizedEventBase {
  type: "turn.failed";
  failureReason: FailureReason;
  payload: Record<string, unknown>;
}

/** Fallback for anything we do not recognize. The original payload is kept. */
export interface RawEvent extends NormalizedEventBase {
  type: "raw";
  payload: unknown;
}

export type NormalizedEvent =
  | UserMessageEvent
  | MessageChunkEvent
  | ThoughtChunkEvent
  | ToolCallEvent
  | ToolUpdateEvent
  | PermissionRequestedEvent
  | PermissionResolvedEvent
  | ModeChangedEvent
  | ConfigChangedEvent
  | CommandsChangedEvent
  | SessionInfoEvent
  | McpStatusEvent
  | WorkflowStatusEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | RawEvent;

export type NormalizedEventType = NormalizedEvent["type"];
