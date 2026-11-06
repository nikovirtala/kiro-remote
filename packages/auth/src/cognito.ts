/**
 * Cognito port + real adapter.
 *
 * The facade NEVER mints, signs, or reshapes tokens. It only brokers the
 * authorization-code exchange and refresh/revoke calls against Cognito's token
 * endpoint and returns Cognito's response unchanged. The port is injected so
 * tests drive a fake Cognito token endpoint with no network.
 */

/** A Cognito OAuth2 token response, passed through to the client unchanged. */
export interface CognitoTokenSet {
  access_token: string;
  token_type: string;
  expires_in: number;
  id_token?: string;
  refresh_token?: string;
  scope?: string;
  [key: string]: unknown;
}

/** An OAuth error returned by Cognito's token endpoint. */
export class CognitoTokenError extends Error {
  readonly error: string;
  readonly errorDescription?: string;
  readonly status: number;
  constructor(error: string, status = 400, errorDescription?: string) {
    super(errorDescription ?? error);
    this.name = "CognitoTokenError";
    this.error = error;
    this.status = status;
    this.errorDescription = errorDescription;
  }
}

/** The subset of Cognito behaviour the facade depends on. */
export interface CognitoPort {
  /** Exchange an authorization code (with the facade's own PKCE verifier). */
  exchangeCode(params: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<CognitoTokenSet>;

  /** Exchange a refresh token for a fresh token set. */
  refresh(params: { refreshToken: string }): Promise<CognitoTokenSet>;

  /** Revoke a refresh token (RFC 7009 pass-through). */
  revoke(params: { token: string }): Promise<void>;
}

/** HTTP transport the Cognito adapter uses (native fetch in prod, fake in tests). */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; json: () => Promise<unknown>; text: () => Promise<string> }>;

export interface CognitoAdapterConfig {
  /** Cognito user-pool domain token endpoint, e.g. https://dom.auth.../oauth2/token. */
  tokenEndpoint: string;
  /** Cognito user-pool domain revocation endpoint. */
  revocationEndpoint: string;
  /** The facade app client id (public, no secret). */
  clientId: string;
  /** Injected fetch transport (defaults to global fetch). */
  fetch?: FetchLike;
}

const defaultFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, init);
  return {
    status: res.status,
    json: () => res.json(),
    text: () => res.text(),
  };
};

/** Real Cognito adapter over the user-pool OAuth2 endpoints. */
export class CognitoAdapter implements CognitoPort {
  private readonly tokenEndpoint: string;
  private readonly revocationEndpoint: string;
  private readonly clientId: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: CognitoAdapterConfig) {
    this.tokenEndpoint = config.tokenEndpoint;
    this.revocationEndpoint = config.revocationEndpoint;
    this.clientId = config.clientId;
    this.fetchImpl = config.fetch ?? defaultFetch;
  }

  private async postToken(form: Record<string, string>): Promise<CognitoTokenSet> {
    const body = new URLSearchParams({ client_id: this.clientId, ...form }).toString();
    const res = await this.fetchImpl(this.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
    });
    const payload = (await res.json()) as Record<string, unknown>;
    if (res.status >= 400) {
      const error = typeof payload.error === "string" ? payload.error : "invalid_request";
      const desc =
        typeof payload.error_description === "string" ? payload.error_description : undefined;
      throw new CognitoTokenError(error, res.status, desc);
    }
    return payload as CognitoTokenSet;
  }

  async exchangeCode(params: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<CognitoTokenSet> {
    return this.postToken({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
    });
  }

  async refresh(params: { refreshToken: string }): Promise<CognitoTokenSet> {
    return this.postToken({
      grant_type: "refresh_token",
      refresh_token: params.refreshToken,
    });
  }

  async revoke(params: { token: string }): Promise<void> {
    const body = new URLSearchParams({ client_id: this.clientId, token: params.token }).toString();
    const res = await this.fetchImpl(this.revocationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    // RFC 7009: the server responds 200 for unknown/already-invalid tokens;
    // only surface hard failures.
    if (res.status >= 500) {
      throw new CognitoTokenError("server_error", res.status);
    }
  }
}
