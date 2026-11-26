/**
 * The Streamable HTTP transport handler mounted at /mcp on the API.
 *
 * The API's /mcp route runs core authenticate() first (so an unauthenticated
 * request already gets the 401 + resource_metadata challenge), then hands the
 * authenticated {@link Principal} and the raw JSON-RPC body here through the
 * {@link McpTransportHandler} seam. The seam is {status, headers, body}, with
 * no streaming, so this file adapts it to the SDK's web-standard handler:
 * the seam request becomes a `Request`, `createMcpHandler().fetch` answers it,
 * and the `Response` is read back into the seam's string body.
 *
 * `createMcpHandler` decides the protocol era per request: a 2026-07-28
 * request (a `MCP-Protocol-Version` header and the `_meta` envelope) is served
 * from a fresh server of the shared factory, and a 2025-era request (initialize
 * without an envelope, `2025-06-18` and earlier) goes to the stateless
 * fallback, which serves it from a fresh server of the same factory. That
 * fallback is the only legacy handling, and it is the {@link LEGACY} option
 * below: retire the 2025 era by changing it to `"reject"`.
 *
 * Tool logic is shared with the stdio transport through the server factory
 * ({@link createMcpServerFactory}), so there is no transport-forked behavior.
 */

import { createMcpHandler } from "@modelcontextprotocol/server";
import type { McpTransportHandler, McpTransportRequest } from "@nikovirtala/kiro-remote-api";
import type { Principal } from "@nikovirtala/kiro-remote-core";
import type { ToolClient } from "./client.ts";
import {
  type BuildMcpServerOptions,
  createMcpServerFactory,
  type Logger,
  silentLogger,
} from "./server.ts";

/**
 * How 2025-era traffic is served: "stateless" answers each request from a
 * fresh server (what every client of the previous hand-written handler got),
 * "reject" refuses it with the unsupported-protocol-version error. This is the
 * one place to retire the legacy era.
 */
const LEGACY = "stateless" as const;

/**
 * The origin the seam request is rebuilt on. The API Gateway host is not on
 * the seam, and the SDK does not read the URL beyond routing, so a fixed
 * placeholder keeps deployment details out of the handler.
 */
const SEAM_ORIGIN = "https://mcp.invalid";

/** The seam is request/response: it cannot hold the stream a listen request opens. */
const STREAMING_METHODS: ReadonlySet<string> = new Set(["subscriptions/listen"]);

/** The key the principal travels under in the SDK's `authInfo.extra`. */
const PRINCIPAL_KEY = "principal";

export interface HttpTransportDeps extends BuildMcpServerOptions {
  client: ToolClient;
  logger?: Logger;
}

/**
 * The seam request as a web `Request`. The previous handler answered any POST
 * with JSON whatever the Accept and Content-Type headers said, and the SDK's
 * stateless leg refuses a POST that does not accept both JSON and SSE or that
 * is not typed JSON. The seam answers one JSON body to every caller, so those
 * two headers are normalised here and a lenient caller (curl, a script) keeps
 * working; all other headers, the protocol version among them, pass unchanged.
 */
function toWebRequest(req: McpTransportRequest): Request {
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== undefined;
  const headers = {
    "content-type": "application/json",
    ...req.headers,
    accept: "application/json, text/event-stream",
  };
  return new Request(`${SEAM_ORIGIN}/mcp`, {
    method: req.method,
    headers,
    ...(hasBody ? { body: req.body as string } : {}),
  });
}

/** A JSON-RPC error answer for a request the seam refuses before the SDK sees it. */
function refusal(id: unknown, code: number, message: string) {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }),
  };
}

/** The request id and method of a JSON-RPC body, or undefined when it is not one object. */
function peek(body: string | undefined): { id?: unknown; method?: unknown } | undefined {
  try {
    const rpc = JSON.parse(body ?? "") as { id?: unknown; method?: unknown } | null;
    return rpc && typeof rpc === "object" && !Array.isArray(rpc) ? rpc : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The SDK's stateless 2025-era leg always answers over SSE: one `message` event
 * per reply. The previous handler answered plain JSON (an array for a batch),
 * so unwrap the events: clients that accept SSE (all conformant ones) read
 * either, and a lenient caller keeps its JSON. Anything else passes as is.
 * This belongs to the legacy era and goes with it.
 */
function unwrapSse(body: string): string | undefined {
  const data: string[] = [];
  for (const event of body.trim().split(/\r?\n\r?\n/)) {
    const lines = event.split(/\r?\n/);
    const payload = lines.filter((l) => l.startsWith("data:"));
    const other = lines.filter((l) => !l.startsWith("data:") && !l.startsWith("event:"));
    if (payload.length !== 1 || other.length > 0) {
      return undefined;
    }
    data.push((payload[0] ?? "").slice(5).trimStart());
  }
  if (data.length === 0) {
    return undefined;
  }
  return data.length === 1 ? data[0] : `[${data.join(",")}]`;
}

/**
 * Build the {@link McpTransportHandler} the API plugs into ApiContext.mcp. The
 * API has already authenticated the caller; we only hand the request to the SDK.
 */
export function createHttpTransportHandler(deps: HttpTransportDeps): McpTransportHandler {
  const logger = deps.logger ?? silentLogger;
  const handler = createMcpHandler(
    createMcpServerFactory({
      client: deps.client,
      logger,
      ...(deps.instructions !== undefined ? { instructions: deps.instructions } : {}),
      ...(deps.attach ? { attach: deps.attach } : {}),
      principal: (ctx) => ctx.authInfo?.extra?.[PRINCIPAL_KEY] as Principal,
    }),
    {
      legacy: LEGACY,
      // "auto" answers one JSON body unless a handler emits a message before
      // its result, which ours never does; "json" would drop such messages.
      onerror: (err) => logger.error("mcp handler error", { message: err.message }),
    },
  );

  return {
    async handle(req: McpTransportRequest) {
      const rpc = peek(req.body);
      if (typeof rpc?.method === "string" && STREAMING_METHODS.has(rpc.method)) {
        return refusal(rpc.id, -32601, `${rpc.method} is not available on this endpoint`);
      }
      const response = await handler.fetch(toWebRequest(req), {
        // No token is carried: the API verified it already.
        authInfo: {
          token: "",
          clientId: req.principal.clientId,
          scopes: req.principal.scopes,
          extra: { [PRINCIPAL_KEY]: req.principal },
        },
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const text = await response.text();
      if (headers["content-type"]?.startsWith("text/event-stream")) {
        const json = unwrapSse(text);
        if (json !== undefined) {
          return {
            status: response.status,
            headers: { "content-type": "application/json" },
            body: json,
          };
        }
      }
      return { status: response.status, headers, body: text };
    },
  };
}
