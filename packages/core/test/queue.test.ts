/**
 * The prompt queue (service/queue.ts and the service calls around it) on the real Repository over
 * the in-memory DynamoDB: the order prompts run in, a steer beside a queue, a delete and an
 * automatic close with a queue, and the failure a prompt that cannot run ends with.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  type Command,
  type CommandQueue,
  deleteSession,
  drainInbox,
  drainQueuedPrompts,
  failOpenQueuedPrompts,
  getSession,
  type InboxItem,
  InvalidStateError,
  isOpenQueuedPrompt,
  type Principal,
  QUEUED_PROMPT_CLAIM_STALE_MS,
  type ServiceDeps,
  sendPrompt,
} from "../src/index.ts";
import { memoryRepository, sessionItem } from "../src/testing/memory-ddb.ts";

const OWNER = "user-sub-1";
const P: Principal = {
  sub: OWNER,
  clientId: "c",
  scopes: ["sessions:read", "sessions:write", "sessions:delete"],
};
const T0 = Date.parse("2026-02-01T11:00:00.000Z");

class Commands implements CommandQueue {
  commands: Command[] = [];
  failNext = false;
  async enqueue(c: Command) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("sqs is down");
    }
    this.commands.push(c);
  }
  of<K extends Command["kind"]>(kind: K) {
    return this.commands.filter((c): c is Extract<Command, { kind: K }> => c.kind === kind);
  }
}

async function setup(status = "running") {
  let now = T0;
  let n = 0;
  let sent = 0;
  const { repo, ddb } = await memoryRepository(() => now);
  ddb.put(sessionItem("S1", { createdBy: OWNER, status }));
  const queue = new Commands();
  const deps: ServiceDeps = {
    repo,
    queue,
    allowedRepos: ["octo/*"],
    now: () => now,
    newId: () => `id-${String(++n).padStart(3, "0")}`,
  };
  const feed = async () => (await repo.readFeed(OWNER, 0, 200)).events;
  const setStatus = async (s: string) => repo.patchSession("S1", { status: s as never });
  return {
    repo,
    ddb,
    deps,
    queue,
    feed,
    setStatus,
    tick: (ms = 1) => {
      now += ms;
    },
    /** Send a prompt the way a caller does, one millisecond after the last. */
    async send(whenBusy: "steer" | "queue" | "reject", prompt = `prompt ${++sent}`) {
      now += 1;
      return sendPrompt(deps, P, "S1", { prompt, whenBusy }, { source: "mcp" });
    },
  };
}

describe("a queued prompt is stored under the turn id the caller gets", () => {
  it("answers queued while a turn runs, and keeps the prompt where GET /v1/sessions/{id} lists it", async () => {
    const w = await setup();
    const turn = await w.send("queue", "do the thing");
    expect(turn).toMatchObject({ status: "queued", sessionId: "S1" });

    const item = await w.repo.getQueuedPrompt("S1", turn.id);
    expect(item).toMatchObject({ status: "queued", claimedAt: null, failReason: null });
    expect(await w.repo.queuedPromptText(item as never)).toBe("do the thing");
    // The same turn id travels with the command.
    expect(w.queue.of("prompt")).toMatchObject([{ turnId: turn.id, whenBusy: "queue" }]);

    const view = await getSession(w.deps, P, "S1");
    expect(view.queue).toEqual([
      { turnId: turn.id, status: "queued", queuedAt: expect.any(String), reason: null },
    ]);
    // Never the prompt's text.
    expect(JSON.stringify(view)).not.toContain("do the thing");
  });

  it("answers running on an idle session with nothing queued, and still queues it (the bridge starts it)", async () => {
    const w = await setup("idle");
    const turn = await w.send("queue");
    expect(turn.status).toBe("running");
    expect((await w.repo.getQueuedPrompt("S1", turn.id))?.status).toBe("queued");
  });

  it("a prompt that is not sent is not left to run: the call fails and the prompt fails with not_sent", async () => {
    const w = await setup();
    w.queue.failNext = true;
    await expect(w.send("queue")).rejects.toThrow("sqs is down");
    const [item] = await w.repo.listQueuedPrompts("S1");
    expect(item).toMatchObject({ status: "failed", failReason: "not_sent" });
    const feed = await w.feed();
    expect(feed.map((e) => [e.type, e.effect, e.source, e.payload])).toEqual([
      [
        "prompt.failed",
        "annotation",
        "mcp",
        { turnId: item.id, whenBusy: "queue", reason: "not_sent" },
      ],
    ]);
  });
});

describe("queue order: oldest first, one at a time, once", () => {
  it("drains the oldest prompt, makes the next wait behind it, and moves on when it has started", async () => {
    const w = await setup();
    const a = await w.send("queue");
    const b = await w.send("queue");
    const c = await w.send("queue");
    w.queue.commands.length = 0;

    // Running: nothing starts.
    expect(await drainQueuedPrompts(w.deps, "S1")).toEqual({ status: "busy" });

    // The turn in front ended.
    await w.setStatus("idle");
    expect(await drainQueuedPrompts(w.deps, "S1")).toEqual({ status: "delivered", turnId: a.id });
    expect(w.queue.of("prompt")).toMatchObject([
      { turnId: a.id, whenBusy: "reject", queued: true, prompt: "prompt 1" },
    ]);
    // A second drain while the first prompt is on its way must not send the next one ahead of it.
    expect(await drainQueuedPrompts(w.deps, "S1")).toEqual({ status: "in_flight", turnId: a.id });
    expect(w.queue.of("prompt")).toHaveLength(1);

    // It starts, runs, and the session is idle again.
    expect(await w.repo.startQueuedPrompt("S1", a.id)).toBe(true);
    expect(await drainQueuedPrompts(w.deps, "S1")).toEqual({ status: "delivered", turnId: b.id });
    expect(await w.repo.startQueuedPrompt("S1", b.id)).toBe(true);
    expect(await drainQueuedPrompts(w.deps, "S1")).toEqual({ status: "delivered", turnId: c.id });
    expect(await w.repo.startQueuedPrompt("S1", c.id)).toBe(true);
    expect(await drainQueuedPrompts(w.deps, "S1")).toEqual({ status: "empty" });

    expect(w.queue.of("prompt").map((p) => p.prompt)).toEqual(["prompt 1", "prompt 2", "prompt 3"]);
  });

  it("orders by when the prompt was sent, not by the turn id", async () => {
    const w = await setup("idle");
    // Two turn ids that sort the other way round from the order they were sent in.
    await w.repo.putQueuedPrompt({ sessionId: "S1", id: "zzz", prompt: "first" });
    w.tick(5);
    await w.repo.putQueuedPrompt({ sessionId: "S1", id: "aaa", prompt: "second" });
    expect(await drainQueuedPrompts(w.deps, "S1")).toEqual({ status: "delivered", turnId: "zzz" });
  });

  it("two drains at once start the prompt once", async () => {
    const w = await setup("idle");
    const a = await w.send("queue");
    w.queue.commands.length = 0;
    const results = await Promise.all([
      drainQueuedPrompts(w.deps, "S1"),
      drainQueuedPrompts(w.deps, "S1"),
      drainQueuedPrompts(w.deps, "S1"),
    ]);
    expect(results.filter((r) => r.status === "delivered")).toEqual([
      { status: "delivered", turnId: a.id },
    ]);
    expect(w.queue.of("prompt")).toHaveLength(1);
    // The turn starts from the claim once; a redelivered command finds it started.
    expect(await w.repo.startQueuedPrompt("S1", a.id)).toBe(true);
    expect(await w.repo.startQueuedPrompt("S1", a.id)).toBe(false);
  });

  it("a prompt the bridge could not start keeps its place: released, it is next again", async () => {
    const w = await setup("idle");
    const a = await w.send("queue");
    const b = await w.send("queue");
    w.queue.commands.length = 0;
    await drainQueuedPrompts(w.deps, "S1");
    expect(await w.repo.releaseQueuedPrompt("S1", a.id)).toBe(true);
    expect(await drainQueuedPrompts(w.deps, "S1")).toEqual({ status: "delivered", turnId: a.id });
    expect((await w.repo.getQueuedPrompt("S1", b.id))?.status).toBe("queued");
  });

  it("a claim whose command was lost is taken back after QUEUED_PROMPT_CLAIM_STALE_MS", async () => {
    const w = await setup("idle");
    const a = await w.send("queue");
    const b = await w.send("queue");
    await drainQueuedPrompts(w.deps, "S1");
    w.queue.commands.length = 0;
    w.tick(QUEUED_PROMPT_CLAIM_STALE_MS + 1);
    expect(await drainQueuedPrompts(w.deps, "S1")).toEqual({ status: "delivered", turnId: a.id });
    expect((await w.repo.getQueuedPrompt("S1", b.id))?.status).toBe("queued");
  });

  it("a prompt that cannot be enqueued is given back and the error reaches the caller of the drain", async () => {
    const w = await setup("idle");
    const a = await w.send("queue");
    w.queue.failNext = true;
    await expect(drainQueuedPrompts(w.deps, "S1")).rejects.toThrow("sqs is down");
    expect((await w.repo.getQueuedPrompt("S1", a.id))?.status).toBe("queued");
    expect(await drainQueuedPrompts(w.deps, "S1")).toEqual({ status: "delivered", turnId: a.id });
  });

  it("wakes wait for the queue: the inbox drain starts nothing while a prompt is queued", async () => {
    const w = await setup("idle");
    const wake: InboxItem = {
      PK: "SESSION#S1",
      SK: "INBOX#i1",
      id: "i1",
      sessionId: "S1",
      source: "github",
      deliveryId: "d1",
      deliveryIds: ["d1"],
      kind: "review",
      key: "octo/repo#1",
      prompt: "[GitHub webhook] review",
      data: null,
      createdAt: new Date(T0).toISOString(),
      notBefore: new Date(T0).toISOString(),
      status: "pending",
      dropReason: null,
      deliveredTurnId: null,
      autoClose: false,
      ttl: 9_999_999_999,
    };
    await w.repo.putInboxItem(wake);
    const a = await w.send("queue");
    expect(await drainInbox(w.deps, "S1")).toEqual({ status: "busy" });
    // Once the queue is empty the wake goes.
    await w.repo.claimQueuedPrompt("S1", a.id);
    await w.repo.startQueuedPrompt("S1", a.id);
    expect((await drainInbox(w.deps, "S1")).status).toBe("delivered");
  });
});

describe("a steer and a queue together", () => {
  it("a steer on a running turn fails in the call, stores nothing and leaves the queue as it was", async () => {
    const w = await setup();
    const a = await w.send("queue");
    const b = await w.send("queue");
    const before = await w.repo.listQueuedPrompts("S1");
    w.queue.commands.length = 0;

    const err = await w.send("steer", "change course").catch((e) => e);
    expect(err).toBeInstanceOf(InvalidStateError);
    expect(err).toMatchObject({ reason: "steer_unsupported", status: 409 });
    expect(err.message).toContain("steer_unsupported");
    expect(err.message).toContain('whenBusy "queue"');
    // Nothing was sent, nothing stored, nothing on the feed, and the queue drains in order.
    expect(w.queue.commands).toEqual([]);
    expect(await w.repo.listQueuedPrompts("S1")).toEqual(before);
    expect(await w.feed()).toEqual([]);
    await w.setStatus("idle");
    expect(await drainQueuedPrompts(w.deps, "S1")).toEqual({ status: "delivered", turnId: a.id });
    await w.repo.startQueuedPrompt("S1", a.id);
    expect(await drainQueuedPrompts(w.deps, "S1")).toEqual({ status: "delivered", turnId: b.id });
  });

  it("a steer on a running turn with an empty queue fails the same way", async () => {
    const w = await setup();
    await expect(w.send("steer")).rejects.toMatchObject({ reason: "steer_unsupported" });
    expect(w.queue.commands).toEqual([]);
    expect(await w.repo.listQueuedPrompts("S1")).toEqual([]);
  });

  it("an idle session with prompts queued is busy: steer and reject fail in the call, queue goes behind them", async () => {
    const w = await setup("idle");
    const a = await w.send("queue");
    w.queue.commands.length = 0;
    await expect(w.send("steer")).rejects.toMatchObject({ reason: "steer_unsupported" });
    await expect(w.send("reject")).rejects.toBeInstanceOf(InvalidStateError);
    expect(w.queue.commands).toEqual([]);
    const b = await w.send("queue");
    expect(b.status).toBe("queued");
    expect((await w.repo.listQueuedPrompts("S1")).map((q) => q.id)).toEqual([a.id, b.id]);
  });

  it("an idle session with an empty queue takes a steer as an ordinary prompt", async () => {
    const w = await setup("idle");
    const turn = await w.send("steer");
    expect(turn.status).toBe("running");
    expect(w.queue.of("prompt")).toMatchObject([{ turnId: turn.id, whenBusy: "steer" }]);
    expect(await w.repo.listQueuedPrompts("S1")).toEqual([]);
  });
});

describe("deleting a session with a queue", () => {
  it("fails each queued prompt first, visibly, and only then sends the delete", async () => {
    const w = await setup();
    const a = await w.send("queue");
    const b = await w.send("queue");
    w.queue.commands.length = 0;

    await deleteSession(w.deps, P, "S1", { source: "mcp" });

    // Each prompt: failed with the reason, in the session's view.
    expect((await getSession(w.deps, P, "S1")).queue).toEqual([
      { turnId: a.id, status: "failed", queuedAt: expect.any(String), reason: "session_deleted" },
      { turnId: b.id, status: "failed", queuedAt: expect.any(String), reason: "session_deleted" },
    ]);
    // ...on the session's event log, under the turn id the caller holds...
    const log = (await w.repo.queryEvents("S1", 0)).filter((e) => e.type === "turn.failed");
    expect(log.map((e) => [e.turnId, e.rawType])).toEqual([
      [a.id, "queued_prompt_failed"],
      [b.id, "queued_prompt_failed"],
    ]);
    expect((log[0].payload as { payload: unknown }).payload).toEqual({
      source: "kiro-remote",
      whenBusy: "queue",
      reason: "session_deleted",
    });
    // ...and on the change feed, with the source of the delete.
    const feed = (await w.feed()).filter((e) => e.type === "prompt.failed");
    expect(feed.map((e) => [e.source, e.payload])).toEqual([
      ["mcp", { turnId: a.id, whenBusy: "queue", reason: "session_deleted" }],
      ["mcp", { turnId: b.id, whenBusy: "queue", reason: "session_deleted" }],
    ]);
    // The delete follows.
    expect(w.queue.commands.map((c) => c.kind)).toEqual(["delete"]);
  });

  it("fails a prompt once: failing it again writes nothing", async () => {
    const w = await setup();
    await w.send("queue");
    expect(
      await failOpenQueuedPrompts(w.deps, "S1", { reason: "session_deleted", source: "rest" }),
    ).toBe(1);
    expect(
      await failOpenQueuedPrompts(w.deps, "S1", { reason: "session_deleted", source: "rest" }),
    ).toBe(0);
    expect((await w.feed()).filter((e) => e.type === "prompt.failed")).toHaveLength(1);
  });

  it("a delete with no queue sends the delete and writes nothing else", async () => {
    const w = await setup();
    await deleteSession(w.deps, P, "S1");
    expect(w.queue.commands.map((c) => c.kind)).toEqual(["delete"]);
    expect(await w.feed()).toEqual([]);
  });

  it("a drain of a session that is deleted or failed fails what is still queued, with the reason", async () => {
    for (const [status, reason] of [
      ["deleted", "session_deleted"],
      ["failed", "session_failed"],
    ] as const) {
      const w = await setup();
      const a = await w.send("queue");
      await w.setStatus(status);
      expect(await drainQueuedPrompts(w.deps, "S1")).toEqual({
        status: "failed",
        failed: 1,
        reason,
      });
      expect(await w.repo.getQueuedPrompt("S1", a.id)).toMatchObject({
        status: "failed",
        failReason: reason,
      });
      expect((await w.feed()).map((e) => [e.type, e.source, e.payload.reason])).toEqual([
        ["prompt.failed", "bridge", reason],
      ]);
    }
  });
});

describe("the failure is on the feed with its schema", () => {
  const dir = new URL("../schemas/feed/", import.meta.url);
  const schema = (name: string) =>
    JSON.parse(readFileSync(fileURLToPath(new URL(name, dir)), "utf8"));

  it("prompt.failed is an annotation that validates, and no prompt text is in it", async () => {
    const w = await setup();
    await w.send("queue", "a secret instruction");
    await w.send("queue");
    await deleteSession(w.deps, P, "S1", { source: "mcp" });
    const events = (await w.feed()).filter((e) => e.type === "prompt.failed");
    expect(events).toHaveLength(2);
    const ajv = new Ajv2020({ strict: false });
    const own = ajv.compile(schema("prompt.failed.json"));
    for (const e of events) {
      expect(e.effect).toBe("annotation");
      expect(own(e), JSON.stringify(own.errors)).toBe(true);
      expect(JSON.stringify(e)).not.toContain("secret");
    }
    expect(own({ ...events[0], effect: "state" })).toBe(false);
    expect(own({ ...events[0], payload: { ...events[0].payload, prompt: "x" } })).toBe(false);
  });

  it("the failure and its feed event commit in one transaction", async () => {
    const w = await setup();
    await w.send("queue");
    await deleteSession(w.deps, P, "S1");
    const failures = w.ddb.log.filter((c) => JSON.stringify(c.input).includes('"failed"'));
    expect(failures.map((c) => c.name)).toEqual(["TransactWriteCommand"]);
    const ops =
      (failures[0].input.TransactItems as Array<Record<string, Record<string, unknown>>>) ?? [];
    expect(
      ops.some((o) =>
        String(o.Update?.Key && (o.Update.Key as { SK: string }).SK).startsWith("QPROMPT#"),
      ),
    ).toBe(true);
    expect(
      ops.some((o) => String((o.Put?.Item as { PK?: string } | undefined)?.PK).startsWith("FEED#")),
    ).toBe(true);
  });

  it("isOpenQueuedPrompt: queued and delivered are open, started and failed are not", () => {
    expect(
      ["queued", "delivered", "started", "failed"].map((status) =>
        isOpenQueuedPrompt({ status } as never),
      ),
    ).toEqual([true, true, false, false]);
  });
});
