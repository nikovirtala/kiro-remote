import { Repository, type RepositoryDeps } from "@nikovirtala/kiro-remote-core";
import { beforeEach, describe, expect, test } from "vitest";
import { type AuthorizeTxData, effectiveUpstreamScope, handleAuthorize } from "./authorize.ts";
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

function makeRepo(ddb: FakeDdbClient, now?: () => number): Repository {
  const deps = {
    ddb,
    s3: new FakeS3Client(),
    tableName: "t",
    bucketName: "b",
    ...(now ? { now } : {}),
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

  const REQUIRED_SCOPES = [
    "https://kiro.example.com/mcp/sessions:read",
    "https://kiro.example.com/mcp/sessions:write",
    "https://kiro.example.com/mcp/sessions:delete",
  ];

  function scopeOf(res: { headers: Record<string, string> }): string[] {
    const scope = new URL(res.headers.location).searchParams.get("scope") ?? "";
    return scope.split(" ").filter((s) => s.length > 0);
  }

  test("forwards openid + all three fully-qualified resource scopes when client asks only openid", async () => {
    const q = baseQuery();
    q.scope = "openid";
    const res = await handleAuthorize(authorizeReq(q), deps());
    expect(res.status).toBe(302);
    const scopes = scopeOf(res);
    expect(scopes).toContain("openid");
    for (const s of REQUIRED_SCOPES) {
      expect(scopes).toContain(s);
    }
  });

  test("forwards the full required scope set when the client sends NO scope param", async () => {
    const q = baseQuery();
    delete q.scope;
    const res = await handleAuthorize(authorizeReq(q), deps());
    const scopes = scopeOf(res);
    expect(scopes).toContain("openid");
    for (const s of REQUIRED_SCOPES) {
      expect(scopes).toContain(s);
    }
  });

  test("forwards the full required scope set even when the client requests a subset", async () => {
    const q = baseQuery();
    q.scope = "sessions:read";
    const res = await handleAuthorize(authorizeReq(q), deps());
    const scopes = scopeOf(res);
    expect(scopes).toContain("openid");
    for (const s of REQUIRED_SCOPES) {
      expect(scopes).toContain(s);
    }
  });

  test("only requests scopes within Cognito's AllowedOAuthScopes (openid + three qualified)", async () => {
    const q = baseQuery();
    q.scope = "openid offline_access profile sessions:read";
    const res = await handleAuthorize(authorizeReq(q), deps());
    const scopes = scopeOf(res);
    const allowed = new Set(["openid", ...REQUIRED_SCOPES]);
    for (const s of scopes) {
      expect(allowed.has(s)).toBe(true);
    }
    // And still carries every required resource scope.
    for (const s of REQUIRED_SCOPES) {
      expect(scopes).toContain(s);
    }
  });

  test("stores the EFFECTIVE forwarded scope string in the OAUTH#TX item", async () => {
    const q = baseQuery();
    q.scope = "openid";
    const res = await handleAuthorize(authorizeReq(q), deps());
    const forwarded = new URL(res.headers.location).searchParams.get("scope");
    const tx = await repo.getOAuthTx("fixed-upstream-state");
    const data = tx?.data as unknown as AuthorizeTxData;
    expect(data.scope).toBe(forwarded);
    expect(data.scope).toBe(effectiveUpstreamScope(config));
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
    q.resource = "https://evil.example/mcp";
    const res = await handleAuthorize(authorizeReq(q), deps());
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    // Rejection redirects back to the CLIENT's registered redirect_uri.
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get("error")).toBe("invalid_target");
  });

  test("missing resource defaults to the facade's mcpResource and succeeds", async () => {
    const q = baseQuery();
    delete q.resource;
    const res = await handleAuthorize(authorizeReq(q), deps());
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    // Still a 302 to the Cognito authorization endpoint (same as with-resource).
    expect(location.origin + location.pathname).toBe(
      "https://kiro-pool.auth.us-east-1.amazoncognito.com/oauth2/authorize",
    );

    // The stored TX carries the defaulted resource.
    const tx = await repo.getOAuthTx("fixed-upstream-state");
    expect(tx).not.toBeNull();
    const data = tx?.data as unknown as AuthorizeTxData;
    expect(data.resource).toBe(config.mcpResource);
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

  test("pre-registered client authorizes with its logical id against the facade Cognito client", async () => {
    const q = baseQuery();
    q.client_id = "preclient";
    q.redirect_uri = "https://pre.example/cb";
    const res = await handleAuthorize(authorizeReq(q), deps());
    // Upstream is always the single facade app client, never one named after the client.
    expect(new URL(res.headers.location).searchParams.get("client_id")).toBe("facadeclient123");
    const tx = await repo.getOAuthTx("fixed-upstream-state");
    expect((tx?.data as { clientId?: string } | undefined)?.clientId).toBe("preclient");
  });

  test("pre-registered client may use only its listed redirect URIs", async () => {
    for (const redirect of [
      "https://pre.example/other",
      "https://pre.example/cb/",
      "https://evil.example/cb",
    ]) {
      const q = baseQuery();
      q.client_id = "preclient";
      q.redirect_uri = redirect;
      const res = await handleAuthorize(authorizeReq(q), deps());
      expect(res.status).toBe(400);
      expect(res.headers.location).toBeUndefined();
    }
    expect(ddb.size()).toBe(0);
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

describe("single-use, short-lived transaction and code (moved clock)", () => {
  const T0 = 1_700_000_000_000;
  const MINUTE = 60_000;
  const clientVerifier = generateCodeVerifier();

  /** Run /oauth/authorize against a repo whose clock the test controls. */
  async function authorized(now: () => number) {
    const repo = makeRepo(new FakeDdbClient(), now);
    const res = await handleAuthorize(
      authorizeReq({
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        code_challenge: s256Challenge(clientVerifier),
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
    expect(res.status).toBe(302);
    return repo;
  }

  const callbackReq = (state: string) => ({
    method: "GET",
    path: "/oauth/callback",
    query: { code: "cognito-code", state },
    headers: {},
  });

  const cognitoWithTokens = () =>
    new FakeCognito({
      codeTokenSet: { access_token: "A", token_type: "Bearer", expires_in: 900 },
    });

  test("a second callback with the same state is refused like an unknown state", async () => {
    const repo = await authorized(() => T0);
    const deps = {
      config,
      repo,
      cognito: cognitoWithTokens(),
      kms: new FakeKms(),
      generateCode: () => "our-code",
    };
    const first = await handleCallback(callbackReq("up-state"), deps);
    expect(first.status).toBe(302);
    expect(new URL(first.headers.location).searchParams.get("code")).toBe("our-code");

    const replay = await handleCallback(callbackReq("up-state"), deps);
    const unknown = await handleCallback(callbackReq("never-issued"), deps);
    expect(replay.status).toBe(400);
    expect(replay.headers.location).toBeUndefined();
    expect(replay.status).toBe(unknown.status);
    expect(replay.body).toBe(unknown.body);
    expect(replay.logContext).toEqual({ branch: "tx_not_found" });
  });

  test("the transaction is spent even when the callback carries an upstream error", async () => {
    const repo = await authorized(() => T0);
    const deps = { config, repo, cognito: cognitoWithTokens(), kms: new FakeKms() };
    const errored = await handleCallback(
      { ...callbackReq("up-state"), query: { state: "up-state", error: "access_denied" } },
      deps,
    );
    expect(new URL(errored.headers.location).searchParams.get("error")).toBe("access_denied");
    const again = await handleCallback(callbackReq("up-state"), deps);
    expect(again.status).toBe(400);
  });

  test("a transaction older than 10 minutes is refused at the callback", async () => {
    let now = T0;
    const repo = await authorized(() => now);
    now = T0 + 10 * MINUTE + 1000;
    const res = await handleCallback(callbackReq("up-state"), {
      config,
      repo,
      cognito: cognitoWithTokens(),
      kms: new FakeKms(),
    });
    expect(res.status).toBe(400);
    expect(res.logContext).toEqual({ branch: "tx_not_found" });
  });

  test("a code older than 60 seconds is refused at the token endpoint", async () => {
    let now = T0;
    const repo = await authorized(() => now);
    const kms = new FakeKms();
    await handleCallback(callbackReq("up-state"), {
      config,
      repo,
      cognito: cognitoWithTokens(),
      kms,
      generateCode: () => "our-code",
    });
    now = T0 + 61_000;
    const res = await handleToken(
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
      { repo, cognito: cognitoWithTokens(), kms },
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_grant");
  });
});

/** The DynamicClientStore the api wiring builds over the Repository, minus the field mapping. */
function repoBackedStore(repo: Repository): DynamicClientStore {
  return {
    async getClient(clientId) {
      const item = await repo.getClient(clientId);
      return item ? { ...item } : null;
    },
    async putClient(client) {
      await repo.putClient({ PK: `CLIENT#${client.clientId}`, SK: "A", ...client });
    },
    async renewClient(clientId, currentTtl) {
      await repo.renewClient(clientId, currentTtl);
    },
  };
}

describe("registered clients expire and are extended when used (moved clock)", () => {
  const T0 = 1_700_000_000_000;
  const DAY = 24 * 60 * 60 * 1000;
  const DYN_ID = "mcp_dyn1";
  const DYN_REDIRECT = "https://dyn.example.com/cb";
  const clientVerifier = generateCodeVerifier();

  async function setup(now: () => number) {
    const ddb = new FakeDdbClient();
    const repo = makeRepo(ddb, now);
    const store = repoBackedStore(repo);
    await store.putClient({
      clientId: DYN_ID,
      clientName: "Dyn",
      redirectUris: [DYN_REDIRECT],
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      tokenEndpointAuthMethod: "none",
      createdAt: now(),
    });
    const clients = new ClientResolver({
      cimd: cimdFetcherFor(CIMD_DOC),
      preRegistered: [],
      dynamic: store,
    });
    return { ddb, repo, clients };
  }

  const authorize = (repo: Repository, clients: ClientResolver) =>
    handleAuthorize(
      authorizeReq({
        response_type: "code",
        client_id: DYN_ID,
        redirect_uri: DYN_REDIRECT,
        code_challenge: s256Challenge(clientVerifier),
        code_challenge_method: "S256",
        resource: config.mcpResource,
      }),
      { config, repo, clients },
    );

  test("a client past its 180 day ttl is unknown at /oauth/authorize", async () => {
    let now = T0;
    const { repo, clients } = await setup(() => now);
    now = T0 + 179 * DAY;
    expect((await authorize(repo, clients)).status).toBe(302);
    // That authorize extended it, so 179 days later it is still known ...
    now = T0 + 358 * DAY;
    expect((await authorize(repo, clients)).status).toBe(302);
    // ... and a client left alone for more than 180 days is not.
    now += 181 * DAY;
    const res = await authorize(repo, clients);
    expect(res.status).toBe(400);
    expect(res.headers.location).toBeUndefined();
    expect(res.body).toContain("invalid_client");
  });

  test("authorize extends the ttl at most once a day", async () => {
    let now = T0;
    const { ddb, repo, clients } = await setup(() => now);
    now = T0 + 60_000;
    await authorize(repo, clients);
    now = T0 + 12 * 60 * 60 * 1000;
    await authorize(repo, clients);
    expect(ddb.updates).toBe(0);
    now = T0 + 25 * 60 * 60 * 1000;
    await authorize(repo, clients);
    await authorize(repo, clients);
    expect(ddb.updates).toBe(1);
    now += DAY + 60_000;
    await authorize(repo, clients);
    expect(ddb.updates).toBe(2);
  });

  test("a failed extension does not fail the authorize", async () => {
    const { repo, clients } = await setup(() => T0 + 2 * DAY);
    const broken = new ClientResolver({
      cimd: cimdFetcherFor(CIMD_DOC),
      preRegistered: [],
      dynamic: {
        ...repoBackedStore(repo),
        async renewClient() {
          throw new Error("throttled");
        },
      },
    });
    expect(clients).toBeDefined();
    expect((await authorize(repo, broken)).status).toBe(302);
  });

  const refreshReq = (body: Record<string, string>) => ({
    method: "POST",
    path: "/oauth/token",
    query: {},
    headers: {},
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: "r",
      ...body,
    }).toString(),
  });

  test("a refresh from an expired registration gets invalid_client (register again)", async () => {
    let now = T0;
    const { repo, clients } = await setup(() => now);
    const deps = { repo, cognito: new FakeCognito({}), kms: new FakeKms(), clients };
    expect((await handleToken(refreshReq({ client_id: DYN_ID }), deps)).status).toBe(200);
    now = T0 + 181 * DAY + 2 * DAY;
    const res = await handleToken(refreshReq({ client_id: DYN_ID }), deps);
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_client");
    // The refresh token is the credential: no client_id, no lookup.
    expect((await handleToken(refreshReq({}), deps)).status).toBe(200);
  });

  test("a refresh from a CIMD or pre-registered client is not looked up", async () => {
    const { repo } = await setup(() => T0);
    let lookups = 0;
    const clients = new ClientResolver({
      cimd: cimdFetcherFor(CIMD_DOC),
      preRegistered: [{ clientId: "preclient", clientName: "Pre", redirectUris: ["https://p/cb"] }],
      dynamic: {
        ...repoBackedStore(repo),
        async getClient() {
          lookups += 1;
          return null;
        },
      },
    });
    const deps = { repo, cognito: new FakeCognito({}), kms: new FakeKms(), clients };
    expect((await handleToken(refreshReq({ client_id: CLIENT_ID }), deps)).status).toBe(200);
    expect((await handleToken(refreshReq({ client_id: "preclient" }), deps)).status).toBe(200);
    expect(lookups).toBe(0);
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
      async renewClient() {},
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
