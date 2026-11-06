/**
 * GET /oauth/authorize.
 *
 * Validates the downstream client's authorization request, resolves the client
 * (CIMD URL or pre-registered), enforces exact redirect_uri + S256 PKCE + the
 * RFC 8707 `resource`, stores an OAUTH#TX item (10 min TTL) carrying the
 * client's challenge AND the facade's OWN upstream PKCE verifier/state, then
 * redirects the user-agent to Cognito managed login.
 *
 * Errors that occur BEFORE redirect_uri is validated render an error page and
 * never redirect (open-redirection mitigation). Errors AFTER validation
 * redirect back to the client with ?error=... per OAuth 2.1.
 */

import type { Repository } from "@kiro-remote/core";
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
  scope: string | null;
  resource: string;
  /** The facade's OWN verifier used for the upstream Cognito code exchange. */
  cognitoVerifier: string;
  createdAt: number;
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
  const resource = q.resource;
  if (!resource) {
    return clientError(redirectUri, "invalid_target", "resource is required (RFC 8707)", state);
  }
  if (resource !== deps.config.mcpResource) {
    return clientError(redirectUri, "invalid_target", "resource is not recognized", state);
  }

  // --- Build the transaction and the upstream Cognito authorization URL.
  const txId = (deps.generateTxId ?? generateOpaqueToken)();
  const cognitoState = (deps.generateState ?? generateOpaqueToken)();
  const cognitoVerifier = (deps.generateVerifier ?? generateCodeVerifier)();

  const txData: AuthorizeTxData = {
    clientId,
    redirectUri,
    clientState: state,
    clientCodeChallenge: codeChallenge,
    scope: q.scope ?? null,
    resource,
    cognitoVerifier,
    createdAt: Date.now(),
  };
  // The TX id is bound to the upstream state so /oauth/callback can locate it.
  await deps.repo.putOAuthTx(cognitoState, txData as unknown as Record<string, unknown>);
  void txId;

  const scope = q.scope ?? deps.config.scopesSupported.join(" ");
  const authorizeUrl = appendQuery(`${deps.config.cognitoDomain}/oauth2/authorize`, {
    response_type: "code",
    client_id: deps.config.cognitoClientId,
    redirect_uri: `${deps.config.publicBaseUrl.replace(/\/+$/, "")}/oauth/callback`,
    scope,
    state: cognitoState,
    code_challenge: s256Challenge(cognitoVerifier),
    code_challenge_method: "S256",
  });

  return redirectResponse(authorizeUrl);
}
