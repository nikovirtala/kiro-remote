/**
 * The /mcp Streamable HTTP route seam AND the single canonical
 * {@link KiroRemoteClient} interface.
 *
 * FEAT-005 owns the transport boundary: the /mcp route is authenticated with
 * core's authenticate() (so an unauthenticated request gets the exact 401 with
 * the WWW-Authenticate resource_metadata challenge and /mcp is a proper RFC
 * 9728 protected resource), and a clean, single entry point is exposed for
 * FEAT-006 to plug in the MCP server implementation.
 *
 * FEAT-006 implements the MCP server over the ONE {@link KiroRemoteClient}
 * interface defined here. There is exactly one definition of this interface in
 * the whole workspace -- it lives in this seam file and @kiro-remote/mcp
 * imports it, so the in-process variant (which calls the core service
 * directly, no self-HTTP) and the HTTP variant (which calls the REST API with
 * the user's bearer token) share an identical contract and the MCP tools never
 * branch on transport.
 *
 * Why the interface lives here and not in @kiro-remote/mcp: @kiro-remote/mcp
 * depends on @kiro-remote/api for the {@link McpTransportHandler} seam types,
 * so the dependency edge is mcp -> api. Putting the client interface here keeps
 * that edge acyclic while still letting FEAT-006 build both implementations
 * against the single canonical definition.
 *
 * FEAT-006 provides an {@link McpTransportHandler} to {@link ApiContext.mcp};
 * until then the route authenticates and returns 501 capability-unavailable so
 * the contract (auth boundary + protected-resource advertisement) is testable.
 */

import type { Action, Principal, Resource } from "@kiro-remote/core";

/* -------------------------------------------------------------------------- */
/* Plain data shapes the client returns (transport-agnostic)                  */
/* -------------------------------------------------------------------------- */

/** A session row as the MCP tools and REST API expose it. */
export interface ClientSession {
  id: string;
  kiroSessionId: string | null;
  title: string | null;
  repos: string[];
  mode: string | null;
  model: string | null;
  effort: string | null;
  status: string;
  activeTurnId: string | null;
  eventSeq: number;
  createdAt: string;
  updatedAt: string;
}

/** A single normalized event row. */
export interface ClientEvent {
  seq: number;
  sessionId: string;
  turnId: string | null;
  type: string;
  rawType: string;
  replay: boolean;
  ts: string;
  payload: unknown;
}

/** The result of an events read: the rows plus the long-poll cursor state. */
export interface ClientEventsPage {
  events: ClientEvent[];
  nextCursor: number;
  turnStatus: string | null;
}

/** A turn row. */
export interface ClientTurn {
  id: string;
  sessionId: string;
  status: string;
  stopReason: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

/** A permission request row. */
export interface ClientPermission {
  requestId: string;
  toolCallId: string;
  toolCall: Record<string, unknown>;
  options: unknown[];
  consent: Record<string, unknown> | null;
  status: string;
  answer: Record<string, unknown> | null;
}

/** The server's advertised capabilities snapshot. */
export interface ClientCapabilities {
  capabilities: Record<string, unknown>;
  kiroCliVersion: string | null;
  activeSessionCount: number;
}

/**
 * The single client interface the MCP server (FEAT-006) is written against.
 * The in-process variant (used by the /mcp Streamable HTTP transport mounted in
 * the API) calls the core service directly; the HTTP variant (used by the
 * stdio CLI) calls the REST API over HTTP with the user's bearer token. Only
 * the method SHAPES are fixed here.
 *
 * Every method takes the authenticated {@link Principal} so authorize() runs
 * with the caller's scopes exactly as it does for the REST routes.
 */
export interface KiroRemoteClient {
  capabilities(principal: Principal): Promise<ClientCapabilities>;

  listModels(principal: Principal): Promise<{ models: string[]; source: string | null }>;

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
  ): Promise<{ sessions: ClientSession[]; cursor?: string }>;

  getSession(principal: Principal, sessionId: string): Promise<ClientSession>;

  deleteSession(principal: Principal, sessionId: string): Promise<void>;

  createTurn(
    principal: Principal,
    sessionId: string,
    args: { prompt: string; whenBusy: "steer" | "queue" | "reject" },
  ): Promise<ClientTurn>;

  getEvents(
    principal: Principal,
    sessionId: string,
    args: { after: number; wait: number; types?: string[] },
  ): Promise<ClientEventsPage>;

  listPermissions(
    principal: Principal,
    sessionId: string,
    args: { status?: string },
  ): Promise<{ permissions: ClientPermission[] }>;

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
