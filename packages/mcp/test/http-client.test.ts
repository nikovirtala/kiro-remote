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

describe("HttpClient: waits", () => {
  it("POSTs the wait to /waits with an Idempotency-Key", async () => {
    const wait = { pr: "octo/repo#7", source: "rest" };
    const { client, recorded } = clientWith({
      "POST /v1/sessions/s1/waits": { status: 201, body: wait },
    });
    expect(await client.waitForPullRequest(P, "s1", { pr: "octo/repo#7" })).toEqual(wait);
    expect(recorded[0].headers["idempotency-key"]).toBe("idem-1");
    expect(JSON.parse(recorded[0].body ?? "{}")).toEqual({ pr: "octo/repo#7" });
  });

  it("DELETEs /waits/{owner}/{repo}/{n} for a PR URL", async () => {
    const { client, recorded } = clientWith({
      "DELETE /v1/sessions/s1/waits/octo/repo/7": { status: 204, body: "" },
    });
    await client.stopWaitingForPullRequest(P, "s1", {
      pr: "https://github.com/octo/repo/pull/7",
    });
    expect(recorded[0].method).toBe("DELETE");
    expect(recorded[0].url).toBe("https://host/v1/sessions/s1/waits/octo/repo/7");
  });

  it("refuses something that is not a PR before calling", async () => {
    const { client, recorded } = clientWith({});
    await expect(client.stopWaitingForPullRequest(P, "s1", { pr: "nope" })).rejects.toThrow();
    expect(recorded).toEqual([]);
  });
});
