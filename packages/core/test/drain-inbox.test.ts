import { describe, expect, it } from "vitest";
import {
  type Command,
  type CommandQueue,
  drainInbox,
  type InboxItem,
  inboxSk,
  type Principal,
  type Repository,
  type ServiceDeps,
  sendPrompt,
  sessionPk,
} from "../src/index.ts";
import { memoryRepository, sessionItem } from "../src/testing/memory-ddb.ts";

const T0 = Date.parse("2026-02-01T00:00:00.000Z");

class Queue implements CommandQueue {
  commands: Command[] = [];
  failNext = false;
  async enqueue(c: Command): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("sqs down");
    }
    this.commands.push(c);
  }
}

function item(id: string, over: Partial<InboxItem> = {}): InboxItem {
  return {
    PK: sessionPk("S1"),
    SK: inboxSk(id),
    id,
    sessionId: "S1",
    source: "github",
    deliveryId: `d-${id}`,
    deliveryIds: [`d-${id}`],
    kind: "review",
    key: "octo/repo#1",
    prompt: `[GitHub webhook] wake ${id}`,
    data: null,
    createdAt: new Date(T0 - 60_000).toISOString(),
    notBefore: new Date(T0 - 60_000).toISOString(),
    status: "pending",
    dropReason: null,
    deliveredTurnId: null,
    autoClose: false,
    ttl: 9_999_999_999,
    ...over,
  };
}

async function setup(sessionOver: Record<string, unknown> = {}) {
  const { repo, ddb } = await memoryRepository(() => T0);
  ddb.put(sessionItem("S1", sessionOver));
  const queue = new Queue();
  let n = 0;
  const deps = { repo, queue, now: () => T0, newId: () => `id-${++n}` };
  const put = (i: InboxItem) => repo.putInboxItem(i);
  const statuses = async () =>
    Object.fromEntries((await repo.queryInbox("S1")).map((i) => [i.id, i.status]));
  return { repo, ddb, queue, deps, put, statuses };
}

describe("drainInbox", () => {
  it("does nothing when the inbox is empty", async () => {
    const { deps, queue } = await setup();
    expect(await drainInbox(deps, "S1")).toEqual({ status: "empty" });
    expect(queue.commands).toEqual([]);
  });

  it("an idle session gets ONE prompt turn for the pending item, marked delivered with the turn id", async () => {
    const { deps, queue, put, repo, statuses } = await setup();
    await put(item("01A"));
    const res = await drainInbox(deps, "S1");
    expect(res.status).toBe("delivered");
    expect(queue.commands).toHaveLength(1);
    const cmd = queue.commands[0];
    expect(cmd).toMatchObject({
      kind: "prompt",
      sub: "user-sub-1",
      sessionId: "S1",
      whenBusy: "reject",
      trigger: { source: "github", deliveryIds: ["d-01A"], inboxIds: ["01A"] },
    });
    expect((cmd as { prompt: string }).prompt).toContain("wake 01A");
    expect(await statuses()).toEqual({ "01A": "delivered" });
    const stored = (await repo.queryInbox("S1"))[0];
    expect(stored.deliveredTurnId).toBe((cmd as { turnId: string }).turnId);
  });

  it("never enqueues into a busy session: items stay pending", async () => {
    for (const status of ["running", "awaiting_permission", "provisioning"]) {
      const { deps, queue, put, statuses } = await setup({ status });
      await put(item("01A"));
      expect((await drainInbox(deps, "S1")).status).toBe("busy");
      expect(queue.commands).toEqual([]);
      expect(await statuses()).toEqual({ "01A": "pending" });
    }
  });

  it("folds all pending items into one turn, oldest first", async () => {
    const { deps, queue, put, statuses } = await setup();
    await put(item("01C", { prompt: "third" }));
    await put(item("01A", { prompt: "first" }));
    await put(item("01B", { prompt: "second", deliveryIds: ["d-1", "d-2"] }));
    const res = await drainInbox(deps, "S1");
    expect(res.status).toBe("delivered");
    expect(queue.commands).toHaveLength(1);
    const cmd = queue.commands[0] as Extract<Command, { kind: "prompt" }>;
    expect(cmd.prompt.indexOf("first")).toBeLessThan(cmd.prompt.indexOf("second"));
    expect(cmd.prompt.indexOf("second")).toBeLessThan(cmd.prompt.indexOf("third"));
    expect(cmd.trigger?.inboxIds).toEqual(["01A", "01B", "01C"]);
    expect(cmd.trigger?.deliveryIds).toEqual(["d-01A", "d-1", "d-2", "d-01C"]);
    expect(await statuses()).toEqual({
      "01A": "delivered",
      "01B": "delivered",
      "01C": "delivered",
    });
    // Draining again finds nothing.
    expect((await drainInbox(deps, "S1")).status).toBe("empty");
    expect(queue.commands).toHaveLength(1);
  });

  it("drops items of a failed or deleted session, recording the reason", async () => {
    for (const status of ["failed", "deleted"]) {
      const { deps, queue, put, repo } = await setup({ status });
      await put(item("01A"));
      await put(item("01B"));
      expect(await drainInbox(deps, "S1")).toEqual({
        status: "dropped",
        dropped: 2,
        reason: `session_${status}`,
      });
      const items = await repo.queryInbox("S1");
      expect(items.map((i) => [i.status, i.dropReason])).toEqual([
        ["dropped", `session_${status}`],
        ["dropped", `session_${status}`],
      ]);
      expect(queue.commands).toEqual([]);
    }
  });

  it("holds items that are not due yet (debounce)", async () => {
    const { deps, queue, put, statuses } = await setup();
    const later = new Date(T0 + 120_000).toISOString();
    await put(item("01A", { notBefore: later }));
    expect(await drainInbox(deps, "S1")).toEqual({ status: "not_due", nextDueAt: later });
    expect(queue.commands).toEqual([]);
    // Once it is due, it goes; due items go without waiting for the not-yet-due one.
    await put(item("01B"));
    const res = await drainInbox(deps, "S1");
    expect(res.status).toBe("delivered");
    expect(await statuses()).toEqual({ "01A": "pending", "01B": "delivered" });
  });

  it("a manual prompt wins: it bumps META's version so a drain that read the session before it loses the lock", async () => {
    const { repo, ddb, deps, queue, put, statuses } = await setup();
    await put(item("01A"));

    // The drain reads META (version 0) and then, before it claims, a manual
    // prompt lands. Simulate the interleaving by running the manual prompt from
    // inside the drain's own read of the inbox.
    const realQuery = repo.queryInbox.bind(repo);
    let interleaved = false;
    repo.queryInbox = async (...a: Parameters<Repository["queryInbox"]>) => {
      const out = await realQuery(...a);
      if (!interleaved) {
        interleaved = true;
        const principal = { sub: "user-sub-1", scopes: ["sessions:write"] } as Principal;
        await sendPrompt(
          { repo, queue: new Queue(), allowedRepos: [], newId: () => "manual" } as ServiceDeps,
          principal,
          "S1",
          { prompt: "hello", whenBusy: "reject" },
        );
      }
      return out;
    };

    const res = await drainInbox(deps, "S1");
    expect(res).toEqual({ status: "contended" });
    expect(queue.commands).toEqual([]);
    expect(await statuses()).toEqual({ "01A": "pending" });

    // After the manual turn settles and the session is idle again, the drain goes through.
    repo.queryInbox = realQuery;
    expect((await drainInbox(deps, "S1")).status).toBe("delivered");
    expect((ddb.get("SESSION#S1", "META") as { version: number }).version).toBeGreaterThan(0);
  });

  it("two drains at once start exactly one turn", async () => {
    const { deps, queue, put } = await setup();
    await put(item("01A"));
    const [a, b] = await Promise.all([drainInbox(deps, "S1"), drainInbox(deps, "S1")]);
    expect([a.status, b.status].sort()).toEqual(["contended", "delivered"]);
    expect(queue.commands).toHaveLength(1);
  });

  it("puts the items back when the wake turn cannot be enqueued", async () => {
    const { deps, queue, put, statuses } = await setup();
    await put(item("01A"));
    queue.failNext = true;
    await expect(drainInbox(deps, "S1")).rejects.toThrow("sqs down");
    expect(await statuses()).toEqual({ "01A": "pending" });
    expect((await drainInbox(deps, "S1")).status).toBe("delivered");
  });

  it("counts a wake turn against the concurrency limit: items stay pending and are retried", async () => {
    const { deps, queue, put, ddb, statuses } = await setup();
    for (let i = 0; i < 2; i++) {
      ddb.put(sessionItem(`R${i}`, { status: "running" }));
    }
    await put(item("01A"));
    const limited = { ...deps, maxCloudSessions: 2 };
    expect(await drainInbox(limited, "S1")).toEqual({ status: "limit", running: 2, limit: 2 });
    expect(queue.commands).toEqual([]);
    expect(await statuses()).toEqual({ "01A": "pending" });
    (ddb.get("SESSION#R0", "META") as { status: string }).status = "idle";
    expect((await drainInbox(limited, "S1")).status).toBe("delivered");
  });

  it("carries autoClose onto the turn", async () => {
    const { deps, queue, put } = await setup();
    await put(item("01A", { autoClose: true, kind: "pr_merged" }));
    await drainInbox(deps, "S1");
    expect((queue.commands[0] as Extract<Command, { kind: "prompt" }>).trigger?.autoClose).toBe(
      true,
    );
  });

  it("releaseInbox only undoes the claim made for that turn", async () => {
    const { repo, put, statuses } = await setup();
    await put(item("01A"));
    await repo.claimInbox("S1", ["01A"], "turn-1");
    await repo.releaseInbox("S1", ["01A"], "other-turn");
    expect(await statuses()).toEqual({ "01A": "delivered" });
    await repo.releaseInbox("S1", ["01A"], "turn-1");
    expect(await statuses()).toEqual({ "01A": "pending" });
  });

  it("merging into a delivered item fails (it must start a new item)", async () => {
    const { repo, put } = await setup();
    await put(item("01A"));
    expect(
      await repo.mergeInboxItem("S1", "01A", { deliveryIds: ["x"], prompt: "p", data: null }),
    ).toBe(true);
    await repo.claimInbox("S1", ["01A"], "t");
    expect(
      await repo.mergeInboxItem("S1", "01A", { deliveryIds: ["y"], prompt: "q", data: null }),
    ).toBe(false);
  });
});
