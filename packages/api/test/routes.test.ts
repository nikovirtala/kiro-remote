import { describe, expect, test } from "vitest";
import type { HttpRequest } from "../src/http.ts";
import { route } from "../src/router.ts";
import { authHeader, buildHarness, mintToken } from "./helpers.ts";

/** Build a parsed HttpRequest directly (bypassing the API Gateway adapter). */
function req(overrides: Partial<HttpRequest> & { method: string; path: string }): HttpRequest {
  return {
    query: {},
    headers: {},
    params: {},
    host: "kiro.example.com",
    ...overrides,
  };
}

const idempotent = (key: string) => ({ "idempotency-key": key });

describe("GET /v1/capabilities", () => {
  test("returns caps, kiro-cli version, and active session count", async () => {
    const h = buildHarness({ kiroCliVersion: "9.9.9" });
    h.seedSession({ id: "a", status: "running" });
    h.seedSession({ id: "b", status: "idle" });
    h.seedSession({ id: "c", status: "deleted" });
    // Seed a CONFIG#CAPS row.
    h.ddb.put({
      PK: "CONFIG",
      SK: "CAPS",
      initializeResult: {
        agentCapabilities: { _meta: { kiro: { extensionMethods: ["_kiro/setMode"] } } },
      },
      extensionMethods: ["_kiro/setMode"],
      configOptions: [],
      modes: [],
      updatedAt: "2024-01-01T00:00:00.000Z",
    });

    const res = await route(h.ctx, {
      ...req({ method: "GET", path: "/v1/capabilities" }),
      headers: authHeader(mintToken({})),
    });

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.kiroCliVersion).toBe("9.9.9");
    expect(body.activeSessionCount).toBe(2);
    expect(body.capabilities.extensionMethods).toContain("_kiro/setMode");
  });
});

describe("GET /v1/models", () => {
  test("reads the MODELS row from DynamoDB", async () => {
    const h = buildHarness();
    h.ddb.put({
      PK: "CONFIG",
      SK: "MODELS",
      models: ["claude-x", "claude-y"],
      source: "config_option",
      updatedAt: "2024-01-01T00:00:00.000Z",
    });
    const res = await route(h.ctx, {
      ...req({ method: "GET", path: "/v1/models" }),
      headers: authHeader(mintToken({})),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      models: ["claude-x", "claude-y"],
      source: "config_option",
    });
  });
});

describe("POST /v1/sessions", () => {
  test("202 and enqueues a launch command", async () => {
    const h = buildHarness({ ids: ["new-session", "cmd-1", "turn-1"] });
    const res = await route(h.ctx, {
      ...req({
        method: "POST",
        path: "/v1/sessions",
        body: JSON.stringify({ prompt: "hi", repos: ["acme/app"] }),
      }),
      headers: { ...authHeader(mintToken({})), ...idempotent("k1") },
    });
    expect(res.status).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.sessionId).toBe("new-session");
    expect(h.queue.commands).toHaveLength(1);
    expect(h.queue.commands[0].kind).toBe("launch");
  });

  test("validation failure returns problem+json", async () => {
    const h = buildHarness();
    const res = await route(h.ctx, {
      ...req({
        method: "POST",
        path: "/v1/sessions",
        body: JSON.stringify({ prompt: "", repos: [] }),
      }),
      headers: { ...authHeader(mintToken({})), ...idempotent("k2") },
    });
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toBe("application/problem+json");
    const body = JSON.parse(res.body);
    expect(body.type).toContain("validation-error");
  });

  test("missing Idempotency-Key is 400", async () => {
    const h = buildHarness();
    const res = await route(h.ctx, {
      ...req({
        method: "POST",
        path: "/v1/sessions",
        body: JSON.stringify({ prompt: "hi", repos: ["acme/app"] }),
      }),
      headers: authHeader(mintToken({})),
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).type).toContain("missing-idempotency-key");
  });

  test("403 for repos outside the allow-list", async () => {
    const h = buildHarness({ allowedRepos: ["acme/*"] });
    const res = await route(h.ctx, {
      ...req({
        method: "POST",
        path: "/v1/sessions",
        body: JSON.stringify({ prompt: "hi", repos: ["evil/app"] }),
      }),
      headers: { ...authHeader(mintToken({})), ...idempotent("k3") },
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).type).toContain("repo-not-allowed");
    expect(h.queue.commands).toHaveLength(0);
  });

  test("429 with Retry-After at the concurrency cap", async () => {
    const h = buildHarness();
    for (let i = 0; i < 10; i++) {
      h.seedSession({ id: `s${i}`, status: "running" });
    }
    const res = await route(h.ctx, {
      ...req({
        method: "POST",
        path: "/v1/sessions",
        body: JSON.stringify({ prompt: "hi", repos: ["acme/app"] }),
      }),
      headers: { ...authHeader(mintToken({})), ...idempotent("k4") },
    });
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("60");
    expect(JSON.parse(res.body).type).toContain("concurrency-limit");
  });

  test("idempotent replay returns the stored result without a second enqueue", async () => {
    const h = buildHarness({ ids: ["sess-x", "cmd-x", "turn-x"] });
    const first = await route(h.ctx, {
      ...req({
        method: "POST",
        path: "/v1/sessions",
        body: JSON.stringify({ prompt: "hi", repos: ["acme/app"] }),
      }),
      headers: { ...authHeader(mintToken({})), ...idempotent("dup") },
    });
    const second = await route(h.ctx, {
      ...req({
        method: "POST",
        path: "/v1/sessions",
        body: JSON.stringify({ prompt: "hi", repos: ["acme/app"] }),
      }),
      headers: { ...authHeader(mintToken({})), ...idempotent("dup") },
    });
    expect(second.status).toBe(202);
    expect(second.body).toBe(first.body);
    expect(h.queue.commands).toHaveLength(1);
  });
});

describe("GET /v1/sessions", () => {
  test("lists the caller's sessions from DynamoDB", async () => {
    const h = buildHarness();
    h.seedSession({ id: "s1", status: "idle" });
    h.seedSession({ id: "s2", status: "running" });
    const res = await route(h.ctx, {
      ...req({ method: "GET", path: "/v1/sessions" }),
      headers: authHeader(mintToken({})),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).sessions).toHaveLength(2);
  });

  test("filters by status", async () => {
    const h = buildHarness();
    h.seedSession({ id: "s1", status: "idle" });
    h.seedSession({ id: "s2", status: "running" });
    const res = await route(h.ctx, {
      ...req({ method: "GET", path: "/v1/sessions", query: { status: "running" } }),
      headers: authHeader(mintToken({})),
    });
    const body = JSON.parse(res.body);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].status).toBe("running");
  });
});

describe("POST /v1/sessions/adopt", () => {
  test("202 and enqueues an adopt command", async () => {
    const h = buildHarness({ ids: ["adopted", "cmd-a"] });
    const res = await route(h.ctx, {
      ...req({
        method: "POST",
        path: "/v1/sessions/adopt",
        body: JSON.stringify({ kiroSessionId: "kiro-abc" }),
      }),
      headers: { ...authHeader(mintToken({})), ...idempotent("ka") },
    });
    expect(res.status).toBe(202);
    expect(h.queue.commands[0].kind).toBe("adopt");
  });
});

describe("GET/DELETE /v1/sessions/{id}", () => {
  test("GET returns the owned session", async () => {
    const h = buildHarness();
    h.seedSession({ id: "mine" });
    const res = await route(h.ctx, {
      ...req({ method: "GET", path: "/v1/sessions/mine" }),
      headers: authHeader(mintToken({})),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).id).toBe("mine");
  });

  test("GET another user's session is 404", async () => {
    const h = buildHarness();
    h.seedSession({ id: "theirs", createdBy: "someone-else" });
    const res = await route(h.ctx, {
      ...req({ method: "GET", path: "/v1/sessions/theirs" }),
      headers: authHeader(mintToken({})),
    });
    expect(res.status).toBe(404);
  });

  test("DELETE enqueues a delete command and returns 202", async () => {
    const h = buildHarness();
    h.seedSession({ id: "gone" });
    const res = await route(h.ctx, {
      ...req({ method: "DELETE", path: "/v1/sessions/gone" }),
      headers: { ...authHeader(mintToken({})), ...idempotent("kd") },
    });
    expect(res.status).toBe(202);
    expect(h.queue.commands[0].kind).toBe("delete");
  });
});

describe("POST /v1/sessions/{id}/turns", () => {
  test("202 and enqueues a prompt command", async () => {
    const h = buildHarness({ ids: ["turn-1", "cmd-1"] });
    h.seedSession({ id: "s1", status: "idle" });
    const res = await route(h.ctx, {
      ...req({
        method: "POST",
        path: "/v1/sessions/s1/turns",
        body: JSON.stringify({ prompt: "go" }),
      }),
      headers: { ...authHeader(mintToken({})), ...idempotent("kt") },
    });
    expect(res.status).toBe(202);
    expect(h.queue.commands[0].kind).toBe("prompt");
    expect(JSON.parse(res.body).status).toBe("running");
  });
});

describe("GET /v1/sessions/{id}/turns/{turnId}", () => {
  test("reads a turn row from DynamoDB", async () => {
    const h = buildHarness();
    h.seedSession({ id: "s1" });
    h.ddb.put({
      PK: "SESSION#s1",
      SK: "TURN#t1",
      id: "t1",
      sessionId: "s1",
      prompt: "hi",
      status: "completed",
      stopReason: "end_turn",
      startedAt: "2024-01-01T00:00:00.000Z",
      endedAt: "2024-01-01T00:00:01.000Z",
      metering: null,
    });
    const res = await route(h.ctx, {
      ...req({ method: "GET", path: "/v1/sessions/s1/turns/t1" }),
      headers: authHeader(mintToken({})),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).status).toBe("completed");
  });
});

describe("GET /v1/sessions/{id}/events (long-poll)", () => {
  test("returns {events, nextCursor, turnStatus}", async () => {
    const h = buildHarness();
    h.seedSession({ id: "s1", status: "running" });
    for (let seq = 1; seq <= 3; seq++) {
      h.ddb.put({
        PK: "SESSION#s1",
        SK: `EVT#${String(seq).padStart(12, "0")}`,
        seq,
        turnId: "t1",
        ts: "2024-01-01T00:00:00.000Z",
        type: "message.chunk",
        rawType: "agent_message_chunk",
        replay: false,
        payload: { text: "x" },
        ttl: 0,
      });
    }
    const res = await route(h.ctx, {
      ...req({ method: "GET", path: "/v1/sessions/s1/events", query: { after: "0" } }),
      headers: authHeader(mintToken({})),
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.events).toHaveLength(3);
    expect(body.nextCursor).toBe(3);
    expect(body.turnStatus).toBe("running");
  });

  test("after cursor skips earlier events", async () => {
    const h = buildHarness();
    h.seedSession({ id: "s1", status: "idle" });
    for (let seq = 1; seq <= 3; seq++) {
      h.ddb.put({
        PK: "SESSION#s1",
        SK: `EVT#${String(seq).padStart(12, "0")}`,
        seq,
        turnId: null,
        ts: "2024-01-01T00:00:00.000Z",
        type: "raw",
        rawType: "x",
        replay: false,
        payload: {},
        ttl: 0,
      });
    }
    const res = await route(h.ctx, {
      ...req({ method: "GET", path: "/v1/sessions/s1/events", query: { after: "2" } }),
      headers: authHeader(mintToken({})),
    });
    const body = JSON.parse(res.body);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].seq).toBe(3);
  });
});

describe("POST /v1/sessions/{id}/cancel", () => {
  test("enqueues a cancel command", async () => {
    const h = buildHarness();
    h.seedSession({ id: "s1", status: "running" });
    const res = await route(h.ctx, {
      ...req({ method: "POST", path: "/v1/sessions/s1/cancel" }),
      headers: { ...authHeader(mintToken({})), ...idempotent("kc") },
    });
    expect(res.status).toBe(202);
    expect(h.queue.commands[0].kind).toBe("cancel");
  });
});

describe("permissions", () => {
  test("GET lists pending permissions from DynamoDB", async () => {
    const h = buildHarness();
    h.seedSession({ id: "s1", status: "awaiting_permission" });
    h.ddb.put({
      PK: "SESSION#s1",
      SK: "PERM#r1",
      requestId: "r1",
      toolCallId: "tc1",
      toolCall: {},
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      consent: null,
      status: "pending",
      answer: null,
      ttl: 0,
    });
    const res = await route(h.ctx, {
      ...req({
        method: "GET",
        path: "/v1/sessions/s1/permissions",
        query: { status: "pending" },
      }),
      headers: authHeader(mintToken({})),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).permissions).toHaveLength(1);
  });

  test("POST answers with an offered optionId (202 + command)", async () => {
    const h = buildHarness();
    h.seedSession({ id: "s1", status: "awaiting_permission" });
    h.ddb.put({
      PK: "SESSION#s1",
      SK: "PERM#r1",
      requestId: "r1",
      toolCallId: "tc1",
      toolCall: {},
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      consent: null,
      status: "pending",
      answer: null,
      ttl: 0,
    });
    const res = await route(h.ctx, {
      ...req({
        method: "POST",
        path: "/v1/sessions/s1/permissions/r1",
        body: JSON.stringify({ optionId: "allow" }),
      }),
      headers: { ...authHeader(mintToken({})), ...idempotent("kp") },
    });
    expect(res.status).toBe(202);
    expect(h.queue.commands[0].kind).toBe("answerPermission");
  });

  test("POST with a non-offered optionId is 422", async () => {
    const h = buildHarness();
    h.seedSession({ id: "s1", status: "awaiting_permission" });
    h.ddb.put({
      PK: "SESSION#s1",
      SK: "PERM#r1",
      requestId: "r1",
      toolCallId: "tc1",
      toolCall: {},
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      consent: null,
      status: "pending",
      answer: null,
      ttl: 0,
    });
    const res = await route(h.ctx, {
      ...req({
        method: "POST",
        path: "/v1/sessions/s1/permissions/r1",
        body: JSON.stringify({ optionId: "nope" }),
      }),
      headers: { ...authHeader(mintToken({})), ...idempotent("kp2") },
    });
    expect(res.status).toBe(422);
    expect(JSON.parse(res.body).type).toContain("option-not-offered");
    expect(h.queue.commands).toHaveLength(0);
  });
});

describe("PATCH /v1/sessions/{id}/config", () => {
  test("202 and enqueues a setConfig command when the capability is advertised", async () => {
    const h = buildHarness({ extensionMethods: ["_kiro/setConfigOption"] });
    h.seedSession({ id: "s1" });
    const res = await route(h.ctx, {
      ...req({
        method: "PATCH",
        path: "/v1/sessions/s1/config",
        body: JSON.stringify({ model: "claude-x" }),
      }),
      headers: authHeader(mintToken({})),
    });
    expect(res.status).toBe(202);
    expect(h.queue.commands[0].kind).toBe("setConfig");
  });

  test("501 capability-unavailable when the extension is not advertised", async () => {
    const h = buildHarness({ extensionMethods: [] });
    h.seedSession({ id: "s1" });
    const res = await route(h.ctx, {
      ...req({
        method: "PATCH",
        path: "/v1/sessions/s1/config",
        body: JSON.stringify({ model: "claude-x" }),
      }),
      headers: authHeader(mintToken({})),
    });
    expect(res.status).toBe(501);
    expect(JSON.parse(res.body).type).toContain("capability-unavailable");
    expect(h.queue.commands).toHaveLength(0);
  });
});

describe("Kiro-mapped concurrency error", () => {
  test("a ConcurrencyLimitError from Kiro (enqueue) maps to 429 with Retry-After", async () => {
    const h = buildHarness({ ids: ["turn-k", "cmd-k"] });
    h.seedSession({ id: "s1", status: "idle" });
    const { ConcurrencyLimitError } = await import("@nikovirtala/kiro-remote-core");
    h.queue.enqueue = async () => {
      throw new ConcurrencyLimitError(10, 10);
    };
    const res = await route(h.ctx, {
      ...req({
        method: "POST",
        path: "/v1/sessions/s1/turns",
        body: JSON.stringify({ prompt: "go" }),
      }),
      headers: { ...authHeader(mintToken({})), ...idempotent("kk") },
    });
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("60");
    expect(JSON.parse(res.body).type).toContain("concurrency-limit");
  });
});
