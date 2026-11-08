import { describe, expect, test } from "vitest";
import type { DynamicClientStore, ResolvedDynamicClient } from "./clients.ts";
import type { FacadeConfig } from "./config.ts";
import { handleRegister, type RegisterDeps } from "./register.ts";
import type { FacadeRequest } from "./types.ts";

const config: FacadeConfig = {
  publicBaseUrl: "https://kiro.example.com",
  mcpResource: "https://kiro.example.com/mcp",
  scopesSupported: ["sessions:read", "sessions:write", "sessions:delete"],
  cognitoDomain: "https://kiro-pool.auth.us-east-1.amazoncognito.com",
  cognitoClientId: "facadeclient123",
  cognitoJwksUri: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc/.well-known/jwks.json",
  cimdAllowedHosts: ["claude.ai", "kiro.example.com"],
  kmsKeyId: "arn:aws:kms:us-east-1:111122223333:key/abc",
};

/** An in-memory DynamicClientStore fake. */
class FakeStore implements DynamicClientStore {
  readonly items = new Map<string, ResolvedDynamicClient>();
  async getClient(clientId: string): Promise<ResolvedDynamicClient | null> {
    return this.items.get(clientId) ?? null;
  }
  async putClient(client: ResolvedDynamicClient): Promise<void> {
    this.items.set(client.clientId, client);
  }
}

function deps(store: FakeStore, overrides: Partial<RegisterDeps> = {}): RegisterDeps {
  return {
    config,
    store,
    generateClientId: () => "fixedtoken",
    now: () => 1_700_000_000_000,
    ...overrides,
  };
}

function req(body: unknown): FacadeRequest {
  return {
    method: "POST",
    path: "/oauth/register",
    query: {},
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

describe("handleRegister (RFC 7591 Dynamic Client Registration)", () => {
  test("valid https registration returns 201 with an opaque mcp_ client_id and no secret", async () => {
    const store = new FakeStore();
    const res = await handleRegister(
      req({ redirect_uris: ["https://app.example.com/cb"] }),
      deps(store),
    );
    expect(res.status).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = JSON.parse(res.body);
    expect(body.client_id).toBe("mcp_fixedtoken");
    expect(body.client_id.startsWith("mcp_")).toBe(true);
    expect(body.client_id.startsWith("https://")).toBe(false);
    expect(body.redirect_uris).toEqual(["https://app.example.com/cb"]);
    expect(body.token_endpoint_auth_method).toBe("none");
    expect("client_secret" in body).toBe(false);
    expect(body.client_id_issued_at).toBe(1_700_000_000);
    // Persisted to the store.
    const stored = await store.getClient("mcp_fixedtoken");
    expect(stored?.redirectUris).toEqual(["https://app.example.com/cb"]);
    expect(stored?.tokenEndpointAuthMethod).toBe("none");
  });

  test("loopback http redirect_uri succeeds", async () => {
    const store = new FakeStore();
    const res = await handleRegister(req({ redirect_uris: ["http://127.0.0.1/cb"] }), deps(store));
    expect(res.status).toBe(201);
    expect(JSON.parse(res.body).redirect_uris).toEqual(["http://127.0.0.1/cb"]);
  });

  test("missing redirect_uris -> 400 invalid_redirect_uri", async () => {
    const res = await handleRegister(req({ client_name: "X" }), deps(new FakeStore()));
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_redirect_uri");
  });

  test("empty redirect_uris array -> 400 invalid_redirect_uri", async () => {
    const res = await handleRegister(req({ redirect_uris: [] }), deps(new FakeStore()));
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_redirect_uri");
  });

  test("non-loopback http redirect_uri -> 400 invalid_redirect_uri", async () => {
    const res = await handleRegister(
      req({ redirect_uris: ["http://evil.example.com/cb"] }),
      deps(new FakeStore()),
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_redirect_uri");
  });

  test("opaque/custom-scheme redirect_uri -> 400 invalid_redirect_uri", async () => {
    const res = await handleRegister(
      req({ redirect_uris: ["com.example.app:/cb"] }),
      deps(new FakeStore()),
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_redirect_uri");
  });

  test("token_endpoint_auth_method other than none -> 400 invalid_client_metadata", async () => {
    const res = await handleRegister(
      req({
        redirect_uris: ["https://app.example.com/cb"],
        token_endpoint_auth_method: "client_secret_basic",
      }),
      deps(new FakeStore()),
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_client_metadata");
  });

  test("non-JSON body -> 400 invalid_client_metadata", async () => {
    const res = await handleRegister(req("not json"), deps(new FakeStore()));
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_client_metadata");
  });

  test("defaults are applied when grant_types/response_types/auth_method omitted", async () => {
    const res = await handleRegister(
      req({ redirect_uris: ["https://app.example.com/cb"] }),
      deps(new FakeStore()),
    );
    const body = JSON.parse(res.body);
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(body.response_types).toEqual(["code"]);
    expect(body.token_endpoint_auth_method).toBe("none");
  });

  test("client_name is echoed when present", async () => {
    const res = await handleRegister(
      req({ redirect_uris: ["https://app.example.com/cb"], client_name: "MCP Inspector" }),
      deps(new FakeStore()),
    );
    expect(JSON.parse(res.body).client_name).toBe("MCP Inspector");
  });

  test("unsupported grant_types -> 400 invalid_client_metadata", async () => {
    const res = await handleRegister(
      req({
        redirect_uris: ["https://app.example.com/cb"],
        grant_types: ["client_credentials"],
      }),
      deps(new FakeStore()),
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_client_metadata");
  });
});
