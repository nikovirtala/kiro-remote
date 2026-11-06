/**
 * CognitoAdapter tests driven by a fake Cognito token endpoint (a FetchLike).
 * They confirm the facade sends the public client_id + its own PKCE verifier,
 * returns the Cognito token set unchanged, and surfaces OAuth errors.
 */

import { describe, expect, test } from "vitest";
import { CognitoAdapter, CognitoTokenError } from "./cognito.ts";
import { fakeCognitoFetch } from "./test-helpers.ts";

const TOKEN_ENDPOINT = "https://pool.auth.us-east-1.amazoncognito.com/oauth2/token";
const REVOKE_ENDPOINT = "https://pool.auth.us-east-1.amazoncognito.com/oauth2/revoke";

describe("CognitoAdapter", () => {
  test("exchangeCode posts the public client_id + PKCE verifier and returns tokens unchanged", async () => {
    const seen: Array<{ url: string; body: Record<string, string> }> = [];
    const adapter = new CognitoAdapter({
      tokenEndpoint: TOKEN_ENDPOINT,
      revocationEndpoint: REVOKE_ENDPOINT,
      clientId: "facadeclient123",
      fetch: fakeCognitoFetch({
        tokenSet: {
          access_token: "A",
          token_type: "Bearer",
          expires_in: 900,
          refresh_token: "R",
        },
        onRequest: (url, body) => seen.push({ url, body }),
      }),
    });

    const tokens = await adapter.exchangeCode({
      code: "c",
      redirectUri: "https://kiro.example.com/oauth/callback",
      codeVerifier: "v",
    });

    expect(tokens).toEqual({
      access_token: "A",
      token_type: "Bearer",
      expires_in: 900,
      refresh_token: "R",
    });
    expect(seen[0].url).toBe(TOKEN_ENDPOINT);
    expect(seen[0].body).toMatchObject({
      grant_type: "authorization_code",
      client_id: "facadeclient123",
      code: "c",
      code_verifier: "v",
      redirect_uri: "https://kiro.example.com/oauth/callback",
    });
  });

  test("surfaces an OAuth error from the token endpoint", async () => {
    const adapter = new CognitoAdapter({
      tokenEndpoint: TOKEN_ENDPOINT,
      revocationEndpoint: REVOKE_ENDPOINT,
      clientId: "facadeclient123",
      fetch: fakeCognitoFetch({
        error: { status: 400, body: { error: "invalid_grant", error_description: "bad code" } },
      }),
    });
    await expect(
      adapter.exchangeCode({ code: "c", redirectUri: "r", codeVerifier: "v" }),
    ).rejects.toMatchObject({ error: "invalid_grant", status: 400 });
  });

  test("refresh posts grant_type=refresh_token", async () => {
    const seen: Array<{ body: Record<string, string> }> = [];
    const adapter = new CognitoAdapter({
      tokenEndpoint: TOKEN_ENDPOINT,
      revocationEndpoint: REVOKE_ENDPOINT,
      clientId: "facadeclient123",
      fetch: fakeCognitoFetch({ onRequest: (_url, body) => seen.push({ body }) }),
    });
    await adapter.refresh({ refreshToken: "r" });
    expect(seen[0].body).toMatchObject({ grant_type: "refresh_token", refresh_token: "r" });
  });

  test("revoke does not throw for a 200-style response", async () => {
    const adapter = new CognitoAdapter({
      tokenEndpoint: TOKEN_ENDPOINT,
      revocationEndpoint: REVOKE_ENDPOINT,
      clientId: "facadeclient123",
      fetch: fakeCognitoFetch({}),
    });
    await expect(adapter.revoke({ token: "r" })).resolves.toBeUndefined();
  });

  test("CognitoTokenError carries error + status", () => {
    const err = new CognitoTokenError("invalid_request", 400, "oops");
    expect(err.error).toBe("invalid_request");
    expect(err.status).toBe(400);
    expect(err.errorDescription).toBe("oops");
  });
});
