import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  FEED_TTL_DAYS,
  FEED_TYPE_NAMES,
  FEED_TYPES,
  type FeedEnvelope,
  type FeedPage,
  FeedQuerySchema,
  feedEventDisposition,
  feedJsonSchemas,
  getSession,
  type InboxItem,
  linkPullRequest,
  listFeedEvents,
  type Principal,
  type ServiceDeps,
  stopWaitingForPullRequest,
  unlinkPullRequest,
  waitForPullRequest,
} from "../src/index.ts";
import {
  feedViolations,
  MemoryDdb,
  memoryRepository,
  sessionItem,
} from "../src/testing/memory-ddb.ts";

const OWNER = "user-sub-1";
const P = { sub: OWNER, scopes: ["sessions:read", "sessions:write"] } as Principal;
const T0 = Date.parse("2026-02-01T11:00:00.000Z");

async function setup() {
  let now = T0;
  const { repo, ddb } = await memoryRepository(() => now);
  ddb.put(sessionItem("S1", { createdBy: OWNER }));
  ddb.put(sessionItem("S2", { createdBy: OWNER }));
  ddb.put(sessionItem("X1", { createdBy: "someone-else", GSI1PK: "USER#someone-else" }));
  const sent: unknown[] = [];
  const deps = {
    repo,
    queue: { enqueue: async () => {} },
    allowedRepos: ["octo/*", "ark/*"],
    githubQueue: {
      async send(m: unknown) {
        sent.push(m);
      },
    },
  } as unknown as ServiceDeps;
  const feed = async (owner = OWNER): Promise<FeedEnvelope[]> =>
    (await repo.readFeed(owner, 0, 200)).events;
  return {
    repo,
    ddb,
    deps,
    sent,
    feed,
    tick(ms: number) {
      now += ms;
    },
  };
}

const wakeItem = (over: Partial<InboxItem> = {}): InboxItem => ({
  PK: "SESSION#S1",
  SK: "INBOX#i1",
  id: "i1",
  sessionId: "S1",
  source: "github",
  deliveryId: "d1",
  deliveryIds: ["d1"],
  kind: "pr_merged",
  key: "octo/repo#7",
  prompt: "SECRET PROMPT TEXT the feed must never carry",
  data: { note: "SECRET DATA" },
  createdAt: new Date(T0).toISOString(),
  notBefore: new Date(T0).toISOString(),
  status: "pending",
  dropReason: null,
  deliveredTurnId: null,
  autoClose: false,
  ttl: 9999999999,
  ...over,
});

const types = (events: FeedEnvelope[]) => events.map((e) => e.type);

describe("the contract", () => {
  const dir = fileURLToPath(new URL("../schemas/feed/", import.meta.url));
  const checkedIn = (name: string) => JSON.parse(readFileSync(`${dir}${name}`, "utf8"));
  const ajv = new Ajv2020({ strict: false });

  it("the checked-in JSON Schemas are what the zod objects generate", () => {
    const generated = feedJsonSchemas();
    expect(readdirSync(dir).sort()).toEqual(Object.keys(generated).sort());
    for (const [file, schema] of Object.entries(generated)) {
      expect(checkedIn(file), file).toEqual(JSON.parse(JSON.stringify(schema)));
    }
  });

  it("has one schema per type, and every type says whether it moves state", () => {
    expect(FEED_TYPE_NAMES.sort()).toEqual([
      "link.added",
      "link.removed",
      "link.state_changed",
      "wait.registered",
      "wait.removed",
      "wake.delivered",
      "wake.dropped",
      "wake.queued",
      "wake.released",
    ]);
    for (const t of FEED_TYPE_NAMES) {
      expect(["state", "annotation"]).toContain(FEED_TYPES[t].effect);
      expect(checkedIn(`${t}.json`).properties.effect.const).toBe(FEED_TYPES[t].effect);
    }
    // Links and waits move state; wakes only record a decision.
    expect(FEED_TYPE_NAMES.filter((t) => FEED_TYPES[t].effect === "annotation").sort()).toEqual([
      "wake.delivered",
      "wake.dropped",
      "wake.queued",
      "wake.released",
    ]);
  });

  it("every event the repository emits validates against its checked-in schema and the envelope", async () => {
    const w = await setup();
    // Every type, through the real write paths.
    await w.repo.createLink({
      repo: "octo/repo",
      number: 1,
      sessionId: "S1",
      linkedBy: "harvest",
      prState: "open",
      headSha: "a",
    });
    await w.repo.updateLinkState("octo/repo#1", { prState: "merged" });
    await w.repo.deleteLink("octo/repo#1", "S1");
    await w.repo.createWait({ sessionId: "S1", pr: "octo/repo#2", source: "trailer" });
    await w.repo.deleteWait("S1", "octo/repo#2");
    await w.repo.createWait({ sessionId: "S1", pr: "octo/repo#3", source: "rest" });
    await w.repo.deleteSessionWaits("S1", { source: "mcp" });
    const a = wakeItem();
    await w.repo.putInboxItem(a);
    await w.repo.mergeInboxItem("S1", "i1", { deliveryIds: ["d1", "d2"], prompt: "p", data: null });
    await w.repo.claimInbox("S1", ["i1"], "turn-1");
    await w.repo.releaseInbox("S1", ["i1"], "turn-1");
    await w.repo.dropInbox("S1", ["i1"], "session_deleted");
    const events = await w.feed();
    expect(new Set(types(events))).toEqual(new Set(FEED_TYPE_NAMES));
    // A session's deleted waits are published under the reason the schema lists for it.
    expect(
      events
        .filter((e) => e.type === "wait.removed")
        .map((e) => (e.payload as { reason: string }).reason),
    ).toContain("session_deleted");
    const envelope = ajv.compile(checkedIn("envelope.json"));
    for (const e of events) {
      expect(envelope(e), JSON.stringify(envelope.errors)).toBe(true);
      const own = ajv.compile(checkedIn(`${e.type}.json`));
      expect(own(e), `${e.type}: ${JSON.stringify(own.errors)}`).toBe(true);
    }
    const page = ajv.compile(checkedIn("page.json"));
    const read = await w.repo.readFeed(OWNER, 0, 3);
    expect(page(read), JSON.stringify(page.errors)).toBe(true);
  });

  it("rejects an event whose payload does not match its type", () => {
    const own = ajv.compile(checkedIn("wait.removed.json"));
    const e = {
      v: 1,
      id: "x",
      seq: 1,
      ts: "t",
      type: "wait.removed",
      effect: "state",
      sessionId: "S1",
      pr: "octo/repo#1",
      source: "rest",
      payload: { reason: "because" },
    };
    expect(own(e)).toBe(false);
    expect(own({ ...e, payload: { reason: "stopped" } })).toBe(true);
    expect(own({ ...e, payload: { reason: "stopped", prompt: "no" } })).toBe(false);
    expect(own({ ...e, effect: "annotation", payload: { reason: "stopped" } })).toBe(false);
  });

  it("a reader skips an annotation type it does not know and stops at a state type it does not", () => {
    const known = new Set(["link.added"]);
    expect(feedEventDisposition({ type: "link.added", effect: "state" }, known)).toBe("handle");
    expect(feedEventDisposition({ type: "wake.queued", effect: "annotation" }, known)).toBe("skip");
    expect(feedEventDisposition({ type: "wait.registered", effect: "state" }, known)).toBe("stop");
    expect(feedEventDisposition({ type: "future.thing", effect: "annotation" }, known)).toBe(
      "skip",
    );
  });
});

describe("one event per change, written with it", () => {
  it("link.added carries the method and state; the source is who caused it", async () => {
    const w = await setup();
    await w.repo.createLink({
      repo: "octo/repo",
      number: 1,
      sessionId: "S1",
      linkedBy: "harvest",
      prState: "open",
      headSha: null,
    });
    await w.repo.createLink({
      repo: "octo/repo",
      number: 2,
      sessionId: "S1",
      linkedBy: "trailer",
      prState: "open",
      headSha: null,
    });
    await linkPullRequest(w.deps, P, "S1", "octo/repo#3", "mcp");
    await linkPullRequest(w.deps, P, "S1", "octo/repo#4");
    const e = await w.feed();
    expect(e.map((x) => [x.type, x.pr, x.source, x.payload])).toEqual([
      ["link.added", "octo/repo#1", "harvest", { method: "harvest", prState: "open" }],
      ["link.added", "octo/repo#2", "trailer", { method: "trailer", prState: "open" }],
      ["link.added", "octo/repo#3", "mcp", { method: "manual", prState: "unknown" }],
      ["link.added", "octo/repo#4", "rest", { method: "manual", prState: "unknown" }],
    ]);
    expect(e.every((x) => x.sessionId === "S1" && x.effect === "state" && x.v === 1)).toBe(true);
  });

  it("a link that already exists writes nothing", async () => {
    const w = await setup();
    await linkPullRequest(w.deps, P, "S1", "octo/repo#3");
    await linkPullRequest(w.deps, P, "S1", "octo/repo#3");
    await expect(linkPullRequest(w.deps, P, "S2", "octo/repo#3")).rejects.toThrow();
    expect(types(await w.feed())).toEqual(["link.added"]);
  });

  it("link.removed on unlinking; nothing when it was not linked", async () => {
    const w = await setup();
    await linkPullRequest(w.deps, P, "S1", "octo/repo#3");
    await unlinkPullRequest(w.deps, P, "S1", "octo/repo#3", "mcp");
    await expect(unlinkPullRequest(w.deps, P, "S1", "octo/repo#3")).rejects.toThrow();
    const e = await w.feed();
    expect(e.map((x) => [x.type, x.source, x.payload])).toEqual([
      ["link.added", "rest", { method: "manual", prState: "unknown" }],
      ["link.removed", "mcp", { reason: "unlinked" }],
    ]);
  });

  it("link.state_changed when the PR's state changes, and not for a head or base refresh", async () => {
    const w = await setup();
    await w.repo.createLink({
      repo: "octo/repo",
      number: 1,
      sessionId: "S1",
      linkedBy: "harvest",
      prState: "open",
      headSha: "a",
    });
    await w.repo.updateLinkState("octo/repo#1", { prState: "open", headSha: "b", baseRef: "main" });
    await w.repo.updateLinkState("octo/repo#1", { headSha: "c" });
    await w.repo.updateLinkState("octo/repo#1", { prState: "merged" });
    await w.repo.updateLinkState("octo/repo#1", { prState: "merged" });
    await w.repo.updateLinkState("octo/missing#9", { prState: "merged" });
    expect(await w.repo.getPrLink("octo/repo#1")).toMatchObject({
      prState: "merged",
      headSha: "c",
    });
    const e = await w.feed();
    expect(e.map((x) => [x.type, x.payload])).toEqual([
      ["link.added", { method: "harvest", prState: "open" }],
      ["link.state_changed", { from: "open", to: "merged" }],
    ]);
    expect(e[1].source).toBe("webhook");
  });

  it("wait.registered with its source; wait.removed with the reason", async () => {
    const w = await setup();
    await waitForPullRequest(w.deps, P, "S1", "ark/ark#5", "mcp");
    await waitForPullRequest(w.deps, P, "S1", "ark/ark#5", "rest"); // twice: no event
    await waitForPullRequest(w.deps, P, "S1", "octo/repo#6", "rest");
    await stopWaitingForPullRequest(w.deps, P, "S1", "ark/ark#5", "mcp");
    await expect(stopWaitingForPullRequest(w.deps, P, "S1", "ark/ark#5")).rejects.toThrow();
    const e = await w.feed();
    expect(e.map((x) => [x.type, x.pr, x.source, x.payload])).toEqual([
      ["wait.registered", "ark/ark#5", "mcp", { waitSource: "mcp" }],
      ["wait.registered", "octo/repo#6", "rest", { waitSource: "rest" }],
      ["wait.removed", "ark/ark#5", "mcp", { reason: "stopped" }],
    ]);
  });

  it("a wait whose first check could not be requested is registered, then removed, honestly", async () => {
    const w = await setup();
    (w.deps.githubQueue as { send: () => Promise<void> }).send = async () => {
      throw new Error("sqs down");
    };
    await expect(waitForPullRequest(w.deps, P, "S1", "ark/ark#5", "rest")).rejects.toThrow();
    expect((await w.feed()).map((x) => [x.type, x.payload])).toEqual([
      ["wait.registered", { waitSource: "rest" }],
      ["wait.removed", { reason: "registration_failed" }],
    ]);
  });

  it("firing a wait removes it and queues the wake in one transaction, with both events", async () => {
    const w = await setup();
    await w.repo.createWait({ sessionId: "S1", pr: "octo/repo#7", source: "mcp" });
    const item = wakeItem({ kind: "pr_wait_merged", key: "octo/repo#7" });
    expect(
      await w.repo.fireWait({
        sessionId: "S1",
        pr: "octo/repo#7",
        reason: "merged",
        item,
        source: "webhook",
      }),
    ).toBe(true);
    // The second caller finds nothing to fire and writes nothing.
    expect(
      await w.repo.fireWait({
        sessionId: "S1",
        pr: "octo/repo#7",
        reason: "merged",
        item: wakeItem({ SK: "INBOX#i2", id: "i2", kind: "pr_wait_merged", key: "octo/repo#7" }),
        source: "sweep",
      }),
    ).toBe(false);
    expect(await w.repo.queryWaits("S1")).toEqual([]);
    expect(await w.repo.queryInbox("S1")).toHaveLength(1);
    expect((await w.feed()).map((x) => [x.type, x.source, x.payload])).toEqual([
      ["wait.registered", "mcp", { waitSource: "mcp" }],
      ["wait.removed", "webhook", { reason: "merged" }],
      [
        "wake.queued",
        "webhook",
        { itemId: "i1", kind: "pr_wait_merged", cause: "wait", merged: false },
      ],
    ]);
  });

  it("a wake's cause: its own PR's event, its PR no longer merging, or a PR it waits for", async () => {
    const w = await setup();
    for (const [i, kind] of [
      "pr_closed",
      "review",
      "pr_conflict",
      "pr_behind",
      "pr_wait_gone",
    ].entries()) {
      await w.repo.putInboxItem(wakeItem({ SK: `INBOX#i${i}`, id: `i${i}`, kind }), {
        source: "sweep",
      });
    }
    expect((await w.feed()).map((x) => [x.payload.kind, x.payload.cause, x.source])).toEqual([
      ["pr_closed", "linked_pr_event", "sweep"],
      ["review", "linked_pr_event", "sweep"],
      ["pr_conflict", "conflict", "sweep"],
      ["pr_behind", "conflict", "sweep"],
      ["pr_wait_gone", "wait", "sweep"],
    ]);
  });

  it("a wake is queued, folded, delivered, released and dropped, each with its item and cause", async () => {
    const w = await setup();
    await w.repo.putInboxItem(wakeItem({ kind: "pr_conflict", key: "octo/repo#8" }));
    expect(
      await w.repo.mergeInboxItem("S1", "i1", {
        deliveryIds: ["d1", "d2"],
        prompt: "q",
        data: null,
      }),
    ).toBe(true);
    expect(await w.repo.claimInbox("S1", ["i1"], "t1")).toEqual(["i1"]);
    expect(await w.repo.claimInbox("S1", ["i1"], "t2")).toEqual([]); // not pending: no event
    await w.repo.releaseInbox("S1", ["i1"], "t1");
    expect(await w.repo.dropInbox("S1", ["i1"], "session_failed")).toBe(1);
    expect(await w.repo.dropInbox("S1", ["i1"], "again")).toBe(0);
    const e = await w.feed();
    expect(e.map((x) => [x.type, x.pr])).toEqual([
      ["wake.queued", "octo/repo#8"],
      ["wake.queued", "octo/repo#8"],
      ["wake.delivered", "octo/repo#8"],
      ["wake.released", "octo/repo#8"],
      ["wake.dropped", "octo/repo#8"],
    ]);
    expect(e.map((x) => x.payload)).toEqual([
      { itemId: "i1", kind: "pr_conflict", cause: "conflict", merged: false },
      { itemId: "i1", kind: "pr_conflict", cause: "conflict", merged: true },
      { itemId: "i1", kind: "pr_conflict", cause: "conflict", turnId: "t1" },
      { itemId: "i1", kind: "pr_conflict", cause: "conflict", turnId: "t1" },
      { itemId: "i1", kind: "pr_conflict", cause: "conflict", reason: "session_failed" },
    ]);
    expect(e.every((x) => x.effect === "annotation")).toBe(true);
  });

  it("never carries prompt text, data, or anything else the item holds", async () => {
    const w = await setup();
    await w.repo.putInboxItem(wakeItem());
    await w.repo.claimInbox("S1", ["i1"], "t1");
    const text = JSON.stringify(await w.feed());
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("prompt");
  });

  it("moving a wake's due time is not a wake and writes no event", async () => {
    const w = await setup();
    await w.repo.putInboxItem(wakeItem());
    await w.repo.setInboxNotBefore("S1", "i1", new Date(T0 + 1000).toISOString());
    expect(types(await w.feed())).toEqual(["wake.queued"]);
  });

  it("an item of a session that is gone changes state without an event, since nobody could read it", async () => {
    const w = await setup();
    await w.repo.createWait({ sessionId: "GONE", pr: "octo/repo#1", source: "mcp" });
    expect(await w.repo.queryWaits("GONE")).toHaveLength(1);
    expect(await w.feed()).toEqual([]);
  });

  it("keeps events at least 30 days (TTL)", async () => {
    const w = await setup();
    await w.repo.createWait({ sessionId: "S1", pr: "octo/repo#1", source: "mcp" });
    const ev = w.ddb.items().find((i) => String(i.SK).startsWith("EVT#")) as { ttl: number };
    const days = (ev.ttl - T0 / 1000) / 86400;
    expect(FEED_TTL_DAYS).toBeGreaterThanOrEqual(30);
    expect(days).toBeCloseTo(FEED_TTL_DAYS, 5);
  });
});

describe("the sequence", () => {
  it("is 1, 2, 3 with no gaps, one counter per account", async () => {
    const w = await setup();
    await w.repo.createWait({ sessionId: "S1", pr: "octo/repo#1", source: "mcp" });
    await w.repo.createWait({ sessionId: "X1", pr: "octo/repo#1", source: "mcp" });
    await w.repo.createWait({ sessionId: "S2", pr: "octo/repo#2", source: "mcp" });
    expect((await w.feed()).map((e) => e.seq)).toEqual([1, 2]);
    expect((await w.feed("someone-else")).map((e) => e.seq)).toEqual([1]);
  });

  it("stays gap-free and ordered when writers collide: each event commits after the one before", async () => {
    const w = await setup();
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        w.repo.createWait({
          sessionId: i % 2 ? "S1" : "S2",
          pr: `octo/repo#${i + 1}`,
          source: "rest",
        }),
      ),
    );
    const events = await w.feed();
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(events.map((e) => e.pr)).size).toBe(8);
    expect(new Set(events.map((e) => e.id)).size).toBe(8);
  });

  it("a transaction whose own condition fails writes no event and does not burn a sequence number", async () => {
    const w = await setup();
    await w.repo.createWait({ sessionId: "S1", pr: "octo/repo#1", source: "mcp" });
    await w.repo.createWait({ sessionId: "S1", pr: "octo/repo#1", source: "mcp" });
    await w.repo.createWait({ sessionId: "S1", pr: "octo/repo#2", source: "mcp" });
    expect((await w.feed()).map((e) => e.seq)).toEqual([1, 2]);
  });
});

describe("reading with a cursor", () => {
  async function seeded(n: number) {
    const w = await setup();
    for (let i = 1; i <= n; i++) {
      await w.repo.createWait({ sessionId: "S1", pr: `octo/repo#${i}`, source: "mcp" });
    }
    return w;
  }

  it("pages in order and resumes from nextCursor", async () => {
    const w = await seeded(7);
    const seen: number[] = [];
    let after = 0;
    let pages = 0;
    for (;;) {
      const page: FeedPage = await w.repo.readFeed(OWNER, after, 3);
      seen.push(...page.events.map((e) => e.seq));
      pages++;
      after = page.nextCursor;
      if (!page.hasMore) {
        break;
      }
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(pages).toBe(3);
  });

  it("exactly limit events left is not 'more'; nothing new returns the same cursor", async () => {
    const w = await seeded(3);
    const page = await w.repo.readFeed(OWNER, 0, 3);
    expect([page.events.length, page.hasMore, page.nextCursor]).toEqual([3, false, 3]);
    const none = await w.repo.readFeed(OWNER, 3, 3);
    expect([none.events.length, none.hasMore, none.nextCursor]).toEqual([0, false, 3]);
    expect((await w.repo.readFeed(OWNER, 99, 3)).nextCursor).toBe(99);
  });

  it("resumes after downtime: events written meanwhile come next, none twice", async () => {
    const w = await seeded(2);
    const first = await w.repo.readFeed(OWNER, 0, 10);
    await w.repo.createWait({ sessionId: "S1", pr: "octo/repo#9", source: "mcp" });
    const next = await w.repo.readFeed(OWNER, first.nextCursor, 10);
    expect(next.events.map((e) => e.seq)).toEqual([3]);
  });

  it("a jump in seq shows that the events between expired", async () => {
    const w = await seeded(4);
    for (const i of w.ddb.items()) {
      if (i.SK === "EVT#000000000002" || i.SK === "EVT#000000000003") {
        w.ddb.store.delete(`${i.PK}\u0000${i.SK}`);
      }
    }
    expect((await w.feed()).map((e) => e.seq)).toEqual([1, 4]);
  });
});

describe("who can read what (service)", () => {
  it("an account reads its own feed and nothing of another's", async () => {
    const w = await setup();
    await w.repo.createWait({ sessionId: "S1", pr: "octo/repo#1", source: "mcp" });
    await w.repo.createWait({ sessionId: "X1", pr: "octo/repo#1", source: "mcp" });
    const mine = await listFeedEvents(w.deps, P, { after: 0, limit: 50 });
    expect(mine.events.map((e) => e.sessionId)).toEqual(["S1"]);
    const theirs = await listFeedEvents(
      w.deps,
      { sub: "someone-else", scopes: ["sessions:read"] } as Principal,
      { after: 0, limit: 50 },
    );
    expect(theirs.events.map((e) => e.sessionId)).toEqual(["X1"]);
    const stranger = await listFeedEvents(
      w.deps,
      { sub: "stranger", scopes: ["sessions:read"] } as Principal,
      { after: 0, limit: 50 },
    );
    expect(stranger).toEqual({ events: [], nextCursor: 0, hasMore: false });
  });

  it("needs sessions:read", async () => {
    const w = await setup();
    await expect(
      listFeedEvents(w.deps, { sub: OWNER, scopes: ["sessions:delete"] } as Principal, {
        after: 0,
        limit: 5,
      }),
    ).rejects.toThrow();
  });

  it("validates the query: defaults, bounds", () => {
    expect(FeedQuerySchema.parse({})).toEqual({ after: 0, limit: 50 });
    expect(FeedQuerySchema.parse({ after: "12", limit: "200" })).toEqual({ after: 12, limit: 200 });
    for (const bad of [{ after: -1 }, { limit: 0 }, { limit: 201 }, { after: "x" }]) {
      expect(FeedQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("getSession is unchanged by the feed", async () => {
    const w = await setup();
    await waitForPullRequest(w.deps, P, "S1", "ark/ark#5", "mcp");
    expect((await getSession(w.deps, P, "S1")).waits).toHaveLength(1);
  });
});

describe("no state change without its event", () => {
  const run = async () => {
    const w = await setup();
    // Every write path of a link and a wait, each at least once.
    await w.repo.createLink({
      repo: "octo/repo",
      number: 1,
      sessionId: "S1",
      linkedBy: "harvest",
      prState: "open",
      headSha: "a",
    });
    await w.repo.createLink({
      repo: "octo/repo",
      number: 1,
      sessionId: "S2",
      linkedBy: "harvest",
      prState: "open",
      headSha: "a",
    });
    await linkPullRequest(w.deps, P, "S1", "octo/repo#2", "mcp");
    await w.repo.updateLinkState("octo/repo#1", { headSha: "b", baseRef: "main" });
    await w.repo.updateLinkState("octo/repo#1", { prState: "closed" });
    await unlinkPullRequest(w.deps, P, "S1", "octo/repo#2");
    await w.repo.deleteLink("octo/repo#1", "S2");
    await w.repo.deleteLink("octo/repo#1", "S1");
    await waitForPullRequest(w.deps, P, "S1", "octo/repo#3", "mcp");
    await waitForPullRequest(w.deps, P, "S1", "octo/repo#3", "rest");
    await stopWaitingForPullRequest(w.deps, P, "S1", "octo/repo#3");
    await w.repo.createWait({ sessionId: "S1", pr: "octo/repo#4", source: "trailer" });
    await w.repo.fireWait({
      sessionId: "S1",
      pr: "octo/repo#4",
      reason: "closed",
      item: wakeItem({ kind: "pr_wait_closed", key: "octo/repo#4" }),
      source: "webhook",
    });
    await w.repo.deleteWait("S1", "octo/repo#4");
    await w.repo.createWait({ sessionId: "S1", pr: "octo/repo#5", source: "mcp" });
    await w.repo.deleteSessionWaits("S1", { source: "rest" });
    return w;
  };

  it("every write of a link or a wait is a transaction that also writes an event", async () => {
    const w = await run();
    expect(feedViolations(w.ddb.log)).toEqual([]);
    // Each of the changes above left an event; a refused one left none.
    expect(types(await w.feed()).sort()).toEqual(
      [
        "link.added",
        "link.added",
        "link.state_changed",
        "link.removed",
        "link.removed",
        "wait.registered",
        "wait.removed",
        "wait.registered",
        "wait.removed",
        "wake.queued",
        "wait.registered",
        "wait.removed",
      ].sort(),
    );
  });

  it("the guard fails a write that changes a link or a wait on its own", () => {
    const ddb = new MemoryDdb();
    const table = "t";
    const bare = [
      {
        name: "PutCommand",
        input: { TableName: table, Item: { PK: "SESSION#S1", SK: "WAIT#a/b#1" } },
      },
      {
        name: "DeleteCommand",
        input: { TableName: table, Key: { PK: "SESSION#S1", SK: "WAIT#a/b#1" } },
      },
      { name: "PutCommand", input: { TableName: table, Item: { PK: "GHPR#a/b#1", SK: "LINK" } } },
      {
        name: "UpdateCommand",
        input: {
          Key: { PK: "GHPR#a/b#1", SK: "LINK" },
          UpdateExpression: "SET prState = :prState",
        },
      },
      {
        name: "TransactWriteCommand",
        input: { TransactItems: [{ Delete: { Key: { PK: "GHPR#a/b#1", SK: "LINK" } } }] },
      },
    ];
    expect(feedViolations(bare)).toHaveLength(bare.length);
    expect(feedViolations(ddb.log)).toEqual([]);
    // A head refresh is not a change a reader follows.
    expect(
      feedViolations([
        {
          name: "UpdateCommand",
          input: { Key: { PK: "GHPR#a/b#1", SK: "LINK" }, UpdateExpression: "SET headSha = :h" },
        },
      ]),
    ).toEqual([]);
  });
});
