/**
 * The `kiro-remote` CLI command implementations as pure, injectable functions
 * so they run offline in tests against a fake facade (no real network, no
 * browser, no OS keychain).
 *
 *   login  -> authorization-code + PKCE against the facade (CIMD + loopback),
 *             store the Cognito tokens in the keychain (0600 file fallback).
 *   logout -> revoke the refresh token via /oauth/revoke, clear the keychain.
 *   whoami -> print the caller's sub and scopes from the stored access token.
 *   mcp    -> run the stdio MCP transport calling the REST API with the user's
 *             token (refreshed silently). Wired in cli.ts.
 *
 * NEVER prints or logs tokens, codes, verifiers, or OAuth URLs. All diagnostic
 * output goes through core's redact.
 */

import { redact } from "@nikovirtala/core";
import type { Keychain, StoredTokens } from "./keychain.ts";
import {
  type AuthorizationRoundtrip,
  type OAuthFetch,
  login as runLogin,
  revoke as runRevoke,
} from "./oauth.ts";
import { decodeTokenForDisplay } from "./token-provider.ts";

/** Where the CLI writes user-facing lines (stdout) and diagnostics (stderr). */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

/** A console-backed {@link CliIo} that redacts every line defensively. */
export const consoleIo: CliIo = {
  out(line) {
    console.log(redact(line));
  },
  err(line) {
    console.error(redact(line));
  },
};

export interface LoginCommandDeps {
  baseUrl: string;
  fetch: OAuthFetch;
  roundtrip: AuthorizationRoundtrip;
  keychain: Keychain;
  io: CliIo;
  now?: () => number;
}

/** `kiro-remote login`. */
export async function loginCommand(deps: LoginCommandDeps): Promise<void> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const result = await runLogin({
    baseUrl: deps.baseUrl,
    fetch: deps.fetch,
    roundtrip: deps.roundtrip,
  });
  const tokens: StoredTokens = {
    accessToken: result.tokens.access_token,
    refreshToken: result.tokens.refresh_token ?? "",
    expiresAt: now() + (result.tokens.expires_in ?? 3600),
    ...(result.tokens.scope ? { scope: result.tokens.scope } : {}),
    tokenEndpoint: result.tokenEndpoint,
    clientId: result.clientId,
  };
  await deps.keychain.set(tokens);
  // Confirm success WITHOUT echoing any secret.
  const who = decodeTokenForDisplay(tokens.accessToken);
  deps.io.out(`Logged in as ${who.sub ?? "(unknown)"}.`);
}

export interface LogoutCommandDeps {
  baseUrl: string;
  fetch: OAuthFetch;
  keychain: Keychain;
  io: CliIo;
}

/** `kiro-remote logout`. */
export async function logoutCommand(deps: LogoutCommandDeps): Promise<void> {
  const stored = await deps.keychain.get();
  if (stored?.refreshToken) {
    await runRevoke({ fetch: deps.fetch, baseUrl: deps.baseUrl, token: stored.refreshToken });
  }
  await deps.keychain.clear();
  deps.io.out("Logged out.");
}

export interface WhoamiCommandDeps {
  keychain: Keychain;
  io: CliIo;
}

/** `kiro-remote whoami`. Prints sub and scopes, never the token. */
export async function whoamiCommand(deps: WhoamiCommandDeps): Promise<void> {
  const stored = await deps.keychain.get();
  if (!stored) {
    deps.io.err("Not logged in. Run `kiro-remote login`.");
    return;
  }
  const who = decodeTokenForDisplay(stored.accessToken);
  const scopes =
    who.scopes.length > 0
      ? who.scopes
      : stored.scope
        ? stored.scope.split(/\s+/).filter(Boolean)
        : [];
  deps.io.out(`sub: ${who.sub ?? "(unknown)"}`);
  deps.io.out(`scopes: ${scopes.join(" ")}`);
}
