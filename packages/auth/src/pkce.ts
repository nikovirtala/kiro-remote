/**
 * PKCE (RFC 7636 / OAuth 2.1) helpers. The facade is BOTH a resource-side
 * authorization server (it verifies the downstream client's S256 challenge)
 * AND an OAuth client to Cognito (it generates its own verifier/challenge for
 * the upstream code exchange).
 */

import { createHash, randomBytes } from "node:crypto";

/** Base64url-encode a buffer with no padding. */
export function base64url(input: Buffer): string {
  return input.toString("base64url");
}

/** Compute the S256 code challenge for a verifier, per RFC 7636. */
export function s256Challenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

/** Generate a high-entropy PKCE code verifier (43-128 chars, base64url). */
export function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

/** Generate an opaque random token (state, authorization codes, tx ids). */
export function generateOpaqueToken(bytes = 32): string {
  return base64url(randomBytes(bytes));
}

/** SHA-256 hex digest, used to key OAUTH#CODE / OAUTH#CIMD items. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Constant-time-ish verification that an S256 `code_verifier` matches the
 * stored `code_challenge`. Returns false for any mismatch or malformed input.
 */
export function verifyS256(codeVerifier: string, codeChallenge: string): boolean {
  if (!codeVerifier || !codeChallenge) {
    return false;
  }
  const expected = s256Challenge(codeVerifier);
  if (expected.length !== codeChallenge.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ codeChallenge.charCodeAt(i);
  }
  return diff === 0;
}
