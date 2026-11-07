/**
 * The production loopback roundtrip must return, at token-exchange time, the
 * EXACT redirect_uri it used at authorize time (same ephemeral 127.0.0.1 port).
 * The facade compares the two with strict string equality, so any drift --
 * notably the old "read server.address() AFTER server.close()" path, which
 * returned null and fell back to port 0 -- produces
 * "invalid_grant (redirect_uri does not match the authorization code)".
 *
 * These tests exercise the REAL http server (the prior unit tests injected a
 * fake roundtrip that returned a fixed redirect_uri, so they never caught it).
 * The injected `open` stands in for the browser: it parses the redirect_uri out
 * of the authorize URL and fires a loopback GET back to it, simulating the
 * facade's redirect. Everything stays on 127.0.0.1 -- no external network.
 */

import { get } from "node:http";
import { describe, expect, it } from "vitest";
import { createLoopbackRoundtrip, type UrlOpener } from "../src/loopback.ts";

const STATE = "state-abc";

/** Build the authorize URL exactly as oauth.ts does: redirect_uri + state. */
const authorizeUrl = (redirectUri: string): string =>
  `https://facade.example/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${STATE}`;

/** Pull the redirect_uri back out of an authorize URL. */
function redirectUriOf(url: string): string {
  const param = new URL(url).searchParams.get("redirect_uri");
  if (!param) throw new Error("authorize URL is missing redirect_uri");
  return param;
}

/**
 * An `open` that simulates the facade redirecting the browser back to the
 * loopback: it GETs the loopback redirect_uri with the supplied query string.
 */
function openThatRedirects(query: string): UrlOpener {
  return (url: string): void => {
    const redirectUri = redirectUriOf(url);
    get(`${redirectUri}?${query}`, (res) => {
      res.resume();
    }).on("error", () => {});
  };
}

describe("createLoopbackRoundtrip against a real loopback server", () => {
  it("resolves the token-exchange redirect_uri equal to the authorize redirect_uri (same port, never port 0)", async () => {
    // Capture the redirect_uri the authorize URL was built with, so we can
    // compare it to the one the roundtrip resolves for the token exchange.
    let authorizeRedirectUri: string | undefined;
    const open: UrlOpener = (url: string): void => {
      authorizeRedirectUri = redirectUriOf(url);
      get(`${authorizeRedirectUri}?code=auth-code-xyz&state=${STATE}`, (res) => {
        res.resume();
      }).on("error", () => {});
    };

    const roundtrip = createLoopbackRoundtrip({ open });
    const result = await roundtrip({
      authorizeUrl,
      loopbackHost: "http://127.0.0.1",
      state: STATE,
    });

    expect(result.code).toBe("auth-code-xyz");
    // The regression guard: identical string, including the real ephemeral
    // port. Before the fix this was http://127.0.0.1:0/callback.
    expect(result.redirectUri).toBe(authorizeRedirectUri);
    expect(result.redirectUri).not.toContain(":0/callback");
    expect(result.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });

  it("resolves the authorization code on the happy path", async () => {
    const roundtrip = createLoopbackRoundtrip({
      open: openThatRedirects(`code=happy-code&state=${STATE}`),
    });
    const result = await roundtrip({
      authorizeUrl,
      loopbackHost: "http://127.0.0.1",
      state: STATE,
    });
    expect(result.code).toBe("happy-code");
  });

  it("rejects when the returned state does not match", async () => {
    const roundtrip = createLoopbackRoundtrip({
      open: openThatRedirects("code=some-code&state=wrong-state"),
    });
    await expect(
      roundtrip({ authorizeUrl, loopbackHost: "http://127.0.0.1", state: STATE }),
    ).rejects.toThrow(/valid code\/state/);
  });
});
