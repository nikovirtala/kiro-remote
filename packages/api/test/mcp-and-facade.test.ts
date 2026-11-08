import { describe, expect, test } from "vitest";
import { isFacadePath } from "../src/facade.ts";
import type { HttpRequest } from "../src/http.ts";
import type { McpTransportHandler } from "../src/mcp-seam.ts";
import { route } from "../src/router.ts";
import { authHeader, buildHarness, mintToken } from "./helpers.ts";

function req(overrides: Partial<HttpRequest> & { method: string; path: string }): HttpRequest {
  return { query: {}, headers: {}, params: {}, host: "kiro.example.com", ...overrides };
}

describe("/mcp route seam", () => {
  test("unauthenticated /mcp returns 401 with the resource_metadata challenge", async () => {
    const h = buildHarness();
    const res = await route(h.ctx, req({ method: "POST", path: "/mcp" }));
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toContain(
      'resource_metadata="https://kiro.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  test("authenticated /mcp with no handler wired returns 501 (seam not yet plugged)", async () => {
    const h = buildHarness();
    const res = await route(h.ctx, {
      ...req({ method: "POST", path: "/mcp" }),
      headers: authHeader(mintToken({})),
    });
    expect(res.status).toBe(501);
    expect(JSON.parse(res.body).type).toContain("capability-unavailable");
  });

  test("authenticated /mcp delegates to the registered transport handler (FEAT-006 seam)", async () => {
    const h = buildHarness();
    const handler: McpTransportHandler = {
      async handle(r) {
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ok: true, sub: r.principal.sub }),
        };
      },
    };
    h.ctx.mcp = handler;
    const res = await route(h.ctx, {
      ...req({ method: "POST", path: "/mcp", body: JSON.stringify({ jsonrpc: "2.0" }) }),
      headers: authHeader(mintToken({ sub: "user-7" })),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, sub: "user-7" });
  });
});

describe("facade endpoints are mounted unauthenticated", () => {
  test("GET /.well-known/oauth-protected-resource/mcp needs no token", async () => {
    const h = buildHarness();
    const res = await route(
      h.ctx,
      req({ method: "GET", path: "/.well-known/oauth-protected-resource/mcp" }),
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.resource).toBe("https://kiro.example.com/mcp");
    expect(body.authorization_servers).toContain("https://kiro.example.com");
  });

  test("GET /.well-known/oauth-authorization-server advertises the facade issuer", async () => {
    const h = buildHarness();
    const res = await route(
      h.ctx,
      req({ method: "GET", path: "/.well-known/oauth-authorization-server" }),
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.issuer).toBe("https://kiro.example.com");
    expect(body.authorization_endpoint).toBe("https://kiro.example.com/oauth/authorize");
    expect(body.code_challenge_methods_supported).toContain("S256");
  });

  test("GET /oauth/clients/cli.json returns the CLI CIMD unauthenticated", async () => {
    const h = buildHarness();
    const res = await route(h.ctx, req({ method: "GET", path: "/oauth/clients/cli.json" }));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).client_id).toBe("https://kiro.example.com/oauth/clients/cli.json");
  });

  test("POST /oauth/register registers a client unauthenticated (RFC 7591)", async () => {
    const h = buildHarness();
    const res = await route(
      h.ctx,
      req({
        method: "POST",
        path: "/oauth/register",
        body: JSON.stringify({ redirect_uris: ["https://app.example.com/cb"] }),
      }),
    );
    expect(res.status).toBe(201);
    const body = JSON.parse(res.body);
    expect(typeof body.client_id).toBe("string");
    expect(body.client_id.startsWith("mcp_")).toBe(true);
    expect(body.token_endpoint_auth_method).toBe("none");
    expect("client_secret" in body).toBe(false);
  });

  test("isFacadePath('/oauth/register') is true", () => {
    expect(isFacadePath("/oauth/register")).toBe(true);
  });
});
