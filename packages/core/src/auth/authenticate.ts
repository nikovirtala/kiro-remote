/**
 * The single call site that reads token claims.
 *
 * `authenticate(req)` verifies a Cognito access token with aws-jwt-verify
 * (JWKS cached by the verifier) and returns a {@link Principal}. Nothing else
 * in the system reads JWT claims. `authorize(principal, action, resource)` is
 * the single authz decision point: scope-per-action plus per-owner visibility.
 *
 * RFC 8707 resource binding: Cognito emits the requested resource server
 * identifier in the access token's `aud`/`scope`. authenticate() requires each
 * scope to be prefixed with the configured resource identifier, which is how
 * the resource binding is asserted here (the exact binding is recorded in the
 * feature findings). If Cognito ever issues an explicit RFC 8707 `aud`
 * claim equal to the resource identifier, it is accepted as well.
 */

/** Minimal request shape authenticate() needs: just the headers. */
export interface AuthRequest {
  headers: Record<string, string | string[] | undefined>;
}

/** The authenticated caller. The only decoded view of the token. */
export interface Principal {
  sub: string;
  clientId: string;
  scopes: string[];
}

/** Verifier abstraction so tests inject a fake (and prod uses aws-jwt-verify). */
export interface TokenVerifier {
  /** Verify and return the decoded claims, or throw on any failure. */
  verify(token: string): Promise<AccessTokenClaims>;
}

export interface AccessTokenClaims {
  sub: string;
  token_use: string;
  client_id?: string;
  scope?: string;
  aud?: string | string[];
  iss: string;
  exp: number;
  [key: string]: unknown;
}

export interface AuthenticateConfig {
  verifier: TokenVerifier;
  /** Allowed client_id values. */
  allowedClientIds: readonly string[];
  /** Resource server identifier scopes must be prefixed with (RFC 8707). */
  resourceIdentifier: string;
  /** Injectable clock for exp checks. */
  now?: () => number;
}

export class UnauthorizedError extends Error {
  readonly status = 401;
  readonly challenge: WwwAuthenticate;
  constructor(challenge: WwwAuthenticate) {
    super("unauthorized");
    this.name = "UnauthorizedError";
    this.challenge = challenge;
  }
}

export class ForbiddenError extends Error {
  readonly status = 403;
  readonly neededScope?: string;
  constructor(neededScope?: string) {
    super("forbidden");
    this.name = "ForbiddenError";
    this.neededScope = neededScope;
  }
}

export interface WwwAuthenticate {
  scheme: "Bearer";
  error?: string;
  errorDescription?: string;
  resourceMetadata?: string;
  scope?: string;
}

/** Build the exact `WWW-Authenticate` header value for a 401/403 response. */
export function wwwAuthenticateHeader(c: WwwAuthenticate): string {
  const parts: string[] = [];
  if (c.error) {
    parts.push(`error="${c.error}"`);
  }
  if (c.errorDescription) {
    parts.push(`error_description="${c.errorDescription}"`);
  }
  if (c.resourceMetadata) {
    parts.push(`resource_metadata="${c.resourceMetadata}"`);
  }
  if (c.scope) {
    parts.push(`scope="${c.scope}"`);
  }
  return parts.length > 0 ? `Bearer ${parts.join(", ")}` : "Bearer";
}

/** Reusable 401 helper: no/invalid token. */
export function unauthorized(resourceMetadata: string, scope?: string): UnauthorizedError {
  return new UnauthorizedError({
    scheme: "Bearer",
    resourceMetadata,
    ...(scope ? { scope } : {}),
  });
}

/** Reusable 403 helper: authenticated but missing scope. */
export function insufficientScope(neededScope: string): ForbiddenError {
  return new ForbiddenError(neededScope);
}

function extractBearer(req: AuthRequest): string | null {
  const raw = req.headers.authorization ?? req.headers.Authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

function parseScopes(scope: string | undefined): string[] {
  if (!scope) {
    return [];
  }
  return scope.split(/\s+/).filter(Boolean);
}

/**
 * Verify the request's bearer token and return the {@link Principal}. Throws
 * {@link UnauthorizedError} on any verification failure, {@link ForbiddenError}
 * when the resource binding / client_id checks fail.
 */
export async function authenticate(
  req: AuthRequest,
  config: AuthenticateConfig,
  resourceMetadata: string,
): Promise<Principal> {
  const token = extractBearer(req);
  if (!token) {
    throw unauthorized(resourceMetadata);
  }

  let claims: AccessTokenClaims;
  try {
    claims = await config.verifier.verify(token);
  } catch {
    throw unauthorized(resourceMetadata);
  }

  if (claims.token_use !== "access") {
    throw unauthorized(resourceMetadata);
  }

  const now = Math.floor((config.now?.() ?? Date.now()) / 1000);
  if (typeof claims.exp === "number" && claims.exp < now) {
    throw unauthorized(resourceMetadata);
  }

  const clientId = claims.client_id ?? "";
  if (!config.allowedClientIds.includes(clientId)) {
    throw unauthorized(resourceMetadata);
  }

  // RFC 8707 resource binding: scopes must be prefixed with the resource
  // identifier, OR an explicit aud equal to the resource identifier.
  const rawScopes = parseScopes(claims.scope);
  const aud = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  const audBound = aud.includes(config.resourceIdentifier);
  const boundScopes = rawScopes.filter((s) => s.startsWith(`${config.resourceIdentifier}/`));

  if (!audBound && boundScopes.length === 0) {
    // Token is valid but not bound to this resource server.
    throw insufficientScope(`${config.resourceIdentifier}/sessions:read`);
  }

  // Normalize scopes to their short form (strip the resource prefix) so
  // authorize() can reason over `sessions:read` etc.
  const scopes = rawScopes.map((s) =>
    s.startsWith(`${config.resourceIdentifier}/`)
      ? s.slice(config.resourceIdentifier.length + 1)
      : s,
  );

  return { sub: claims.sub, clientId, scopes };
}
