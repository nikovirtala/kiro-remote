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
 *   POST /oauth/register
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
  handleRegister,
  handleRevoke,
  handleToken,
  parseForm,
} from "@nikovirtala/kiro-remote-auth";
import type { ApiContext } from "./context.ts";
import type { HttpRequest, HttpResponse } from "./http.ts";

/** Facade paths that must be served WITHOUT authentication. */
const FACADE_PATHS = new Set([
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/oauth/authorize",
  "/oauth/callback",
  "/oauth/register",
  "/oauth/token",
  "/oauth/revoke",
  "/oauth/clients/cli.json",
]);

/**
 * GET /passkeys/add: redirect to the Cognito managed-login passkey registration
 * page, which needs the facade client id and callback as query parameters.
 * The invitation email links here because the client id cannot be embedded in
 * the user pool's invitation template (the app client depends on the pool).
 */
export const PASSKEY_ADD_PATH = "/passkeys/add";

/** True when the request targets an unauthenticated passkey-add redirect. */
export function isPasskeyAddPath(path: string): boolean {
  return path === PASSKEY_ADD_PATH;
}

/** Build the Cognito managed-login passkey add URL. */
export function passkeyAddUrl(ctx: ApiContext): string {
  const { cognitoDomain, cognitoClientId, publicBaseUrl } = ctx.facade.config;
  const q = new URLSearchParams({
    client_id: cognitoClientId,
    redirect_uri: `${publicBaseUrl.replace(/\/+$/, "")}/oauth/callback`,
  });
  return `${cognitoDomain.replace(/\/+$/, "")}/passkeys/add?${q.toString()}`;
}

/** True when the request targets an unauthenticated facade endpoint. */
export function isFacadePath(path: string): boolean {
  return FACADE_PATHS.has(path);
}

/**
 * Convert the pure handler's {@link FacadeResponse} to the API's
 * {@link HttpResponse}, DROPPING the optional non-secret `logContext`
 * breadcrumb (it is for server-side logging only and never goes on the wire).
 */
function toFacadeResponse(r: FacadeResponse): HttpResponse {
  return { status: r.status, headers: r.headers, body: r.body };
}

/**
 * Log a 4xx OAuth control-flow rejection server-side so the facade shows WHICH
 * validation failed (the pure auth handlers carry no logger). The RFC 6749
 * `error` / `error_description` are non-secret OAuth error codes, and the obs
 * facade still runs every attribute through core's redact. We log ONLY 4xx:
 * 2xx is a success and 5xx is already error-logged by the router.
 */
function logOauthRejection(
  ctx: ApiContext,
  event: string,
  res: HttpResponse | FacadeResponse,
): void {
  if (res.status < 400 || res.status >= 500) {
    return;
  }
  let error: string | undefined;
  let errorDescription: string | undefined;
  if (typeof res.body === "string" && res.body.length > 0) {
    try {
      const parsed = JSON.parse(res.body) as { error?: unknown; error_description?: unknown };
      if (typeof parsed.error === "string") {
        error = parsed.error;
      }
      if (typeof parsed.error_description === "string") {
        errorDescription = parsed.error_description;
      }
    } catch {
      // Non-JSON body (e.g. an HTML error page); log the status alone.
    }
  }
  ctx.obs.warn(event, {
    status: res.status,
    ...(error ? { error } : {}),
    ...(errorDescription ? { error_description: errorDescription } : {}),
  });
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
    const facadeRes = await handleAuthorize(facadeReq, facade.authorize);
    const res = toFacadeResponse(facadeRes);
    ctx.obs.info("oauth_authorize", { status: res.status, ...(facadeRes.logContext ?? {}) });
    logOauthRejection(ctx, "oauth_authorize_rejected", res);
    return res;
  }
  if (req.path === "/oauth/callback" && req.method === "GET") {
    const facadeRes = await handleCallback(facadeReq, facade.callback);
    const res = toFacadeResponse(facadeRes);
    ctx.obs.info("oauth_callback", { status: res.status, ...(facadeRes.logContext ?? {}) });
    logOauthRejection(ctx, "oauth_callback_rejected", res);
    return res;
  }
  if (req.path === "/oauth/register" && req.method === "POST") {
    const res = toFacadeResponse(await handleRegister(facadeReq, facade.register));
    logOauthRejection(ctx, "oauth_register_rejected", res);
    return res;
  }
  if (req.path === "/oauth/token" && req.method === "POST") {
    const res = toFacadeResponse(await handleToken(facadeReq, facade.token));
    // grant_type is a non-secret OAuth parameter; success is derived from the
    // status. We NEVER log the code, code_verifier, refresh_token, or the token
    // set (all of which also route through redact() if they ever appeared).
    const grantType = parseForm(req.body).grant_type ?? "";
    ctx.obs.info("oauth_token", {
      grant_type: grantType,
      status: res.status,
      success: res.status < 400,
    });
    logOauthRejection(ctx, "oauth_token_rejected", res);
    return res;
  }
  if (req.path === "/oauth/revoke" && req.method === "POST") {
    return toFacadeResponse(await handleRevoke(facadeReq, facade.revoke));
  }

  return null;
}
