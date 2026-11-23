/** The prompt queue over REST: what POST /turns stores, and where GET shows it. */

import { describe, expect, test } from "vitest";
import type { HttpRequest } from "../src/http.ts";
import { route } from "../src/router.ts";
import { authHeader, buildHarness, mintToken } from "./helpers.ts";

const req = (o: Partial<HttpRequest> & { method: string; path: string }): HttpRequest => ({
  query: {},
  headers: {},
  params: {},
  host: "kiro.example.com",
  ...o,
});
const post = (h: ReturnType<typeof buildHarness>, body: object, key: string) =>
  route(h.ctx, {
    ...req({ method: "POST", path: "/v1/sessions/s1/turns", body: JSON.stringify(body) }),
    headers: { ...authHeader(mintToken({})), "idempotency-key": key },
  });
const get = (h: ReturnType<typeof buildHarness>, path: string) =>
  route(h.ctx, { ...req({ method: "GET", path }), headers: authHeader(mintToken({})) });

describe("whenBusy queue over REST", () => {
  test("202 with the turn id and status queued; the prompt is on the session's queue and in GET", async () => {
    const h = buildHarness({ ids: ["turn-1", "cmd-1", "turn-2", "cmd-2"] });
    h.seedSession({ id: "s1", status: "running" });

    const first = await post(h, { prompt: "one", whenBusy: "queue" }, "k1");
    expect(first.status).toBe(202);
    expect(JSON.parse(first.body)).toMatchObject({ id: "turn-1", status: "queued" });
    expect(h.queue.commands).toMatchObject([
      { kind: "prompt", turnId: "turn-1", whenBusy: "queue" },
    ]);

    const session = JSON.parse((await get(h, "/v1/sessions/s1")).body);
    expect(session.queue).toEqual([
      { turnId: "turn-1", status: "queued", queuedAt: expect.any(String), reason: null },
    ]);
    // The prompt text is not part of the session view.
    expect((await get(h, "/v1/sessions/s1")).body).not.toContain("one");
  });

  test("GET /turns/{turnId} answers for a prompt that is still queued, and for one that failed", async () => {
    const h = buildHarness({ ids: ["turn-1", "cmd-1"] });
    h.seedSession({ id: "s1", status: "running" });
    await post(h, { prompt: "one", whenBusy: "queue" }, "k1");

    const queued = JSON.parse((await get(h, "/v1/sessions/s1/turns/turn-1")).body);
    expect(queued).toMatchObject({
      id: "turn-1",
      status: "queued",
      stopReason: null,
      prompt: "one",
      trigger: { source: "user", deliveryIds: [] },
    });

    h.ddb.put({
      ...((await h.repo.getQueuedPrompt("s1", "turn-1")) as never),
      status: "failed",
      failReason: "session_deleted",
      failedAt: "2026-01-01T00:00:00.000Z",
    });
    const failed = JSON.parse((await get(h, "/v1/sessions/s1/turns/turn-1")).body);
    expect(failed).toMatchObject({ status: "failed", stopReason: "session_deleted" });
    expect((await get(h, "/v1/sessions/s1/turns/nope")).status).toBe(404);
  });

  test("whenBusy reject is refused while prompts are queued, even when the session is idle", async () => {
    const h = buildHarness({ ids: ["turn-1", "cmd-1", "turn-2", "cmd-2"] });
    h.seedSession({ id: "s1", status: "idle" });
    await post(h, { prompt: "one", whenBusy: "queue" }, "k1");
    const res = await post(h, { prompt: "two", whenBusy: "reject" }, "k2");
    expect(res.status).toBe(409);
  });

  test("steer (the default) on a running turn is a 409 with reason steer_unsupported; nothing is stored or sent", async () => {
    const h = buildHarness();
    h.seedSession({ id: "s1", status: "running" });
    for (const body of [{ prompt: "go" }, { prompt: "go", whenBusy: "steer" }]) {
      const res = await post(h, body, `k-${JSON.stringify(body).length}`);
      expect(res.status).toBe(409);
      expect(JSON.parse(res.body)).toMatchObject({
        reason: "steer_unsupported",
        detail: expect.stringContaining('whenBusy "queue"'),
      });
    }
    expect(h.queue.commands).toEqual([]);
    expect(await h.repo.listQueuedPrompts("s1")).toEqual([]);
  });

  test("steer on an idle session with prompts queued is a 409 too, and the queue is untouched", async () => {
    const h = buildHarness();
    h.seedSession({ id: "s1", status: "idle" });
    await post(h, { prompt: "one", whenBusy: "queue" }, "k1");
    const before = await h.repo.listQueuedPrompts("s1");
    const res = await post(h, { prompt: "two", whenBusy: "steer" }, "k2");
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).reason).toBe("steer_unsupported");
    expect(h.queue.commands).toHaveLength(1);
    expect(await h.repo.listQueuedPrompts("s1")).toEqual(before);
  });

  test("steer on an idle session with an empty queue is 202, as before", async () => {
    const h = buildHarness();
    h.seedSession({ id: "s1", status: "idle" });
    const res = await post(h, { prompt: "go" }, "k1");
    expect(res.status).toBe(202);
    expect(h.queue.commands).toMatchObject([{ kind: "prompt", whenBusy: "steer" }]);
  });
});
