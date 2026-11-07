/**
 * The Streamable HTTP transport handler mounted at /mcp on the API.
 *
 * The API's /mcp route runs core authenticate() first (so an unauthenticated
 * request already gets the 401 + resource_metadata challenge), then hands the
 * authenticated {@link Principal} and the raw JSON-RPC body here through the
 * {@link McpTransportHandler} seam. This is a STATELESS handler: each POST is a
 * single JSON-RPC request (initialize / tools/list / tools/call) answered with
 * a single JSON-RPC response. That matches the seam's {status, headers, body}
 * contract without needing Node's IncomingMessage/ServerResponse plumbing.
 *
 * Tool logic is shared with the stdio transport via {@link callTool} /
 * {@link listTools}, so there is no transport-forked behavior.
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { McpTransportHandler, McpTransportRequest } from "@nikovirtala/api";
import { type Principal, redact } from "@nikovirtala/core";
import type { ToolClient } from "./client.ts";
import {
  callTool,
  InsufficientScopeError,
  type Logger,
  listTools,
  SERVER_NAME,
  SERVER_VERSION,
  silentLogger,
} from "./server.ts";

/** Protocol version the server speaks (matches the SDK's current default). */
const PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: string | number | null | undefined, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown,
): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  });
}

async function dispatch(
  client: ToolClient,
  principal: Principal,
  rpc: JsonRpcRequest,
  logger: Logger,
): Promise<string | null> {
  switch (rpc.method) {
    case "initialize":
      return rpcResult(rpc.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    case "notifications/initialized":
    case "initialized":
      // Notifications carry no id and expect no response body.
      return null;
    case "ping":
      return rpcResult(rpc.id, {});
    case "tools/list":
      return rpcResult(rpc.id, listTools());
    case "tools/call": {
      const params = rpc.params ?? {};
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const outcome = await callTool(client, principal, name, args, logger);
        return rpcResult(rpc.id, outcome);
      } catch (err) {
        if (err instanceof InsufficientScopeError) {
          // insufficient_scope is a protocol-level error, not a tool error.
          return rpcError(rpc.id, err.code, err.message, err.data);
        }
        if (err instanceof McpError) {
          return rpcError(rpc.id, err.code, err.message, err.data);
        }
        const message = err instanceof Error ? err.message : String(err);
        return rpcError(rpc.id, ErrorCode.InternalError, redact(message));
      }
    }
    default:
      return rpcError(rpc.id, ErrorCode.MethodNotFound, `method not found: ${rpc.method}`);
  }
}

export interface HttpTransportDeps {
  client: ToolClient;
  logger?: Logger;
}

/**
 * Build the {@link McpTransportHandler} the API plugs into ApiContext.mcp. The
 * API has already authenticated the caller; we only translate JSON-RPC here.
 */
export function createHttpTransportHandler(deps: HttpTransportDeps): McpTransportHandler {
  const logger = deps.logger ?? silentLogger;
  return {
    async handle(req: McpTransportRequest) {
      const headers = { "content-type": "application/json" };

      if (req.method !== "POST") {
        // The stateless transport answers everything over POST; a GET (SSE
        // stream) is not offered here.
        return {
          status: 405,
          headers,
          body: rpcError(null, ErrorCode.ConnectionClosed, "method not allowed"),
        };
      }

      let rpc: JsonRpcRequest | JsonRpcRequest[];
      try {
        rpc = JSON.parse(req.body ?? "");
      } catch {
        return { status: 400, headers, body: rpcError(null, ErrorCode.ParseError, "parse error") };
      }

      if (Array.isArray(rpc)) {
        const responses: string[] = [];
        for (const one of rpc) {
          const out = await dispatch(deps.client, req.principal, one, logger);
          if (out !== null) {
            responses.push(out);
          }
        }
        return { status: 200, headers, body: `[${responses.join(",")}]` };
      }

      const out = await dispatch(deps.client, req.principal, rpc, logger);
      if (out === null) {
        // A notification: acknowledge with 202 and an empty body.
        return { status: 202, headers, body: "" };
      }
      return { status: 200, headers, body: out };
    },
  };
}
