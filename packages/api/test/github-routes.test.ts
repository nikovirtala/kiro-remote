import { Repository } from "@nikovirtala/kiro-remote-core";
import { MemoryDdb, MemoryS3, sessionItem } from "@nikovirtala/kiro-remote-core/testing";
import { describe, expect, test } from "vitest";
import type { HttpRequest } from "../src/http.ts";
import { route } from "../src/router.ts";
import { authHeader, buildHarness, mintToken } from "./helpers.ts";

function req(o: Partial<HttpRequest> & { method: string; path: string }): HttpRequest {
  return { query: {}, headers: {}, params: {}, host: "kiro.example.com", ...o };
}

/** A harness whose repository runs over the in-memory DynamoDB that understands transactions. */
function harness(allowed = ["octo/*"]) {
  const h = buildHarness({ allowedRepos: allowed });
  const mem = new MemoryDdb();
  const repo = new Repository({
    ddb: mem as never,
    s3: new MemoryS3() as never,
    tableName: "t",
    bucketName: "b",
  });
  h.ctx.repo = repo;
  h.ctx.service.repo = repo;
  mem.put(sessionItem("S1", { createdBy: "user-1", GSI1PK: "USER#user-1", repos: ["octo/repo"] }));
  mem.put(sessionItem("S2", { createdBy: "user-1", GSI1PK: "USER#user-1", repos: ["octo/repo"] }));
  const call = (r: Partial<HttpRequest> & { method: string; path: string }, scopes?: string[]) =>
    route(h.ctx, {
      ...req(r),
      headers: {
        ...authHeader(mintToken(scopes ? { scopes } : {})),
        "idempotency-key": `k-${Math.random()}`,
      },
    });
  return { h, mem, repo, call };
}

const link = (pr: string) => ({
  method: "POST",
  path: "/v1/sessions/S1/links",
  body: JSON.stringify({ pr }),
});

describe("POST /v1/sessions/{id}/links", () => {
  test("links by owner/repo#n (201), and again is idempotent (200)", async () => {
    const { call } = harness();
    const first = await call(link("octo/repo#7"));
    expect(first.status).toBe(201);
    expect(JSON.parse(first.body)).toMatchObject({
      pr: "octo/repo#7",
      linkedBy: "manual",
      prState: "unknown",
    });
    const again = await call(link("https://github.com/octo/repo/pull/7"));
    expect(again.status).toBe(200);
  });

  test("GET /v1/sessions/{id} now lists links[]", async () => {
    const { call } = harness();
    await call(link("octo/repo#7"));
    const res = await call({ method: "GET", path: "/v1/sessions/S1" });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).links).toMatchObject([{ pr: "octo/repo#7", linkedBy: "manual" }]);
    // Other sessions have none.
    expect(JSON.parse((await call({ method: "GET", path: "/v1/sessions/S2" })).body).links).toEqual(
      [],
    );
  });

  test("409 when the PR is linked to another session, and the first link stays", async () => {
    const { call, repo } = harness();
    await call(link("octo/repo#7"));
    const res = await call({
      method: "POST",
      path: "/v1/sessions/S2/links",
      body: JSON.stringify({ pr: "octo/repo#7" }),
    });
    expect(res.status).toBe(409);
    expect((await repo.getPrLink("octo/repo#7"))?.sessionId).toBe("S1");
  });

  test("403 for a repo that is not one of the session's repos, 400 for a malformed ref", async () => {
    const { call } = harness();
    expect((await call(link("octo/other#7"))).status).toBe(403);
    const bad = await call(link("not a pr"));
    expect(bad.status).toBe(400);
    expect(bad.headers["content-type"]).toBe("application/problem+json");
  });

  test("needs sessions:write", async () => {
    const { call } = harness();
    expect((await call(link("octo/repo#7"), ["sessions:read"])).status).toBe(403);
  });

  test("requires an Idempotency-Key like every POST", async () => {
    const { h } = harness();
    const res = await route(h.ctx, {
      ...req(link("octo/repo#7")),
      headers: authHeader(mintToken({})),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /v1/sessions/{id}/links/{owner}/{repo}/{n}", () => {
  test("unlinks (204) and then 409s because nothing is linked", async () => {
    const { call, repo } = harness();
    await call(link("octo/repo#7"));
    const res = await call({ method: "DELETE", path: "/v1/sessions/S1/links/octo/repo/7" });
    expect(res.status).toBe(204);
    expect(await repo.getPrLink("octo/repo#7")).toBeNull();
    expect(
      (await call({ method: "DELETE", path: "/v1/sessions/S1/links/octo/repo/7" })).status,
    ).toBe(409);
  });
});

describe("GET /v1/github/unmatched", () => {
  test("lists unmatched deliveries for allowed repos, newest first, honouring limit", async () => {
    const { call, repo } = harness();
    for (const [i, r] of ["octo/repo", "octo/repo", "elsewhere/x"].entries()) {
      await repo.putUnmatched({
        deliveryId: `d${i}`,
        event: "pull_request",
        action: "opened",
        repo: r,
        number: i + 1,
        sender: "kiro",
        receivedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
        url: `https://github.com/${r}/pull/${i + 1}`,
      });
    }
    const res = await call({ method: "GET", path: "/v1/github/unmatched", query: { limit: "20" } });
    expect(res.status).toBe(200);
    expect(
      JSON.parse(res.body).deliveries.map((d: { deliveryId: string }) => d.deliveryId),
    ).toEqual(["d1", "d0"]);
    const one = await call({ method: "GET", path: "/v1/github/unmatched", query: { limit: "1" } });
    expect(JSON.parse(one.body).deliveries).toHaveLength(1);
  });

  test("needs sessions:read", async () => {
    const { call } = harness();
    expect((await call({ method: "GET", path: "/v1/github/unmatched" }, [])).status).toBe(403);
  });
});

describe("GET /v1/sessions/{id}/turns/{turnId} shows the trigger", () => {
  test("a wake turn reports its github trigger; an old row reads as a user turn", async () => {
    const { call, repo } = harness();
    await repo.putTurn({
      PK: "SESSION#S1",
      SK: "TURN#T1",
      id: "T1",
      sessionId: "S1",
      prompt: "[GitHub webhook] ...",
      status: "completed",
      stopReason: "end_turn",
      startedAt: null,
      endedAt: null,
      metering: null,
      trigger: { source: "github", deliveryIds: ["d1"], inboxIds: ["i1"] },
    });
    await repo.putTurn({
      PK: "SESSION#S1",
      SK: "TURN#T0",
      id: "T0",
      sessionId: "S1",
      prompt: "hi",
      status: "completed",
      stopReason: "end_turn",
      startedAt: null,
      endedAt: null,
      metering: null,
    });
    expect(
      JSON.parse((await call({ method: "GET", path: "/v1/sessions/S1/turns/T1" })).body).trigger,
    ).toEqual({
      source: "github",
      deliveryIds: ["d1"],
    });
    expect(
      JSON.parse((await call({ method: "GET", path: "/v1/sessions/S1/turns/T0" })).body).trigger,
    ).toEqual({
      source: "user",
      deliveryIds: [],
    });
  });
});
