/** kiro_send_prompt and the prompt queue over the in-process /mcp transport. */

import { describe, expect, it } from "vitest";
import { callTool } from "../src/server.ts";
import { buildInProcess, principal } from "./helpers.ts";

const P = principal();
const send = (h: ReturnType<typeof buildInProcess>, whenBusy: string, prompt = "go") =>
  callTool(h.client, P, "kiro_send_prompt", { sessionId: "s1", prompt, whenBusy });

describe("kiro_send_prompt whenBusy steer on a busy session", () => {
  it("is a tool error naming steer_unsupported and queue, on a running turn; nothing is stored or sent", async () => {
    const h = buildInProcess({ ids: ["turn-1", "cmd-1"] });
    h.seedSession({ id: "s1", status: "running" });
    const res = await send(h, "steer");
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("steer_unsupported");
    expect(res.content[0].text).toContain('whenBusy "queue"');
    expect(h.queue.commands).toEqual([]);
    expect([...h.ddb.items.keys()].filter((k) => k.includes("QPROMPT#"))).toEqual([]);
  });

  it("is the same tool error on an idle session with prompts queued, and the queue is untouched", async () => {
    const h = buildInProcess({ ids: ["turn-1", "cmd-1", "turn-2", "cmd-2"] });
    h.seedSession({ id: "s1", status: "idle" });
    const queued = await send(h, "queue", "later");
    expect(queued.structuredContent).toMatchObject({ turn: { id: "turn-1" } });
    const before = JSON.stringify((await h.client.getSession(P, "s1")).queue);

    const res = await send(h, "steer");
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("steer_unsupported");
    expect(h.queue.commands).toHaveLength(1);
    expect(JSON.stringify((await h.client.getSession(P, "s1")).queue)).toBe(before);
  });

  it("is still an ordinary prompt on an idle session with an empty queue, and the default is steer", async () => {
    const h = buildInProcess({ ids: ["turn-1", "cmd-1"] });
    h.seedSession({ id: "s1", status: "idle" });
    const res = await callTool(h.client, P, "kiro_send_prompt", { sessionId: "s1", prompt: "go" });
    expect(res.isError).toBeUndefined();
    expect(h.queue.commands).toMatchObject([{ kind: "prompt", whenBusy: "steer" }]);
  });

  it("queue on a running turn answers queued and kiro_get_session lists it", async () => {
    const h = buildInProcess({ ids: ["turn-1", "cmd-1"] });
    h.seedSession({ id: "s1", status: "running" });
    const res = await send(h, "queue");
    expect(res.structuredContent).toMatchObject({ turn: { id: "turn-1", status: "queued" } });
    const session = await callTool(h.client, P, "kiro_get_session", { sessionId: "s1" });
    expect(session.structuredContent).toMatchObject({
      session: { queue: [{ turnId: "turn-1", status: "queued", reason: null }] },
    });
  });
});
