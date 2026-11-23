import {
  type GithubQueue,
  type GithubQueueMessage,
  Repository,
} from "@nikovirtala/kiro-remote-core";
import { MemoryDdb, MemoryS3, sessionItem } from "@nikovirtala/kiro-remote-core/testing";
import { describe, expect, test } from "vitest";
import type { HttpRequest } from "../src/http.ts";
import { route } from "../src/router.ts";
import { authHeader, buildHarness, mintToken } from "./helpers.ts";

function req(o: Partial<HttpRequest> & { method: string; path: string }): HttpRequest {
  return { query: {}, headers: {}, params: {}, host: "kiro.example.com", ...o };
}

/** A harness whose repository runs over the in-memory DynamoDB that understands transactions. */
function harness(allowed = ["octo/*", "ark/*"], withQueue = true) {
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
  const sent: GithubQueueMessage[] = [];
  const githubQueue: GithubQueue = {
    async send(m) {
      sent.push(m);
    },
  };
  if (withQueue) {
    h.ctx.service.githubQueue = githubQueue;
  }
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
  return { h, mem, repo, call, sent };
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

const wait = (pr: string, session = "S1") => ({
  method: "POST",
  path: `/v1/sessions/${session}/waits`,
  body: JSON.stringify({ pr }),
});

describe("POST /v1/sessions/{id}/waits", () => {
  test("waits (201) and asks for one read of the PR; again is a no-op (200)", async () => {
    const { call, sent, repo } = harness();
    const first = await call(wait("octo/repo#7"));
    expect(first.status).toBe(201);
    expect(JSON.parse(first.body)).toMatchObject({
      pr: "octo/repo#7",
      repo: "octo/repo",
      number: 7,
      source: "rest",
    });
    const again = await call(wait("https://github.com/octo/repo/pull/7"));
    expect(again.status).toBe(200);
    expect(sent).toEqual([{ kind: "wait_check", sessionId: "S1", pr: "octo/repo#7" }]);
    expect(await repo.queryWaits("S1")).toHaveLength(1);
  });

  test("the PR may be in another allowed repo than the session's", async () => {
    const { call } = harness();
    expect((await call(wait("ark/ark#2"))).status).toBe(201);
  });

  test("GET /v1/sessions/{id} lists waits[]", async () => {
    const { call } = harness();
    await call(wait("octo/repo#7"));
    await call(wait("ark/ark#2"));
    const body = JSON.parse((await call({ method: "GET", path: "/v1/sessions/S1" })).body);
    expect(body.waits.map((w: { pr: string }) => w.pr)).toEqual(["ark/ark#2", "octo/repo#7"]);
    expect(body.links).toEqual([]);
    expect(JSON.parse((await call({ method: "GET", path: "/v1/sessions/S2" })).body).waits).toEqual(
      [],
    );
  });

  test("403 outside ALLOWED_REPOS, 400 for a malformed ref, 404 for another's session", async () => {
    const { call } = harness();
    expect((await call(wait("evil/repo#7"))).status).toBe(403);
    expect((await call(wait("not a pr"))).status).toBe(400);
    expect((await call(wait("octo/repo#7", "nope"))).status).toBe(404);
  });

  test("501 where the GitHub feature is not deployed", async () => {
    const { call } = harness(["octo/*"], false);
    const res = await call(wait("octo/repo#7"));
    expect(res.status).toBe(501);
    expect(JSON.parse(res.body)).toMatchObject({ method: "github" });
  });

  test("needs sessions:write and an Idempotency-Key", async () => {
    const { call, h } = harness();
    expect((await call(wait("octo/repo#7"), ["sessions:read"])).status).toBe(403);
    const res = await route(h.ctx, {
      ...req(wait("octo/repo#7")),
      headers: authHeader(mintToken({})),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /v1/sessions/{id}/waits/{owner}/{repo}/{n}", () => {
  test("stops waiting (204) and then 409s because nothing is waited for", async () => {
    const { call, repo } = harness();
    await call(wait("octo/repo#7"));
    const res = await call({ method: "DELETE", path: "/v1/sessions/S1/waits/octo/repo/7" });
    expect(res.status).toBe(204);
    expect(await repo.queryWaiters("octo/repo#7")).toEqual([]);
    expect(
      (await call({ method: "DELETE", path: "/v1/sessions/S1/waits/octo/repo/7" })).status,
    ).toBe(409);
  });
});
