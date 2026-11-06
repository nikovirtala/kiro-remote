import { describe, expect, test } from "vitest";
import { handleCliClientMetadata } from "./cli-client.ts";
import type { FacadeConfig } from "./config.ts";
import {
  authorizationServerMetadata,
  handleAuthorizationServerMetadata,
  handleProtectedResourceMetadata,
  protectedResourceMetadata,
} from "./metadata.ts";

const config: FacadeConfig = {
  publicBaseUrl: "https://kiro.example.com",
  mcpResource: "https://kiro.example.com/mcp",
  scopesSupported: ["sessions:read", "sessions:write", "sessions:delete"],
  cognitoDomain: "https://kiro-pool.auth.us-east-1.amazoncognito.com",
  cognitoClientId: "facadeclient123",
  cognitoJwksUri: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc/.well-known/jwks.json",
  cimdAllowedHosts: ["claude.ai", "kiro.example.com"],
  preRegisteredClientIds: [],
  kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/abc",
};

describe("RFC 9728 protected-resource-metadata", () => {
  test("matches the resource, authorization server, scopes, and bearer methods", () => {
    const doc = protectedResourceMetadata(config);
    expect(doc.resource).toBe("https://kiro.example.com/mcp");
    expect(doc.authorization_servers).toEqual(["https://kiro.example.com"]);
    expect(doc.scopes_supported).toEqual(["sessions:read", "sessions:write", "sessions:delete"]);
    expect(doc.bearer_methods_supported).toEqual(["header"]);
  });

  test("handler returns JSON with no-store", () => {
    const res = handleProtectedResourceMetadata(config);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(res.body).resource).toBe("https://kiro.example.com/mcp");
  });

  test("nothing is hardcoded: endpoints derive from publicBaseUrl", () => {
    const doc = protectedResourceMetadata({ ...config, publicBaseUrl: "https://other.host" });
    expect(doc.authorization_servers).toEqual(["https://other.host"]);
  });
});

describe("RFC 8414 authorization-server-metadata", () => {
  const doc = authorizationServerMetadata(config);

  test("advertises issuer=<host> and the facade endpoints", () => {
    expect(doc.issuer).toBe("https://kiro.example.com");
    expect(doc.authorization_endpoint).toBe("https://kiro.example.com/oauth/authorize");
    expect(doc.token_endpoint).toBe("https://kiro.example.com/oauth/token");
    expect(doc.revocation_endpoint).toBe("https://kiro.example.com/oauth/revoke");
  });

  test("jwks_uri points at Cognito", () => {
    expect(doc.jwks_uri).toBe(config.cognitoJwksUri);
  });

  test("declares S256-only PKCE, none auth, both grants, and CIMD", () => {
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
    expect(doc.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(doc.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(doc.client_id_metadata_document_supported).toBe(true);
    expect(doc.authorization_response_iss_parameter_supported).toBe(true);
  });

  test("has NO registration_endpoint", () => {
    expect("registration_endpoint" in doc).toBe(false);
  });

  test("handler returns JSON with no-store", () => {
    const res = handleAuthorizationServerMetadata(config);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("GET /oauth/clients/cli.json", () => {
  test("is a CIMD whose client_id equals its own URL and uses loopback + S256", () => {
    const res = handleCliClientMetadata(config);
    expect(res.status).toBe(200);
    const doc = JSON.parse(res.body);
    expect(doc.client_id).toBe("https://kiro.example.com/oauth/clients/cli.json");
    expect(doc.redirect_uris).toEqual(["http://127.0.0.1/callback"]);
    expect(doc.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(doc.token_endpoint_auth_method).toBe("none");
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
  });
});
