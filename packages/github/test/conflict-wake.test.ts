import { describe, expect, it } from "vitest";
import { handleQueueMessage, processDelivery } from "../src/consumer.ts";
import { fixture, type World, world } from "./helpers.ts";

const S8 = "01HZX0000000000000000000S8";
const S9 = "01HZX0000000000000000000S9";
const H = (c: string) => c.repeat(40);
const MERGE_SHA = "2222222222222222222222222222222222222222";

/** Link PR `n` of octo/repo to a session, open on `base`. */
async function link(
  w: World,
  n: number,
  session: string,
  over: { prState?: "open" | "closed" | "unknown"; baseRef?: string | null; headSha?: string } = {},
) {
  if (!w.ddb.get(`SESSION#${session}`, "META")) {
    w.seedSession(session);
  }
  await w.repo.createLink({
    repo: "octo/repo",
    number: n,
    sessionId: session,
    linkedBy: "harvest",
    prState: over.prState ?? "open",
    headSha: over.headSha ?? H("a"),
    baseRef: over.baseRef === undefined ? "main" : over.baseRef,
  });
}

type PullState = {
  state?: "open" | "closed";
  merged?: boolean;
  headSha?: string;
  baseRef?: string | null;
  mergeable?: boolean | null;
  mergeableState?: string | null;
};
/** What GitHub says about PR `n` right now; counts reads. */
function github(w: World) {
  const reads: number[] = [];
  const set = (n: number, p: PullState) => {
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
      mergeable: false,
      mergeableState: "dirty",
      ...p,
    });
  };
  const original = w.deps.github.getPull;
  w.deps.github.getPull = async (repo, n, id) => {
    reads.push(n);
    return original(repo, n, id);
  };
  return { set, reads };
}

const DIRTY: PullState = { mergeable: false, mergeableState: "dirty" };
const CLEAN: PullState = { mergeable: true, mergeableState: "clean" };
const UNKNOWN: PullState = { mergeable: null, mergeableState: "unknown" };

/** Deliver "PR #n was merged into main" for a PR that is not linked. */
async function merged(w: World, number: number, deliveryId: string, sha = MERGE_SHA) {
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

const pending = (w: World, session: string) => w.repo.queryInbox(session, { status: "pending" });
const rechecks = (w: World) =>
  w.githubQueue.sent.filter((s) => s.message.kind === "conflict_check");

describe("conflict wake: a merge moves the base", () => {
  it("wakes only the session whose PR conflicts, once the debounce is up", async () => {
    const w = world();
    const gh = github(w);
    await link(w, 8, S8);
    await link(w, 9, S9);
    gh.set(8, DIRTY);
    gh.set(9, CLEAN);

    const out = await merged(w, 7, "del-merge-7");
    expect(out?.status).toBe("processed");
    expect(gh.reads.sort()).toEqual([8, 9]);
    expect(await pending(w, S9)).toEqual([]);
    const [item] = await pending(w, S8);
    expect(item).toMatchObject({ kind: "pr_conflict", key: "octo/repo#8" });
    expect(item.prompt.split("\n")[1]).toBe(
      `PR #8 no longer merges into \`main\`: it conflicts with \`main\` at ${MERGE_SHA} (after #7 was merged). Rebase onto \`main\` (never merge it in), resolve the conflicts, push with --force-with-lease and say what changed.`,
    );
    expect(w.commands.commands).toEqual([]); // debounced: not due yet
    expect(w.metrics.sum("ConflictChecks")).toBe(2);
    expect(w.metrics.sum("ConflictsFound")).toBe(1);
    expect(w.metrics.sum("ConflictWakes")).toBe(1);

    w.clock.now += 125_000;
    await handleQueueMessage(w.deps, { kind: "drain", sessionId: S8 });
    expect(w.commands.commands).toHaveLength(1);
    expect(w.commands.commands[0]).toMatchObject({
      kind: "prompt",
      sessionId: S8,
      whenBusy: "reject",
      trigger: { source: "github", deliveryIds: ["del-merge-7"] },
    });
  });

  it("never wakes a busy session; the item waits for the turn to settle", async () => {
    const w = world();
    const gh = github(w);
    await link(w, 8, S8);
    gh.set(8, DIRTY);
    (w.ddb.get(`SESSION#${S8}`, "META") as { status: string }).status = "running";
    await merged(w, 7, "del-merge-7");
    w.clock.now += 125_000;
    await handleQueueMessage(w.deps, { kind: "drain", sessionId: S8 });
    expect(w.commands.commands).toEqual([]);
    expect(await pending(w, S8)).toHaveLength(1);
  });

  it("does not check the PR that was just merged, even when it is linked", async () => {
    const w = world();
    const gh = github(w);
    await link(w, 7, S8);
    gh.set(7, DIRTY);
    await merged(w, 7, "del-merge-7");
    expect(gh.reads).toEqual([]);
    expect((await pending(w, S8)).map((i) => i.kind)).toEqual([]);
  });

  it("does not read a closed PR, and ignores one GitHub reports closed", async () => {
    const w = world();
    const gh = github(w);
    await link(w, 8, S8, { prState: "closed" });
    await link(w, 9, S9);
    gh.set(9, { ...DIRTY, state: "closed" });
    await merged(w, 7, "del-merge-7");
    expect(gh.reads).toEqual([9]);
    expect(await pending(w, S8)).toEqual([]);
    expect(await pending(w, S9)).toEqual([]);
    expect(w.metrics.sum("ConflictChecksSkipped", { reason: "closed" })).toBe(1);
  });

  it("does not check a PR on another base; a PR with an unknown base is read and filtered", async () => {
    const w = world();
    const gh = github(w);
    await link(w, 8, S8, { baseRef: "develop" });
    await link(w, 9, S9, { baseRef: null });
    gh.set(8, DIRTY);
    gh.set(9, { ...DIRTY, baseRef: "develop" });
    await merged(w, 7, "del-merge-7");
    expect(gh.reads).toEqual([9]);
    expect(await pending(w, S8)).toEqual([]);
    expect(await pending(w, S9)).toEqual([]);
    expect(w.metrics.sum("ConflictChecksSkipped", { reason: "other_base" })).toBe(1);
  });

  it("works without the push subscription: only the merge delivery is needed", async () => {
    const w = world();
    const gh = github(w);
    await link(w, 8, S8);
    gh.set(8, DIRTY);
    await merged(w, 7, "del-merge-7");
    expect(await pending(w, S8)).toHaveLength(1);
  });
});

describe("conflict wake: GitHub has not computed mergeability yet", () => {
  it("asks again after 40 s and wakes when the re-check says conflicting", async () => {
    const w = world();
    const gh = github(w);
    await link(w, 8, S8);
    gh.set(8, UNKNOWN);
    await merged(w, 7, "del-merge-7");
    expect(await pending(w, S8)).toEqual([]);
    expect(rechecks(w)).toEqual([
      {
        delaySeconds: 40,
        message: expect.objectContaining({
          kind: "conflict_check",
          number: 8,
          attempt: 2,
          headSha: H("a"),
        }),
      },
    ]);

    gh.set(8, DIRTY);
    w.clock.now += 40_000;
    await handleQueueMessage(w.deps, rechecks(w)[0].message);
    const [item] = await pending(w, S8);
    expect(item.prompt).toContain("PR #8 no longer merges into `main`");
    expect(item.deliveryIds).toEqual(["del-merge-7"]);
    expect(w.metrics.sum("ConflictRechecks")).toBe(1);
    expect(rechecks(w)).toHaveLength(1); // no third try needed
  });

  it("gives up after three tries over about two minutes and writes no wake", async () => {
    const w = world();
    const gh = github(w);
    await link(w, 8, S8);
    gh.set(8, UNKNOWN);
    await merged(w, 7, "del-merge-7");
    await handleQueueMessage(w.deps, rechecks(w)[0].message);
    expect(rechecks(w).map((r) => r.delaySeconds)).toEqual([40, 80]);
    await handleQueueMessage(w.deps, rechecks(w)[1].message);

    expect(gh.reads).toEqual([8, 8, 8]);
    expect(rechecks(w)).toHaveLength(2); // nothing scheduled after the third try
    expect(await pending(w, S8)).toEqual([]);
    expect(w.metrics.sum("ConflictChecksGaveUp", { reason: "still_unknown" })).toBe(1);
    expect(w.log.lines.some((l) => l.includes("conflict_check_gave_up"))).toBe(true);
    expect(w.metrics.sum("ConflictWakes")).toBe(0);
  });

  it("does not wake when the head changed after the base moved (the agent may have rebased)", async () => {
    const w = world();
    const gh = github(w);
    await link(w, 8, S8);
    gh.set(8, UNKNOWN);
    await merged(w, 7, "del-merge-7");
    gh.set(8, { ...DIRTY, headSha: H("c") });
    await handleQueueMessage(w.deps, rechecks(w)[0].message);
    expect(await pending(w, S8)).toEqual([]);
    expect(w.metrics.sum("ConflictChecksSkipped", { reason: "head_changed" })).toBe(1);
  });

  it("a read that fails is tried again, then given up, never guessed", async () => {
    const w = world();
    await link(w, 8, S8);
    w.deps.github.getPull = async () => {
      throw new Error("github 502");
    };
    await merged(w, 7, "del-merge-7");
    await handleQueueMessage(w.deps, rechecks(w)[0].message);
    await handleQueueMessage(w.deps, rechecks(w)[1].message);
    expect(await pending(w, S8)).toEqual([]);
    expect(w.metrics.sum("ConflictChecksGaveUp", { reason: "read_failed" })).toBe(1);
  });

  it("a re-check for a PR that was closed meanwhile does nothing", async () => {
    const w = world();
    const gh = github(w);
    await link(w, 8, S8);
    gh.set(8, UNKNOWN);
    await merged(w, 7, "del-merge-7");
    await w.repo.updateLinkState("octo/repo#8", { prState: "closed" });
    await handleQueueMessage(w.deps, rechecks(w)[0].message);
    expect(await pending(w, S8)).toEqual([]);
    expect(gh.reads).toEqual([8]); // the re-check did not read
  });
});

describe("conflict wake: debounce", () => {
  it("several merges in a row give one wake that names them all", async () => {
    const w = world();
    const gh = github(w);
    await link(w, 8, S8);
    gh.set(8, DIRTY);
    await merged(w, 7, "del-merge-7", H("2"));
    w.clock.now += 30_000;
    await merged(w, 10, "del-merge-10", H("3"));
    w.clock.now += 20_000;
    await merged(w, 11, "del-merge-11", H("4"));

    const items = await w.repo.queryInbox(S8);
    expect(items).toHaveLength(1);
    expect(items[0].deliveryIds).toEqual(["del-merge-7", "del-merge-10", "del-merge-11"]);
    expect(items[0].prompt.split("\n")[1]).toContain(
      `at ${H("4")} (after #7, #10, #11 were merged)`,
    );
    expect(w.metrics.sum("ConflictWakes")).toBe(1);

    w.clock.now += 100_000;
    await handleQueueMessage(w.deps, { kind: "drain", sessionId: S8 });
    expect(w.commands.commands).toHaveLength(1);
  });

  it("a merge after the first wake went out starts a new wake", async () => {
    const w = world();
    const gh = github(w);
    await link(w, 8, S8);
    gh.set(8, DIRTY);
    await merged(w, 7, "del-merge-7");
    w.clock.now += 130_000;
    await handleQueueMessage(w.deps, { kind: "drain", sessionId: S8 });
    expect(w.commands.commands).toHaveLength(1);
    (w.ddb.get(`SESSION#${S8}`, "META") as { status: string }).status = "idle";
    await merged(w, 10, "del-merge-10");
    expect((await w.repo.queryInbox(S8)).map((i) => i.status)).toEqual(["delivered", "pending"]);
  });
});

describe("conflict wake: a push to the base (optional push subscription)", () => {
  async function pushed(w: World, ref: string, id = "del-push-1") {
    const payload = fixture("push");
    payload.ref = ref;
    await w.repo.putDelivery({
      deliveryId: id,
      event: "push",
      action: null,
      repo: "octo/repo",
      rawBody: JSON.stringify(payload),
    });
    return processDelivery(w.deps, id);
  }

  it("wakes for a PR that now conflicts and says 'after a push'", async () => {
    const w = world();
    const gh = github(w);
    await link(w, 8, S8);
    gh.set(8, DIRTY);
    await pushed(w, "refs/heads/main");
    const [item] = await pending(w, S8);
    expect(item.prompt.split("\n")[1]).toContain(`at ${H("4")} (after a push)`);
  });

  it("a push to a branch no linked PR targets reads nothing", async () => {
    const w = world();
    const gh = github(w);
    await link(w, 8, S8);
    gh.set(8, DIRTY);
    const out = await pushed(w, "refs/heads/feature/x");
    expect(gh.reads).toEqual([]);
    expect(out?.status).toBe("ignored");
  });

  it("a merge and its push together produce one wake", async () => {
    const w = world();
    const gh = github(w);
    await link(w, 8, S8);
    gh.set(8, DIRTY);
    await merged(w, 7, "del-merge-7", H("4"));
    await pushed(w, "refs/heads/main", "del-push-1");
    const items = await w.repo.queryInbox(S8);
    expect(items).toHaveLength(1);
    expect(items[0].deliveryIds).toEqual(["del-merge-7", "del-push-1"]);
  });
});

describe("conflict wake: the PR index", () => {
  it("indexes a link written before the index existed on its next state refresh", async () => {
    const w = world();
    await link(w, 8, S8);
    const row = w.ddb.get("GHPR#octo/repo#8", "LINK") as Record<string, unknown>;
    delete row.GSI1PK;
    delete row.GSI1SK;
    expect(await w.repo.queryOpenLinks("octo/repo")).toEqual([]);
    await w.repo.updateLinkState("octo/repo#8", { prState: "open", headSha: H("c") });
    expect((await w.repo.queryOpenLinks("octo/repo")).map((l) => l.pr)).toEqual(["octo/repo#8"]);
  });

  it("drops a merged or closed PR from the index, and keeps repos apart", async () => {
    const w = world();
    await link(w, 8, S8);
    await link(w, 9, S9);
    await w.repo.createLink({
      repo: "octo/other",
      number: 1,
      sessionId: S9,
      linkedBy: "manual",
      prState: "unknown",
      headSha: null,
    });
    await w.repo.updateLinkState("octo/repo#8", { prState: "merged" });
    expect((await w.repo.queryOpenLinks("octo/repo")).map((l) => l.pr)).toEqual(["octo/repo#9"]);
    expect((await w.repo.queryOpenLinks("octo/other")).map((l) => l.pr)).toEqual(["octo/other#1"]);
  });
});
