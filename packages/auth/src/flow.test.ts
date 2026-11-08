import { Repository, type RepositoryDeps } from "@nikovirtala/kiro-remote-core";
import { beforeEach, describe, expect, test } from "vitest";
import { type AuthorizeTxData, handleAuthorize } from "./authorize.ts";
import { handleCallback } from "./callback.ts";
import { CimdFetcher } from "./cimd.ts";
import {
  ClientResolver,
  type DynamicClientStore,
  type ResolvedDynamicClient,
  redirectUriAllowed,
} from "./clients.ts";
import type { FacadeConfig } from "./config.ts";
import { generateCodeVerifier, s256Challenge, sha256Hex } from "./pkce.ts";
import { FakeCognito, FakeDdbClient, FakeKms, FakeS3Client } from "./test-helpers.ts";
import { handleRevoke, handleToken } from "./token.ts";
import { parseForm } from "./types.ts";

const config: FacadeConfig = {
  publicBaseUrl: "https://kiro.example.com",
  mcpResource: "https://kiro.example.com/mcp",
  scopesSupported: ["sessions:read", "sessions:write", "sessions:delete"],
  cognitoDomain: "https://kiro-pool.auth.us-east-1.amazoncognito.com",
  cognitoClientId: "facadeclient123",
  cognitoJwksUri: "https://cognito-idp/jwks.json",
  cimdAllowedHosts: ["claude.ai", "kiro.example.com"],
  kmsKeyId: "kms-key",
};

const CLIENT_ID = "https://claude.ai/mcp.json";
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

function makeRepo(ddb: FakeDdbClient): Repository {
  const deps = {
    ddb,
    s3: new FakeS3Client(),
    tableName: "t",
    bucketName: "b",
  } as unknown as RepositoryDeps;
  return new Repository(deps);
}

function cimdFetcherFor(doc: Record<string, unknown>): CimdFetcher {
  return new CimdFetcher({
    allowedHosts: config.cimdAllowedHosts,
    resolve: async () => ["8.8.8.8"],
    httpGet: async () => ({
      status: 200,
      redirected: false,
      headers: {},
      body: JSON.stringify(doc),
      tooLarge: false,
    }),
  });
}

const CIMD_DOC = {
  client_id: CLIENT_ID,
  client_name: "Claude",
  redirect_uris: [REDIRECT_URI],
};

function clientResolver(): ClientResolver {
  return new ClientResolver({
    cimd: cimdFetcherFor(CIMD_DOC),
    preRegistered: [
      { clientId: "preclient", clientName: "Pre", redirectUris: ["https://pre.example/cb"] },
    ],
  });
}

interface Query {
  [key: string]: string;
}

function authorizeReq(query: Query) {
  return { method: "GET", path: "/oauth/authorize", query, headers: {} };
}

describe("GET /oauth/authorize", () => {
  let ddb: FakeDdbClient;
  let repo: Repository;
  const clientVerifier = generateCodeVerifier();
  const clientChallenge = s256Challenge(clientVerifier);

  beforeEach(() => {
    ddb = new FakeDdbClient();
    repo = makeRepo(ddb);
  });

  function deps() {
    return {
      config,
      repo,
      clients: clientResolver(),
      generateState: () => "fixed-upstream-state",
      generateVerifier: () => "facade-upstream-verifier",
    };
  }

  const baseQuery = (): Query => ({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: clientChallenge,
    code_challenge_method: "S256",
    resource: config.mcpResource,
    state: "client-state",
    scope: "sessions:read sessions:write",
  });

  test("redirects to Cognito with the facade's own PKCE + state and stores a TX", async () => {
    const res = await handleAuthorize(authorizeReq(baseQuery()), deps());
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.origin + location.pathname).toBe(
      "https://kiro-pool.auth.us-east-1.amazoncognito.com/oauth2/authorize",
    );
    expect(location.searchParams.get("client_id")).toBe("facadeclient123");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toBe(
      s256Challenge("facade-upstream-verifier"),
    );
    expect(location.searchParams.get("state")).toBe("fixed-upstream-state");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://kiro.example.com/oauth/callback",
    );

    const tx = await repo.getOAuthTx("fixed-upstream-state");
    expect(tx).not.toBeNull();
    const data = tx?.data as unknown as AuthorizeTxData;
    expect(data.clientCodeChallenge).toBe(clientChallenge);
    expect(data.redirectUri).toBe(REDIRECT_URI);
    expect(data.cognitoVerifier).toBe("facade-upstream-verifier");
  });

  test("missing PKCE challenge redirects to the client with invalid_request", async () => {
    const q = baseQuery();
    delete q.code_challenge;
    const res = await handleAuthorize(authorizeReq(q), deps());
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get("error")).toBe("invalid_request");
    expect(location.searchParams.get("state")).toBe("client-state");
  });

  test("plain (non-S256) PKCE is rejected", async () => {
    const q = baseQuery();
    q.code_challenge_method = "plain";
    const res = await handleAuthorize(authorizeReq(q), deps());
    expect(new URL(res.headers.location).searchParams.get("error")).toBe("invalid_request");
  });

  test("wrong resource is rejected with invalid_target", async () => {
    const q = baseQuery();
    q.resource = "https://kiro.example.com/other";
    const res = await handleAuthorize(authorizeReq(q), deps());
    expect(new URL(res.headers.location).searchParams.get("error")).toBe("invalid_target");
  });

  test("unregistered redirect_uri renders an error page and does NOT redirect", async () => {
    const q = baseQuery();
    q.redirect_uri = "https://claude.ai/evil";
    const res = await handleAuthorize(authorizeReq(q), deps());
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers.location).toBeUndefined();
  });

  test("unknown client renders an error page, never redirects", async () => {
    const q = baseQuery();
    q.client_id = "https://claude.ai/missing.json";
    const resolver = new ClientResolver({
      cimd: cimdFetcherFor(CIMD_DOC),
      preRegistered: [],
    });
    const res = await handleAuthorize(authorizeReq(q), { ...deps(), clients: resolver });
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toContain("text/html");
  });

  test("pre-registered client resolves without CIMD", async () => {
    const q = baseQuery();
    q.client_id = "preclient";
    q.redirect_uri = "https://pre.example/cb";
    const res = await handleAuthorize(authorizeReq(q), deps());
    expect(res.status).toBe(302);
    expect(new URL(res.headers.location).pathname).toBe("/oauth2/authorize");
  });
});

describe("full authorize -> callback -> token happy path", () => {
  test("returns the Cognito token set unchanged, single-use, with no-store", async () => {
    const ddb = new FakeDdbClient();
    const repo = makeRepo(ddb);
    const cognito = new FakeCognito({
      codeTokenSet: {
        access_token: "ACCESS",
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: "REFRESH",
        id_token: "ID",
        scope: "openid https://kiro.example.com/mcp/sessions:read",
      },
    });
    const kms = new FakeKms();

    const clientVerifier = generateCodeVerifier();
    const clientChallenge = s256Challenge(clientVerifier);

    // 1. authorize
    const authRes = await handleAuthorize(
      authorizeReq({
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        code_challenge: clientChallenge,
        code_challenge_method: "S256",
        resource: config.mcpResource,
        state: "client-state",
      }),
      {
        config,
        repo,
        clients: clientResolver(),
        generateState: () => "up-state",
        generateVerifier: () => "up-verifier",
      },
    );
    expect(authRes.status).toBe(302);

    // 2. callback (Cognito redirects back with its code + our upstream state)
    const cbRes = await handleCallback(
      {
        method: "GET",
        path: "/oauth/callback",
        query: { code: "cognito-code", state: "up-state" },
        headers: {},
      },
      { config, repo, cognito, kms, generateCode: () => "our-code" },
    );
    expect(cbRes.status).toBe(302);
    const cbLocation = new URL(cbRes.headers.location);
    expect(cbLocation.origin + cbLocation.pathname).toBe(REDIRECT_URI);
    expect(cbLocation.searchParams.get("code")).toBe("our-code");
    expect(cbLocation.searchParams.get("state")).toBe("client-state");
    // RFC 9207: iss equals the advertised AS issuer (publicBaseUrl).
    expect(cbLocation.searchParams.get("iss")).toBe("https://kiro.example.com");
    // The facade used ITS OWN verifier for the upstream exchange.
    expect(cognito.exchanges[0].codeVerifier).toBe("up-verifier");

    // 3. token exchange
    const tokRes = await handleToken(
      {
        method: "POST",
        path: "/oauth/token",
        query: {},
        headers: {},
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "our-code",
          code_verifier: clientVerifier,
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
        }).toString(),
      },
      { repo, cognito, kms },
    );
    expect(tokRes.status).toBe(200);
    expect(tokRes.headers["cache-control"]).toBe("no-store");
    const tokens = JSON.parse(tokRes.body);
    expect(tokens.access_token).toBe("ACCESS");
    expect(tokens.refresh_token).toBe("REFRESH");
    expect(tokens.id_token).toBe("ID");

    // 4. replay the SAME code -> rejected (delete-on-first-use)
    const replay = await handleToken(
      {
        method: "POST",
        path: "/oauth/token",
        query: {},
        headers: {},
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "our-code",
          code_verifier: clientVerifier,
          client_id: CLIENT_ID,
          redirect_uri: REDIRECT_URI,
        }).toString(),
      },
      { repo, cognito, kms },
    );
    expect(replay.status).toBe(400);
    expect(JSON.parse(replay.body).error).toBe("invalid_grant");
  });
});

describe("ported loopback redirect_uri round-trip (native CLI)", () => {
  // The CLI registers a PORT-LESS loopback (http://127.0.0.1/callback) in its
  // CIMD doc but, per the OAuth 2.1 native-app rule, presents a PORT-FULL
  // ephemeral-port URI at BOTH authorize and token time. The facade MUST store
  // the exact client-presented ported URI at authorize and compare against the
  // same ported URI at token time, or the token exchange fails invalid_grant.
  const LOOPBACK_CLIENT_ID = "https://kiro.example.com/oauth/clients/cli.json";
  const PORTLESS_REGISTERED = "http://127.0.0.1/callback";
  const PORTED_REDIRECT = "http://127.0.0.1:54321/callback";

  function loopbackResolver(): ClientResolver {
    return new ClientResolver({
      cimd: cimdFetcherFor({
        client_id: LOOPBACK_CLIENT_ID,
        client_name: "kiro-remote CLI",
        redirect_uris: [PORTLESS_REGISTERED],
      }),
      preRegistered: [],
    });
  }

  test("authorize stores the ported URI and token accepts the same ported URI", async () => {
    const ddb = new FakeDdbClient();
    const repo = makeRepo(ddb);
    const cognito = new FakeCognito({
      codeTokenSet: { access_token: "ACCESS", token_type: "Bearer", expires_in: 900 },
    });
    const kms = new FakeKms();

    const clientVerifier = generateCodeVerifier();
    const clientChallenge = s256Challenge(clientVerifier);

    // 1. authorize with the PORTED loopback redirect_uri.
    const authRes = await handleAuthorize(
      authorizeReq({
        response_type: "code",
        client_id: LOOPBACK_CLIENT_ID,
        redirect_uri: PORTED_REDIRECT,
        code_challenge: clientChallenge,
        code_challenge_method: "S256",
        resource: config.mcpResource,
        state: "client-state",
      }),
      {
        config,
        repo,
        clients: loopbackResolver(),
        generateState: () => "up-state",
        generateVerifier: () => "up-verifier",
      },
    );
    expect(authRes.status).toBe(302);

    // The facade must persist the EXACT client-presented ported URI.
    const tx = await repo.getOAuthTx("up-state");
    expect(tx).not.toBeNull();
    const txData = tx?.data as unknown as AuthorizeTxData;
    expect(txData.redirectUri).toBe(PORTED_REDIRECT);

    // 2. callback mints our code bound to the stored ported redirect_uri.
    const cbRes = await handleCallback(
      {
        method: "GET",
        path: "/oauth/callback",
        query: { code: "cognito-code", state: "up-state" },
        headers: {},
      },
      { config, repo, cognito, kms, generateCode: () => "our-code" },
    );
    expect(cbRes.status).toBe(302);
    expect(new URL(cbRes.headers.location).origin + new URL(cbRes.headers.location).pathname).toBe(
      "http://127.0.0.1:54321/callback",
    );

    // 3. token exchange with the SAME ported redirect_uri must SUCCEED.
    const tokRes = await handleToken(
      {
        method: "POST",
        path: "/oauth/token",
        query: {},
        headers: {},
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "our-code",
          code_verifier: clientVerifier,
          client_id: LOOPBACK_CLIENT_ID,
          redirect_uri: PORTED_REDIRECT,
        }).toString(),
      },
      { repo, cognito, kms },
    );
    expect(tokRes.status).toBe(200);
    expect(JSON.parse(tokRes.body).access_token).toBe("ACCESS");
  });

  test("redirectUriAllowed accepts the ported loopback against a port-less registration", () => {
    expect(redirectUriAllowed([PORTLESS_REGISTERED], PORTED_REDIRECT)).toBe(true);
  });
});

describe("POST /oauth/token error paths", () => {
  let repo: Repository;
  const cognito = new FakeCognito({});
  const kms = new FakeKms();
  const clientVerifier = generateCodeVerifier();
  const clientChallenge = s256Challenge(clientVerifier);

  async function seedCode(overrides: Partial<{ clientId: string; redirectUri: string }> = {}) {
    const ddb = new FakeDdbClient();
    repo = makeRepo(ddb);
    const encrypted = await kms.encrypt(
      JSON.stringify({ access_token: "A", token_type: "Bearer", expires_in: 900 }),
    );
    await repo.putOAuthCode(sha256Hex("our-code"), {
      encryptedTokens: encrypted,
      clientId: overrides.clientId ?? CLIENT_ID,
      redirectUri: overrides.redirectUri ?? REDIRECT_URI,
      codeChallenge: clientChallenge,
    });
  }

  function tokenReq(form: Record<string, string>) {
    return {
      method: "POST",
      path: "/oauth/token",
      query: {},
      headers: {},
      body: new URLSearchParams(form).toString(),
    };
  }

  test("wrong code_verifier is rejected with invalid_grant", async () => {
    await seedCode();
    const res = await handleToken(
      tokenReq({
        grant_type: "authorization_code",
        code: "our-code",
        code_verifier: generateCodeVerifier(),
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
      }),
      { repo, cognito, kms },
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_grant");
  });

  test("missing code_verifier is rejected with invalid_request", async () => {
    await seedCode();
    const res = await handleToken(
      tokenReq({
        grant_type: "authorization_code",
        code: "our-code",
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
      }),
      { repo, cognito, kms },
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_request");
  });

  test("mismatched client_id / redirect_uri are rejected", async () => {
    await seedCode();
    const badClient = await handleToken(
      tokenReq({
        grant_type: "authorization_code",
        code: "our-code",
        code_verifier: clientVerifier,
        client_id: "https://claude.ai/other.json",
        redirect_uri: REDIRECT_URI,
      }),
      { repo, cognito, kms },
    );
    expect(JSON.parse(badClient.body).error).toBe("invalid_grant");

    await seedCode();
    const badRedirect = await handleToken(
      tokenReq({
        grant_type: "authorization_code",
        code: "our-code",
        code_verifier: clientVerifier,
        client_id: CLIENT_ID,
        redirect_uri: "https://claude.ai/evil",
      }),
      { repo, cognito, kms },
    );
    expect(JSON.parse(badRedirect.body).error).toBe("invalid_grant");
  });

  test("refresh_token grant passes straight through to Cognito", async () => {
    await seedCode();
    const res = await handleToken(
      tokenReq({ grant_type: "refresh_token", refresh_token: "r-token" }),
      { repo, cognito, kms },
    );
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(cognito.refreshes.at(-1)?.refreshToken).toBe("r-token");
  });

  test("unsupported grant_type is rejected", async () => {
    await seedCode();
    const res = await handleToken(tokenReq({ grant_type: "password" }), { repo, cognito, kms });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe("unsupported_grant_type");
  });
});

describe("GET /oauth/callback error paths", () => {
  test("expired/unknown transaction renders an error page", async () => {
    const ddb = new FakeDdbClient();
    const repo = makeRepo(ddb);
    const res = await handleCallback(
      { method: "GET", path: "/oauth/callback", query: { code: "x", state: "nope" }, headers: {} },
      { config, repo, cognito: new FakeCognito({}), kms: new FakeKms() },
    );
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toContain("text/html");
  });
});

describe("POST /oauth/revoke", () => {
  test("passes the token through to Cognito and returns 200 no-store", async () => {
    const cognito = new FakeCognito({});
    const res = await handleRevoke(
      {
        method: "POST",
        path: "/oauth/revoke",
        query: {},
        headers: {},
        body: new URLSearchParams({ token: "r-token" }).toString(),
      },
      { cognito },
    );
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(cognito.revocations.at(-1)?.token).toBe("r-token");
  });

  test("parseForm handles empty bodies", () => {
    expect(parseForm(undefined)).toEqual({});
  });
});

describe("ClientResolver dynamic-store lookup (RFC 7591)", () => {
  function dynamicStore(client: ResolvedDynamicClient | null): DynamicClientStore {
    const map = new Map<string, ResolvedDynamicClient>();
    if (client) {
      map.set(client.clientId, client);
    }
    return {
      async getClient(id) {
        return map.get(id) ?? null;
      },
      async putClient(c) {
        map.set(c.clientId, c);
      },
    };
  }

  const dynClient: ResolvedDynamicClient = {
    clientId: "mcp_dyn123",
    clientName: "Dynamic MCP Client",
    redirectUris: ["https://dyn.example.com/cb"],
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
    createdAt: 1_700_000_000_000,
  };

  function resolverWithDynamic(client: ResolvedDynamicClient | null): ClientResolver {
    return new ClientResolver({
      cimd: cimdFetcherFor(CIMD_DOC),
      preRegistered: [
        { clientId: "preclient", clientName: "Pre", redirectUris: ["https://pre.example/cb"] },
      ],
      dynamic: dynamicStore(client),
    });
  }

  test("resolves a dynamically-registered mcp_ client and its redirect_uris", async () => {
    const resolved = await resolverWithDynamic(dynClient).resolve("mcp_dyn123");
    expect(resolved.clientId).toBe("mcp_dyn123");
    expect(resolved.clientName).toBe("Dynamic MCP Client");
    expect(resolved.redirectUris).toEqual(["https://dyn.example.com/cb"]);
    expect(resolved.isCimd).toBe(false);
  });

  test("still resolves a CIMD (https://) client ahead of the dynamic store", async () => {
    const resolved = await resolverWithDynamic(dynClient).resolve(CLIENT_ID);
    expect(resolved.isCimd).toBe(true);
    expect(resolved.redirectUris).toEqual([REDIRECT_URI]);
  });

  test("still resolves a pre-registered client ahead of the dynamic store", async () => {
    const resolved = await resolverWithDynamic(dynClient).resolve("preclient");
    expect(resolved.isCimd).toBe(false);
    expect(resolved.redirectUris).toEqual(["https://pre.example/cb"]);
  });

  test("falls back to clientId as clientName when the stored name is null", async () => {
    const resolved = await resolverWithDynamic({ ...dynClient, clientName: null }).resolve(
      "mcp_dyn123",
    );
    expect(resolved.clientName).toBe("mcp_dyn123");
  });

  test("throws invalid_client when the dynamic store misses too", async () => {
    await expect(resolverWithDynamic(null).resolve("mcp_missing")).rejects.toThrow(
      "unknown client_id",
    );
  });
});
