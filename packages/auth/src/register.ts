/**
 * RFC 7591 Dynamic Client Registration.
 *
 * POST /oauth/register lets a standards-compliant MCP client (claude.ai remote
 * connector, MCP Inspector) register a PUBLIC PKCE client at runtime and get a
 * `client_id` before running the authorization-code + PKCE flow. The facade
 * already advertises CIMD + deploy-time pre-registered clients; this endpoint
 * adds the registration path CIMD-less clients need.
 *
 * The handler is a pure function of (request, deps): the dynamic-client store
 * is INJECTED (interface {@link DynamicClientStore}) so this stays testable
 * with an in-memory fake and packages/auth imports no @aws-sdk / core
 * Repository. Clients are PUBLIC only (`token_endpoint_auth_method` = "none");
 * NO client_secret is ever issued.
 */

import type { DynamicClientStore } from "./clients.ts";
import { isAllowedRedirectUri } from "./clients.ts";
import type { FacadeConfig } from "./config.ts";
import { generateOpaqueToken } from "./pkce.ts";
import { type FacadeRequest, type FacadeResponse, jsonResponse } from "./types.ts";

/** The grant types a facade public client may register (metadata-consistent). */
const SUPPORTED_GRANT_TYPES = ["authorization_code", "refresh_token"];
/** The response types a facade public client may register. */
const SUPPORTED_RESPONSE_TYPES = ["code"];

export interface RegisterDeps {
  config: FacadeConfig;
  store: DynamicClientStore;
  /** Injectable client_id entropy source (without the `mcp_` prefix). */
  generateClientId?: () => string;
  /** Injectable clock for deterministic `client_id_issued_at` in tests. */
  now?: () => number;
}

/** An RFC 7591 `invalid_client_metadata` 400. */
function invalidMetadata(description: string): FacadeResponse {
  return jsonResponse(
    400,
    { error: "invalid_client_metadata", error_description: description },
    { "cache-control": "no-store" },
  );
}

/** An RFC 7591 `invalid_redirect_uri` 400. */
function invalidRedirectUri(description: string): FacadeResponse {
  return jsonResponse(
    400,
    { error: "invalid_redirect_uri", error_description: description },
    { "cache-control": "no-store" },
  );
}

/** True when `value` is a non-empty array of strings drawn only from `allowed`. */
function isAllowedSubset(value: unknown, allowed: string[]): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === "string" && allowed.includes(v))
  );
}

/** Handle POST /oauth/register (RFC 7591 Dynamic Client Registration). */
export async function handleRegister(
  req: FacadeRequest,
  deps: RegisterDeps,
): Promise<FacadeResponse> {
  let metadata: Record<string, unknown>;
  try {
    const parsed = JSON.parse(req.body ?? "");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return invalidMetadata("request body must be a JSON object");
    }
    metadata = parsed as Record<string, unknown>;
  } catch {
    return invalidMetadata("request body must be a JSON object");
  }

  // redirect_uris: REQUIRED, non-empty array of allowed absolute URIs.
  const redirectUris = metadata.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return invalidRedirectUri("redirect_uris is required and must be a non-empty array");
  }
  if (!redirectUris.every((u) => typeof u === "string")) {
    return invalidRedirectUri("redirect_uris must be an array of strings");
  }
  for (const uri of redirectUris as string[]) {
    if (!isAllowedRedirectUri(uri)) {
      return invalidRedirectUri(
        `redirect_uri must be an absolute https URI or an http loopback URI: ${uri}`,
      );
    }
  }

  // token_endpoint_auth_method: public client only ("none").
  const authMethod = metadata.token_endpoint_auth_method;
  if (authMethod !== undefined && authMethod !== "none") {
    return invalidMetadata('token_endpoint_auth_method must be "none"');
  }

  // grant_types / response_types: default, else accept only supported subsets.
  let grantTypes = SUPPORTED_GRANT_TYPES;
  if (metadata.grant_types !== undefined) {
    if (!isAllowedSubset(metadata.grant_types, SUPPORTED_GRANT_TYPES)) {
      return invalidMetadata(
        `grant_types must be a non-empty subset of ${JSON.stringify(SUPPORTED_GRANT_TYPES)}`,
      );
    }
    grantTypes = metadata.grant_types;
  }
  let responseTypes = SUPPORTED_RESPONSE_TYPES;
  if (metadata.response_types !== undefined) {
    if (!isAllowedSubset(metadata.response_types, SUPPORTED_RESPONSE_TYPES)) {
      return invalidMetadata(
        `response_types must be a non-empty subset of ${JSON.stringify(SUPPORTED_RESPONSE_TYPES)}`,
      );
    }
    responseTypes = metadata.response_types;
  }

  // client_name: optional string (echo if present, else null).
  const clientNameRaw = metadata.client_name;
  if (clientNameRaw !== undefined && typeof clientNameRaw !== "string") {
    return invalidMetadata("client_name must be a string");
  }
  const clientName = (clientNameRaw as string | undefined) ?? null;

  // Issue an OPAQUE, non-URL client_id. The `mcp_` prefix guarantees it never
  // starts with `https://`, so the resolver routes it to the dynamic path and
  // never mistakes it for a CIMD URL. Public client: NO client_secret.
  const clientId = `mcp_${deps.generateClientId ? deps.generateClientId() : generateOpaqueToken()}`;
  const createdAt = deps.now ? deps.now() : Date.now();

  await deps.store.putClient({
    clientId,
    clientName,
    redirectUris: redirectUris as string[],
    grantTypes,
    responseTypes,
    tokenEndpointAuthMethod: "none",
    createdAt,
  });

  return jsonResponse(
    201,
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(createdAt / 1000),
      redirect_uris: redirectUris,
      grant_types: grantTypes,
      response_types: responseTypes,
      token_endpoint_auth_method: "none",
      ...(clientName ? { client_name: clientName } : {}),
    },
    { "cache-control": "no-store" },
  );
}
