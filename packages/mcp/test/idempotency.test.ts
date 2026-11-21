/**
 * Optional idempotencyKey on the state-changing tools, on both MCP paths:
 * the in-process transport wraps the service call in withIdempotency, and the
 * stdio HTTP client sends the key as the Idempotency-Key header.
 */

import { describe, expect, it } from "vitest";
import { HttpClient, HttpClientError } from "../src/http-client.ts";
import { callTool } from "../src/server.ts";
import { buildInProcess, fakeRestFetch, principal, type RecordedRequest } from "./helpers.ts";

const P = principal();
const LAUNCH = { prompt: "do it", repos: ["acme/app"] };

describe("in-process /mcp transport", () => {
  it("the same key and input returns the first result without a second command", async () => {
    const h = buildInProcess({ ids: ["sess-1", "cmd-1", "sess-2", "cmd-2"] });
    const first = await callTool(h.client, P, "kiro_launch_session", {
      ...LAUNCH,
      idempotencyKey: "launch-1",
    });
    const second = await callTool(h.client, P, "kiro_launch_session", {
      ...LAUNCH,
      idempotencyKey: "launch-1",
    });
    expect(first.isError).toBeUndefined();
    expect(first.structuredContent).toMatchObject({ sessionId: "sess-1" });
    expect(second.structuredContent).toEqual(first.structuredContent);
    expect(h.queue.commands).toHaveLength(1);
  });

  it("the same key with different input is refused as a tool error and runs nothing", async () => {
    const h = buildInProcess({ ids: ["sess-1", "cmd-1", "sess-2", "cmd-2"] });
    await callTool(h.client, P, "kiro_launch_session", { ...LAUNCH, idempotencyKey: "k" });
    const refused = await callTool(h.client, P, "kiro_launch_session", {
      ...LAUNCH,
      prompt: "something else",
      idempotencyKey: "k",
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/idempotency key was already used/);
    expect(h.queue.commands).toHaveLength(1);
  });

  it("the same key on a different tool is refused too", async () => {
    const h = buildInProcess({ ids: ["sess-1", "cmd-1"] });
    h.seedSession({ id: "s1", status: "idle" });
    await callTool(h.client, P, "kiro_cancel_turn", { sessionId: "s1", idempotencyKey: "k" });
    const refused = await callTool(h.client, P, "kiro_delete_session", {
      sessionId: "s1",
      idempotencyKey: "k",
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/idempotency key was already used/);
  });

  it("without a key every call runs, as before", async () => {
    const h = buildInProcess({ ids: ["sess-1", "cmd-1", "sess-2", "cmd-2"] });
    const a = await callTool(h.client, P, "kiro_launch_session", LAUNCH);
    const b = await callTool(h.client, P, "kiro_launch_session", LAUNCH);
    expect(a.structuredContent).toMatchObject({ sessionId: "sess-1" });
    expect(b.structuredContent).toMatchObject({ sessionId: "sess-2" });
    expect(h.queue.commands).toHaveLength(2);
    expect([...h.ddb.items.keys()].some((k) => k.startsWith("IDEMP#"))).toBe(false);
  });

  it("keys are scoped to the caller's sub", async () => {
    const h = buildInProcess({ ids: ["sess-1", "cmd-1", "sess-2", "cmd-2"] });
    await callTool(h.client, P, "kiro_launch_session", { ...LAUNCH, idempotencyKey: "k" });
    const other = await callTool(h.client, principal({ sub: "user-2" }), "kiro_launch_session", {
      ...LAUNCH,
      idempotencyKey: "k",
    });
    expect(other.structuredContent).toMatchObject({ sessionId: "sess-2" });
    expect(h.queue.commands).toHaveLength(2);
  });

  it("an error is not cached: a retry with the same key runs again", async () => {
    const h = buildInProcess({ ids: ["turn-1", "cmd-1"] });
    const args = { sessionId: "s1", prompt: "hi", whenBusy: "reject", idempotencyKey: "retry" };
    const failed = await callTool(h.client, P, "kiro_send_prompt", args);
    expect(failed.isError).toBe(true);
    expect(h.queue.commands).toHaveLength(0);

    h.seedSession({ id: "s1", status: "idle" });
    const ok = await callTool(h.client, P, "kiro_send_prompt", args);
    expect(ok.isError).toBeUndefined();
    expect(h.queue.commands).toHaveLength(1);

    const again = await callTool(h.client, P, "kiro_send_prompt", args);
    expect(again.structuredContent).toEqual(ok.structuredContent);
    expect(h.queue.commands).toHaveLength(1);
  });

  it("a key-less void tool and a keyed one return the same result", async () => {
    const h = buildInProcess();
    h.seedSession({ id: "s1", status: "idle" });
    const plain = await callTool(h.client, P, "kiro_cancel_turn", { sessionId: "s1" });
    const keyed = await callTool(h.client, P, "kiro_cancel_turn", {
      sessionId: "s1",
      idempotencyKey: "c",
    });
    const replayed = await callTool(h.client, P, "kiro_cancel_turn", {
      sessionId: "s1",
      idempotencyKey: "c",
    });
    expect(keyed.structuredContent).toEqual(plain.structuredContent);
    expect(replayed.structuredContent).toEqual(plain.structuredContent);
  });

  it("rejects a key with characters outside the allowed set", async () => {
    const h = buildInProcess();
    const res = await callTool(h.client, P, "kiro_launch_session", {
      ...LAUNCH,
      idempotencyKey: "bad key#1",
    });
    expect(res.isError).toBe(true);
    expect(h.queue.commands).toHaveLength(0);
  });

  it("rejects a key longer than 128 characters", async () => {
    const h = buildInProcess();
    const res = await callTool(h.client, P, "kiro_launch_session", {
      ...LAUNCH,
      idempotencyKey: "a".repeat(129),
    });
    expect(res.isError).toBe(true);
  });
});

function httpClient(routes: Record<string, { status: number; body: unknown }>) {
  const recorded: RecordedRequest[] = [];
  const client = new HttpClient({
    baseUrl: "https://host",
    tokens: { accessToken: async () => "tok" },
    fetch: fakeRestFetch(routes, recorded),
    newIdempotencyKey: () => "generated",
  });
  return { client, recorded };
}

describe("stdio HTTP client", () => {
  const routes = {
    "POST /v1/sessions": { status: 202, body: { sessionId: "s1", turnId: null } },
    "POST /v1/sessions/s1/turns": { status: 202, body: { id: "t1" } },
    "POST /v1/sessions/s1/cancel": { status: 202, body: {} },
    "DELETE /v1/sessions/s1": { status: 202, body: {} },
    "PATCH /v1/sessions/s1/config": { status: 202, body: {} },
    "DELETE /v1/sessions/s1/links/acme/app/7": { status: 204, body: {} },
  };

  it("sends the caller's key as the Idempotency-Key header instead of a fresh one", async () => {
    const { client, recorded } = httpClient(routes);
    await callTool(client, P, "kiro_launch_session", { ...LAUNCH, idempotencyKey: "mine-1" });
    await callTool(client, P, "kiro_send_prompt", {
      sessionId: "s1",
      prompt: "hi",
      idempotencyKey: "mine-2",
    });
    await callTool(client, P, "kiro_cancel_turn", { sessionId: "s1", idempotencyKey: "mine-3" });
    await callTool(client, P, "kiro_delete_session", { sessionId: "s1", idempotencyKey: "mine-4" });
    await callTool(client, P, "kiro_set_config", {
      sessionId: "s1",
      mode: "vibe",
      idempotencyKey: "mine-5",
    });
    await callTool(client, P, "kiro_unlink_pull_request", {
      sessionId: "s1",
      pr: "acme/app#7",
      idempotencyKey: "mine-6",
    });
    expect(recorded.map((r) => r.headers["idempotency-key"])).toEqual([
      "mine-1",
      "mine-2",
      "mine-3",
      "mine-4",
      "mine-5",
      "mine-6",
    ]);
  });

  it("without a key it still generates a fresh key on writes that had one", async () => {
    const { client, recorded } = httpClient(routes);
    await callTool(client, P, "kiro_launch_session", LAUNCH);
    expect(recorded[0].headers["idempotency-key"]).toBe("generated");
  });

  it("without a key PATCH config and DELETE link send no header, as before", async () => {
    const { client, recorded } = httpClient(routes);
    await callTool(client, P, "kiro_set_config", { sessionId: "s1", mode: "vibe" });
    await callTool(client, P, "kiro_unlink_pull_request", { sessionId: "s1", pr: "acme/app#7" });
    expect(recorded.map((r) => r.headers["idempotency-key"])).toEqual([undefined, undefined]);
  });

  it("the key is not sent in the request body", async () => {
    const { client, recorded } = httpClient(routes);
    await callTool(client, P, "kiro_launch_session", { ...LAUNCH, idempotencyKey: "mine-1" });
    expect(JSON.parse(recorded[0].body ?? "{}")).toEqual(LAUNCH);
  });

  it("surfaces the server's 422 reason as the tool error", async () => {
    const { client } = httpClient({
      "POST /v1/sessions": {
        status: 422,
        body: {
          type: "https://x/idempotency-key-reused",
          status: 422,
          detail: "this idempotency key was already used for a different request",
        },
      },
    });
    const res = await callTool(client, P, "kiro_launch_session", {
      ...LAUNCH,
      idempotencyKey: "k",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("422");
    expect(res.content[0].text).toContain("already used for a different request");
    await expect(client.launchSession(P, LAUNCH)).rejects.toBeInstanceOf(HttpClientError);
  });
});
