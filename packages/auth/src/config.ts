/**
 * Runtime configuration for the OAuth 2.1 facade handlers.
 *
 * Nothing here is hardcoded: the deploying stack (packages/cdk, FEAT-007)
 * injects the public host, the Cognito user-pool domain, the JWKS URL, the
 * resource identifiers, the allowed CIMD hosts, and the KMS key. The handlers
 * compute every advertised URL from `publicBaseUrl`.
 */

/** The canonical facade configuration passed to every handler. */
export interface FacadeConfig {
  /**
   * The facade's own public origin WITHOUT a trailing slash, e.g.
   * "https://kiro.example.com". This is the RFC 8414 issuer and the base for
   * every advertised endpoint.
   */
  publicBaseUrl: string;

  /**
   * Canonical MCP resource identifier (RFC 8707 / RFC 9728 `resource`), e.g.
   * "https://kiro.example.com/mcp". Also the Cognito resource-server
   * identifier that scopes are prefixed with.
   */
  mcpResource: string;

  /** The scope short-names supported by the resource server. */
  scopesSupported: readonly string[];

  /** Cognito user-pool managed-login / Hosted UI base URL (no trailing slash). */
  cognitoDomain: string;

  /** The facade's single public app client id registered in Cognito. */
  cognitoClientId: string;

  /** Cognito JWKS URL for the user pool (advertised as `jwks_uri`). */
  cognitoJwksUri: string;

  /**
   * Hosts (lower-cased, no port) permitted as CIMD `client_id` URL hosts. The
   * construct defaults this to claude.ai plus the facade's own host.
   */
  cimdAllowedHosts: readonly string[];

  /**
   * Pre-registered public client ids that may be used at /oauth/authorize
   * without a CIMD document (Claude Code, VS Code, the facade CLI).
   */
  preRegisteredClientIds: readonly string[];

  /** KMS key id/arn used to envelope-encrypt the one-time code token set. */
  kmsKeyId: string;
}

/** The facade endpoint URLs derived from {@link FacadeConfig.publicBaseUrl}. */
export interface FacadeEndpoints {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
  callbackEndpoint: string;
  cliClientMetadata: string;
  protectedResourceMetadata: string;
  authorizationServerMetadata: string;
}

/** Compute the facade endpoint URLs from the config. */
export function facadeEndpoints(config: FacadeConfig): FacadeEndpoints {
  const base = config.publicBaseUrl.replace(/\/+$/, "");
  return {
    issuer: base,
    authorizationEndpoint: `${base}/oauth/authorize`,
    tokenEndpoint: `${base}/oauth/token`,
    revocationEndpoint: `${base}/oauth/revoke`,
    callbackEndpoint: `${base}/oauth/callback`,
    cliClientMetadata: `${base}/oauth/clients/cli.json`,
    protectedResourceMetadata: `${base}/.well-known/oauth-protected-resource/mcp`,
    authorizationServerMetadata: `${base}/.well-known/oauth-authorization-server`,
  };
}
