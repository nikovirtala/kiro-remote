/**
 * GET /oauth/authorize.
 *
 * Validates the downstream client's authorization request, resolves the client
 * (CIMD URL or pre-registered), enforces exact redirect_uri + S256 PKCE,
 * defaults a missing RFC 8707 `resource` to the facade's sole MCP resource (and
 * rejects a present-but-mismatched one), stores an OAUTH#TX item (10 min TTL) carrying the
 * client's challenge AND the facade's OWN upstream PKCE verifier/state, then
 * redirects the user-agent to Cognito managed login.
 *
 * Errors that occur BEFORE redirect_uri is validated render an error page and
 * never redirect (open-redirection mitigation). Errors AFTER validation
 * redirect back to the client with ?error=... per OAuth 2.1.
 */

import type { Repository } from "@nikovirtala/kiro-remote-core";
import { CimdError } from "./cimd.ts";
import { type ClientResolver, redirectUriAllowed } from "./clients.ts";
import type { FacadeConfig } from "./config.ts";
import { generateCodeVerifier, generateOpaqueToken, s256Challenge } from "./pkce.ts";
import {
  errorPageResponse,
  type FacadeRequest,
  type FacadeResponse,
  redirectResponse,
} from "./types.ts";

export interface AuthorizeDeps {
  config: FacadeConfig;
  repo: Repository;
  clients: ClientResolver;
  /** Injectable id/secret generators for deterministic tests. */
  generateTxId?: () => string;
  generateState?: () => string;
  generateVerifier?: () => string;
}

/** The data persisted in the OAUTH#TX item. */
export interface AuthorizeTxData {
  clientId: string;
  redirectUri: string;
  clientState: string | null;
  clientCodeChallenge: string;
  /**
   * The EFFECTIVE upstream scope string actually sent to Cognito (the resolved
   * set the facade forwarded), NOT the raw scope the downstream client asked
   * for. See {@link effectiveUpstreamScope}.
   */
  scope: string;
  resource: string;
  /** The facade's OWN verifier used for the upstream Cognito code exchange. */
  cognitoVerifier: string;
  createdAt: number;
}

/**
 * Compute the scope string the facade MUST forward to Cognito, independent of
 * the (often minimal, e.g. just `openid`) scope the downstream client requests.
 *
 * The facade fronts exactly ONE resource server and the Cognito app client's
 * AllowedOAuthScopes are exactly `openid` plus the three fully-qualified
 * `${mcpResource}/${short}` resource scopes. The resource server
 * (packages/core authenticate) rejects any /mcp call whose access token lacks
 * those qualified scopes, so we ALWAYS request the full required set rather
 * than forwarding the client's scope verbatim. Requesting a scope outside
 * Cognito's AllowedOAuthScopes would make Cognito error, so we never add
 * unknown scopes the client may have asked for -- we only ever request
 * `openid` + the three qualified resource scopes, deduplicated and
 * space-joined, `openid` first.
 */
export function effectiveUpstreamScope(config: FacadeConfig): string {
  const base = config.mcpResource.replace(/\/+$/, "");
  const scopes = ["openid", ...config.scopesSupported.map((s) => `${base}/${s}`)];
  return [...new Set(scopes)].join(" ");
}

function appendQuery(uri: string, params: Record<string, string>): string {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

/** Redirect back to the client's validated redirect_uri with an OAuth error. */
function clientError(
  redirectUri: string,
  error: string,
  description: string,
  state: string | null,
): FacadeResponse {
  const params: Record<string, string> = { error, error_description: description };
  if (state) {
    params.state = state;
  }
  return redirectResponse(appendQuery(redirectUri, params));
}

export async function handleAuthorize(
  req: FacadeRequest,
  deps: AuthorizeDeps,
): Promise<FacadeResponse> {
  const q = req.query;
  const clientId = q.client_id;
  const redirectUri = q.redirect_uri;
  const state = q.state ?? null;

  // --- Pre-redirect-validation errors: render an error page, never redirect.
  if (!clientId) {
    return errorPageResponse(400, "invalid_request", "client_id is required");
  }
  if (!redirectUri) {
    return errorPageResponse(400, "invalid_request", "redirect_uri is required");
  }

  let resolved: Awaited<ReturnType<ClientResolver["resolve"]>>;
  try {
    resolved = await deps.clients.resolve(clientId);
  } catch (err) {
    if (err instanceof CimdError) {
      return errorPageResponse(400, err.oauthError, err.message);
    }
    return errorPageResponse(400, "invalid_client", "could not resolve client");
  }

  if (!redirectUriAllowed(resolved.redirectUris, redirectUri)) {
    // redirect_uri is NOT trusted yet -> error page, do not redirect.
    return errorPageResponse(400, "invalid_request", "redirect_uri is not registered");
  }

  // --- From here redirect_uri is validated; errors redirect to the client.
  if (q.response_type !== "code") {
    return clientError(
      redirectUri,
      "unsupported_response_type",
      "response_type must be code",
      state,
    );
  }
  const codeChallenge = q.code_challenge;
  const codeChallengeMethod = q.code_challenge_method;
  if (!codeChallenge) {
    return clientError(redirectUri, "invalid_request", "code_challenge is required (PKCE)", state);
  }
  if (codeChallengeMethod !== "S256") {
    return clientError(redirectUri, "invalid_request", "code_challenge_method must be S256", state);
  }
  // RFC 8707 resource is optional for the client to send. The facade advertises
  // exactly one MCP resource, so a missing/empty resource defaults to it. Only a
  // resource that is PRESENT and does NOT match is rejected.
  const resource = q.resource ?? deps.config.mcpResource;
  if (resource !== deps.config.mcpResource) {
    return clientError(redirectUri, "invalid_target", "resource is not recognized", state);
  }

  // --- Build the transaction and the upstream Cognito authorization URL.
  const txId = (deps.generateTxId ?? generateOpaqueToken)();
  const cognitoState = (deps.generateState ?? generateOpaqueToken)();
  const cognitoVerifier = (deps.generateVerifier ?? generateCodeVerifier)();

  // ALWAYS forward the full required resource-scope set (fully-qualified) +
  // openid, regardless of the client's requested scope. A minimal client scope
  // (e.g. just `openid`) would otherwise mint a token the resource server
  // rejects for insufficient_scope.
  const scope = effectiveUpstreamScope(deps.config);

  const txData: AuthorizeTxData = {
    clientId,
    redirectUri,
    clientState: state,
    clientCodeChallenge: codeChallenge,
    // Store the EFFECTIVE forwarded upstream scope (what we actually requested).
    scope,
    resource,
    cognitoVerifier,
    createdAt: Date.now(),
  };
  // The TX id is bound to the upstream state so /oauth/callback can locate it.
  await deps.repo.putOAuthTx(cognitoState, txData as unknown as Record<string, unknown>);
  void txId;

  const authorizeUrl = appendQuery(`${deps.config.cognitoDomain}/oauth2/authorize`, {
    response_type: "code",
    client_id: deps.config.cognitoClientId,
    redirect_uri: `${deps.config.publicBaseUrl.replace(/\/+$/, "")}/oauth/callback`,
    scope,
    state: cognitoState,
    code_challenge: s256Challenge(cognitoVerifier),
    code_challenge_method: "S256",
  });

  const res = redirectResponse(authorizeUrl);
  // NON-SECRET breadcrumb for the api adapter: client kind/host, the raw scope
  // the client asked for, the forwarded scope we resolved, whether `resource`
  // was provided or defaulted, and the redirect_uri host. No code/state/URL.
  res.logContext = {
    branch: "redirect",
    client_kind: clientIdKind(clientId),
    requested_scope: q.scope ?? "",
    forwarded_scope: scope,
    resource,
    resource_defaulted: q.resource === undefined || q.resource === "",
    redirect_host: hostOf(redirectUri),
  };
  return res;
}

/**
 * Classify a client_id for logging WITHOUT leaking a full OAuth URL: a CIMD
 * client_id is an https URL -> log only `cimd:<host>`; anything else is a
 * pre-registered or dynamically-registered id -> `prereg-or-dynamic`.
 */
function clientIdKind(clientId: string): string {
  if (clientId.startsWith("https://")) {
    return `cimd:${hostOf(clientId)}`;
  }
  return "prereg-or-dynamic";
}

/** The host of a URL, or "" when it is not parseable. */
function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return "";
  }
}
