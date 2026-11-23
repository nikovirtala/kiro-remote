/**
 * The sweep's sparse index (GSI2), the removal of a deleted session's waits, the base tip the sweep
 * compares, and the one-off backfill of waits and links that predate the index.
 */

import { describe, expect, it } from "vitest";
import {
  backfillSweepIndex,
  SWEEP_LINK_PK,
  SWEEP_WAIT_PK,
  sweepKeysFor,
  sweepWaitSk,
} from "../src/index.ts";
import { feedViolations, memoryRepository, sessionItem } from "../src/testing/memory-ddb.ts";

const OWNER = "user-sub-1";

async function setup() {
  const { repo, ddb } = await memoryRepository(() => Date.parse("2026-02-01T11:00:00.000Z"));
  ddb.put(sessionItem("S1", { createdBy: OWNER }));
  ddb.put(sessionItem("S2", { createdBy: "someone-else", GSI1PK: "USER#someone-else" }));
  return { repo, ddb, feed: async (owner = OWNER) => (await repo.readFeed(owner, 0, 200)).events };
}

const link = (
  w: Awaited<ReturnType<typeof setup>>,
  n: number,
  over: {
    sessionId?: string;
    prState?: "open" | "closed" | "merged" | "unknown";
    repo?: string;
  } = {},
) =>
  w.repo.createLink({
    repo: over.repo ?? "octo/repo",
    number: n,
    sessionId: over.sessionId ?? "S1",
    linkedBy: "harvest",
    prState: over.prState ?? "open",
    headSha: "a",
    baseRef: "main",
  });

describe("the sweep's index: open waits", () => {
  it("lists every open wait of every account, sorted by PR, and drops a wait when it goes", async () => {
    const w = await setup();
    await w.repo.createWait({ sessionId: "S1", pr: "octo/repo#9", source: "mcp" });
    await w.repo.createWait({ sessionId: "S2", pr: "octo/repo#7", source: "rest" });
    await w.repo.createWait({ sessionId: "S1", pr: "octo/repo#7", source: "trailer" });

    expect((await w.repo.queryOpenWaits()).map((x) => [x.pr, x.sessionId])).toEqual([
      ["octo/repo#7", "S1"],
      ["octo/repo#7", "S2"],
      ["octo/repo#9", "S1"],
    ]);

    await w.repo.deleteWait("S1", "octo/repo#7");
    await w.repo.fireWait({
      sessionId: "S2",
      pr: "octo/repo#7",
      reason: "merged",
      source: "sweep",
      item: {
        PK: "SESSION#S2",
        SK: "INBOX#i1",
        id: "i1",
        sessionId: "S2",
        source: "github",
        deliveryId: "",
        deliveryIds: [],
        kind: "pr_wait_merged",
        key: "octo/repo#7",
        prompt: "p",
        data: null,
        createdAt: "2026-02-01T11:00:00.000Z",
        notBefore: "2026-02-01T11:00:00.000Z",
        status: "pending",
        dropReason: null,
        deliveredTurnId: null,
        autoClose: false,
        ttl: 9999999999,
      },
    });
    expect((await w.repo.queryOpenWaits()).map((x) => x.pr)).toEqual(["octo/repo#9"]);
  });

  it("keys a wait with the PR first, so the waits for one PR are adjacent", () => {
    expect(sweepWaitSk("Octo/Repo#7", "S1")).toBe("octo/repo#7|S1");
  });
});

describe("the sweep's index: open linked PRs", () => {
  it("holds a link while its PR is open or not known, and not once it closed or merged", async () => {
    const w = await setup();
    await link(w, 1);
    await link(w, 2, { prState: "unknown" });
    await link(w, 3, { prState: "merged" });
    expect((await w.repo.queryOpenLinkIndex()).map((l) => l.pr)).toEqual([
      "octo/repo#1",
      "octo/repo#2",
    ]);

    await w.repo.updateLinkState("octo/repo#1", { prState: "closed" });
    await w.repo.updateLinkState("octo/repo#3", { prState: "open" });
    await w.repo.updateLinkState("octo/repo#2", { headSha: "b" }); // a refresh of the head alone
    expect((await w.repo.queryOpenLinkIndex()).map((l) => l.pr)).toEqual([
      "octo/repo#2",
      "octo/repo#3",
    ]);
    // Closing removes both keys: the item is no longer in the index at all.
    expect(w.ddb.get("GHPR#octo/repo#1", "LINK")).not.toHaveProperty("GSI2PK");
    expect(w.ddb.get("GHPR#octo/repo#1", "LINK")).not.toHaveProperty("GSI2SK");
    expect(w.ddb.get("GHPR#octo/repo#2", "LINK")).toMatchObject({ GSI2PK: SWEEP_LINK_PK });
    expect(feedViolations(w.ddb.log)).toEqual([]);
  });

  it("lists links across repos and accounts", async () => {
    const w = await setup();
    await link(w, 1);
    await link(w, 2, { sessionId: "S2", repo: "octo/other" });
    expect((await w.repo.queryOpenLinkIndex()).map((l) => l.pr)).toEqual([
      "octo/other#2",
      "octo/repo#1",
    ]);
  });
});

describe("deleting a session removes its waits", () => {
  it("each wait goes with its own wait.removed event (session_deleted), and nobody else's", async () => {
    const w = await setup();
    await w.repo.createWait({ sessionId: "S1", pr: "octo/repo#7", source: "mcp" });
    await w.repo.createWait({ sessionId: "S1", pr: "ark/ark#5", source: "trailer" });
    await w.repo.createWait({ sessionId: "S2", pr: "octo/repo#7", source: "rest" });

    expect(await w.repo.deleteSessionWaits("S1", { source: "mcp" })).toBe(2);

    expect(await w.repo.queryWaits("S1")).toEqual([]);
    expect((await w.repo.queryOpenWaits()).map((x) => [x.sessionId, x.pr])).toEqual([
      ["S2", "octo/repo#7"],
    ]);
    const removed = (await w.feed()).filter((e) => e.type === "wait.removed");
    expect(removed.map((e) => [e.sessionId, e.pr, e.source, e.payload])).toEqual([
      ["S1", "ark/ark#5", "mcp", { reason: "session_deleted" }],
      ["S1", "octo/repo#7", "mcp", { reason: "session_deleted" }],
    ]);
    // The other account's wait and feed are untouched.
    expect((await w.feed("someone-else")).map((e) => e.type)).toEqual(["wait.registered"]);
    expect(feedViolations(w.ddb.log)).toEqual([]);
  });

  it("does nothing, and says 0, for a session with no waits or one called twice", async () => {
    const w = await setup();
    await w.repo.createWait({ sessionId: "S1", pr: "octo/repo#7", source: "mcp" });
    expect(await w.repo.deleteSessionWaits("S1")).toBe(1);
    expect(await w.repo.deleteSessionWaits("S1")).toBe(0);
    expect(await w.repo.deleteSessionWaits("S2")).toBe(0);
  });

  it("keeps the session's links as history", async () => {
    const w = await setup();
    await link(w, 1);
    await w.repo.createWait({ sessionId: "S1", pr: "octo/repo#7", source: "mcp" });
    await w.repo.deleteSessionWaits("S1");
    expect((await w.repo.queryLinks("S1")).map((l) => l.pr)).toEqual(["octo/repo#1"]);
  });
});

describe("the base tip", () => {
  it("is stored per repo and branch, and read back; the repo is case-insensitive", async () => {
    const w = await setup();
    expect(await w.repo.getBaseTip("octo/repo", "main")).toBeNull();
    await w.repo.putBaseTip({ repo: "Octo/Repo", base: "main", sha: "abc1234", afterPr: 7 });
    expect(await w.repo.getBaseTip("octo/repo", "main")).toMatchObject({
      repo: "octo/repo",
      base: "main",
      sha: "abc1234",
      afterPr: 7,
      checkedAt: "2026-02-01T11:00:00.000Z",
    });
    expect(await w.repo.getBaseTip("octo/repo", "release")).toBeNull();
    await w.repo.putBaseTip({ repo: "octo/repo", base: "main", sha: "def5678", afterPr: 9 });
    expect(await w.repo.getBaseTip("octo/repo", "main")).toMatchObject({ sha: "def5678" });
  });
});

describe("backfilling the index for waits and links that predate it", () => {
  /** What an item looked like before GSI2: no GSI2 keys. */
  async function legacy() {
    const w = await setup();
    await w.repo.createWait({ sessionId: "S1", pr: "octo/repo#7", source: "mcp" });
    await link(w, 1);
    await link(w, 2, { prState: "closed" });
    for (const [pk, sk] of [
      ["SESSION#S1", "WAIT#octo/repo#7"],
      ["GHPR#octo/repo#1", "LINK"],
    ]) {
      const item = w.ddb.get(pk, sk) as Record<string, unknown>;
      delete item.GSI2PK;
      delete item.GSI2SK;
    }
    return w;
  }

  it("a legacy wait and open link are not in the index until the backfill puts them there", async () => {
    const w = await legacy();
    expect(await w.repo.queryOpenWaits()).toEqual([]);
    expect(await w.repo.queryOpenLinkIndex()).toEqual([]);

    const result = await backfillSweepIndex(w.ddb as never, "t", { dryRun: false });

    expect(result).toEqual({ scanned: 5, waits: 1, links: 1, skipped: 0 });
    expect((await w.repo.queryOpenWaits()).map((x) => x.pr)).toEqual(["octo/repo#7"]);
    expect((await w.repo.queryOpenLinkIndex()).map((x) => x.pr)).toEqual(["octo/repo#1"]);
    // A closed link stays out, and the closed one's keys are not invented.
    expect(w.ddb.get("GHPR#octo/repo#2", "LINK")).not.toHaveProperty("GSI2PK");
  });

  it("is idempotent: a second run finds everything indexed", async () => {
    const w = await legacy();
    await backfillSweepIndex(w.ddb as never, "t", { dryRun: false });
    expect(await backfillSweepIndex(w.ddb as never, "t", { dryRun: false })).toEqual({
      scanned: 5,
      waits: 0,
      links: 0,
      skipped: 2,
    });
  });

  it("a dry run counts and changes nothing", async () => {
    const w = await legacy();
    const before = w.ddb.log.length;
    const result = await backfillSweepIndex(w.ddb as never, "t", { dryRun: true });
    expect(result).toMatchObject({ waits: 1, links: 1 });
    expect(w.ddb.log.slice(before).map((c) => c.name)).toEqual(["ScanCommand"]);
    expect(await w.repo.queryOpenWaits()).toEqual([]);
  });

  it("reads keys only, never an item's content", async () => {
    const w = await legacy();
    await backfillSweepIndex(w.ddb as never, "t", { dryRun: false });
    const scans = w.ddb.log.filter((c) => c.name === "ScanCommand");
    expect(scans.length).toBeGreaterThan(0);
    for (const s of scans) {
      expect(s.input.IndexName).toBe("GSI1");
      expect(s.input.ProjectionExpression).toBe("PK, SK, GSI1PK, GSI1SK, GSI2PK");
    }
  });

  it("follows every page of the scan", async () => {
    const w = await legacy();
    const send = w.ddb.send.bind(w.ddb);
    w.ddb.send = (cmd) => {
      if (cmd.constructor.name === "ScanCommand") {
        (cmd.input as Record<string, unknown>).Limit = 2;
      }
      return send(cmd);
    };
    expect(await backfillSweepIndex(w.ddb as never, "t", { dryRun: false })).toMatchObject({
      scanned: 5,
      waits: 1,
      links: 1,
    });
  });

  it("skips a link that closed between the scan and the write", async () => {
    const w = await legacy();
    const send = w.ddb.send.bind(w.ddb);
    w.ddb.send = (cmd) => {
      if (cmd.constructor.name === "UpdateCommand") {
        const item = w.ddb.get("GHPR#octo/repo#1", "LINK") as Record<string, unknown>;
        item.GSI1SK = "DONE#1";
      }
      return send(cmd);
    };
    const result = await backfillSweepIndex(w.ddb as never, "t", { dryRun: false });
    expect(result.links).toBe(0);
    expect(w.ddb.get("GHPR#octo/repo#1", "LINK")).not.toHaveProperty("GSI2PK");
  });

  it("sweepKeysFor tells a wait and an open link from everything else GSI1 holds", () => {
    expect(
      sweepKeysFor({
        PK: "SESSION#S1",
        SK: "WAIT#octo/repo#7",
        GSI1PK: "GHWAIT#octo/repo#7",
        GSI1SK: "S1",
      }),
    ).toEqual({ kind: "wait", gsi2pk: SWEEP_WAIT_PK, gsi2sk: "octo/repo#7|S1" });
    expect(
      sweepKeysFor({
        PK: "GHPR#octo/repo#1",
        SK: "LINK",
        GSI1PK: "GHREPO#octo/repo",
        GSI1SK: "OPEN#1",
      }),
    ).toEqual({ kind: "link", gsi2pk: SWEEP_LINK_PK, gsi2sk: "octo/repo#1" });
    expect(
      sweepKeysFor({
        PK: "GHPR#octo/repo#1",
        SK: "LINK",
        GSI1PK: "GHREPO#octo/repo",
        GSI1SK: "DONE#1",
      }),
    ).toBeNull();
    expect(
      sweepKeysFor({ PK: "SESSION#S1", SK: "META", GSI1PK: "USER#u", GSI1SK: "2026-01-01" }),
    ).toBeNull();
  });
});
