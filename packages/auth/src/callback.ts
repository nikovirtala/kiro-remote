/**
 * GET /oauth/callback.
 *
 * Cognito redirects here after managed login. We locate the OAUTH#TX by the
 * upstream `state`, exchange the Cognito authorization code using the facade's
 * OWN PKCE verifier, envelope-encrypt the Cognito token set with KMS into a
 * one-time OAUTH#CODE item (sha256(code) key, 60 s TTL, bound to
 * client_id/redirect_uri/client code_challenge), then redirect to the client's
 * redirect_uri with OUR code, the original client state, and iss=publicBaseUrl
 * (so the client's RFC 9207 check against the advertised AS issuer passes).
 */

import type { Repository } from "@nikovirtala/core";
import type { AuthorizeTxData } from "./authorize.ts";
import type { CognitoPort } from "./cognito.ts";
import type { FacadeConfig } from "./config.ts";
import type { KmsPort } from "./kms.ts";
import { generateOpaqueToken, sha256Hex } from "./pkce.ts";
import {
  errorPageResponse,
  type FacadeRequest,
  type FacadeResponse,
  redirectResponse,
} from "./types.ts";

export interface CallbackDeps {
  config: FacadeConfig;
  repo: Repository;
  cognito: CognitoPort;
  kms: KmsPort;
  generateCode?: () => string;
}

function appendQuery(uri: string, params: Record<string, string>): string {
  const url = new URL(uri);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

export async function handleCallback(
  req: FacadeRequest,
  deps: CallbackDeps,
): Promise<FacadeResponse> {
  const q = req.query;
  const upstreamState = q.state;
  if (!upstreamState) {
    return errorPageResponse(400, "invalid_request", "state is required");
  }

  const tx = await deps.repo.getOAuthTx(upstreamState);
  if (!tx) {
    // Expired or unknown transaction -> cannot trust any redirect target.
    return errorPageResponse(
      400,
      "invalid_request",
      "authorization transaction not found or expired",
    );
  }
  const data = tx.data as unknown as AuthorizeTxData;

  // Upstream (Cognito) error: we know the client's redirect_uri from the TX,
  // so surface it there with the original client state.
  if (q.error) {
    const params: Record<string, string> = {
      error: q.error,
      error_description: q.error_description ?? "authorization failed",
      iss: deps.config.publicBaseUrl.replace(/\/+$/, ""),
    };
    if (data.clientState) {
      params.state = data.clientState;
    }
    return redirectResponse(appendQuery(data.redirectUri, params));
  }

  const code = q.code;
  if (!code) {
    return errorPageResponse(400, "invalid_request", "code is required");
  }

  let tokenSet: Awaited<ReturnType<CognitoPort["exchangeCode"]>>;
  try {
    tokenSet = await deps.cognito.exchangeCode({
      code,
      redirectUri: `${deps.config.publicBaseUrl.replace(/\/+$/, "")}/oauth/callback`,
      codeVerifier: data.cognitoVerifier,
    });
  } catch {
    const params: Record<string, string> = {
      error: "server_error",
      error_description: "token exchange failed",
      iss: deps.config.publicBaseUrl.replace(/\/+$/, ""),
    };
    if (data.clientState) {
      params.state = data.clientState;
    }
    return redirectResponse(appendQuery(data.redirectUri, params));
  }

  const ourCode = (deps.generateCode ?? generateOpaqueToken)();
  const encryptedTokens = await deps.kms.encrypt(JSON.stringify(tokenSet));
  await deps.repo.putOAuthCode(sha256Hex(ourCode), {
    encryptedTokens,
    clientId: data.clientId,
    redirectUri: data.redirectUri,
    codeChallenge: data.clientCodeChallenge,
  });

  const params: Record<string, string> = {
    code: ourCode,
    iss: deps.config.publicBaseUrl.replace(/\/+$/, ""),
  };
  if (data.clientState) {
    params.state = data.clientState;
  }
  return redirectResponse(appendQuery(data.redirectUri, params));
}
