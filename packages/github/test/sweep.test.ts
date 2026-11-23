/**
 * The scheduled sweep: each pass's pure decide function, the budget and the cap, the passes against
 * the in-memory table (a PR that merged with no webhook, a base branch that moved with none), the
 * race with the webhook, and the change feed the sweep writes. See docs/github.md, "The sweep".
 */

import type { Command, PrWaitItem } from "@nikovirtala/kiro-remote-core";
import { feedViolations } from "@nikovirtala/kiro-remote-core/testing";
import { describe, expect, it } from "vitest";
import type { MergedPull, RateLimit } from "../src/app-client.ts";
import { handleQueueMessage, processDelivery } from "../src/consumer.ts";
import { isRateLimited, ReadBudget } from "../src/sweep/budget.ts";
import { type Pass, runSweep, type SweepDeps } from "../src/sweep/index.ts";
import {
  decideBaseMove,
  decideSweptWait,
  groupLinksByBase,
  groupWaitsByPr,
  planReads,
} from "../src/sweep/plan.ts";
import { waitsPass } from "../src/sweep/waits.ts";
import { fixture, type World, world } from "./helpers.ts";

const WAITER = "01HZX0000000000000000000W1";
const OTHER = "01HZX0000000000000000000W2";
const OWNER = "user-sub-1";
const MERGE_SHA = "2222222222222222222222222222222222222222";
const H = (c: string) => c.repeat(40);
const INTERVAL_MS = 15 * 60_000;

/* -------------------------------- pure decisions ------------------------------- */

describe("planReads: the cap and the rotation", () => {
  const items = ["a", "b", "c", "d", "e"];

  it("reads everything when it fits, and nothing when there is no room", () => {
    expect(planReads(items, 5, 0)).toEqual({ read: items, skipped: [] });
    expect(planReads(items, 9, 3)).toEqual({ read: items, skipped: [] });
    expect(planReads(items, 0, 0)).toEqual({ read: [], skipped: items });
    expect(planReads([], 3, 0)).toEqual({ read: [], skipped: [] });
  });

  it("reads at most `room`, and says what it left", () => {
    const { read, skipped } = planReads(items, 2, 0);
    expect(read).toEqual(["a", "b"]);
    expect(skipped).toEqual(["c", "d", "e"]);
  });

  it("moves the window each run, so every item is read within ceil(n / room) runs", () => {
    const seen = new Set<string>();
    const runs = Math.ceil(items.length / 2);
    for (let run = 0; run < runs; run++) {
      for (const item of planReads(items, 2, run).read) {
        seen.add(item);
      }
    }
    expect([...seen].sort()).toEqual(items);
  });

  it("wraps around the end of the list", () => {
    expect(planReads(items, 2, 2).read).toEqual(["a", "e"]); // start 4: e, then a
  });
});

describe("decideSweptWait (pure)", () => {
  const pull = (over: Record<string, unknown> = {}) => ({
    state: "open" as const,
    merged: false,
    baseRef: "main",
    mergeCommitSha: null,
    ...over,
  });

  it("a deleted session's wait is removed, whatever the PR did and without a read", () => {
    expect(decideSweptWait({ sessionActive: false, read: { type: "unread" } })).toEqual({
      type: "remove",
      reason: "session_deleted",
    });
    expect(
      decideSweptWait({
        sessionActive: false,
        read: { type: "pull", pull: pull({ state: "closed", merged: true }) },
      }),
    ).toEqual({ type: "remove", reason: "session_deleted" });
  });

  it("is decideWait for a live session: open keeps, merged and closed fire, a missing PR is gone", () => {
    const read = (p: ReturnType<typeof pull> | null) =>
      decideSweptWait({ sessionActive: true, read: { type: "pull", pull: p } });
    expect(read(pull())).toEqual({ type: "keep" });
    expect(
      read(pull({ state: "closed", merged: true, mergeCommitSha: MERGE_SHA.toUpperCase() })),
    ).toEqual({ type: "fire", outcome: "merged", base: "main", sha: MERGE_SHA.toUpperCase() });
    expect(read(pull({ state: "closed" }))).toEqual({ type: "fire", outcome: "closed" });
    expect(read(null)).toEqual({ type: "fire", outcome: "gone" });
  });

  it("a PR not read this run (the cap) or whose read failed is not decided", () => {
    expect(decideSweptWait({ sessionActive: true, read: { type: "unread" } })).toEqual({
      type: "skip",
      why: "cap",
    });
    expect(decideSweptWait({ sessionActive: true, read: { type: "failed" } })).toEqual({
      type: "skip",
      why: "read_failed",
    });
  });
});

describe("decideBaseMove (pure)", () => {
  const latest = { number: 7, mergedAt: "2026-02-01T12:00:00Z", sha: MERGE_SHA };

  it("nothing merged into the branch: nothing to check", () => {
    expect(
      decideBaseMove({ stored: null, latest: null, oldestLinkedAt: "2026-02-01T09:00:00Z" }),
    ).toEqual({ type: "none" });
    expect(
      decideBaseMove({
        stored: null,
        latest: { ...latest, sha: null },
        oldestLinkedAt: "2026-02-01T09:00:00Z",
      }),
    ).toEqual({ type: "none" });
  });

  it("the tip the last check saw is unchanged", () => {
    expect(
      decideBaseMove({
        stored: { sha: MERGE_SHA },
        latest,
        oldestLinkedAt: "2026-02-01T09:00:00Z",
      }),
    ).toEqual({ type: "unchanged" });
  });

  it("a different tip than the last check saw is a move, whatever the links' age", () => {
    expect(
      decideBaseMove({ stored: { sha: H("9") }, latest, oldestLinkedAt: "2026-02-02T09:00:00Z" }),
    ).toEqual({ type: "moved", sha: MERGE_SHA, afterPr: 7 });
  });

  it("with no stored tip, a merge after the oldest open link is a move, an older one a baseline", () => {
    expect(
      decideBaseMove({ stored: null, latest, oldestLinkedAt: "2026-02-01T09:00:00Z" }),
    ).toEqual({ type: "moved", sha: MERGE_SHA, afterPr: 7 });
    expect(
      decideBaseMove({ stored: null, latest, oldestLinkedAt: "2026-02-01T13:00:00Z" }),
    ).toEqual({ type: "baseline", sha: MERGE_SHA, afterPr: 7 });
  });
});

describe("grouping", () => {
  const wait = (sessionId: string, pr: string) => ({ sessionId, pr }) as PrWaitItem;

  it("groups waits by awaited PR, one entry per distinct PR", () => {
    const groups = groupWaitsByPr([
      wait("s1", "octo/repo#7"),
      wait("s2", "octo/repo#7"),
      wait("s1", "octo/repo#9"),
    ]);
    expect([...groups.keys()]).toEqual(["octo/repo#7", "octo/repo#9"]);
    expect(groups.get("octo/repo#7")?.map((w) => w.sessionId)).toEqual(["s1", "s2"]);
  });

  it("groups open links by repo and base, leaving out deleted sessions and links without a base", () => {
    const link = (pr: string, sessionId: string, baseRef: string | null) =>
      ({
        pr,
        repo: pr.split("#")[0],
        number: Number(pr.split("#")[1]),
        sessionId,
        baseRef,
        linkedAt: "2026-02-01T09:00:00Z",
      }) as never;
    const { groups, withoutBase } = groupLinksByBase(
      [
        link("octo/repo#8", "live", "main"),
        link("octo/repo#9", "live", "main"),
        link("octo/repo#10", "live", "release"),
        link("octo/repo#11", "gone", "main"),
        link("octo/repo#12", "live", null),
        link("octo/other#1", "live", "main"),
      ],
      (id) => id === "live",
    );
    expect(groups.map((g) => [g.repo, g.base, g.links.length])).toEqual([
      ["octo/other", "main", 1],
      ["octo/repo", "main", 2],
      ["octo/repo", "release", 1],
    ]);
    expect(withoutBase).toBe(1);
  });
});

describe("ReadBudget", () => {
  const budget = (rate: RateLimit | null, cap = 10, now = 1_000) =>
    new ReadBudget({ cap, rateLimit: () => rate, reserve: 500, now: () => now });

  it("has room until its cap is spent", () => {
    const b = budget(null, 3);
    expect(b.room()).toBe(3);
    b.spend(2);
    expect(b.room()).toBe(1);
    b.spend(5);
    expect(b.room()).toBe(0);
  });

  it("stops when the rate limit headers say the reserve is reached, until the window resets", () => {
    expect(budget({ remaining: 501, resetAtMs: 9_999 }).room()).toBe(10);
    const near = budget({ remaining: 500, resetAtMs: 9_999 });
    expect(near.room()).toBe(0);
    expect(near.rateLimited).toBe(true);
    // A window that has already reset says nothing about what is left now.
    expect(budget({ remaining: 3, resetAtMs: 500 }).room()).toBe(10);
  });

  it("a pass's budget is its own quota out of the run's, and stopping it stops the run", () => {
    const run = budget(null, 10);
    const pass = run.child(4);
    expect(pass.room()).toBe(4);
    pass.spend(4);
    expect(pass.room()).toBe(0);
    expect(run.room()).toBe(6);
    run.spend(5);
    expect(run.child(4).room()).toBe(1);
    run.child(2).stop();
    expect(run.room()).toBe(0);
  });

  it("recognises GitHub's rate limit answers", () => {
    expect(isRateLimited({ status: 429 })).toBe(true);
    expect(
      isRateLimited({ status: 403, response: { headers: { "x-ratelimit-remaining": "0" } } }),
    ).toBe(true);
    expect(
      isRateLimited({ status: 403, response: { headers: { "x-ratelimit-remaining": "12" } } }),
    ).toBe(false);
    expect(isRateLimited({ status: 502 })).toBe(false);
    expect(isRateLimited(new Error("boom"))).toBe(false);
  });
});

/* ----------------------------------- the passes -------------------------------- */

type PullState = Record<string, unknown>;

/** A world whose GitHub the test controls and whose reads are counted. */
function sweepWorld(config: Partial<Parameters<typeof world>[0]> = {}) {
  const w = world(config);
  const reads: string[] = [];
  const merges = new Map<string, MergedPull | null>();
  const mergeReads: string[] = [];
  let rate: RateLimit | null = null;
  const baseGetPull = w.deps.github.getPull;
  const github: SweepDeps["github"] = {
    ...w.deps.github,
    getPull: async (repo, n, id) => {
      reads.push(`${repo}#${n}`);
      return baseGetPull(repo, n, id);
    },
    async latestMergedPull(repo, base) {
      mergeReads.push(`${repo}#${base}`);
      return merges.get(`${repo}#${base}`) ?? null;
    },
    rateLimit: () => rate,
  };
  const deps: SweepDeps = { ...w.deps, github };
  // The webhook consumer shares the sweep's GitHub, so a read made by either is counted.
  w.deps.github = github;
  return {
    w,
    deps,
    reads,
    mergeReads,
    merges,
    setRate: (r: RateLimit | null) => {
      rate = r;
    },
    pull(n: number, over: PullState = {}) {
      w.github.pulls.set(`octo/repo#${n}`, {
        number: n,
        state: "open",
        merged: false,
        createdAt: "2026-02-01T10:00:00Z",
        headSha: H("a"),
        headRef: `kiro/pr-${n}`,
        authorLogin: "kiro-agent[bot]",
        body: null,
        baseRef: "main",
        mergeCommitSha: null,
        mergeable: true,
        mergeableState: "clean",
        ...over,
      });
    },
    /** Run the sweep as the schedule would, `runs` intervals after the epoch. */
    sweep(run = 0, extra: { passes?: readonly Pass[]; maxPrReads?: number } = {}) {
      w.clock.now = run * INTERVAL_MS + 30 * 60_000;
      return runSweep(deps, { intervalMs: INTERVAL_MS, ...extra });
    },
  };
}

const prompts = (w: World) =>
  w.commands.commands.filter((c): c is Extract<Command, { kind: "prompt" }> => c.kind === "prompt");
const feed = async (w: World) => (await w.repo.readFeed(OWNER, 0, 200)).events;
const brief = (events: Awaited<ReturnType<typeof feed>>) =>
  events.map((e) => [e.type, e.pr, e.source, e.payload.reason ?? e.payload.cause ?? null]);

async function link(w: World, n: number, session: string, base: string | null = "main") {
  if (!w.ddb.get(`SESSION#${session}`, "META")) {
    w.seedSession(session);
  }
  await w.repo.createLink({
    repo: "octo/repo",
    number: n,
    sessionId: session,
    linkedBy: "harvest",
    prState: "open",
    headSha: H("a"),
    baseRef: base,
  });
}

/** Deliver "PR #n was merged into main" as the webhook would. */
async function webhookMerge(w: World, number: number, deliveryId: string, sha = MERGE_SHA) {
  const payload = fixture("pull_request.closed.merged") as {
    number: number;
    pull_request: { number: number; merge_commit_sha: string };
  };
  payload.number = number;
  payload.pull_request.number = number;
  payload.pull_request.merge_commit_sha = sha;
  await w.repo.putDelivery({
    deliveryId,
    event: "pull_request",
    action: "closed",
    repo: "octo/repo",
    rawBody: JSON.stringify(payload),
  });
  return processDelivery(w.deps, deliveryId);
}

describe("the waits pass", () => {
  it("fires a wait whose PR merged with no webhook, and the feed says it was the sweep", async () => {
    const s = sweepWorld();
    s.w.seedSession(WAITER);
    await s.w.repo.createWait({ sessionId: WAITER, pr: "octo/repo#7", source: "mcp" });
    s.pull(7, { state: "closed", merged: true, mergeCommitSha: MERGE_SHA });

    const result = await s.sweep();

    expect(result).toEqual({ prsRead: 1, failedPasses: [] });
    expect(prompts(s.w)).toHaveLength(1);
    const [cmd] = prompts(s.w);
    expect(cmd.sessionId).toBe(WAITER);
    expect(cmd.prompt.split("\n")[1]).toBe(
      `PR #7, which this session waits for, was merged into main at ${MERGE_SHA}. Rebase onto main (never merge it in), continue the work it unblocked, push with --force-with-lease and say what changed.`,
    );
    expect(await s.w.repo.queryWaits(WAITER)).toEqual([]);
    expect(await s.w.repo.queryOpenWaits()).toEqual([]);
    expect(brief(await feed(s.w))).toEqual([
      ["wait.registered", "octo/repo#7", "mcp", null],
      ["wait.removed", "octo/repo#7", "sweep", "merged"],
      ["wake.queued", "octo/repo#7", "sweep", "wait"],
      ["wake.delivered", "octo/repo#7", "sweep", "wait"],
    ]);
    expect(feedViolations(s.w.ddb.log)).toEqual([]);
    expect(s.w.metrics.sum("SweepWaitsFired", { outcome: "merged" })).toBe(1);
  });

  it("fires a closed and an unreadable PR too, and keeps an open one", async () => {
    const s = sweepWorld();
    for (const [i, n] of [31, 32, 33, 34].entries()) {
      s.w.seedSession(`S-${i}`);
      await s.w.repo.createWait({ sessionId: `S-${i}`, pr: `octo/repo#${n}`, source: "rest" });
    }
    s.pull(31, { state: "closed" });
    s.pull(32, { state: "open" });
    // 33 is not on GitHub; 34 is merged
    s.pull(34, { state: "closed", merged: true, mergeCommitSha: MERGE_SHA });

    await s.sweep();

    const removed = (await feed(s.w)).filter((e) => e.type === "wait.removed");
    expect(removed.map((e) => [e.pr, e.source, e.payload.reason])).toEqual([
      ["octo/repo#31", "sweep", "closed"],
      ["octo/repo#33", "sweep", "unreadable"],
      ["octo/repo#34", "sweep", "merged"],
    ]);
    expect((await s.w.repo.queryOpenWaits()).map((x) => x.pr)).toEqual(["octo/repo#32"]);
  });

  it("works on a wait whatever created it, including a source added later", async () => {
    const s = sweepWorld();
    s.w.seedSession(WAITER);
    s.w.seedSession(OTHER);
    await s.w.repo.createWait({ sessionId: WAITER, pr: "octo/repo#7", source: "trailer" });
    // A later producer (an ark issue's depends-on link) adds a value to `source`.
    await s.w.repo.createWait({
      sessionId: OTHER,
      pr: "octo/repo#7",
      source: "ark" as never,
    });
    s.pull(7, { state: "closed", merged: true, mergeCommitSha: MERGE_SHA });

    await s.sweep();

    expect(
      prompts(s.w)
        .map((c) => c.sessionId)
        .sort(),
    ).toEqual([WAITER, OTHER]);
    expect(await s.w.repo.queryOpenWaits()).toEqual([]);
  });

  it("reads each distinct awaited PR once, however many sessions wait for it", async () => {
    const s = sweepWorld();
    for (const id of ["S-1", "S-2", "S-3"]) {
      s.w.seedSession(id);
      await s.w.repo.createWait({ sessionId: id, pr: "octo/repo#7", source: "mcp" });
    }
    s.pull(7, { state: "closed", merged: true, mergeCommitSha: MERGE_SHA });

    await s.sweep();

    expect(s.reads).toEqual(["octo/repo#7"]);
    expect(prompts(s.w)).toHaveLength(3);
    expect(s.w.metrics.sum("SweepPrsRead")).toBe(1);
  });

  it("a failed read leaves the wait for the next run, and does not stop the other PRs", async () => {
    const s = sweepWorld();
    for (const [i, n] of [7, 8].entries()) {
      s.w.seedSession(`S-${i}`);
      await s.w.repo.createWait({ sessionId: `S-${i}`, pr: `octo/repo#${n}`, source: "mcp" });
    }
    s.pull(8, { state: "closed" });
    const get = s.deps.github.getPull;
    s.deps.github.getPull = async (repo, n, id) => {
      if (n === 7) {
        throw new Error("github 502");
      }
      return get(repo, n, id);
    };

    await s.sweep();

    expect((await s.w.repo.queryOpenWaits()).map((x) => x.pr)).toEqual(["octo/repo#7"]);
    expect(prompts(s.w).map((c) => c.sessionId)).toEqual(["S-1"]);
    expect(s.w.metrics.sum("SweepReadsFailed")).toBe(1);
  });

  it("a rate limited answer stops the run's reads, and what is left waits", async () => {
    const s = sweepWorld();
    for (const [i, n] of [7, 8, 9].entries()) {
      s.w.seedSession(`S-${i}`);
      await s.w.repo.createWait({ sessionId: `S-${i}`, pr: `octo/repo#${n}`, source: "mcp" });
    }
    s.deps.github.getPull = async () => {
      throw Object.assign(new Error("rate limited"), { status: 429 });
    };

    await s.sweep();

    expect(s.w.metrics.sum("SweepReadsFailed")).toBe(1);
    expect(s.w.metrics.sum("SweepSkippedForCap")).toBe(2);
    expect(await s.w.repo.queryOpenWaits()).toHaveLength(3);
  });

  it("reads nothing while the rate limit headers say the reserve is reached", async () => {
    const s = sweepWorld();
    s.w.seedSession(WAITER);
    await s.w.repo.createWait({ sessionId: WAITER, pr: "octo/repo#7", source: "mcp" });
    s.pull(7, { state: "closed", merged: true });
    s.setRate({ remaining: 12, resetAtMs: s.w.clock.now + 3_600_000 });

    await s.sweep();

    expect(s.reads).toEqual([]);
    expect(prompts(s.w)).toEqual([]);
    expect(s.w.metrics.sum("SweepSkippedForCap")).toBe(1);
  });

  it("removes the waits of a deleted session without reading GitHub, with the new reason", async () => {
    const s = sweepWorld();
    s.w.seedSession(WAITER, { status: "deleted" });
    s.w.seedSession(OTHER);
    await s.w.repo.createWait({ sessionId: WAITER, pr: "octo/repo#7", source: "mcp" });
    await s.w.repo.createWait({ sessionId: OTHER, pr: "octo/repo#9", source: "mcp" });
    s.pull(9, { state: "open" });

    await s.sweep();

    expect(s.reads).toEqual(["octo/repo#9"]);
    expect(prompts(s.w)).toEqual([]);
    expect(await s.w.repo.queryWaits(WAITER)).toEqual([]);
    const removed = (await feed(s.w)).filter((e) => e.type === "wait.removed");
    expect(removed.map((e) => [e.sessionId, e.source, e.payload.reason])).toEqual([
      [WAITER, "sweep", "session_deleted"],
    ]);
    expect(s.w.metrics.sum("SweepWaitsRemoved")).toBe(1);
    expect(feedViolations(s.w.ddb.log)).toEqual([]);
  });

  describe("the cap", () => {
    async function fiveWaits(s: ReturnType<typeof sweepWorld>) {
      for (const [i, n] of [1, 2, 3, 4, 5].entries()) {
        s.w.seedSession(`S-${i}`);
        await s.w.repo.createWait({ sessionId: `S-${i}`, pr: `octo/repo#${n}`, source: "mcp" });
        s.pull(n, { state: "closed" });
      }
    }

    it("reads at most the cap per run, counts what it left, and the next run reads the rest", async () => {
      const s = sweepWorld();
      await fiveWaits(s);
      // The waits pass has half the run's reads: a cap of 4 gives it 2.
      const first = await s.sweep(0, { maxPrReads: 4, passes: [waitsPass] });
      expect(first.prsRead).toBe(4 / 2);
      expect(s.w.metrics.sum("SweepSkippedForCap", { pass: "waits" })).toBe(3);
      expect(prompts(s.w)).toHaveLength(2);
      expect(await s.w.repo.queryOpenWaits()).toHaveLength(3);
    });

    it("every wait is decided within ceil(n / room) runs, whatever the order the index gives", async () => {
      const s = sweepWorld();
      await fiveWaits(s);
      for (let run = 0; run < 3; run++) {
        await s.sweep(run, { maxPrReads: 4, passes: [waitsPass] });
      }
      expect(prompts(s.w)).toHaveLength(5);
      expect(await s.w.repo.queryOpenWaits()).toEqual([]);
      expect(new Set(s.reads).size).toBe(5);
    });
  });
});

describe("a webhook and the sweep race for the same wait", () => {
  const setup = async () => {
    const s = sweepWorld();
    s.w.seedSession(WAITER);
    await s.w.repo.createWait({ sessionId: WAITER, pr: "octo/repo#7", source: "mcp" });
    s.pull(7, { state: "closed", merged: true, mergeCommitSha: MERGE_SHA });
    return s;
  };
  const wakes = async (s: Awaited<ReturnType<typeof setup>>) =>
    (await feed(s.w)).filter((e) => e.type === "wake.queued");

  it("the webhook lands while the sweep is reading GitHub: the session is woken once, by the webhook", async () => {
    const s = await setup();
    const get = s.deps.github.getPull;
    let delivered = false;
    s.deps.github.getPull = async (repo, n, id) => {
      const pull = await get(repo, n, id);
      if (!delivered) {
        delivered = true;
        await webhookMerge(s.w, 7, "del-race-1");
      }
      return pull;
    };

    await s.sweep();

    expect(prompts(s.w)).toHaveLength(1);
    expect(await wakes(s)).toHaveLength(1);
    expect(brief(await feed(s.w)).filter((e) => e[0] === "wait.removed")).toEqual([
      ["wait.removed", "octo/repo#7", "webhook", "merged"],
    ]);
    expect(s.w.metrics.sum("SweepWaitsFired")).toBe(0);
  });

  it("the sweep fires first: the webhook that arrives after finds nothing to fire", async () => {
    const s = await setup();
    await s.sweep();
    await webhookMerge(s.w, 7, "del-race-2");
    expect(prompts(s.w)).toHaveLength(1);
    expect(brief(await feed(s.w)).filter((e) => e[0] === "wait.removed")).toEqual([
      ["wait.removed", "octo/repo#7", "sweep", "merged"],
    ]);
  });

  it("both at once: exactly one wake and one removal, whoever wins", async () => {
    const s = await setup();
    await Promise.all([s.sweep(), webhookMerge(s.w, 7, "del-race-3")]);
    expect(prompts(s.w)).toHaveLength(1);
    expect(await wakes(s)).toHaveLength(1);
    expect((await feed(s.w)).filter((e) => e.type === "wait.removed")).toHaveLength(1);
    expect(feedViolations(s.w.ddb.log)).toEqual([]);
  });

  it("the sweep runs twice over one wait: the second finds it gone", async () => {
    const s = await setup();
    await s.sweep(0);
    await s.sweep(1);
    expect(prompts(s.w)).toHaveLength(1);
  });
});

describe("the base moves pass", () => {
  const S8 = "01HZX0000000000000000000S8";
  const S9 = "01HZX0000000000000000000S9";
  const merge = (n: number, sha = MERGE_SHA, at = "2026-02-01T12:00:00Z"): MergedPull => ({
    number: n,
    mergedAt: at,
    mergeCommitSha: sha,
  });

  it("checks a base that moved with no webhook, wakes a conflicting PR as the sweep, and remembers the tip", async () => {
    const s = sweepWorld();
    await link(s.w, 8, S8);
    s.pull(8, { mergeable: false, mergeableState: "dirty" });
    s.merges.set("octo/repo#main", merge(7));

    const result = await s.sweep();

    expect(s.mergeReads).toEqual(["octo/repo#main"]);
    expect(s.reads).toEqual(["octo/repo#8"]);
    expect(result.prsRead).toBe(2);
    // The conflict wake debounces for two minutes, as for a webhook: it is queued, not yet sent.
    const [wake] = await s.w.repo.queryInbox(S8, { status: "pending" });
    expect(wake).toMatchObject({ kind: "pr_conflict", key: "octo/repo#8" });
    expect(wake.prompt).toContain("PR #8 no longer merges into `main`");
    expect(brief(await feed(s.w)).filter((e) => e[0].startsWith("wake"))).toEqual([
      ["wake.queued", "octo/repo#8", "sweep", "conflict"],
    ]);
    expect(await s.w.repo.getBaseTip("octo/repo", "main")).toMatchObject({
      sha: MERGE_SHA,
      afterPr: 7,
    });
    expect(s.w.metrics.sum("SweepBaseMovesFound")).toBe(1);
    expect(feedViolations(s.w.ddb.log)).toEqual([]);
  });

  it("does not check the same move twice: the next run reads the branch and nothing else", async () => {
    const s = sweepWorld();
    await link(s.w, 8, S8);
    s.pull(8, { mergeable: true, mergeableState: "clean" });
    s.merges.set("octo/repo#main", merge(7));
    await s.sweep(0);
    s.reads.length = 0;

    const second = await s.sweep(1);

    expect(s.reads).toEqual([]);
    expect(second.prsRead).toBe(1);
    expect(s.w.metrics.sum("SweepBaseMovesFound")).toBe(1);
  });

  it("checks a base again when a later merge moved it", async () => {
    const s = sweepWorld();
    await link(s.w, 8, S8);
    s.pull(8, { mergeable: true, mergeableState: "clean" });
    s.merges.set("octo/repo#main", merge(7));
    await s.sweep(0);
    s.merges.set("octo/repo#main", merge(9, H("c"), "2026-02-01T12:30:00Z"));
    await s.sweep(1);
    expect(s.w.metrics.sum("SweepBaseMovesFound")).toBe(2);
    expect(await s.w.repo.getBaseTip("octo/repo", "main")).toMatchObject({ sha: H("c") });
  });

  it("a merge that is older than every open link is only remembered, not checked", async () => {
    const s = sweepWorld();
    await link(s.w, 8, S8);
    s.merges.set("octo/repo#main", merge(7, MERGE_SHA, "2026-02-01T08:00:00Z"));

    await s.sweep();

    expect(s.reads).toEqual([]);
    expect(await s.w.repo.getBaseTip("octo/repo", "main")).toMatchObject({ sha: MERGE_SHA });
    expect(s.w.metrics.sum("SweepBaseMovesFound")).toBe(0);
  });

  it("does not check a base whose merge the webhook already checked", async () => {
    const s = sweepWorld();
    await link(s.w, 8, S8);
    s.pull(8, { mergeable: true, mergeableState: "clean" });
    await webhookMerge(s.w, 7, "del-base-1");
    expect(await s.w.repo.getBaseTip("octo/repo", "main")).toMatchObject({
      sha: MERGE_SHA,
      afterPr: 7,
    });
    s.reads.length = 0;
    s.merges.set("octo/repo#main", merge(7));

    await s.sweep();

    expect(s.reads).toEqual([]);
    expect(s.w.metrics.sum("SweepBaseMovesFound")).toBe(0);
  });

  it("queues the re-check GitHub needs when it has not computed mergeability, as the sweep", async () => {
    const s = sweepWorld();
    await link(s.w, 8, S8);
    s.pull(8, { mergeable: null, mergeableState: "unknown" });
    s.merges.set("octo/repo#main", merge(7));

    await s.sweep();

    const [queued] = s.w.githubQueue.sent.filter((m) => m.message.kind === "conflict_check");
    expect(queued.message).toMatchObject({ attempt: 2, source: "sweep", base: "main" });
    // GitHub has computed it by the re-check, and the PR conflicts.
    s.pull(8, { mergeable: false, mergeableState: "dirty" });
    await handleQueueMessage(s.w.deps, queued.message);
    expect(brief(await feed(s.w)).filter((e) => e[0] === "wake.queued")).toEqual([
      ["wake.queued", "octo/repo#8", "sweep", "conflict"],
    ]);
  });

  it("watches no branch for a deleted session's PR or a link with no stored base", async () => {
    const s = sweepWorld();
    s.w.seedSession(S9, { status: "deleted" });
    await link(s.w, 9, S9, "release");
    await link(s.w, 10, "S-nobase", null);
    s.merges.set("octo/repo#release", merge(7));

    const result = await s.sweep();

    expect(s.mergeReads).toEqual([]);
    expect(result.prsRead).toBe(0);
  });

  it("skips a moved base that does not fit what is left of the cap, after the first, and says so", async () => {
    const s = sweepWorld();
    await link(s.w, 8, S8); // main: 1 open PR
    for (const n of [10, 11, 12]) {
      await link(s.w, n, S8, "release"); // release: 3 open PRs
      s.pull(n, { baseRef: "release", mergeable: true, mergeableState: "clean" });
    }
    s.pull(8, { mergeable: true, mergeableState: "clean" });
    s.merges.set("octo/repo#main", merge(7));
    s.merges.set("octo/repo#release", merge(9, H("c"), "2026-02-01T12:30:00Z"));
    // Something else (the waits pass) used the run's reads and left five.
    const spender: Pass = {
      name: "uses-reads",
      async run(ctx) {
        ctx.budget.spend(ctx.budget.room() - 5);
      },
    };
    const { baseMovesPass } = await import("../src/sweep/base-moves.ts");

    await s.sweep(0, { maxPrReads: 10, passes: [spender, baseMovesPass] });

    // main: one read of the branch and one of its PR. release: its branch read leaves 2, its 3 PRs do not fit.
    expect(s.reads).toEqual(["octo/repo#8"]);
    expect(s.w.metrics.sum("SweepSkippedForCap", { pass: "base_moves" })).toBe(1);
    expect(await s.w.repo.getBaseTip("octo/repo", "main")).toMatchObject({ sha: MERGE_SHA });
    expect(await s.w.repo.getBaseTip("octo/repo", "release")).toBeNull();
  });

  it("checks the first moved base even when it is larger than the cap", async () => {
    const s = sweepWorld();
    for (const n of [8, 9, 10]) {
      await link(s.w, n, S8);
      s.pull(n, { mergeable: true, mergeableState: "clean" });
    }
    s.merges.set("octo/repo#main", merge(7));
    const result = await s.sweep(0, { maxPrReads: 2 });
    expect(s.reads.sort()).toEqual(["octo/repo#10", "octo/repo#8", "octo/repo#9"]);
    expect(result.prsRead).toBe(4);
  });
});

describe("the sweep", () => {
  it("runs every pass even when one fails, then drains what it woke and reports the failure", async () => {
    const s = sweepWorld();
    s.w.seedSession(WAITER);
    await s.w.repo.createWait({ sessionId: WAITER, pr: "octo/repo#7", source: "mcp" });
    s.pull(7, { state: "closed", merged: true, mergeCommitSha: MERGE_SHA });
    const broken: Pass = {
      name: "broken",
      async run() {
        throw new Error("boom");
      },
    };

    const result = await s.sweep(0, { passes: [broken, waitsPass] });

    expect(result.failedPasses).toEqual(["broken"]);
    expect(prompts(s.w)).toHaveLength(1);
    expect(s.w.metrics.sum("SweepPassFailed", { pass: "broken" })).toBe(1);
  });

  it("with nothing open, reads nothing", async () => {
    const s = sweepWorld();
    expect(await s.sweep()).toEqual({ prsRead: 0, failedPasses: [] });
    expect(s.reads).toEqual([]);
    expect(s.mergeReads).toEqual([]);
  });

  it("holds a merge wake so it folds with the waiter's own conflict wake, as the webhook does", async () => {
    const s = sweepWorld();
    await link(s.w, 8, WAITER);
    s.w.seedSession(OTHER);
    await s.w.repo.createWait({ sessionId: WAITER, pr: "octo/repo#7", source: "mcp" });
    s.pull(7, { state: "closed", merged: true, mergeCommitSha: MERGE_SHA });
    s.pull(8, { mergeable: false, mergeableState: "dirty" });
    s.merges.set("octo/repo#main", {
      number: 7,
      mergedAt: "2026-02-01T12:00:00Z",
      mergeCommitSha: MERGE_SHA,
    });

    await s.sweep();

    // Both wakes are pending and due together: nothing was sent while the conflict wake debounces.
    const pending = await s.w.repo.queryInbox(WAITER, { status: "pending" });
    expect(pending.map((i) => i.kind).sort()).toEqual(["pr_conflict", "pr_wait_merged"]);
    expect(new Set(pending.map((i) => i.notBefore)).size).toBe(1);
    expect(prompts(s.w)).toEqual([]);
  });
});
