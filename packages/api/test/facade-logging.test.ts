/**
 * The facade's pure auth handlers carry no logger, so their 4xx OAuth
 * control-flow rejections are invisible server-side. dispatchFacade bridges
 * that: after a facade response it logs any 4xx reason through ctx.obs.warn so
 * CloudWatch shows WHICH validation failed (RFC 6749 error + description, which
 * are non-secret). 2xx and 5xx are NOT warn-logged here.
 */

import { describe, expect, test, vi } from "vitest";
import { dispatchFacade } from "../src/facade.ts";
import type { HttpRequest } from "../src/http.ts";
import type { Observability } from "../src/observability.ts";
import { NoopObservability } from "../src/observability.ts";
import { buildHarness } from "./helpers.ts";

/** An Observability that records every warn(message, attrs) call. */
function spyObs(): {
  obs: Observability;
  warns: Array<{ message: string; attrs?: Record<string, unknown> }>;
} {
  const warns: Array<{ message: string; attrs?: Record<string, unknown> }> = [];
  const base = new NoopObservability();
  const obs: Observability = {
    ...base,
    info: base.info.bind(base),
    error: base.error.bind(base),
    authFailure: base.authFailure.bind(base),
    cimdFetch: base.cimdFetch.bind(base),
    sessionLaunched: base.sessionLaunched.bind(base),
    flush: base.flush.bind(base),
    warn(message, attrs) {
      warns.push({ message, ...(attrs ? { attrs } : {}) });
    },
  };
  return { obs, warns };
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

  test("uses the injected obs.warn spy (sanity)", async () => {
    const h = buildHarness();
    const warn = vi.fn();
    h.ctx.obs = { ...new NoopObservability(), warn } as unknown as Observability;
    await dispatchFacade(h.ctx, tokenReq({ grant_type: "password" }));
    expect(warn).toHaveBeenCalledWith(
      "oauth_token_rejected",
      expect.objectContaining({ error: "unsupported_grant_type", status: 400 }),
    );
  });
});
