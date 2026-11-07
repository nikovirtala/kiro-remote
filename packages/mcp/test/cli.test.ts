/**
 * CLI login / logout / whoami against a FAKE facade (no real network, no
 * browser, no OS keychain) plus a redaction assertion that no token, code,
 * verifier, or OAuth URL is ever printed.
 */

import { describe, expect, it, vi } from "vitest";
import type { CliIo } from "../src/cli-commands.ts";
import { loginCommand, logoutCommand, whoamiCommand } from "../src/cli-commands.ts";
import { MemoryKeychain } from "../src/keychain.ts";
import type { AuthorizationRoundtrip } from "../src/oauth.ts";
import { KeychainTokenProvider } from "../src/token-provider.ts";
import { fakeFacadeFetch, fakeJwt, type RecordedRequest } from "./helpers.ts";

const BASE = "https://kiro.example.com";

function captureIo(): { io: CliIo; lines: string[] } {
  const lines: string[] = [];
  return {
    io: { out: (l) => lines.push(l), err: (l) => lines.push(l) },
    lines,
  };
}

/** A roundtrip that validates state and hands back a canned code (no browser). */
const fakeRoundtrip: AuthorizationRoundtrip = async ({ authorizeUrl, state }) => {
  // The authorize URL must carry PKCE + state; we never log it.
  const url = new URL(authorizeUrl("http://127.0.0.1:54321/callback"));
  if (url.searchParams.get("state") !== state) {
    throw new Error("state mismatch");
  }
  if (url.searchParams.get("code_challenge_method") !== "S256") {
    throw new Error("missing PKCE");
  }
  // RFC 8707: the authorize request MUST carry the canonical MCP resource, or
  // the facade rejects with invalid_target and the loopback never gets a code.
  if (url.searchParams.get("resource") !== `${BASE}/mcp`) {
    throw new Error("missing RFC 8707 resource");
  }
  return { code: "auth-code-xyz", redirectUri: "http://127.0.0.1:54321/callback" };
};

describe("kiro-remote login", () => {
  it("runs authorization-code + PKCE against the facade and stores tokens", async () => {
    const recorded: RecordedRequest[] = [];
    const keychain = new MemoryKeychain();
    const { io, lines } = captureIo();
    await loginCommand({
      baseUrl: BASE,
      fetch: fakeFacadeFetch(BASE, {}, recorded),
      roundtrip: fakeRoundtrip,
      keychain,
      io,
      now: () => 1000,
    });

    const stored = await keychain.get();
    expect(stored?.accessToken).toBeTruthy();
    expect(stored?.refreshToken).toBe("refresh-xyz");
    expect(stored?.clientId).toBe(`${BASE}/oauth/clients/cli.json`);
    expect(stored?.tokenEndpoint).toBe(`${BASE}/oauth/token`);
    expect(stored?.expiresAt).toBe(1000 + 3600);

    // The token exchange sent the PKCE verifier and the authorization code.
    const tokenCall = recorded.find((r) => r.url.endsWith("/oauth/token"));
    expect(tokenCall?.body).toContain("grant_type=authorization_code");
    expect(tokenCall?.body).toContain("code_verifier=");

    // Confirmation line names the sub but no secret.
    expect(lines.join("\n")).toContain("Logged in as user-1");
  });

  it("NEVER prints tokens, the code, the verifier, or OAuth URLs", async () => {
    const keychain = new MemoryKeychain();
    const { io, lines } = captureIo();
    await loginCommand({
      baseUrl: BASE,
      fetch: fakeFacadeFetch(BASE, {}, []),
      roundtrip: fakeRoundtrip,
      keychain,
      io,
    });
    const output = lines.join("\n");
    expect(output).not.toContain("auth-code-xyz");
    expect(output).not.toContain("refresh-xyz");
    expect(output).not.toContain("code_verifier");
    expect(output).not.toContain("/oauth/authorize");
    expect(output).not.toMatch(/eyJ/); // no JWT payloads
  });
});

describe("kiro-remote logout", () => {
  it("revokes the refresh token via /oauth/revoke and clears the keychain", async () => {
    const keychain = new MemoryKeychain();
    await keychain.set({
      accessToken: fakeJwt({ sub: "user-1" }),
      refreshToken: "refresh-xyz",
      expiresAt: 9999999999,
      tokenEndpoint: `${BASE}/oauth/token`,
      clientId: `${BASE}/oauth/clients/cli.json`,
    });
    let revoked = "";
    const { io } = captureIo();
    await logoutCommand({
      baseUrl: BASE,
      fetch: fakeFacadeFetch(
        BASE,
        {
          onRevoke: (t) => {
            revoked = t;
          },
        },
        [],
      ),
      keychain,
      io,
    });
    expect(revoked).toBe("refresh-xyz");
    expect(await keychain.get()).toBeNull();
  });
});

describe("kiro-remote whoami", () => {
  it("prints sub and scopes from the stored access token", async () => {
    const keychain = new MemoryKeychain();
    await keychain.set({
      accessToken: fakeJwt({ sub: "user-42", scope: "sessions:read sessions:write" }),
      refreshToken: "r",
      expiresAt: 9999999999,
      tokenEndpoint: `${BASE}/oauth/token`,
      clientId: `${BASE}/oauth/clients/cli.json`,
    });
    const { io, lines } = captureIo();
    await whoamiCommand({ keychain, io });
    const out = lines.join("\n");
    expect(out).toContain("sub: user-42");
    expect(out).toContain("scopes: sessions:read sessions:write");
  });

  it("tells the user to log in when no token is stored", async () => {
    const { io, lines } = captureIo();
    await whoamiCommand({ keychain: new MemoryKeychain(), io });
    expect(lines.join("\n")).toContain("Not logged in");
  });
});

describe("silent token refresh", () => {
  it("refreshes when the access token is near expiry and persists the new set", async () => {
    const keychain = new MemoryKeychain();
    await keychain.set({
      accessToken: "old-token",
      refreshToken: "refresh-xyz",
      expiresAt: 1000, // already expired relative to now below
      tokenEndpoint: `${BASE}/oauth/token`,
      clientId: `${BASE}/oauth/clients/cli.json`,
    });
    const provider = new KeychainTokenProvider({
      keychain,
      fetch: fakeFacadeFetch(BASE, {
        tokenResponse: {
          access_token: fakeJwt({ sub: "user-1" }),
          refresh_token: "refresh-new",
          expires_in: 3600,
        },
      }),
      now: () => 2000,
    });
    const token = await provider.accessToken();
    expect(token).not.toBe("old-token");
    const stored = await keychain.get();
    expect(stored?.refreshToken).toBe("refresh-new");
    expect(stored?.expiresAt).toBe(2000 + 3600);
  });

  it("returns the stored token without refreshing when still valid", async () => {
    const keychain = new MemoryKeychain();
    await keychain.set({
      accessToken: "valid-token",
      refreshToken: "r",
      expiresAt: 100000,
      tokenEndpoint: `${BASE}/oauth/token`,
      clientId: `${BASE}/oauth/clients/cli.json`,
    });
    const fetchSpy = vi.fn();
    const provider = new KeychainTokenProvider({
      keychain,
      fetch: fetchSpy as never,
      now: () => 1000,
    });
    expect(await provider.accessToken()).toBe("valid-token");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
