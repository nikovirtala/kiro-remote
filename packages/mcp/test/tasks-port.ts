/**
 * A session port for @modelcontextprotocol/ext-tasks/client that talks to this
 * server, so the tests drive it with the extension's own requester (not with
 * requests written by hand next to the server code).
 *
 * The requester builds the task requests; the port only frames them the way a
 * 2026-07-28 client does (the `_meta` envelope and the Mcp-* routing headers)
 * and carries them over one of the two transports.
 */

import type {
  ConnectedMcpSessionPort,
  JsonRpcResponse,
} from "@modelcontextprotocol/ext-tasks/client";
import type { McpTransportHandler } from "@nikovirtala/kiro-remote-api";
import type { Principal } from "@nikovirtala/kiro-remote-core";

type Json = Record<string, unknown>;

const PROTOCOL = "2026-07-28";

/** Add the envelope a 2026-07-28 request carries. */
function frame(request: Json): Json {
  const params = (request.params ?? {}) as Json;
  const meta = (params._meta ?? {}) as Json;
  return {
    ...request,
    params: {
      ...params,
      _meta: {
        ...meta,
        "io.modelcontextprotocol/protocolVersion": PROTOCOL,
        "io.modelcontextprotocol/clientInfo": { name: "ext-tasks-requester", version: "0.0.0" },
        // The requester declares the Tasks extension itself, in the request's own `_meta`.
        "io.modelcontextprotocol/clientCapabilities":
          meta["io.modelcontextprotocol/clientCapabilities"] ?? {},
      },
    },
  };
}

function toResponse(json: Json): JsonRpcResponse {
  return json.error
    ? { kind: "error", error: json.error as never }
    : { kind: "result", result: json.result as never };
}

const idle = (): (() => void) => () => {};

function portOf(
  send: (message: Json, headers: Record<string, string>) => Promise<Json>,
): ConnectedMcpSessionPort {
  let nextId = 0;
  return {
    endpointId: "kiro-remote-test",
    taskCapabilities: { generation: "v2", capabilities: {} },
    async dispatch(request) {
      const message = {
        jsonrpc: "2.0",
        id: ++nextId,
        ...frame(request as Json),
      };
      const params = message.params as Json;
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "mcp-protocol-version": PROTOCOL,
        "mcp-method": String(message.method),
        ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
        ...(typeof params.taskId === "string" ? { "mcp-name": params.taskId } : {}),
      };
      return toResponse(await send(message, headers));
    },
    onServerRequest: idle,
    onNotification: idle,
    onInvalidated: idle,
    invalidated: false,
  };
}

/** Over the /mcp handler, as the API router calls it. */
export function httpPort(handler: McpTransportHandler, who: Principal): ConnectedMcpSessionPort {
  return portOf(async (message, headers) => {
    const res = await handler.handle({
      principal: who,
      method: "POST",
      headers,
      body: JSON.stringify(message),
    });
    return JSON.parse(res.body) as Json;
  });
}

/** Over a stdio-style message pipe: `ask` sends one message and resolves its answer. */
export function pipePort(ask: (message: Json) => Promise<Json>): ConnectedMcpSessionPort {
  return portOf((message) => ask(message));
}
