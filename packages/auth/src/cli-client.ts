/**
 * GET /oauth/clients/cli.json.
 *
 * The CIMD document for the `kiro-remote` CLI itself. The client_id is this
 * document's own URL (https://<host>/oauth/clients/cli.json), it declares a
 * loopback redirect_uri (http://127.0.0.1/callback, any port per the OAuth 2.1
 * native-app loopback rule), authorization_code + refresh_token grants, public
 * `none` auth, and S256 PKCE.
 */

import { type FacadeConfig, facadeEndpoints } from "./config.ts";
import { type FacadeResponse, jsonResponse } from "./types.ts";

/** Build the CLI CIMD document. */
export function cliClientMetadata(config: FacadeConfig): Record<string, unknown> {
  const ep = facadeEndpoints(config);
  return {
    client_id: ep.cliClientMetadata,
    client_name: "kiro-remote CLI",
    client_uri: ep.issuer,
    redirect_uris: ["http://127.0.0.1/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    code_challenge_methods_supported: ["S256"],
  };
}

/** Handle GET /oauth/clients/cli.json. */
export function handleCliClientMetadata(config: FacadeConfig): FacadeResponse {
  return jsonResponse(200, cliClientMetadata(config), {
    "cache-control": "public, max-age=3600",
  });
}
