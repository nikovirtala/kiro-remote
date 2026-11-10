import { describe, expect, test } from "vitest";
import { createHandler } from "../src/router.ts";
import { authHeader, buildHarness, makeEvent, mintToken } from "./helpers.ts";

describe("Lambda handler over API Gateway HTTP API v2 events", () => {
  test("parses the event, authenticates, and returns the proxy result shape", async () => {
    const h = buildHarness();
    h.seedSession({ id: "s1" });
    const handler = createHandler(h.ctx);
    const result = await handler(
      makeEvent({
        method: "GET",
        path: "/v1/sessions/s1",
        headers: authHeader(mintToken({})),
      }),
    );
    expect(result.statusCode).toBe(200);
    expect(result.headers?.["content-type"]).toBe("application/json");
    expect(JSON.parse(result.body as string).id).toBe("s1");
  });

  test("base64-encoded POST body is decoded before validation", async () => {
    const h = buildHarness({ ids: ["s-new", "cmd", "turn"] });
    const handler = createHandler(h.ctx);
    const body = Buffer.from(JSON.stringify({ prompt: "hi", repos: ["acme/app"] })).toString(
      "base64",
    );
    const event = makeEvent({
      method: "POST",
      path: "/v1/sessions",
      headers: { ...authHeader(mintToken({})), "idempotency-key": "k" },
      body,
    });
    const result = await handler({ ...event, isBase64Encoded: true });
    expect(result.statusCode).toBe(202);
    expect(h.queue.commands[0].kind).toBe("launch");
  });

  test("GET /passkeys/add redirects unauthenticated to the Cognito passkey page", async () => {
    const h = buildHarness();
    const handler = createHandler(h.ctx);
    const result = await handler(makeEvent({ method: "GET", path: "/passkeys/add" }));
    expect(result.statusCode).toBe(302);
    expect(result.headers?.location).toBe(
      "https://cognito.example.com/passkeys/add?client_id=cognito-app-client&redirect_uri=https%3A%2F%2Fkiro.example.com%2Fpasskeys%2Fadded",
    );
  });

  test("GET /passkeys/added renders a static success page unauthenticated", async () => {
    const h = buildHarness();
    const handler = createHandler(h.ctx);
    const result = await handler(
      makeEvent({ method: "GET", path: "/passkeys/added", query: { code: "x" } }),
    );
    expect(result.statusCode).toBe(200);
    expect(result.headers?.["content-type"]).toContain("text/html");
    expect(result.body).toContain("Passkey added");
  });

  test("GET /passkeys/added shows an escaped Cognito error", async () => {
    const h = buildHarness();
    const handler = createHandler(h.ctx);
    const result = await handler(
      makeEvent({
        method: "GET",
        path: "/passkeys/added",
        query: { error: "access_denied", error_description: "<script>x</script>" },
      }),
    );
    expect(result.statusCode).toBe(400);
    expect(result.body).toContain("access_denied");
    expect(result.body).not.toContain("<script>");
  });

  test("unknown path returns 404 problem+json", async () => {
    const h = buildHarness();
    const handler = createHandler(h.ctx);
    const result = await handler(
      makeEvent({ method: "GET", path: "/v1/nope", headers: authHeader(mintToken({})) }),
    );
    expect(result.statusCode).toBe(404);
    expect(result.headers?.["content-type"]).toBe("application/problem+json");
  });
});
