/**
 * The facade's pure auth handlers carry no logger, so their 4xx OAuth
 * control-flow rejections are invisible server-side. dispatchFacade bridges
 * that: after a facade response it logs any 4xx reason through ctx.obs.warn so
 * CloudWatch shows WHICH validation failed (RFC 6749 error + description, which
 * are non-secret). 2xx and 5xx are NOT warn-logged here.
 */

import {
  CimdFetcher,
  ClientResolver,
  type CognitoPort,
  type CognitoTokenSet,
  type KmsPort,
  s256Challenge,
} from "@nikovirtala/kiro-remote-auth";
import { describe, expect, test, vi } from "vitest";
import { dispatchFacade } from "../src/facade.ts";
import type { HttpRequest } from "../src/http.ts";
import type { Observability } from "../src/observability.ts";
import { NoopObservability } from "../src/observability.ts";
import { buildHarness, RESOURCE } from "./helpers.ts";

type LogCall = { message: string; attrs?: Record<string, unknown> };

/** An Observability that records every warn(...) AND info(...) call. */
function spyObs(): {
  obs: Observability;
  warns: LogCall[];
  infos: LogCall[];
} {
  const warns: LogCall[] = [];
  const infos: LogCall[] = [];
  const base = new NoopObservability();
  const obs: Observability = {
    ...base,
    error: base.error.bind(base),
    authFailure: base.authFailure.bind(base),
    cimdFetch: base.cimdFetch.bind(base),
    sessionLaunched: base.sessionLaunched.bind(base),
    flush: base.flush.bind(base),
    info(message, attrs) {
      infos.push({ message, ...(attrs ? { attrs } : {}) });
    },
    warn(message, attrs) {
      warns.push({ message, ...(attrs ? { attrs } : {}) });
    },
  };
  return { obs, warns, infos };
}

function tokenReq(form: Record<string, string>): HttpRequest {
  return {
    method: "POST",
    path: "/oauth/token",
    query: {},
    headers: {},
    params: {},
    host: "kiro.example.com",
    body: new URLSearchParams(form).toString(),
  };
}

describe("dispatchFacade logs OAuth 4xx rejections", () => {
  test("warns oauth_token_rejected with the error + description on a token 4xx", async () => {
    const h = buildHarness();
    const { obs, warns } = spyObs();
    h.ctx.obs = obs;

    // An unsupported grant_type is a deterministic 4xx that needs no deps.
    const res = await dispatchFacade(h.ctx, tokenReq({ grant_type: "password" }));

    expect(res?.status).toBe(400);
    const rejected = warns.find((w) => w.message === "oauth_token_rejected");
    expect(rejected).toBeDefined();
    expect(rejected?.attrs?.status).toBe(400);
    expect(rejected?.attrs?.error).toBe("unsupported_grant_type");
    expect(typeof rejected?.attrs?.error_description).toBe("string");
  });

  test("does NOT warn on a 2xx token response", async () => {
    const h = buildHarness();
    const { obs, warns } = spyObs();
    h.ctx.obs = obs;

    // A refresh grant that passes straight through to a fake Cognito succeeds.
    const fakeCognito = {
      async refresh() {
        return { access_token: "A", token_type: "Bearer", expires_in: 900 };
      },
    };
    h.ctx.facade.token = {
      repo: h.repo,
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake cognito/kms.
      cognito: fakeCognito as any,
      // biome-ignore lint/suspicious/noExplicitAny: kms unused on this path.
      kms: {} as any,
    };

    const res = await dispatchFacade(
      h.ctx,
      tokenReq({ grant_type: "refresh_token", refresh_token: "r" }),
    );

    expect(res?.status).toBe(200);
    expect(warns.find((w) => w.message === "oauth_token_rejected")).toBeUndefined();
  });

  test("warns oauth_register_rejected on a register 4xx (missing redirect_uris)", async () => {
    const h = buildHarness();
    const { obs, warns } = spyObs();
    h.ctx.obs = obs;

    const res = await dispatchFacade(h.ctx, {
      method: "POST",
      path: "/oauth/register",
      query: {},
      headers: {},
      params: {},
      host: "kiro.example.com",
      body: JSON.stringify({ client_name: "no redirect uris" }),
    });

    expect(res?.status).toBe(400);
    const rejected = warns.find((w) => w.message === "oauth_register_rejected");
    expect(rejected).toBeDefined();
    expect(rejected?.attrs?.status).toBe(400);
    expect(rejected?.attrs?.error).toBe("invalid_redirect_uri");
  });

  test("does NOT warn on a 2xx register response", async () => {
    const h = buildHarness();
    const { obs, warns } = spyObs();
    h.ctx.obs = obs;

    const res = await dispatchFacade(h.ctx, {
      method: "POST",
      path: "/oauth/register",
      query: {},
      headers: {},
      params: {},
      host: "kiro.example.com",
      body: JSON.stringify({ redirect_uris: ["https://app.example.com/cb"] }),
    });

    expect(res?.status).toBe(201);
    expect(warns.find((w) => w.message === "oauth_register_rejected")).toBeUndefined();
  });

  test("uses the injected obs.warn spy (sanity)", async () => {
    const h = buildHarness();
    const warn = vi.fn();
    const base = new NoopObservability();
    h.ctx.obs = { ...base, info: base.info.bind(base), warn } as unknown as Observability;
    await dispatchFacade(h.ctx, tokenReq({ grant_type: "password" }));
    expect(warn).toHaveBeenCalledWith(
      "oauth_token_rejected",
      expect.objectContaining({ error: "unsupported_grant_type", status: 400 }),
    );
  });
});

/* --------------------------- breadcrumb INFO logs -------------------------- */

const PRE_CLIENT_ID = "prereg-client";
const PRE_REDIRECT = "https://app.example.com/cb";

/** A CimdFetcher whose httpGet is never expected to run (pre-reg clients). */
function neverCalledCimd(): CimdFetcher {
  return new CimdFetcher({
    allowedHosts: ["kiro.example.com"],
    resolve: async () => ["8.8.8.8"],
    httpGet: async () => {
      throw new Error("CIMD must not be fetched for a pre-registered client");
    },
  });
}

/** A ClientResolver with a single pre-registered (non-CIMD) client. */
function preRegResolver(): ClientResolver {
  return new ClientResolver({
    cimd: neverCalledCimd(),
    preRegistered: [{ clientId: PRE_CLIENT_ID, clientName: "Pre", redirectUris: [PRE_REDIRECT] }],
  });
}

/** Minimal in-memory KMS: reversible base64 marker. */
const fakeKms: KmsPort = {
  async encrypt(plaintext: string): Promise<string> {
    return `enc:${Buffer.from(plaintext, "utf8").toString("base64")}`;
  },
  async decrypt(ciphertext: string): Promise<string> {
    return Buffer.from(ciphertext.slice(4), "base64").toString("utf8");
  },
};

const DEFAULT_TOKEN_SET: CognitoTokenSet = {
  access_token: "A",
  token_type: "Bearer",
  expires_in: 900,
};

/**
 * A fully-typed fake {@link CognitoPort} so the breadcrumb tests need no
 * `any`. `exchangeCode`/`refresh` resolve to a token set unless `throwOn`
 * names them, in which case they reject (exercising the exchange_failed path).
 */
function fakeCognito(opts: { throwOn?: "exchange" } = {}): CognitoPort {
  return {
    async exchangeCode(): Promise<CognitoTokenSet> {
      if (opts.throwOn === "exchange") {
        throw new Error("exchange boom");
      }
      return DEFAULT_TOKEN_SET;
    },
    async refresh(): Promise<CognitoTokenSet> {
      return DEFAULT_TOKEN_SET;
    },
    async revoke(): Promise<void> {},
  };
}

/** Build a GET /oauth/authorize request. */
function authorizeReq(query: Record<string, string>): HttpRequest {
  return {
    method: "GET",
    path: "/oauth/authorize",
    query,
    headers: {},
    params: {},
    host: "kiro.example.com",
  };
}

/** Build a GET /oauth/callback request. */
function callbackReq(query: Record<string, string>): HttpRequest {
  return {
    method: "GET",
    path: "/oauth/callback",
    query,
    headers: {},
    params: {},
    host: "kiro.example.com",
  };
}

/** The literal secret values used in these tests; none may appear in a log. */
const SECRETS = ["cognito-code", "our-code", "up-state", "client-code-verifier"];

/** Assert no secret literal leaked into any recorded log attribute. */
function assertNoSecrets(calls: LogCall[]): void {
  const json = JSON.stringify(calls);
  for (const s of SECRETS) {
    expect(json).not.toContain(s);
  }
}

describe("dispatchFacade emits OAuth INFO breadcrumbs", () => {
  const clientVerifier = "client-code-verifier-0000000000000000000000000000";
  const clientChallenge = s256Challenge(clientVerifier);

  function wireAuthorize(h: ReturnType<typeof buildHarness>): void {
    h.ctx.facade.authorize = {
      config: h.ctx.facade.config,
      repo: h.repo,
      clients: preRegResolver(),
      generateState: () => "up-state",
      generateVerifier: () => "up-verifier",
    };
  }

  test("authorize success logs oauth_authorize with forwarded qualified scopes + openid", async () => {
    const h = buildHarness();
    const { obs, infos } = spyObs();
    h.ctx.obs = obs;
    wireAuthorize(h);

    const res = await dispatchFacade(
      h.ctx,
      authorizeReq({
        response_type: "code",
        client_id: PRE_CLIENT_ID,
        redirect_uri: PRE_REDIRECT,
        code_challenge: clientChallenge,
        code_challenge_method: "S256",
        scope: "openid",
      }),
    );

    expect(res?.status).toBe(302);
    // The forwarded scope breadcrumb and strip-from-wire are both covered.
    expect(res?.body).toBe("");

    const log = infos.find((i) => i.message === "oauth_authorize");
    expect(log).toBeDefined();
    expect(log?.attrs?.status).toBe(302);
    const forwarded = String(log?.attrs?.forwarded_scope);
    expect(forwarded).toContain("openid");
    expect(forwarded).toContain(`${RESOURCE}/sessions:read`);
    expect(forwarded).toContain(`${RESOURCE}/sessions:write`);
    expect(forwarded).toContain(`${RESOURCE}/sessions:delete`);
    // client kind + requested scope + resource + redirect host.
    expect(log?.attrs?.client_kind).toBe("prereg-or-dynamic");
    expect(log?.attrs?.requested_scope).toBe("openid");
    expect(log?.attrs?.resource).toBe(RESOURCE);
    expect(log?.attrs?.resource_defaulted).toBe(true);
    expect(log?.attrs?.redirect_host).toBe("app.example.com");
  });

  test("authorize with a CIMD client logs client_kind cimd:<host>", async () => {
    const h = buildHarness();
    const { obs, infos } = spyObs();
    h.ctx.obs = obs;
    h.ctx.facade.authorize = {
      config: h.ctx.facade.config,
      repo: h.repo,
      clients: new ClientResolver({
        cimd: new CimdFetcher({
          allowedHosts: ["claude.ai"],
          resolve: async () => ["8.8.8.8"],
          httpGet: async () => ({
            status: 200,
            redirected: false,
            headers: {},
            body: JSON.stringify({
              client_id: "https://claude.ai/mcp.json",
              client_name: "Claude",
              redirect_uris: ["https://claude.ai/cb"],
            }),
            tooLarge: false,
          }),
        }),
        preRegistered: [],
      }),
      generateState: () => "up-state",
      generateVerifier: () => "up-verifier",
    };

    const res = await dispatchFacade(
      h.ctx,
      authorizeReq({
        response_type: "code",
        client_id: "https://claude.ai/mcp.json",
        redirect_uri: "https://claude.ai/cb",
        code_challenge: clientChallenge,
        code_challenge_method: "S256",
        resource: RESOURCE,
      }),
    );

    expect(res?.status).toBe(302);
    const log = infos.find((i) => i.message === "oauth_authorize");
    expect(log?.attrs?.client_kind).toBe("cimd:claude.ai");
    expect(log?.attrs?.resource_defaulted).toBe(false);
  });

  async function seedTx(h: ReturnType<typeof buildHarness>): Promise<void> {
    wireAuthorize(h);
    // Drive a real authorize to persist the OAUTH#TX under "up-state".
    await dispatchFacade(
      h.ctx,
      authorizeReq({
        response_type: "code",
        client_id: PRE_CLIENT_ID,
        redirect_uri: PRE_REDIRECT,
        code_challenge: clientChallenge,
        code_challenge_method: "S256",
        scope: "openid",
      }),
    );
  }

  test("callback success logs oauth_callback branch=success (no secrets)", async () => {
    const h = buildHarness();
    const { obs, infos } = spyObs();
    h.ctx.obs = obs;
    await seedTx(h);
    h.ctx.facade.callback = {
      config: h.ctx.facade.config,
      repo: h.repo,
      cognito: fakeCognito(),
      kms: fakeKms,
      generateCode: () => "our-code",
    };

    const res = await dispatchFacade(
      h.ctx,
      callbackReq({ code: "cognito-code", state: "up-state" }),
    );
    expect(res?.status).toBe(302);
    const log = infos.find((i) => i.message === "oauth_callback");
    expect(log?.attrs?.branch).toBe("success");
    expect(log?.attrs?.status).toBe(302);
    assertNoSecrets(infos);
  });

  test("callback with an upstream Cognito error logs branch=upstream_error", async () => {
    const h = buildHarness();
    const { obs, infos } = spyObs();
    h.ctx.obs = obs;
    await seedTx(h);
    h.ctx.facade.callback = {
      config: h.ctx.facade.config,
      repo: h.repo,
      cognito: fakeCognito(),
      kms: fakeKms,
    };

    const res = await dispatchFacade(
      h.ctx,
      callbackReq({ state: "up-state", error: "access_denied" }),
    );
    expect(res?.status).toBe(302);
    expect(infos.find((i) => i.message === "oauth_callback")?.attrs?.branch).toBe("upstream_error");
  });

  test("callback with an unknown transaction logs branch=tx_not_found", async () => {
    const h = buildHarness();
    const { obs, infos } = spyObs();
    h.ctx.obs = obs;
    h.ctx.facade.callback = {
      config: h.ctx.facade.config,
      repo: h.repo,
      cognito: fakeCognito(),
      kms: fakeKms,
    };

    const res = await dispatchFacade(h.ctx, callbackReq({ code: "c", state: "nope" }));
    expect(res?.status).toBe(400);
    expect(infos.find((i) => i.message === "oauth_callback")?.attrs?.branch).toBe("tx_not_found");
  });

  test("callback whose Cognito exchange throws logs branch=exchange_failed", async () => {
    const h = buildHarness();
    const { obs, infos } = spyObs();
    h.ctx.obs = obs;
    await seedTx(h);
    h.ctx.facade.callback = {
      config: h.ctx.facade.config,
      repo: h.repo,
      cognito: fakeCognito({ throwOn: "exchange" }),
      kms: fakeKms,
    };

    const res = await dispatchFacade(
      h.ctx,
      callbackReq({ code: "cognito-code", state: "up-state" }),
    );
    expect(res?.status).toBe(302);
    expect(infos.find((i) => i.message === "oauth_callback")?.attrs?.branch).toBe(
      "exchange_failed",
    );
  });

  test("callback missing code logs branch=missing_code", async () => {
    const h = buildHarness();
    const { obs, infos } = spyObs();
    h.ctx.obs = obs;
    await seedTx(h);
    h.ctx.facade.callback = {
      config: h.ctx.facade.config,
      repo: h.repo,
      cognito: fakeCognito(),
      kms: fakeKms,
    };

    const res = await dispatchFacade(h.ctx, callbackReq({ state: "up-state" }));
    expect(res?.status).toBe(400);
    expect(infos.find((i) => i.message === "oauth_callback")?.attrs?.branch).toBe("missing_code");
  });

  test("token success logs oauth_token with grant_type + success=true, no secrets", async () => {
    const h = buildHarness();
    const { obs, infos } = spyObs();
    h.ctx.obs = obs;
    h.ctx.facade.token = {
      repo: h.repo,
      cognito: fakeCognito(),
      kms: fakeKms,
    };

    const res = await dispatchFacade(
      h.ctx,
      tokenReq({ grant_type: "refresh_token", refresh_token: "secret-refresh" }),
    );
    expect(res?.status).toBe(200);
    const log = infos.find((i) => i.message === "oauth_token");
    expect(log?.attrs?.grant_type).toBe("refresh_token");
    expect(log?.attrs?.success).toBe(true);
    expect(log?.attrs?.status).toBe(200);
    // No refresh token value in the breadcrumb.
    expect(JSON.stringify(infos)).not.toContain("secret-refresh");
  });

  test("token failure logs oauth_token with success=false", async () => {
    const h = buildHarness();
    const { obs, infos } = spyObs();
    h.ctx.obs = obs;
    const res = await dispatchFacade(h.ctx, tokenReq({ grant_type: "password" }));
    expect(res?.status).toBe(400);
    const log = infos.find((i) => i.message === "oauth_token");
    expect(log?.attrs?.grant_type).toBe("password");
    expect(log?.attrs?.success).toBe(false);
  });
});
