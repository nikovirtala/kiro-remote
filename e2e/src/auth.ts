/**
 * Get the harness's bearer token by reusing the `kiro-remote login` flow and
 * its 0600 file keychain (~/.config/kiro-remote/tokens.json).
 *
 *   1. Stored tokens for this host are used through KeychainTokenProvider,
 *      which refreshes silently and writes the refreshed set back.
 *   2. No tokens, tokens for another host, or a failed refresh: run the same
 *      browser + loopback login as `kiro-remote login`, then read again.
 *   3. The access token must carry the sessions read, write and delete scopes.
 *
 * The token itself is only ever handed to the transports through the
 * TokenProvider. It is never printed, captured in the report, or written
 * anywhere except the existing keychain file.
 */
import { redact } from "@nikovirtala/kiro-remote-core";
import {
  type CliIo,
  createLoopbackRoundtrip,
  decodeTokenForDisplay,
  type FetchLike,
  type Keychain,
  KeychainTokenProvider,
  loginCommand,
  NotLoggedInError,
  OAuthError,
  type OAuthFetch,
  type TokenProvider,
} from "@nikovirtala/kiro-remote-mcp";

/** Adapt the global fetch to the OAuthFetch / http-client FetchLike shape. */
export const nodeFetch: OAuthFetch & FetchLike = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
  return { status: res.status, text: () => res.text() };
};

/** Login messages go to stderr, redacted, so stdout stays the JSON report. */
export const stderrIo: CliIo = {
  out(line) {
    process.stderr.write(`${redact(line)}\n`);
  },
  err(line) {
    process.stderr.write(`${redact(line)}\n`);
  },
};

/** The scopes the flow needs (short form; the token may carry the resource-prefixed form). */
export const REQUIRED_SCOPES = ["sessions:read", "sessions:write", "sessions:delete"] as const;

export interface ObtainedToken {
  tokens: TokenProvider;
  source: "keychain" | "browser-login";
  scopes: string[];
}

export interface ObtainTokenDeps {
  keychain: Keychain;
  fetch: OAuthFetch;
  /** Run the browser login and store the tokens in `keychain`. */
  login(): Promise<void>;
  /** Unix epoch seconds. */
  now?: () => number;
}

function hasScope(scopes: string[], wanted: string): boolean {
  return scopes.some((s) => s === wanted || s.endsWith(`/${wanted}`));
}

/** Return a token provider for `baseUrl`, logging in through the browser when needed. */
export async function obtainToken(baseUrl: string, deps: ObtainTokenDeps): Promise<ObtainedToken> {
  const provider = new KeychainTokenProvider({
    keychain: deps.keychain,
    fetch: deps.fetch,
    ...(deps.now ? { now: deps.now } : {}),
  });
  const tokenEndpoint = `${baseUrl}/oauth/token`;
  let source: ObtainedToken["source"] = "keychain";
  let accessToken: string | null = null;
  const stored = await deps.keychain.get();
  if (stored && stored.tokenEndpoint === tokenEndpoint) {
    try {
      accessToken = await provider.accessToken();
    } catch (err) {
      if (!(err instanceof NotLoggedInError || err instanceof OAuthError)) {
        throw err;
      }
    }
  }
  if (accessToken === null) {
    source = "browser-login";
    await deps.login();
    const after = await deps.keychain.get();
    if (!after || after.tokenEndpoint !== tokenEndpoint) {
      throw new Error("login did not store tokens for this host");
    }
    accessToken = await provider.accessToken();
  }
  const decoded = decodeTokenForDisplay(accessToken).scopes;
  const fromStore = (await deps.keychain.get())?.scope?.split(/\s+/).filter(Boolean) ?? [];
  const scopes = decoded.length > 0 ? decoded : fromStore;
  const missing = REQUIRED_SCOPES.filter((s) => !hasScope(scopes, s));
  if (missing.length > 0) {
    throw new Error(`access token lacks scope(s): ${missing.join(", ")}`);
  }
  return { tokens: provider, source, scopes };
}

/** The real login: exactly what `kiro-remote login` does, with output on stderr. */
export async function defaultLogin(baseUrl: string, keychain: Keychain): Promise<void> {
  await loginCommand({
    baseUrl,
    fetch: nodeFetch,
    roundtrip: createLoopbackRoundtrip(),
    keychain,
    io: stderrIo,
  });
}
