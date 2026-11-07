/**
 * The HTTP client variant: attaches the bearer token, adds Idempotency-Key on
 * writes, targets /v1, and surfaces non-2xx as HttpClientError.
 */

import { describe, expect, it } from "vitest";
import { HttpClient, HttpClientError } from "../src/http-client.ts";
import { fakeRestFetch, principal, type RecordedRequest } from "./helpers.ts";

const P = principal();

function clientWith(routes: Record<string, { status: number; body: unknown }>) {
  const recorded: RecordedRequest[] = [];
  const client = new HttpClient({
    baseUrl: "https://host",
    tokens: {
      async accessToken() {
        return "tok-123";
      },
    },
    fetch: fakeRestFetch(routes, recorded),
    newIdempotencyKey: () => "idem-1",
  });
  return { client, recorded };
}

describe("HttpClient", () => {
  it("attaches the bearer token and targets /v1 on reads", async () => {
    const { client, recorded } = clientWith({
      "GET /v1/capabilities": {
        status: 200,
        body: { capabilities: {}, kiroCliVersion: "1.2.3", activeSessionCount: 0 },
      },
    });
    const caps = await client.capabilities(P);
    expect(caps.kiroCliVersion).toBe("1.2.3");
    expect(recorded[0].url).toBe("https://host/v1/capabilities");
    expect(recorded[0].headers.authorization).toBe("Bearer tok-123");
    // Reads carry no Idempotency-Key.
    expect(recorded[0].headers["idempotency-key"]).toBeUndefined();
  });

  it("adds an Idempotency-Key to writes", async () => {
    const { client, recorded } = clientWith({
      "POST /v1/sessions": { status: 202, body: { sessionId: "s1", turnId: null } },
    });
    await client.launchSession(P, { prompt: "x", repos: ["acme/app"] });
    expect(recorded[0].headers["idempotency-key"]).toBe("idem-1");
    expect(recorded[0].method).toBe("POST");
  });

  it("builds query strings for list/events", async () => {
    const { client, recorded } = clientWith({
      "GET /v1/sessions": { status: 200, body: { sessions: [] } },
    });
    await client.listSessions(P, { limit: 5, status: "running" });
    expect(recorded[0].url).toContain("limit=5");
    expect(recorded[0].url).toContain("status=running");
  });

  it("throws HttpClientError on a non-2xx response", async () => {
    const { client } = clientWith({
      "GET /v1/sessions/x": { status: 404, body: { error: "not found" } },
    });
    await expect(client.getSession(P, "x")).rejects.toBeInstanceOf(HttpClientError);
  });
});
