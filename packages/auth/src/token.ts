/**
 * POST /oauth/token and POST /oauth/revoke.
 *
 * authorization_code: verify the client's S256 code_verifier against the
 * stored code_challenge, verify client_id + redirect_uri, consume the
 * OAUTH#CODE atomically (delete-on-first-use so replay fails), decrypt the
 * Cognito token set via KMS, and return the Cognito tokens UNCHANGED.
 *
 * refresh_token: pass straight through to Cognito.
 *
 * revoke: pass straight through to Cognito RevokeToken.
 *
 * Every token response carries Cache-Control: no-store. The facade NEVER
 * mints, signs, or reshapes tokens -- Cognito is the only issuer.
 */

import type { Repository } from "@nikovirtala/kiro-remote-core";
import { type CognitoPort, CognitoTokenError, type CognitoTokenSet } from "./cognito.ts";
import type { KmsPort } from "./kms.ts";
import { sha256Hex, verifyS256 } from "./pkce.ts";
import { type FacadeRequest, type FacadeResponse, jsonResponse, parseForm } from "./types.ts";

export interface TokenDeps {
  repo: Repository;
  cognito: CognitoPort;
  kms: KmsPort;
}

export interface RevokeDeps {
  cognito: CognitoPort;
}

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

function tokenError(status: number, error: string, description?: string): FacadeResponse {
  const body: Record<string, string> = { error };
  if (description) {
    body.error_description = description;
  }
  return jsonResponse(status, body, NO_STORE);
}

async function handleAuthorizationCode(
  form: Record<string, string>,
  deps: TokenDeps,
): Promise<FacadeResponse> {
  const code = form.code;
  const codeVerifier = form.code_verifier;
  const clientId = form.client_id;
  const redirectUri = form.redirect_uri;

  if (!code) {
    return tokenError(400, "invalid_request", "code is required");
  }
  if (!codeVerifier) {
    return tokenError(400, "invalid_request", "code_verifier is required (PKCE)");
  }
  if (!clientId) {
    return tokenError(400, "invalid_request", "client_id is required");
  }
  if (!redirectUri) {
    return tokenError(400, "invalid_request", "redirect_uri is required");
  }

  // Delete-on-first-use: a replayed code finds nothing.
  const item = await deps.repo.consumeOAuthCode(sha256Hex(code));
  if (!item) {
    return tokenError(400, "invalid_grant", "authorization code is invalid or already used");
  }
  if (item.clientId !== clientId) {
    return tokenError(400, "invalid_grant", "client_id does not match the authorization code");
  }
  if (item.redirectUri !== redirectUri) {
    return tokenError(400, "invalid_grant", "redirect_uri does not match the authorization code");
  }
  if (!verifyS256(codeVerifier, item.codeChallenge)) {
    return tokenError(400, "invalid_grant", "PKCE verification failed");
  }

  const plaintext = await deps.kms.decrypt(item.encryptedTokens);
  const tokenSet = JSON.parse(plaintext) as CognitoTokenSet;
  // Return the Cognito token set UNCHANGED.
  return jsonResponse(200, tokenSet, NO_STORE);
}

async function handleRefresh(
  form: Record<string, string>,
  deps: TokenDeps,
): Promise<FacadeResponse> {
  const refreshToken = form.refresh_token;
  if (!refreshToken) {
    return tokenError(400, "invalid_request", "refresh_token is required");
  }
  try {
    const tokenSet = await deps.cognito.refresh({ refreshToken });
    return jsonResponse(200, tokenSet, NO_STORE);
  } catch (err) {
    if (err instanceof CognitoTokenError) {
      return tokenError(err.status, err.error, err.errorDescription);
    }
    return tokenError(400, "invalid_grant", "refresh failed");
  }
}

export async function handleToken(req: FacadeRequest, deps: TokenDeps): Promise<FacadeResponse> {
  const form = parseForm(req.body);
  const grantType = form.grant_type;
  if (grantType === "authorization_code") {
    return handleAuthorizationCode(form, deps);
  }
  if (grantType === "refresh_token") {
    return handleRefresh(form, deps);
  }
  return tokenError(400, "unsupported_grant_type", "grant_type is not supported");
}

export async function handleRevoke(req: FacadeRequest, deps: RevokeDeps): Promise<FacadeResponse> {
  const form = parseForm(req.body);
  const token = form.token;
  if (!token) {
    return tokenError(400, "invalid_request", "token is required");
  }
  try {
    await deps.cognito.revoke({ token });
  } catch {
    // RFC 7009: still respond 200 for client-visible idempotence.
  }
  return { status: 200, headers: { ...NO_STORE }, body: "" };
}
