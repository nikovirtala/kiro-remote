/**
 * The OAuth 2.1 authorization-code + PKCE login flow for the `kiro-remote` CLI,
 * run against the @nikovirtala/kiro-remote-auth facade.
 *
 * Flow:
 *   1. Fetch the CLI's own CIMD document from
 *      https://<host>/oauth/clients/cli.json. Its `client_id` is that URL; it
 *      declares a loopback redirect and S256 PKCE.
 *   2. Generate a PKCE verifier/challenge and a random state.
 *   3. Start a loopback HTTP server on an EPHEMERAL port and build the
 *      authorization URL with redirect_uri http://127.0.0.1:<port>/callback.
 *   4. Open the authorization URL in the browser and wait for the facade to
 *      redirect back to the loopback with ?code&state.
 *   5. Verify state, then exchange the code at /oauth/token (sending the PKCE
 *      verifier). Return the Cognito token set UNCHANGED.
 *
 * NEVER logs the authorization URL, the code, the verifier, state, or any
 * token. The browser-open and loopback steps are injected so the flow is
 * fully testable offline against a fake facade (no real network, no browser).
 */

import {
  generateCodeVerifier,
  generateOpaqueToken,
  s256Challenge,
} from "@nikovirtala/kiro-remote-auth";

/** The subset of the CIMD document the CLI needs. */
export interface CliClientMetadata {
  client_id: string;
  redirect_uris: string[];
  code_challenge_methods_supported?: string[];
}

/** A Cognito token set as returned by /oauth/token (unchanged). */
export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

/** Minimal fetch used by the flow (JSON GET + form POST). */
export type OAuthFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; text(): Promise<string> }>;

/**
 * Drives the browser + loopback roundtrip: given the authorization URL and the
 * expected `state`, returns the authorization `code` the facade redirected
 * back with. The default production implementation starts a loopback server
 * and opens a browser; tests inject a fake that returns a code directly.
 */
export type AuthorizationRoundtrip = (args: {
  /** Build the authorization URL from the chosen redirect_uri. */
  authorizeUrl: (redirectUri: string) => string;
  /** The loopback redirect base (scheme+host) WITHOUT a port. */
  loopbackHost: string;
  /** The expected state to validate on the callback. */
  state: string;
}) => Promise<{ code: string; redirectUri: string }>;

export interface LoginDeps {
  /** Facade public base URL WITHOUT trailing slash, e.g. https://host. */
  baseUrl: string;
  fetch: OAuthFetch;
  roundtrip: AuthorizationRoundtrip;
  /** Loopback host for the redirect; defaults to http://127.0.0.1. */
  loopbackHost?: string;
}

/** Raised when the OAuth flow fails. Messages never contain secrets. */
export class OAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthError";
  }
}

/** The result of a successful login (tokens + metadata needed to refresh). */
export interface LoginResult {
  tokens: TokenSet;
  clientId: string;
  tokenEndpoint: string;
}

/** Run the authorization-code + PKCE login flow. Returns the Cognito tokens. */
export async function login(deps: LoginDeps): Promise<LoginResult> {
  const base = deps.baseUrl.replace(/\/+$/, "");
  const loopbackHost = deps.loopbackHost ?? "http://127.0.0.1";
  const cliMetadataUrl = `${base}/oauth/clients/cli.json`;
  const authorizeEndpoint = `${base}/oauth/authorize`;
  const tokenEndpoint = `${base}/oauth/token`;
  // The RFC 8707 resource indicator: the RFC 9728 canonical MCP resource, which
  // the facade's /oauth/authorize requires and matches against mcpResource.
  const resource = `${base}/mcp`;

  // 1. CIMD document. client_id is the document URL itself.
  const cimdRes = await deps.fetch(cliMetadataUrl, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  if (cimdRes.status < 200 || cimdRes.status >= 300) {
    throw new OAuthError("failed to fetch CLI client metadata");
  }
  const cimd = JSON.parse(await cimdRes.text()) as CliClientMetadata;
  const clientId = cimd.client_id;
  if (!clientId) {
    throw new OAuthError("CLI client metadata is missing client_id");
  }

  // 2. PKCE + state.
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = s256Challenge(codeVerifier);
  const state = generateOpaqueToken();

  // The CLI is a full-access personal client: request openid PLUS the three
  // fully-qualified resource-server scopes the REST API requires (reads need
  // sessions:read, writes sessions:write, delete sessions:delete). Cognito
  // prefixes resource-server scopes with the resource identifier, so these
  // match the facade app client's AllowedOAuthScopes. Without them the issued
  // access token carries only openid and every /v1 call returns 403.
  const scope = [
    "openid",
    `${resource}/sessions:read`,
    `${resource}/sessions:write`,
    `${resource}/sessions:delete`,
  ].join(" ");

  // 3 + 4. Loopback roundtrip returns the code and the exact redirect_uri used.
  const authorizeUrl = (redirectUri: string): string => {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      scope,
      resource,
    });
    return `${authorizeEndpoint}?${params.toString()}`;
  };

  const { code, redirectUri } = await deps.roundtrip({ authorizeUrl, loopbackHost, state });
  if (!code) {
    throw new OAuthError("authorization did not return a code");
  }

  // 5. Token exchange with the PKCE verifier.
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: codeVerifier,
    client_id: clientId,
    redirect_uri: redirectUri,
  });
  const tokenRes = await deps.fetch(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form.toString(),
  });
  const tokenBody = await tokenRes.text();
  if (tokenRes.status < 200 || tokenRes.status >= 300) {
    throw new OAuthError("token exchange failed");
  }
  const tokens = JSON.parse(tokenBody) as TokenSet;
  if (!tokens.access_token) {
    throw new OAuthError("token response is missing an access token");
  }

  return { tokens, clientId, tokenEndpoint };
}

/** Refresh an access token using a refresh token at /oauth/token. */
export async function refresh(deps: {
  fetch: OAuthFetch;
  tokenEndpoint: string;
  clientId: string;
  refreshToken: string;
}): Promise<TokenSet> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: deps.refreshToken,
    client_id: deps.clientId,
  });
  const res = await deps.fetch(deps.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form.toString(),
  });
  const body = await res.text();
  if (res.status < 200 || res.status >= 300) {
    throw new OAuthError("token refresh failed");
  }
  const tokens = JSON.parse(body) as TokenSet;
  if (!tokens.access_token) {
    throw new OAuthError("refresh response is missing an access token");
  }
  return tokens;
}

/** Revoke a refresh token at /oauth/revoke. */
export async function revoke(deps: {
  fetch: OAuthFetch;
  baseUrl: string;
  token: string;
}): Promise<void> {
  const base = deps.baseUrl.replace(/\/+$/, "");
  const form = new URLSearchParams({ token: deps.token, token_type_hint: "refresh_token" });
  await deps.fetch(`${base}/oauth/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}
