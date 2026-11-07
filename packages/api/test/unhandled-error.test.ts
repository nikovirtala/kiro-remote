import { describe, expect, test } from "vitest";
import type { HttpRequest } from "../src/http.ts";
import type {
  AuthFailureReason,
  CimdOutcome,
  LaunchPath,
  Observability,
} from "../src/observability.ts";
import { route } from "../src/router.ts";
import { authHeader, buildHarness, mintToken } from "./helpers.ts";

/** An Observability that captures error() calls so we can assert on them. */
class SpyObservability implements Observability {
  readonly errors: Array<{ message: string; attributes?: Record<string, unknown> }> = [];
  info(): void {}
  warn(): void {}
  error(message: string, attributes?: Record<string, unknown>): void {
    this.errors.push({ message, ...(attributes ? { attributes } : {}) });
  }
  authFailure(_reason: AuthFailureReason): void {}
  cimdFetch(_outcome: CimdOutcome): void {}
  sessionLaunched(_path: LaunchPath): void {}
  flush(): void {}
}

function req(overrides: Partial<HttpRequest> & { method: string; path: string }): HttpRequest {
  return {
    query: {},
    headers: {},
    params: {},
    host: "kiro.example.com",
    ...overrides,
  };
}

describe("router error-level logging of unexpected failures", () => {
  test("an unexpected throw (mapped 500) is logged via obs.error with redacted context", async () => {
    const h = buildHarness();
    const obs = new SpyObservability();
    h.ctx.obs = obs;
    // A route whose dependency throws an arbitrary, non-problem error.
    h.ctx.kiroCliVersion = async () => {
      throw new Error("boom: ksk_live_deadbeefcafef00d");
    };

    const res = await route(h.ctx, {
      ...req({ method: "GET", path: "/v1/capabilities" }),
      headers: authHeader(mintToken({})),
    });

    // Response shape is unchanged: a generic 500 problem+json.
    expect(res.status).toBe(500);
    expect(res.headers?.["content-type"]).toBe("application/problem+json");

    // The unexpected error was surfaced at error level.
    expect(obs.errors).toHaveLength(1);
    expect(obs.errors[0].message).toBe("unhandled_error");
    const attrs = obs.errors[0].attributes ?? {};
    expect(attrs.path).toBe("/v1/capabilities");
    expect(attrs.method).toBe("GET");
    expect(attrs.err).toBeInstanceOf(Error);
  });

  test("a known 4xx (UnauthorizedError) is NOT logged at error level", async () => {
    const h = buildHarness();
    const obs = new SpyObservability();
    h.ctx.obs = obs;

    // No Authorization header -> authenticate() throws UnauthorizedError (401).
    const res = await route(h.ctx, req({ method: "GET", path: "/v1/capabilities" }));

    expect(res.status).toBe(401);
    expect(obs.errors).toHaveLength(0);
  });

  test("a known 404 (NotFoundError) is NOT logged at error level", async () => {
    const h = buildHarness();
    const obs = new SpyObservability();
    h.ctx.obs = obs;

    const res = await route(h.ctx, {
      ...req({ method: "GET", path: "/v1/nope" }),
      headers: authHeader(mintToken({})),
    });

    expect(res.status).toBe(404);
    expect(obs.errors).toHaveLength(0);
  });
});
