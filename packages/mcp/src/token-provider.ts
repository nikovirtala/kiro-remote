/**
 * A keychain-backed {@link TokenProvider} that refreshes the access token
 * silently when it is near expiry, using the facade's /oauth/token refresh
 * grant. Updated tokens are written back to the keychain.
 *
 * Tokens are never logged. The whoami helper decodes the access-token payload
 * locally only to display `sub` and `scope`; it does not verify the signature
 * (the resource server does that), which is why whoami is a convenience view of
 * the token the CLI already holds.
 */

import type { TokenProvider } from "./http-client.ts";
import type { Keychain, StoredTokens } from "./keychain.ts";
import { type OAuthFetch, refresh } from "./oauth.ts";

/** Refresh when fewer than this many seconds remain on the access token. */
const REFRESH_SKEW_SECONDS = 60;

export interface KeychainTokenProviderDeps {
  keychain: Keychain;
  fetch: OAuthFetch;
  /** Injectable clock (unix epoch seconds) for deterministic tests. */
  now?: () => number;
}

/** Raised when no tokens are stored (the user must run `kiro-remote login`). */
export class NotLoggedInError extends Error {
  constructor() {
    super("not logged in: run `kiro-remote login` first");
    this.name = "NotLoggedInError";
  }
}

/** A {@link TokenProvider} backed by the keychain with silent refresh. */
export class KeychainTokenProvider implements TokenProvider {
  private readonly keychain: Keychain;
  private readonly fetchFn: OAuthFetch;
  private readonly now: () => number;

  constructor(deps: KeychainTokenProviderDeps) {
    this.keychain = deps.keychain;
    this.fetchFn = deps.fetch;
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async accessToken(): Promise<string> {
    const stored = await this.keychain.get();
    if (!stored) {
      throw new NotLoggedInError();
    }
    if (stored.expiresAt - REFRESH_SKEW_SECONDS > this.now()) {
      return stored.accessToken;
    }

    // Near/after expiry: refresh silently.
    const refreshed = await refresh({
      fetch: this.fetchFn,
      tokenEndpoint: stored.tokenEndpoint,
      clientId: stored.clientId,
      refreshToken: stored.refreshToken,
    });
    const next: StoredTokens = {
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token ?? stored.refreshToken,
      expiresAt: this.now() + (refreshed.expires_in ?? 3600),
      ...(refreshed.scope
        ? { scope: refreshed.scope }
        : stored.scope
          ? { scope: stored.scope }
          : {}),
      tokenEndpoint: stored.tokenEndpoint,
      clientId: stored.clientId,
    };
    await this.keychain.set(next);
    return next.accessToken;
  }
}

/** The identity view whoami prints. */
export interface WhoamiView {
  sub: string | null;
  scopes: string[];
}

/** Decode the (unverified) JWT payload of an access token for display only. */
export function decodeTokenForDisplay(accessToken: string): WhoamiView {
  const parts = accessToken.split(".");
  if (parts.length < 2) {
    return { sub: null, scopes: [] };
  }
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const claims = JSON.parse(json) as { sub?: string; scope?: string };
    const scopes =
      typeof claims.scope === "string" ? claims.scope.split(/\s+/).filter(Boolean) : [];
    return { sub: claims.sub ?? null, scopes };
  } catch {
    return { sub: null, scopes: [] };
  }
}
