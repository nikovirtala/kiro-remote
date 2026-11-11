import type { EventItem } from "@nikovirtala/kiro-remote-core";
import { describe, expect, it } from "vitest";
import type { PullInfo } from "../src/app-client.ts";
import { extractCandidates, harvestTurn } from "../src/harvest.ts";
import { coreFixture, type World, world } from "./helpers.ts";

const { events: FIXTURE_EVENTS } = coreFixture<{ events: Array<Record<string, unknown>> }>(
  "pr-url-events.synthetic.json",
);

const SESSION = "S1";

/** A loosely typed recorded event, for patching fixture fields. */
interface Rec {
  type: string;
  payload: { rawOutput: { output: string }; rawInput: { command: string } };
}

function pull(over: Partial<PullInfo> = {}): PullInfo {
  return {
    number: 7,
    state: "open",
    merged: false,
    createdAt: "2026-02-01T10:00:00Z",
    headSha: "1".repeat(40),
    headRef: "kiro/fix-typo",
    authorLogin: "kiro-agent[bot]",
    body: null,
    ...over,
  };
}

/** Write the fixture turn's events into the session's log. */
async function appendFixtureEvents(w: World, turnId = "T1") {
  for (const e of FIXTURE_EVENTS) {
    await w.repo.appendEvent(SESSION, {
      turnId: (e.turnId as string) === "T1" ? turnId : (e.turnId as string),
      ts: "2026-02-01T10:00:00.000Z",
      type: e.type as string,
      rawType: e.rawType as string,
      replay: false,
      payload: e.payload,
    });
  }
}

function harvestDeps(w: World) {
  return {
    repo: w.repo,
    github: w.deps.github,
    metrics: w.metrics,
    logger: w.deps.logger,
    now: () => w.clock.now,
  };
}

const infoEvents = async (w: World) =>
  (await w.repo.queryEvents(SESSION, 0)).filter((e) => e.type === "session.info");
const payloadOf = (e: EventItem) => (e.payload as { payload: Record<string, unknown> }).payload;

describe("extractCandidates (fixture: one turn that opened a PR)", () => {
  it("finds PR URLs in tool.call, tool.update and message.chunk, not in thoughts or other fields", () => {
    const events = FIXTURE_EVENTS as unknown as EventItem[];
    expect(extractCandidates(events).map((r) => `${r.owner}/${r.repo}#${r.number}`)).toEqual([
      "octo/repo#7",
      "octo/repo#3",
      "other/thing#12",
    ]);
  });

  it("finds a URL that is split across message chunks", () => {
    const chunk = (text: string) => ({
      type: "message.chunk",
      payload: { content: { type: "text", text } },
    });
    const events = [
      chunk("Opened https://github.com/octo/re"),
      chunk("po/pull/"),
      chunk("42 for you."),
      { type: "tool.call", payload: {} },
      chunk("https://github.com/octo/repo/pull/"), // cut by a tool call: not a URL
      { type: "tool.call", payload: {} },
      chunk("9"),
    ] as unknown as EventItem[];
    expect(extractCandidates(events).map((r) => r.number)).toEqual([42]);
  });

  it("works on the shape of a REAL recorded turn (no PR was opened, so no candidates)", () => {
    const { events } = coreFixture<{ events: unknown[] }>("audit-turn-no-pr.redacted.json");
    expect(events.length).toBeGreaterThan(10);
    expect(extractCandidates(events as EventItem[])).toEqual([]);
  });

  it("finds the URL where a real tool.update carries command output (rawOutput.output)", () => {
    const { events } = coreFixture<{ events: Array<Rec> }>("audit-turn-no-pr.redacted.json");
    const update = events.find(
      (e) => e.type === "tool.update" && e.payload?.rawOutput?.output !== undefined,
    );
    expect(update).toBeTruthy();
    const patched = structuredClone(update) as Rec;
    patched.payload.rawOutput.output = "https://github.com/octo/repo/pull/77\n";
    expect(extractCandidates([patched as unknown as EventItem]).map((r) => r.number)).toEqual([77]);
    // ...and the command text of a real tool.call is scanned too.
    const call = structuredClone(events.find((e) => e.type === "tool.call")) as Rec;
    call.payload.rawInput.command = "gh pr view https://github.com/octo/repo/pull/78";
    expect(extractCandidates([call as unknown as EventItem]).map((r) => r.number)).toEqual([78]);
  });

  it("each event type alone is enough", () => {
    const only = (type: string) =>
      extractCandidates((FIXTURE_EVENTS as unknown as EventItem[]).filter((e) => e.type === type));
    expect(only("tool.update").map((r) => r.number)).toEqual([7]);
    expect(only("message.chunk").map((r) => r.number)).toEqual([7, 3, 12]);
    expect(only("tool.call").map((r) => r.number)).toEqual([]); // the command text has no URL yet
    expect(only("thought.chunk")).toEqual([]);
  });
});

describe("harvestTurn", () => {
  async function setup(sessionOver: Record<string, unknown> = {}) {
    const w = world();
    w.seedSession(SESSION, {
      repos: ["octo/repo"],
      createdAt: "2026-02-01T09:00:00.000Z",
      ...sessionOver,
    });
    await appendFixtureEvents(w);
    return w;
  }

  it("links the PR the agent opened and records every other candidate with its reason", async () => {
    const w = await setup();
    w.github.pulls.set("octo/repo#7", pull());
    w.github.pulls.set("octo/repo#3", pull({ number: 3, createdAt: "2026-01-15T10:00:00Z" })); // before the session
    const res = await harvestTurn(harvestDeps(w), {
      sessionId: SESSION,
      turnId: "T1",
      afterSeq: 0,
    });

    expect(res.linked).toEqual(["octo/repo#7"]);
    expect(res.rejected).toEqual([
      { pr: "octo/repo#3", reason: "created_before_session" },
      { pr: "other/thing#12", reason: "repo_not_in_session" },
    ]);
    expect(await w.repo.getPrLink("octo/repo#7")).toMatchObject({
      sessionId: SESSION,
      linkedBy: "harvest",
      prState: "open",
      headSha: "1".repeat(40),
    });
    expect(await w.repo.getPrLink("octo/repo#3")).toBeNull();

    const info = await infoEvents(w);
    const rejected = info.filter((e) => e.rawType === "pr_link_rejected");
    expect(rejected.map((e) => [payloadOf(e).pr, payloadOf(e).reason])).toEqual([
      ["octo/repo#3", "created_before_session"],
      ["other/thing#12", "repo_not_in_session"],
    ]);
    expect(rejected.every((e) => e.turnId === "T1")).toBe(true);
    expect(info.filter((e) => e.rawType === "pr_linked")).toHaveLength(1);
    expect(w.metrics.sum("LinksCreated", { method: "harvest" })).toBe(1);
    expect(w.metrics.sum("LinksRejected")).toBe(2);
  });

  it("rejects a repo outside the session's repos[] without calling GitHub", async () => {
    const w = await setup({ repos: ["acme/other"] });
    let calls = 0;
    w.deps.github.getPull = async () => {
      calls++;
      return pull();
    };
    const res = await harvestTurn(harvestDeps(w), {
      sessionId: SESSION,
      turnId: "T1",
      afterSeq: 0,
    });
    expect(res.linked).toEqual([]);
    expect(res.rejected.map((r) => r.reason)).toEqual([
      "repo_not_in_session",
      "repo_not_in_session",
      "repo_not_in_session",
    ]);
    expect(calls).toBe(0);
  });

  it("rejects a PR that does not exist", async () => {
    const w = await setup();
    const res = await harvestTurn(harvestDeps(w), {
      sessionId: SESSION,
      turnId: "T1",
      afterSeq: 0,
    });
    expect(res.rejected).toContainEqual({ pr: "octo/repo#7", reason: "pr_not_found" });
    expect(await w.repo.getPrLink("octo/repo#7")).toBeNull();
  });

  it("rejects a PR created before the session", async () => {
    const w = await setup({ createdAt: "2026-02-01T11:00:00.000Z" });
    w.github.pulls.set("octo/repo#7", pull());
    const res = await harvestTurn(harvestDeps(w), {
      sessionId: SESSION,
      turnId: "T1",
      afterSeq: 0,
    });
    expect(res.rejected).toContainEqual({ pr: "octo/repo#7", reason: "created_before_session" });
  });

  it("rejects a PR already linked to ANOTHER session, and leaves that link alone", async () => {
    const w = await setup();
    w.github.pulls.set("octo/repo#7", pull());
    await w.repo.createLink({
      repo: "octo/repo",
      number: 7,
      sessionId: "OTHER",
      linkedBy: "trailer",
      prState: "open",
      headSha: null,
    });
    const res = await harvestTurn(harvestDeps(w), {
      sessionId: SESSION,
      turnId: "T1",
      afterSeq: 0,
    });
    expect(res.linked).toEqual([]);
    expect(res.rejected).toContainEqual({ pr: "octo/repo#7", reason: "already_linked" });
    expect((await w.repo.getPrLink("octo/repo#7"))?.sessionId).toBe("OTHER");
  });

  it("a PR already linked to THIS session is not re-linked or reported", async () => {
    const w = await setup();
    w.github.pulls.set("octo/repo#7", pull());
    await harvestTurn(harvestDeps(w), { sessionId: SESSION, turnId: "T1", afterSeq: 0 });
    const before = (await infoEvents(w)).length;
    const again = await harvestTurn(harvestDeps(w), {
      sessionId: SESSION,
      turnId: "T1",
      afterSeq: 0,
    });
    expect(again.linked).toEqual([]);
    expect(again.rejected.map((r) => r.pr)).not.toContain("octo/repo#7");
    expect((await infoEvents(w)).length).toBeGreaterThanOrEqual(before);
  });

  it("only scans the settled turn's events", async () => {
    const w = await setup();
    w.github.pulls.set("octo/repo#7", pull());
    const res = await harvestTurn(harvestDeps(w), {
      sessionId: SESSION,
      turnId: "ANOTHER-TURN",
      afterSeq: 0,
    });
    expect(res).toEqual({ linked: [], rejected: [] });
  });

  it("does nothing for a deleted session", async () => {
    const w = await setup({ status: "deleted" });
    w.github.pulls.set("octo/repo#7", pull());
    expect(
      await harvestTurn(harvestDeps(w), { sessionId: SESSION, turnId: "T1", afterSeq: 0 }),
    ).toEqual({ linked: [], rejected: [] });
  });

  it("lets a transient GitHub error propagate so the message is retried", async () => {
    const w = await setup();
    w.deps.github.getPull = async () => {
      throw new Error("503");
    };
    await expect(
      harvestTurn(harvestDeps(w), { sessionId: SESSION, turnId: "T1", afterSeq: 0 }),
    ).rejects.toThrow("503");
  });

  describe("autoClose after the post-merge turn", () => {
    async function mergedLink(w: World, number: number) {
      await w.repo.createLink({
        repo: "octo/repo",
        number,
        sessionId: SESSION,
        linkedBy: "harvest",
        prState: "merged",
        headSha: null,
      });
    }
    async function pendingItem(w: World) {
      await w.repo.putInboxItem({
        PK: `SESSION#${SESSION}`,
        SK: "INBOX#01P",
        id: "01P",
        sessionId: SESSION,
        source: "github",
        deliveryId: "d-p",
        deliveryIds: ["d-p"],
        kind: "review",
        key: "octo/repo#7",
        prompt: "[GitHub webhook] This turn was started by GitHub, not by the user: pending",
        data: null,
        createdAt: new Date(0).toISOString(),
        notBefore: new Date(0).toISOString(),
        status: "pending",
        dropReason: null,
        deliveredTurnId: null,
        autoClose: false,
        ttl: 9_999_999_999,
      });
    }
    const autoCloseMsg = {
      kind: "harvest" as const,
      sessionId: SESSION,
      turnId: "T1",
      afterSeq: 0,
      autoClose: true,
    };

    it("keeps the session when that turn opened a follow-up PR, and drains its inbox", async () => {
      const w = await setup();
      await mergedLink(w, 3); // the PR whose merge woke the session
      w.github.pulls.set("octo/repo#7", pull()); // opened in this turn (its URL is in the events)
      await pendingItem(w);
      const { handleQueueMessage } = await import("../src/consumer.ts");
      await handleQueueMessage(w.deps, autoCloseMsg);

      expect((await w.repo.getPrLink("octo/repo#7"))?.prState).toBe("open");
      expect(w.commands.commands.filter((c) => c.kind === "delete")).toEqual([]);
      expect(w.metrics.sum("AutoCloseSkipped")).toBe(1);
      expect(
        w.log.lines.some((l) => l.includes("auto_close_skipped") && l.includes("octo/repo#7")),
      ).toBe(true);
      // The drain the bridge skipped happens here.
      expect(w.commands.commands.filter((c) => c.kind === "prompt")).toHaveLength(1);
    });

    it("deletes the session when no linked PR is still open, dropping what is pending", async () => {
      const w = world();
      w.seedSession(SESSION, { repos: ["octo/repo"] }); // no events: nothing new to harvest
      await mergedLink(w, 3);
      await pendingItem(w);
      const { handleQueueMessage } = await import("../src/consumer.ts");
      await handleQueueMessage(w.deps, autoCloseMsg);

      expect(w.commands.commands).toEqual([
        { kind: "delete", sub: "user-sub-1", sessionId: SESSION, commandId: expect.any(String) },
      ]);
      expect((await w.repo.queryInbox(SESSION))[0]).toMatchObject({
        status: "dropped",
        dropReason: "auto_closed",
      });
      expect(w.metrics.sum("AutoClosed")).toBe(1);
    });

    it("a link of unknown state (a manual link not yet seen by a webhook) also keeps the session", async () => {
      const w = world();
      w.seedSession(SESSION, { repos: ["octo/repo"] });
      await mergedLink(w, 3);
      await w.repo.createLink({
        repo: "octo/repo",
        number: 9,
        sessionId: SESSION,
        linkedBy: "manual",
        prState: "unknown",
        headSha: null,
      });
      const { handleQueueMessage } = await import("../src/consumer.ts");
      await handleQueueMessage(w.deps, autoCloseMsg);
      expect(w.commands.commands.filter((c) => c.kind === "delete")).toEqual([]);
    });

    it("without the flag, a harvest never closes", async () => {
      const w = world();
      w.seedSession(SESSION, { repos: ["octo/repo"] });
      await mergedLink(w, 3);
      const { handleQueueMessage } = await import("../src/consumer.ts");
      await handleQueueMessage(w.deps, { ...autoCloseMsg, autoClose: undefined });
      expect(w.commands.commands).toEqual([]);
    });
  });

  it("is invoked through the queue message", async () => {
    const w = await setup();
    w.github.pulls.set("octo/repo#7", pull());
    const { handleQueueMessage } = await import("../src/consumer.ts");
    await handleQueueMessage(w.deps, {
      kind: "harvest",
      sessionId: SESSION,
      turnId: "T1",
      afterSeq: 0,
    });
    expect(await w.repo.getPrLink("octo/repo#7")).not.toBeNull();
  });
});
