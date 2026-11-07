/**
 * The /mcp Streamable HTTP route seam.
 *
 * FEAT-005 owns ONLY the transport boundary: the route is authenticated with
 * core's authenticate() (so an unauthenticated request gets the exact 401 with
 * the WWW-Authenticate resource_metadata challenge and /mcp is a proper RFC
 * 9728 protected resource), and a clean, single entry point is exposed for
 * FEAT-006 to plug in the MCP server implementation.
 *
 * FEAT-006 implements the MCP server over ONE {@link KiroRemoteClient}
 * interface. The in-process variant of that client simply calls the same core
 * service functions this API already uses (no self-HTTP round trip). FEAT-006
 * provides an {@link McpTransportHandler} to {@link ApiContext.mcp}; until then
 * the route authenticates and returns 501 capability-unavailable so the
 * contract (auth boundary + protected-resource advertisement) is testable now.
 */

import type { Action, Principal, Resource } from "@kiro-remote/core";

/**
 * The single client interface the MCP server (FEAT-006) is written against.
 * The API provides the in-process-service variant; a remote variant could call
 * the REST API over HTTP. Only the method SHAPES are fixed here so FEAT-006 can
 * depend on this seam without importing the Lambda internals.
 *
 * Every method takes the authenticated {@link Principal} so authorize() runs
 * with the caller's scopes exactly as it does for the REST routes.
 */
export interface KiroRemoteClient {
  launchSession(
    principal: Principal,
    args: {
      prompt: string;
      repos: string[];
      title?: string;
      mode?: string;
      model?: string;
      effort?: string;
    },
  ): Promise<{ sessionId: string; turnId: string | null }>;

  adoptSession(
    principal: Principal,
    args: { kiroSessionId: string },
  ): Promise<{ sessionId: string }>;

  listSessions(
    principal: Principal,
    args: { limit: number; cursor?: string; status?: string },
  ): Promise<unknown>;

  getSession(principal: Principal, sessionId: string): Promise<unknown>;

  deleteSession(principal: Principal, sessionId: string): Promise<void>;

  createTurn(
    principal: Principal,
    sessionId: string,
    args: { prompt: string; whenBusy: "steer" | "queue" | "reject" },
  ): Promise<{ turnId: string }>;

  getEvents(
    principal: Principal,
    sessionId: string,
    args: { after: number; wait: number; types?: string[] },
  ): Promise<unknown>;

  cancelTurn(principal: Principal, sessionId: string): Promise<void>;

  answerPermission(
    principal: Principal,
    sessionId: string,
    requestId: string,
    args: { optionId: string; consent?: Record<string, unknown> },
  ): Promise<void>;

  setConfig(
    principal: Principal,
    sessionId: string,
    args: { model?: string; effort?: string; mode?: string },
  ): Promise<void>;
}

/** The request context handed to the MCP transport handler by the router. */
export interface McpTransportRequest {
  /** The authenticated caller (authenticate() already ran). */
  principal: Principal;
  /** HTTP method of the /mcp request. */
  method: string;
  /** Lower-cased request headers. */
  headers: Record<string, string>;
  /** Raw request body (JSON-RPC payload for Streamable HTTP). */
  body?: string;
}

/** The transport handler FEAT-006 registers on {@link ApiContext.mcp}. */
export interface McpTransportHandler {
  handle(req: McpTransportRequest): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }>;
}

/** Re-exported for the client variant FEAT-006 builds against the service. */
export type { Action, Resource };
