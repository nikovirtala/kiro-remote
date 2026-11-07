/**
 * The MCP request dispatch shared by BOTH transports.
 *
 * This is the single place tool calls are authorized and executed, so the
 * Streamable HTTP transport (in the API) and the stdio transport (in the CLI)
 * behave identically. It also builds the official @modelcontextprotocol/sdk
 * {@link Server} for the stdio transport.
 *
 * Authorization contract (MCP auth spec): a tool call whose required scope the
 * caller lacks returns the OAuth `insufficient_scope` error, NOT a generic tool
 * error. We surface it as a JSON-RPC error carrying `error` = "insufficient_scope"
 * and the needed scope in `data`, which is distinct from a tool that merely
 * failed (that returns a result with `isError: true`). All logging through
 * core's redact.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { ForbiddenError, type Principal, redact } from "@nikovirtala/kiro-remote-core";
import type { ToolClient } from "./client.ts";
import { authorizeTool, findTool, type ToolResult, toolListEntries } from "./tools.ts";

export const SERVER_NAME = "kiro-remote";
export const SERVER_VERSION = "0.0.0";

/** Minimal logger surface; defaults to a redaction-safe console logger. */
export interface Logger {
  info(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

/** A logger that routes every message and meta object through core's redact. */
export const redactingLogger: Logger = {
  info(message, meta) {
    if (meta !== undefined) {
      console.error(redact(message), redact(meta));
    } else {
      console.error(redact(message));
    }
  },
  error(message, meta) {
    if (meta !== undefined) {
      console.error(redact(message), redact(meta));
    } else {
      console.error(redact(message));
    }
  },
};

/** A logger that drops everything (used in tests). */
export const silentLogger: Logger = { info() {}, error() {} };

/**
 * An McpError subtype that carries the OAuth `insufficient_scope` error so the
 * JSON-RPC error payload is distinguishable from a generic tool failure.
 */
export class InsufficientScopeError extends McpError {
  constructor(neededScope?: string) {
    super(ErrorCode.InvalidRequest, "insufficient_scope", {
      error: "insufficient_scope",
      ...(neededScope ? { scope: neededScope } : {}),
    });
    this.name = "InsufficientScopeError";
  }
}

/** The result of a tools/call: a structured content result. */
export interface CallToolOutcome {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: ToolResult;
  isError?: boolean;
}

/**
 * Authorize + execute a single tool call. Throws {@link InsufficientScopeError}
 * when the caller lacks the tool's scope (per the MCP auth spec); a tool that
 * runs but fails returns an outcome with `isError: true` instead.
 */
export async function callTool(
  client: ToolClient,
  principal: Principal,
  name: string,
  args: Record<string, unknown>,
  logger: Logger = silentLogger,
): Promise<CallToolOutcome> {
  const def = findTool(name);
  if (!def) {
    throw new McpError(ErrorCode.MethodNotFound, `unknown tool: ${name}`);
  }

  // Scope gating FIRST: a missing scope is insufficient_scope, never a tool error.
  try {
    authorizeTool(def, principal);
  } catch (err) {
    if (err instanceof ForbiddenError) {
      throw new InsufficientScopeError(err.neededScope);
    }
    throw err;
  }

  try {
    const result = await def.run(client, principal, args);
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    };
  } catch (err) {
    // A genuine execution failure -> a tool result flagged isError, so the
    // calling agent sees it as a tool outcome, not a protocol-level error.
    const message = err instanceof Error ? err.message : String(err);
    logger.error("tool execution failed", { tool: name, message });
    return {
      content: [{ type: "text", text: redact(message) }],
      isError: true,
    };
  }
}

/** The list of tools advertised to clients (name + schema + annotations). */
export function listTools() {
  return { tools: toolListEntries() };
}

/**
 * Build the official SDK {@link Server} wired to the given client and a
 * resolver for the authenticated principal. The stdio transport drives this
 * server directly. The HTTP transport uses {@link callTool}/{@link listTools}
 * via the stateless handler, so both paths share identical tool logic.
 */
export function buildMcpServer(
  client: ToolClient,
  getPrincipal: () => Principal,
  logger: Logger = silentLogger,
): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => listTools());

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const outcome = await callTool(client, getPrincipal(), name, args, logger);
    // CallToolOutcome is a structurally-valid CallToolResult; the SDK's result
    // type carries extra optional task fields we do not use.
    return outcome as unknown as Record<string, unknown>;
  });

  return server;
}
