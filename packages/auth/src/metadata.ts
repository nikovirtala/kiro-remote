/**
 * Discovery metadata handlers.
 *
 *  - GET /.well-known/oauth-protected-resource/mcp  (RFC 9728)
 *  - GET /.well-known/oauth-authorization-server    (RFC 8414)
 *
 * The facade advertises ITSELF as the authorization server (issuer =
 * publicBaseUrl) while delegating JWKS to Cognito. RFC 9207 issuer validation
 * is client-side and compares the authorization-response `iss` to this
 * advertised `issuer`; the facade emits iss=publicBaseUrl from /oauth/callback
 * so the two match. The access token's own `iss` is Cognito's and is validated
 * SEPARATELY by the resource server (RFC 8707 audience = mcpResource). The MCP
 * 2026-07-28 spec does not require the token iss to equal the AS issuer.
 */

import { type FacadeConfig, facadeEndpoints } from "./config.ts";
import { type FacadeResponse, jsonResponse } from "./types.ts";

/** RFC 9728 protected-resource-metadata document. */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
}

/** RFC 8414 authorization-server-metadata document. */
export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
  jwks_uri: string;
  response_types_supported: string[];
  grant_types_supported: string[];
  code_challenge_methods_supported: string[];
  token_endpoint_auth_methods_supported: string[];
  revocation_endpoint_auth_methods_supported: string[];
  registration_endpoint: string;
  scopes_supported: string[];
  client_id_metadata_document_supported: boolean;
  authorization_response_iss_parameter_supported: boolean;
}

/** Build the RFC 9728 protected-resource-metadata document. */
export function protectedResourceMetadata(config: FacadeConfig): ProtectedResourceMetadata {
  return {
    resource: config.mcpResource,
    authorization_servers: [facadeEndpoints(config).issuer],
    scopes_supported: [...config.scopesSupported],
    bearer_methods_supported: ["header"],
  };
}

/** Build the RFC 8414 authorization-server-metadata document. */
export function authorizationServerMetadata(config: FacadeConfig): AuthorizationServerMetadata {
  const ep = facadeEndpoints(config);
  return {
    issuer: ep.issuer,
    authorization_endpoint: ep.authorizationEndpoint,
    token_endpoint: ep.tokenEndpoint,
    revocation_endpoint: ep.revocationEndpoint,
    registration_endpoint: `${ep.issuer}/oauth/register`,
    jwks_uri: config.cognitoJwksUri,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [...config.scopesSupported],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

/** Handle GET /.well-known/oauth-protected-resource/mcp. */
export function handleProtectedResourceMetadata(config: FacadeConfig): FacadeResponse {
  return jsonResponse(200, protectedResourceMetadata(config), { "cache-control": "no-store" });
}

/** Handle GET /.well-known/oauth-authorization-server. */
export function handleAuthorizationServerMetadata(config: FacadeConfig): FacadeResponse {
  return jsonResponse(200, authorizationServerMetadata(config), { "cache-control": "no-store" });
}
