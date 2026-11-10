import { MemoryKeychain, type OAuthFetch, type StoredTokens } from "@nikovirtala/kiro-remote-mcp";
import { describe, expect, it, vi } from "vitest";
import { obtainToken } from "./auth.ts";

const BASE = "https://kiro.example.com";
const NOW = 1_000_000;
const ALL_SCOPES = ["read", "write", "delete"].map((s) => `${BASE}/mcp/sessions:${s}`).join(" ");

function jwt(scope: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: "u1", scope })).toString("base64url");
  return `eyJhbGciOiJub25lIn0.${payload}.sig`;
}

function tokens(over: Partial<StoredTokens> = {}): StoredTokens {
  return {
    accessToken: jwt(ALL_SCOPES),
    refreshToken: "rt",
    expiresAt: NOW + 3600,
    tokenEndpoint: `${BASE}/oauth/token`,
    clientId: `${BASE}/oauth/clients/cli.json`,
    ...over,
  };
}

const rejectingFetch: OAuthFetch = async () => ({
  status: 400,
  text: async () => '{"error":"invalid_grant"}',
});

describe("obtainToken", () => {
  it("uses a valid keychain entry without logging in", async () => {
    const keychain = new MemoryKeychain();
    await keychain.set(tokens());
    const login = vi.fn(async () => {});
    const res = await obtainToken(BASE, { keychain, fetch: rejectingFetch, login, now: () => NOW });
    expect(res.source).toBe("keychain");
    expect(login).not.toHaveBeenCalled();
    expect(await res.tokens.accessToken()).toBe(tokens().accessToken);
  });

  it("logs in through the browser when the keychain is empty", async () => {
    const keychain = new MemoryKeychain();
    const login = vi.fn(async () => keychain.set(tokens()));
    const res = await obtainToken(BASE, { keychain, fetch: rejectingFetch, login, now: () => NOW });
    expect(res.source).toBe("browser-login");
    expect(login).toHaveBeenCalledTimes(1);
  });

  it("logs in when the stored tokens belong to another host", async () => {
    const keychain = new MemoryKeychain();
    await keychain.set(tokens({ tokenEndpoint: "https://other.example.com/oauth/token" }));
    const login = vi.fn(async () => keychain.set(tokens()));
    const res = await obtainToken(BASE, { keychain, fetch: rejectingFetch, login, now: () => NOW });
    expect(res.source).toBe("browser-login");
    expect(login).toHaveBeenCalledTimes(1);
  });

  it("logs in when the silent refresh fails", async () => {
    const keychain = new MemoryKeychain();
    await keychain.set(tokens({ expiresAt: NOW - 10 }));
    const login = vi.fn(async () => keychain.set(tokens()));
    const res = await obtainToken(BASE, { keychain, fetch: rejectingFetch, login, now: () => NOW });
    expect(res.source).toBe("browser-login");
    expect(login).toHaveBeenCalledTimes(1);
  });

  it("throws when the token lacks a required scope", async () => {
    const keychain = new MemoryKeychain();
    await keychain.set(tokens({ accessToken: jwt(`${BASE}/mcp/sessions:read`) }));
    await expect(
      obtainToken(BASE, { keychain, fetch: rejectingFetch, login: async () => {}, now: () => NOW }),
    ).rejects.toThrow("access token lacks scope(s): sessions:write, sessions:delete");
  });
});
