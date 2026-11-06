/**
 * ACP V3 event normalizer.
 *
 * Maps ACP `session/update` notifications AND agent-to-client requests into the
 * normalized event union ({@link NormalizedEvent}). The rules, taken from the
 * V3 migration guide:
 *
 *  - Dispatch `session_info_update` by `_meta.kiro.kind`.
 *  - Unknown update types / kinds / `_meta` fields map to `raw`, preserving the
 *    ORIGINAL payload, and increment the RawEventsUnmapped counter hook. Never
 *    drop an event, never fail the session.
 *  - Key tool events by `toolCallId`, never by title.
 *  - Map `_meta.kiro.failureReason` in {cancelled, denied, error}, else generic.
 *  - `_meta.kiro.mcpTool` (version 1) annotations are display-only; preserve the
 *    difference between an omitted field and explicit `false`.
 *  - Mark replayed updates (`_meta.kiro.replay: true`) distinctly.
 */

import type {
  CommandsChangedEvent,
  ConfigChangedEvent,
  FailureReason,
  McpStatusEvent,
  McpToolAnnotations,
  McpToolEnvelope,
  MessageChunkEvent,
  ModeChangedEvent,
  NormalizedEvent,
  PermissionOption,
  PermissionRequestedEvent,
  RawEvent,
  SessionInfoEvent,
  ThoughtChunkEvent,
  ToolCallEvent,
  ToolUpdateEvent,
  TurnCompletedEvent,
  TurnFailedEvent,
  UserMessageEvent,
  WorkflowStatusEvent,
} from "../domain.ts";

/** Hook invoked whenever an update cannot be mapped and falls back to `raw`. */
export interface NormalizeHooks {
  /** Increment a RawEventsUnmapped-style metric. Called once per raw event. */
  onUnmapped?: (rawType: string) => void;
}

export interface NormalizeContext {
  /** Turn id to attribute events to, when known. */
  turnId?: string | null;
  hooks?: NormalizeHooks;
}

type AnyRecord = Record<string, unknown>;

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getKiroMeta(meta: unknown): AnyRecord | undefined {
  if (!isRecord(meta)) {
    return undefined;
  }
  const kiro = meta.kiro;
  return isRecord(kiro) ? kiro : undefined;
}

function isReplay(meta: unknown): boolean {
  return getKiroMeta(meta)?.replay === true;
}

/** Normalize `_meta.kiro.failureReason` to the closed union. */
export function normalizeFailureReason(value: unknown): FailureReason {
  if (value === "cancelled" || value === "denied" || value === "error") {
    return value;
  }
  return "generic";
}

/**
 * Read a version-1 `_meta.kiro.mcpTool` envelope, preserving the distinction
 * between an omitted annotation field and an explicit `false`.
 */
export function readMcpTool(meta: unknown): McpToolEnvelope | undefined {
  const kiro = getKiroMeta(meta);
  const mcpTool = kiro?.mcpTool;
  if (!isRecord(mcpTool) || mcpTool.version !== 1) {
    return undefined;
  }
  const identity = mcpTool.identity;
  if (!isRecord(identity)) {
    return undefined;
  }
  const annotationsRaw = mcpTool.annotations;
  let annotations: McpToolAnnotations | undefined;
  if (isRecord(annotationsRaw)) {
    annotations = {};
    for (const key of [
      "readOnlyHint",
      "destructiveHint",
      "idempotentHint",
      "openWorldHint",
    ] as const) {
      if (key in annotationsRaw) {
        annotations[key] = annotationsRaw[key] === true;
      }
    }
  }
  return {
    version: 1,
    identity: {
      serverName: String(identity.serverName ?? ""),
      toolName: String(identity.toolName ?? ""),
    },
    ...(annotations ? { annotations } : {}),
  };
}

function base(
  sessionId: string,
  rawType: string,
  update: AnyRecord,
  ctx: NormalizeContext,
): {
  sessionId: string;
  turnId: string | null;
  replay: boolean;
  rawType: string;
  meta?: AnyRecord;
} {
  const meta = isRecord(update._meta) ? (update._meta as AnyRecord) : undefined;
  return {
    sessionId,
    turnId: ctx.turnId ?? null,
    replay: isReplay(update._meta),
    rawType,
    ...(meta ? { meta } : {}),
  };
}

function toRaw(
  sessionId: string,
  rawType: string,
  payload: unknown,
  update: AnyRecord,
  ctx: NormalizeContext,
): RawEvent {
  ctx.hooks?.onUnmapped?.(rawType);
  return { type: "raw", payload, ...base(sessionId, rawType, update, ctx) };
}

function normalizeSessionInfo(
  sessionId: string,
  update: AnyRecord,
  ctx: NormalizeContext,
): NormalizedEvent {
  const kind = getKiroMeta(update._meta)?.kind;
  const payload: AnyRecord = { ...update };
  const b = base(sessionId, "session_info_update", update, ctx);

  if (typeof kind !== "string") {
    return toRaw(sessionId, "session_info_update", update, update, ctx);
  }

  if (kind === "turn_completion") {
    const stopReason = typeof payload.status === "string" ? payload.status : undefined;
    const ev: TurnCompletedEvent = {
      type: "turn.completed",
      payload,
      ...(stopReason ? { stopReason } : {}),
      ...b,
    };
    return ev;
  }

  // context_usage, steering_*, summarization, and any other named kind are all
  // valid session.info events carrying the kind through.
  const ev: SessionInfoEvent = { type: "session.info", kind, payload, ...b };
  return ev;
}

/** Normalize a single `session/update` notification's `update` object. */
export function normalizeUpdate(
  sessionId: string,
  update: unknown,
  ctx: NormalizeContext = {},
): NormalizedEvent {
  if (!isRecord(update)) {
    return toRaw(sessionId, "unknown", update, {}, ctx);
  }
  const kind = update.sessionUpdate;
  const rawType = typeof kind === "string" ? kind : "unknown";
  const b = base(sessionId, rawType, update, ctx);

  switch (kind) {
    case "user_message_chunk": {
      const ev: UserMessageEvent = {
        type: "user.message",
        content: isRecord(update.content) ? (update.content as never) : { type: "text" },
        ...b,
      };
      return ev;
    }
    case "agent_message_chunk": {
      const ev: MessageChunkEvent = {
        type: "message.chunk",
        content: isRecord(update.content) ? (update.content as never) : { type: "text" },
        ...b,
      };
      return ev;
    }
    case "agent_thought_chunk": {
      const ev: ThoughtChunkEvent = {
        type: "thought.chunk",
        content: isRecord(update.content) ? (update.content as never) : { type: "text" },
        ...b,
      };
      return ev;
    }
    case "tool_call": {
      const ev: ToolCallEvent = {
        type: "tool.call",
        toolCallId: String(update.toolCallId ?? ""),
        title: typeof update.title === "string" ? update.title : "",
        status: typeof update.status === "string" ? update.status : "pending",
        payload: update,
        ...b,
      };
      return ev;
    }
    case "tool_call_update": {
      const failureRaw = getKiroMeta(update._meta)?.failureReason;
      const status = typeof update.status === "string" ? update.status : "";
      const ev: ToolUpdateEvent = {
        type: "tool.update",
        toolCallId: String(update.toolCallId ?? ""),
        status,
        payload: update,
        ...(failureRaw !== undefined ? { failureReason: normalizeFailureReason(failureRaw) } : {}),
        ...b,
      };
      return ev;
    }
    case "available_commands_update": {
      const ev: CommandsChangedEvent = {
        type: "commands.changed",
        commands: Array.isArray(update.availableCommands) ? update.availableCommands : [],
        ...b,
      };
      return ev;
    }
    case "current_mode_update": {
      const ev: ModeChangedEvent = {
        type: "mode.changed",
        modeId: String(update.currentModeId ?? update.modeId ?? ""),
        ...b,
      };
      return ev;
    }
    case "config_option_update": {
      const ev: ConfigChangedEvent = { type: "config.changed", payload: update, ...b };
      return ev;
    }
    case "session_info_update": {
      return normalizeSessionInfo(sessionId, update, ctx);
    }
    default:
      return toRaw(sessionId, rawType, update, update, ctx);
  }
}

/**
 * Normalize an agent-to-client request into an event. Currently
 * `session/request_permission` becomes a `permission.requested` event; a
 * `_kiro/mcp/status` notification becomes `mcp.status`; `_kiro/workflow/*`
 * becomes `workflow.status`. Any other method maps to `raw` (the transport
 * layer separately answers unknown requests with a JSON-RPC error).
 */
export function normalizeRequest(
  sessionId: string,
  method: string,
  params: unknown,
  ctx: NormalizeContext = {},
): NormalizedEvent {
  const p = isRecord(params) ? params : {};
  const b = base(sessionId, method, p, ctx);

  if (method === "session/request_permission") {
    const toolCall = isRecord(p.toolCall) ? (p.toolCall as AnyRecord) : {};
    const options: PermissionOption[] = Array.isArray(p.options)
      ? (p.options as AnyRecord[]).filter(isRecord).map((o) => ({
          optionId: String(o.optionId ?? ""),
          name: String(o.name ?? ""),
          kind: String(o.kind ?? ""),
        }))
      : [];
    const kiro = getKiroMeta(p._meta);
    const consent = isRecord(kiro?.consent) ? (kiro.consent as AnyRecord) : undefined;
    const mcpTool = readMcpTool(p._meta);
    const ev: PermissionRequestedEvent = {
      type: "permission.requested",
      requestId: String(p.requestId ?? toolCall.toolCallId ?? ""),
      toolCallId: String(toolCall.toolCallId ?? ""),
      toolCall,
      options,
      ...(consent ? { consent } : {}),
      ...(mcpTool ? { mcpTool } : {}),
      ...b,
    };
    return ev;
  }

  if (method === "_kiro/mcp/status") {
    const ev: McpStatusEvent = {
      type: "mcp.status",
      servers: Array.isArray(p.servers) ? p.servers : [],
      ...b,
    };
    return ev;
  }

  if (method.startsWith("_kiro/workflow/")) {
    const ev: WorkflowStatusEvent = { type: "workflow.status", payload: p, ...b };
    return ev;
  }

  if (method === "_kiro/error/rate_limit") {
    const ev: TurnFailedEvent = {
      type: "turn.failed",
      failureReason: "error",
      payload: p,
      ...b,
    };
    return ev;
  }

  return toRaw(sessionId, method, params, p, ctx);
}
