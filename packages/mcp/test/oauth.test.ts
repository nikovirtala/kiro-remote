/**
 * The CLI token exchange + refresh must surface the facade's precise OAuth
 * failure reason instead of a bare "token exchange failed". The facade returns
 * a non-secret RFC 6749 `{error, error_description}` body on a non-2xx; we quote
 * it in the thrown OAuthError so the user sees e.g. "invalid_grant (redirect_uri
 * does not match the authorization code)". The code/verifier/tokens live in the
 * REQUEST (never the error body), and the final message is still redacted at the
 * CLI output boundary.
 */

import { describe, expect, it } from "vitest";
import { login, OAuthError, type OAuthFetch, refresh } from "../src/oauth.ts";

const BASE = "https://kiro.example.com";

/**
 * A fetch that serves the CIMD doc, then returns the given status+body for the
 * token exchange (so we can drive the non-2xx error-surfacing path).
 */
function facadeWithTokenResponse(status: number, body: string): OAuthFetch {
  return async (url, _init) => {
    const path = new URL(url).pathname;
    if (path === "/oauth/clients/cli.json") {
      return {
        status: 200,
        async text() {
          return JSON.stringify({
            client_id: `${BASE}/oauth/clients/cli.json`,
            redirect_uris: ["http://127.0.0.1/callback"],
            code_challenge_methods_supported: ["S256"],
          });
        },
      };
    }
    if (path === "/oauth/token") {
      return {
        status,
        async text() {
          return body;
        },
      };
    }
    return {
      status: 404,
      async text() {
        return "{}";
      },
    };
  };
}

const roundtrip = async () => ({
  code: "auth-code-xyz",
  redirectUri: "http://127.0.0.1:54321/callback",
});

describe("login token exchange error surfacing", () => {
  it("includes the facade error + description in the thrown OAuthError", async () => {
    const fetch = facadeWithTokenResponse(
      400,
      JSON.stringify({
        error: "invalid_grant",
        error_description: "redirect_uri does not match the authorization code",
      }),
    );

    const err = await login({ baseUrl: BASE, fetch, roundtrip }).catch((e) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).message).toContain("token exchange failed");
    expect((err as OAuthError).message).toContain("invalid_grant");
    expect((err as OAuthError).message).toContain(
      "redirect_uri does not match the authorization code",
    );
  });

  it("includes the error code alone when no description is present", async () => {
    const fetch = facadeWithTokenResponse(400, JSON.stringify({ error: "invalid_request" }));
    const err = await login({ baseUrl: BASE, fetch, roundtrip }).catch((e) => e);
    expect((err as OAuthError).message).toContain("token exchange failed: invalid_request");
  });

  it("falls back to status + truncated body when the body is not JSON", async () => {
    const fetch = facadeWithTokenResponse(502, "<html>Bad Gateway</html>");
    const err = await login({ baseUrl: BASE, fetch, roundtrip }).catch((e) => e);
    expect((err as OAuthError).message).toContain("token exchange failed: HTTP 502");
    expect((err as OAuthError).message).toContain("Bad Gateway");
  });

  it("never echoes the authorization code or the PKCE verifier in the message", async () => {
    const fetch = facadeWithTokenResponse(
      400,
      JSON.stringify({ error: "invalid_grant", error_description: "bad" }),
    );
    const err = await login({ baseUrl: BASE, fetch, roundtrip }).catch((e) => e);
    expect((err as OAuthError).message).not.toContain("auth-code-xyz");
    expect((err as OAuthError).message).not.toContain("code_verifier");
  });
});

describe("refresh token error surfacing", () => {
  it("includes the facade error + description on a non-2xx refresh", async () => {
    const fetch: OAuthFetch = async () => ({
      status: 400,
      async text() {
        return JSON.stringify({
          error: "invalid_grant",
          error_description: "refresh token is expired",
        });
      },
    });
    const err = await refresh({
      fetch,
      tokenEndpoint: `${BASE}/oauth/token`,
      clientId: `${BASE}/oauth/clients/cli.json`,
      refreshToken: "r",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).message).toContain("token refresh failed");
    expect((err as OAuthError).message).toContain("invalid_grant");
    expect((err as OAuthError).message).toContain("refresh token is expired");
  });
});
