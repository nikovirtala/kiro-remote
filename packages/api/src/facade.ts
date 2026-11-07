/**
 * Mount the @nikovirtala/kiro-remote-auth OAuth facade handlers on THIS API with NO
 * authentication. These endpoints are the OAuth 2.1 Cognito facade the MCP
 * clients talk to before they ever hold a token, so they must be reachable
 * unauthenticated:
 *
 *   GET  /.well-known/oauth-protected-resource/mcp
 *   GET  /.well-known/oauth-authorization-server
 *   GET  /oauth/authorize
 *   GET  /oauth/callback
 *   POST /oauth/token
 *   POST /oauth/revoke
 *   GET  /oauth/clients/cli.json
 *
 * The handlers are pure functions of (FacadeRequest, deps); this adapter just
 * translates the API's {@link HttpRequest} to a {@link FacadeRequest} and back.
 */

import {
  type FacadeResponse,
  handleAuthorizationServerMetadata,
  handleAuthorize,
  handleCallback,
  handleCliClientMetadata,
  handleProtectedResourceMetadata,
  handleRevoke,
  handleToken,
} from "@nikovirtala/kiro-remote-auth";
import type { ApiContext } from "./context.ts";
import type { HttpRequest, HttpResponse } from "./http.ts";

/** Facade paths that must be served WITHOUT authentication. */
const FACADE_PATHS = new Set([
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/oauth/authorize",
  "/oauth/callback",
  "/oauth/token",
  "/oauth/revoke",
  "/oauth/clients/cli.json",
]);

/** True when the request targets an unauthenticated facade endpoint. */
export function isFacadePath(path: string): boolean {
  return FACADE_PATHS.has(path);
}

function toFacadeResponse(r: FacadeResponse): HttpResponse {
  return { status: r.status, headers: r.headers, body: r.body };
}

/** Dispatch a facade request. Returns null when the path is not a facade path. */
export async function dispatchFacade(
  ctx: ApiContext,
  req: HttpRequest,
): Promise<HttpResponse | null> {
  const facadeReq = {
    method: req.method,
    path: req.path,
    query: req.query,
    headers: req.headers,
    ...(req.body !== undefined ? { body: req.body } : {}),
  };
  const { facade } = ctx;

  if (req.path === "/.well-known/oauth-protected-resource/mcp" && req.method === "GET") {
    return toFacadeResponse(handleProtectedResourceMetadata(facade.config));
  }
  if (req.path === "/.well-known/oauth-authorization-server" && req.method === "GET") {
    return toFacadeResponse(handleAuthorizationServerMetadata(facade.config));
  }
  if (req.path === "/oauth/clients/cli.json" && req.method === "GET") {
    return toFacadeResponse(handleCliClientMetadata(facade.config));
  }
  if (req.path === "/oauth/authorize" && req.method === "GET") {
    return toFacadeResponse(await handleAuthorize(facadeReq, facade.authorize));
  }
  if (req.path === "/oauth/callback" && req.method === "GET") {
    return toFacadeResponse(await handleCallback(facadeReq, facade.callback));
  }
  if (req.path === "/oauth/token" && req.method === "POST") {
    return toFacadeResponse(await handleToken(facadeReq, facade.token));
  }
  if (req.path === "/oauth/revoke" && req.method === "POST") {
    return toFacadeResponse(await handleRevoke(facadeReq, facade.revoke));
  }

  return null;
}
