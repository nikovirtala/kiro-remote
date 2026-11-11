/**
 * Dispatch tests: scope gating yields insufficient_scope (not a generic tool
 * error), genuine tool failures surface as isError results, and both transports
 * share the SAME tool logic through the one client interface.
 */

import { describe, expect, it } from "vitest";
import { InProcessClient } from "../src/client.ts";
import { HttpClient } from "../src/http-client.ts";
import { createHttpTransportHandler } from "../src/http-transport.ts";
import { callTool, InsufficientScopeError, listTools } from "../src/server.ts";
import { buildInProcess, fakeRestFetch, principal } from "./helpers.ts";

describe("scope gating -> insufficient_scope", () => {
  it("throws InsufficientScopeError when the caller lacks the tool scope", async () => {
    const { client } = buildInProcess();
    const readOnly = principal({ scopes: ["sessions:read"] });
    await expect(
      callTool(client, readOnly, "kiro_launch_session", {
        prompt: "hi",
        repos: ["acme/app"],
      }),
    ).rejects.toBeInstanceOf(InsufficientScopeError);
  });

  it("the insufficient_scope error names the needed scope and the OAuth error", async () => {
    const { client } = buildInProcess();
    const readOnly = principal({ scopes: ["sessions:read"] });
    try {
      await callTool(client, readOnly, "kiro_delete_session", { sessionId: "x" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InsufficientScopeError);
      const e = err as InsufficientScopeError;
      expect(e.message).toContain("insufficient_scope");
      expect(e.data).toMatchObject({ error: "insufficient_scope", scope: "sessions:delete" });
    }
  });

  it("allows a tool when the caller holds the scope", async () => {
    const h = buildInProcess({ ids: ["sess-1", "cmd-1"] });
    const out = await callTool(h.client, principal(), "kiro_launch_session", {
      prompt: "hi",
      repos: ["acme/app"],
    });
    expect(out.isError).toBeUndefined();
    expect(out.structuredContent).toMatchObject({ sessionId: "sess-1" });
    expect(h.queue.commands).toHaveLength(1);
    expect(h.queue.commands[0].kind).toBe("launch");
  });
});

describe("generic tool failures are NOT insufficient_scope", () => {
  it("a run-time failure returns an isError result, not a thrown protocol error", async () => {
    const { client } = buildInProcess();
    // Authorized (read scope) but the session does not exist -> service throws.
    const out = await callTool(client, principal(), "kiro_get_session", {
      sessionId: "missing",
    });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("session not found");
  });

  it("unknown tool name throws MethodNotFound, not insufficient_scope", async () => {
    const { client } = buildInProcess();
    await expect(callTool(client, principal(), "nope", {})).rejects.toThrow(/unknown tool/);
  });
});

describe("one client interface, two implementations, no transport branching", () => {
  it("tools accept both the in-process and HTTP clients identically", async () => {
    // In-process client.
    const h = buildInProcess({ ids: ["sess-a", "cmd-a"] });
    const inProc = await callTool(h.client, principal(), "kiro_launch_session", {
      prompt: "x",
      repos: ["acme/app"],
    });
    expect(inProc.structuredContent).toMatchObject({ sessionId: "sess-a" });

    // HTTP client against a fake REST API: SAME tool code path.
    const http = new HttpClient({
      baseUrl: "https://host",
      tokens: {
        async accessToken() {
          return "tok";
        },
      },
      fetch: fakeRestFetch({
        "POST /v1/sessions": { status: 202, body: { sessionId: "sess-b", turnId: null } },
      }),
      newIdempotencyKey: () => "key-1",
    });
    const httpOut = await callTool(http, principal(), "kiro_launch_session", {
      prompt: "x",
      repos: ["acme/app"],
    });
    expect(httpOut.structuredContent).toMatchObject({ sessionId: "sess-b" });

    // Both are the same class family: exactly one in-process + one HTTP impl.
    expect(h.client).toBeInstanceOf(InProcessClient);
    expect(http).toBeInstanceOf(HttpClient);
  });

  it("listTools advertises all 16 tools", () => {
    expect(listTools().tools).toHaveLength(16);
  });
});

describe("HTTP transport handler (stateless JSON-RPC)", () => {
  it("answers initialize, tools/list, and tools/call", async () => {
    const h = buildInProcess({ ids: ["sess-1", "cmd-1"] });
    const handler = createHttpTransportHandler({ client: h.client });
    const p = principal();

    const init = await handler.handle({
      principal: p,
      method: "POST",
      headers: {},
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(init.status).toBe(200);
    expect(JSON.parse(init.body).result.serverInfo.name).toBe("kiro-remote");

    const list = await handler.handle({
      principal: p,
      method: "POST",
      headers: {},
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(JSON.parse(list.body).result.tools).toHaveLength(16);

    const call = await handler.handle({
      principal: p,
      method: "POST",
      headers: {},
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "kiro_launch_session", arguments: { prompt: "x", repos: ["acme/app"] } },
      }),
    });
    expect(JSON.parse(call.body).result.structuredContent).toMatchObject({ sessionId: "sess-1" });
  });

  it("returns a JSON-RPC error (insufficient_scope) for a scope-gated call, not a tool error", async () => {
    const { client } = buildInProcess();
    const handler = createHttpTransportHandler({ client });
    const res = await handler.handle({
      principal: principal({ scopes: ["sessions:read"] }),
      method: "POST",
      headers: {},
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "kiro_delete_session", arguments: { sessionId: "x" } },
      }),
    });
    const parsed = JSON.parse(res.body);
    expect(parsed.error).toBeDefined();
    expect(parsed.error.message).toContain("insufficient_scope");
    expect(parsed.error.data).toMatchObject({
      error: "insufficient_scope",
      scope: "sessions:delete",
    });
    expect(parsed.result).toBeUndefined();
  });

  it("acknowledges notifications with 202 and no body", async () => {
    const { client } = buildInProcess();
    const handler = createHttpTransportHandler({ client });
    const res = await handler.handle({
      principal: principal(),
      method: "POST",
      headers: {},
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(res.status).toBe(202);
    expect(res.body).toBe("");
  });
});
