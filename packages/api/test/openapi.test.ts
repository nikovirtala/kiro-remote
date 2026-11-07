import { requiredScope } from "@nikovirtala/core";
import { describe, expect, test } from "vitest";
import type { HttpRequest } from "../src/http.ts";
import { buildOpenApiDocument } from "../src/openapi.ts";
import { route } from "../src/router.ts";
import { buildHarness, facadeConfig, RESOURCE } from "./helpers.ts";

function doc(): Record<string, unknown> {
  return buildOpenApiDocument(facadeConfig());
}

describe("GET /openapi.json", () => {
  test("is served unauthenticated and parses as an OpenAPI 3.1 document", async () => {
    const h = buildHarness();
    const res = await route(h.ctx, {
      method: "GET",
      path: "/openapi.json",
      query: {},
      headers: {},
      params: {},
      host: "kiro.example.com",
    } satisfies HttpRequest);
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(parsed.openapi).toBe("3.1.0");
    expect(parsed.info).toBeDefined();
    expect(parsed.paths).toBeDefined();
    expect((parsed.info as { title: string }).title).toBeTruthy();
  });

  test("declares the OAuth 2.1 authorizationCode security scheme pointing at the facade", () => {
    const d = doc();
    const schemes = (d.components as { securitySchemes: Record<string, Record<string, unknown>> })
      .securitySchemes;
    const oauth = schemes.oauth2;
    expect(oauth.type).toBe("oauth2");
    const flow = (oauth.flows as { authorizationCode: Record<string, string> }).authorizationCode;
    expect(flow.authorizationUrl).toBe("https://kiro.example.com/oauth/authorize");
    expect(flow.tokenUrl).toBe("https://kiro.example.com/oauth/token");
  });
});

describe("operation scopes match authorize()'s action->scope mapping", () => {
  // The exact operation -> action mapping the API enforces in routes.ts.
  const OPERATION_ACTION: Record<string, Parameters<typeof requiredScope>[0]> = {
    getCapabilities: "read",
    listModels: "read",
    listSessions: "read",
    launchSession: "launch",
    adoptSession: "launch",
    getSession: "read",
    deleteSession: "delete",
    createTurn: "prompt",
    getTurn: "read",
    getEvents: "read",
    cancelTurn: "cancel",
    listPermissions: "read",
    answerPermission: "answerPermission",
    setConfig: "config",
  };

  test("every operation's security scope equals requiredScope(action), resource-prefixed", () => {
    const d = doc();
    const paths = d.paths as Record<string, Record<string, Record<string, unknown>>>;
    const seen = new Set<string>();

    for (const operations of Object.values(paths)) {
      for (const op of Object.values(operations)) {
        const operationId = op.operationId as string;
        const action = OPERATION_ACTION[operationId];
        expect(action, `unmapped operation ${operationId}`).toBeDefined();
        seen.add(operationId);

        const security = op.security as Array<Record<string, string[]>>;
        expect(security).toHaveLength(1);
        const scopes = security[0].oauth2;
        expect(scopes).toHaveLength(1);
        expect(scopes[0]).toBe(`${RESOURCE}/${requiredScope(action)}`);
      }
    }

    // Every mapped operation appears in the document.
    expect([...seen].sort()).toEqual(Object.keys(OPERATION_ACTION).sort());
  });

  test("the declared scheme scopes are exactly the three resource scopes", () => {
    const d = doc();
    const flow = (
      d.components as {
        securitySchemes: {
          oauth2: { flows: { authorizationCode: { scopes: Record<string, string> } } };
        };
      }
    ).securitySchemes.oauth2.flows.authorizationCode.scopes;
    expect(Object.keys(flow).sort()).toEqual(
      [
        `${RESOURCE}/sessions:read`,
        `${RESOURCE}/sessions:write`,
        `${RESOURCE}/sessions:delete`,
      ].sort(),
    );
  });
});
