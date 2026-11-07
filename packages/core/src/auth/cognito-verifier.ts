/**
 * Production {@link TokenVerifier} backed by aws-jwt-verify's
 * {@link CognitoJwtVerifier}.
 *
 * The verifier validates the JWT signature (against the user pool JWKS, cached
 * by aws-jwt-verify), the issuer, the token expiry, and that `token_use` is
 * `access`. It deliberately does NOT enforce the RFC 8707 resource binding or
 * the allowed client ids: {@link authenticate} owns those checks so a single
 * code path asserts the resource binding regardless of the verifier used. For
 * that reason the verifier is created with `clientId: null` (authenticate()
 * re-checks client_id against the configured allow-list).
 *
 * The underlying verifier is injected so this adapter is unit-testable with a
 * fake that returns canned claims (no JWKS fetch, no network).
 */

import { CognitoJwtVerifier } from "aws-jwt-verify/cognito-verifier";
import type { AccessTokenClaims, TokenVerifier } from "./authenticate.ts";

/** The slice of the aws-jwt-verify verifier this adapter depends on. */
export interface CognitoVerifierLike {
  verify(token: string): Promise<Record<string, unknown>>;
}

export interface CognitoTokenVerifierDeps {
  /**
   * A pre-built verifier (e.g. from {@link CognitoJwtVerifier.create}). When
   * omitted, one is created from {@link userPoolId}.
   */
  verifier?: CognitoVerifierLike;
  /** Cognito user pool id (required when {@link verifier} is not supplied). */
  userPoolId?: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Adapt aws-jwt-verify's Cognito verifier to the core {@link TokenVerifier}. */
export class CognitoTokenVerifier implements TokenVerifier {
  private readonly verifier: CognitoVerifierLike;

  constructor(deps: CognitoTokenVerifierDeps) {
    if (deps.verifier) {
      this.verifier = deps.verifier;
    } else {
      if (!deps.userPoolId) {
        throw new Error("CognitoTokenVerifier requires a verifier or userPoolId");
      }
      // clientId: null -- authenticate() enforces the allowed client ids and
      // the RFC 8707 resource binding, so the verifier only proves the JWT is
      // a genuine, unexpired access token from the user pool.
      this.verifier = CognitoJwtVerifier.create({
        userPoolId: deps.userPoolId,
        tokenUse: "access",
        clientId: null,
      });
    }
  }

  async verify(token: string): Promise<AccessTokenClaims> {
    const payload = await this.verifier.verify(token);
    const sub = asString(payload.sub);
    const iss = asString(payload.iss);
    const tokenUse = asString(payload.token_use);
    if (!sub || !iss || !tokenUse) {
      throw new Error("token is missing required claims");
    }
    const aud = payload.aud;
    return {
      ...payload,
      sub,
      iss,
      token_use: tokenUse,
      exp: typeof payload.exp === "number" ? payload.exp : 0,
      ...(asString(payload.client_id) ? { client_id: asString(payload.client_id) } : {}),
      ...(asString(payload.scope) ? { scope: asString(payload.scope) } : {}),
      ...(typeof aud === "string" || Array.isArray(aud) ? { aud: aud as string | string[] } : {}),
    };
  }
}
