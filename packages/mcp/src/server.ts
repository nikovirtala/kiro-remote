/**
 * The MCP request dispatch shared by BOTH transports.
 *
 * This is the single place tool calls are authorized and executed, so the
 * Streamable HTTP transport (in the API) and the stdio transport (in the CLI)
 * behave identically. It also builds the one official
 * @modelcontextprotocol/server {@link McpServer} both transports serve.
 *
 * Authorization contract (MCP auth spec): a tool call whose required scope the
 * caller lacks returns the OAuth `insufficient_scope` error, NOT a generic tool
 * error. We surface it as a JSON-RPC error carrying `error` = "insufficient_scope"
 * and the needed scope in `data`, which is distinct from a tool that merely
 * failed (that returns a result with `isError: true`). All logging through
 * core's redact.
 */

import {
  type McpRequestContext,
  McpServer,
  type McpServerFactory,
  type McpServerOptions,
  ProtocolError,
  ProtocolErrorCode,
} from "@modelcontextprotocol/server";
import { ForbiddenError, type Principal, redact } from "@nikovirtala/kiro-remote-core";
import type { ToolClient } from "./client.ts";
import { loadExtensions, type McpExtension } from "./extensions.ts";
import { INSTRUCTIONS } from "./instructions.ts";
import { type Logger, redactingLogger, silentLogger } from "./logger.ts";
import { authorizeTool, findTool, type ToolResult, toolListEntries } from "./tools.ts";

export { type Logger, redactingLogger, silentLogger };

export const SERVER_NAME = "kiro-remote";
export const SERVER_VERSION = "0.0.0";

/**
 * A ProtocolError subtype that carries the OAuth `insufficient_scope` error so the
 * JSON-RPC error payload is distinguishable from a generic tool failure.
 */
export class InsufficientScopeError extends ProtocolError {
  constructor(neededScope?: string) {
    super(ProtocolErrorCode.InvalidRequest, "insufficient_scope", {
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
    throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `unknown tool: ${name}`);
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

/** What {@link buildMcpServer} adds on top of the tools: instructions and extensions. */
export interface BuildMcpServerOptions {
  /** Shown to clients in `initialize` and `server/discover`. */
  instructions?: string;
  /** Attached to the new server, in order, before it is connected. */
  extensions?: readonly McpExtension[];
}

/**
 * Build the SDK {@link McpServer} wired to the given client and a resolver for
 * the authenticated principal. This is the one server both transports serve:
 * stdio through serveStdio and /mcp through createMcpHandler, each calling it
 * once per connection or request. `tools/list` and `tools/call` are handled
 * here from tools.ts (not through registerTool) so the advertised schemas stay
 * exactly the ones the OpenAPI generator's twin produces.
 */
export function buildMcpServer(
  client: ToolClient,
  getPrincipal: () => Principal,
  logger: Logger = silentLogger,
  options: BuildMcpServerOptions = {},
): McpServer {
  const serverOptions: McpServerOptions = {
    // Neither transport can push a list change (the HTTP seam has no stream), so say so.
    capabilities: { tools: { listChanged: false } },
    ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
  };
  const mcp = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, serverOptions);

  // The entries are plain JSON; the SDK result type wants `type: "object"` spelled out.
  mcp.server.setRequestHandler("tools/list", async () => listTools() as never);

  mcp.server.setRequestHandler("tools/call", async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    // CallToolOutcome is a structurally-valid CallToolResult.
    return (await callTool(client, getPrincipal(), name, args, logger)) as never;
  });

  for (const extension of options.extensions ?? []) {
    extension.attach(mcp);
  }
  // An extension that serves resources declares that their list can change. No
  // transport can push that (the HTTP seam has no stream), so say it does not.
  if (mcp.server.getCapabilities().resources) {
    mcp.server.registerCapabilities({ resources: { listChanged: false } });
  }
  return mcp;
}

/** What {@link createMcpServerFactory} needs. */
export interface McpServerFactoryDeps {
  client: ToolClient;
  logger?: Logger;
  /** The caller of the exchange the new server will serve. */
  principal: (ctx: McpRequestContext) => Principal;
  /** Replaces the instructions every server carries (tests). */
  instructions?: string;
  /** Replaces the extensions every server carries (tests). */
  extensions?: () => Promise<readonly McpExtension[]>;
}

/**
 * The factory both serving entries call: createMcpHandler once per HTTP
 * request, serveStdio once per connection. The same factory serves every
 * protocol era, so tools, instructions and extensions are defined once, here.
 */
export function createMcpServerFactory(deps: McpServerFactoryDeps): McpServerFactory {
  return async (ctx) =>
    buildMcpServer(deps.client, () => deps.principal(ctx), deps.logger ?? silentLogger, {
      instructions: deps.instructions ?? INSTRUCTIONS,
      extensions: await (deps.extensions ?? loadExtensions)(),
    });
}
