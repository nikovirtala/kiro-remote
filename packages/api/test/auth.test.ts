import { describe, expect, test } from "vitest";
import type { HttpRequest } from "../src/http.ts";
import { route } from "../src/router.ts";
import { authHeader, buildHarness, mintToken } from "./helpers.ts";

function req(overrides: Partial<HttpRequest> & { method: string; path: string }): HttpRequest {
  return {
    query: {},
    headers: {},
    params: {},
    host: "kiro.example.com",
    ...overrides,
  };
}

const RM_URL = "https://kiro.example.com/.well-known/oauth-protected-resource/mcp";

describe("401 unauthenticated", () => {
  test("no token on a protected route carries the WWW-Authenticate resource_metadata", async () => {
    const h = buildHarness();
    const res = await route(h.ctx, req({ method: "GET", path: "/v1/sessions" }));
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toBe("application/problem+json");
    const header = res.headers["www-authenticate"];
    expect(header).toContain("Bearer");
    expect(header).toContain(`resource_metadata="${RM_URL}"`);
  });

  test("invalid token is 401", async () => {
    const h = buildHarness();
    const res = await route(h.ctx, {
      ...req({ method: "GET", path: "/v1/sessions" }),
      headers: { authorization: "Bearer not-a-valid-token" },
    });
    expect(res.status).toBe(401);
  });
});

describe("403 insufficient scope", () => {
  test("a read-only token cannot launch; 403 carries insufficient_scope + needed scope", async () => {
    const h = buildHarness();
    const res = await route(h.ctx, {
      ...req({
        method: "POST",
        path: "/v1/sessions",
        body: JSON.stringify({ prompt: "hi", repos: ["acme/app"] }),
      }),
      headers: {
        ...authHeader(mintToken({ scopes: ["sessions:read"] })),
        "idempotency-key": "k1",
      },
    });
    expect(res.status).toBe(403);
    const header = res.headers["www-authenticate"];
    expect(header).toContain('error="insufficient_scope"');
    expect(header).toContain('scope="sessions:write"');
    const body = JSON.parse(res.body);
    expect(body.scope).toBe("sessions:write");
  });

  test("a write token cannot delete; needs sessions:delete", async () => {
    const h = buildHarness();
    h.seedSession({ id: "s1" });
    const res = await route(h.ctx, {
      ...req({ method: "DELETE", path: "/v1/sessions/s1" }),
      headers: {
        ...authHeader(mintToken({ scopes: ["sessions:read", "sessions:write"] })),
        "idempotency-key": "kd",
      },
    });
    expect(res.status).toBe(403);
    expect(res.headers["www-authenticate"]).toContain('scope="sessions:delete"');
  });
});

describe("token is never forwarded", () => {
  test("enqueued commands carry only the sub, never the bearer token", async () => {
    const h = buildHarness({ ids: ["s-new", "cmd", "turn"] });
    const token = mintToken({ sub: "user-9" });
    await route(h.ctx, {
      ...req({
        method: "POST",
        path: "/v1/sessions",
        body: JSON.stringify({ prompt: "hi", repos: ["acme/app"] }),
      }),
      headers: { ...authHeader(token), "idempotency-key": "k" },
    });
    const serialized = JSON.stringify(h.queue.commands);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("Bearer");
    expect(h.queue.commands[0].sub).toBe("user-9");
  });
});
