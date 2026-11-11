import type { Command } from "@nikovirtala/kiro-remote-core";
import { describe, expect, it } from "vitest";
import { handleQueueMessage, linkFromTrailer, processDelivery } from "../src/consumer.ts";
import { processRecords } from "../src/lambda/consumer.ts";
import { WAKE_HEADER_PREFIX } from "../src/render.ts";
import { event, fixture, SHA, type World, world } from "./helpers.ts";

const SESSION = "01HZX0000000000000000000S1";

async function linked(w: World, session = SESSION) {
  w.seedSession(session);
  await w.repo.createLink({
    repo: "octo/repo",
    number: 7,
    sessionId: session,
    linkedBy: "harvest",
    prState: "open",
    headSha: SHA,
  });
}

const prompts = (w: World) =>
  w.commands.commands.filter((c): c is Extract<Command, { kind: "prompt" }> => c.kind === "prompt");

describe("processDelivery: wake", () => {
  it("a merge wakes an idle session with ONE prompt turn carrying the trigger", async () => {
    const w = world();
    await linked(w);
    const id = await w.ingest("pull_request", "pull_request.closed.merged", "del-merge-1");
    const out = await processDelivery(w.deps, id);
    expect(out).toMatchObject({ status: "processed" });
    expect(prompts(w)).toHaveLength(1);
    const cmd = prompts(w)[0];
    expect(cmd).toMatchObject({
      sessionId: SESSION,
      sub: "user-sub-1",
      whenBusy: "reject",
      trigger: { source: "github", deliveryIds: ["del-merge-1"] },
    });
    expect(cmd.prompt.split("\n")[0]).toContain(WAKE_HEADER_PREFIX);
    expect(cmd.prompt).toContain(
      "PR #7 was merged into main at 2222222222222222222222222222222222222222.",
    );
    expect(w.metrics.sum("WakesDelivered")).toBe(1);
    expect((await w.repo.getPrLink("octo/repo#7"))?.prState).toBe("merged");
    expect((await w.repo.getDelivery(id))?.status).toBe("processed");
  });

  it("a busy session keeps the wake pending; the next drain delivers it", async () => {
    const w = world();
    await linked(w);
    (w.ddb.get(`SESSION#${SESSION}`, "META") as { status: string }).status = "running";
    const id = await w.ingest("pull_request", "pull_request.closed.merged");
    await processDelivery(w.deps, id);
    expect(prompts(w)).toEqual([]);
    expect((await w.repo.queryInbox(SESSION, { status: "pending" })).map((i) => i.kind)).toEqual([
      "pr_merged",
    ]);

    (w.ddb.get(`SESSION#${SESSION}`, "META") as { status: string }).status = "idle";
    await handleQueueMessage(w.deps, { kind: "drain", sessionId: SESSION });
    expect(prompts(w)).toHaveLength(1);
  });

  it("a deleted session's wake is dropped with the reason, and counted", async () => {
    const w = world();
    await linked(w);
    (w.ddb.get(`SESSION#${SESSION}`, "META") as { status: string }).status = "deleted";
    await processDelivery(w.deps, await w.ingest("pull_request", "pull_request.closed.merged"));
    expect(prompts(w)).toEqual([]);
    const [item] = await w.repo.queryInbox(SESSION);
    expect(item).toMatchObject({ status: "dropped", dropReason: "session_deleted" });
    expect(w.metrics.sum("WakesDropped", { reason: "session_deleted" })).toBe(1);
  });

  it("several wakes for a busy session fold into one turn when it goes idle", async () => {
    const w = world();
    await linked(w);
    (w.ddb.get(`SESSION#${SESSION}`, "META") as { status: string }).status = "running";
    await processDelivery(
      w.deps,
      await w.ingest("issue_comment", "issue_comment.created.trusted", "del-c1"),
    );
    await processDelivery(
      w.deps,
      await w.ingest(
        "pull_request_review",
        "pull_request_review.changes_requested.trusted",
        "del-r1",
      ),
    );
    (w.ddb.get(`SESSION#${SESSION}`, "META") as { status: string }).status = "idle";
    await handleQueueMessage(w.deps, { kind: "drain", sessionId: SESSION });
    expect(prompts(w)).toHaveLength(1);
    expect(prompts(w)[0].trigger?.deliveryIds).toEqual(["del-c1", "del-r1"]);
    expect(prompts(w)[0].prompt.match(/\[GitHub webhook\]/g)).toHaveLength(2);
  });

  it("autoCloseOnMerge marks the merge wake so the bridge closes the session after the turn", async () => {
    const w = world({ autoCloseOnMerge: "after_turn" });
    await linked(w);
    await processDelivery(w.deps, await w.ingest("pull_request", "pull_request.closed.merged"));
    expect(prompts(w)[0].trigger?.autoClose).toBe(true);

    const w2 = world({ autoCloseOnMerge: "after_turn" });
    await linked(w2);
    await processDelivery(w2.deps, await w2.ingest("pull_request", "pull_request.closed.unmerged"));
    expect(prompts(w2)[0].trigger?.autoClose).toBeUndefined();
  });

  it("fetches a trusted reviewer's inline comments and quotes them", async () => {
    const w = world();
    await linked(w);
    w.github.reviewComments.push({ path: "README.md", line: 3, body: "Rename this heading." });
    await processDelivery(
      w.deps,
      await w.ingest("pull_request_review", "pull_request_review.changes_requested.trusted"),
    );
    expect(prompts(w)[0].prompt).toContain("[inline comment on README.md:3]");
  });

  it("still wakes when the inline comments cannot be fetched", async () => {
    const w = world();
    await linked(w);
    w.deps.github.listReviewComments = async () => {
      throw new Error("rate limited");
    };
    await processDelivery(
      w.deps,
      await w.ingest("pull_request_review", "pull_request_review.changes_requested.trusted"),
    );
    expect(prompts(w)).toHaveLength(1);
  });

  it("defaults the trusted login to the repo owner when none is configured", async () => {
    const w = world({ trustedLogins: [] });
    await linked(w);
    // octocat is not the owner ("octo"), so their text is not quoted.
    await processDelivery(w.deps, await w.ingest("issue_comment", "issue_comment.created.trusted"));
    expect(prompts(w)[0].prompt).not.toContain("update the changelog");
  });
});

describe("processDelivery: check failures are debounced into one wake", () => {
  it("merges a burst, waits out the window, then sends one wake for the batch", async () => {
    const w = world();
    await linked(w);
    await processDelivery(
      w.deps,
      await w.ingest("check_suite", "check_suite.completed.failure", "del-cs"),
    );
    expect(prompts(w)).toEqual([]); // not due yet
    expect(w.githubQueue.sent).toEqual([
      { message: { kind: "drain", sessionId: SESSION }, delaySeconds: 122 },
    ]);

    w.clock.now += 30_000;
    await processDelivery(
      w.deps,
      await w.ingest("workflow_run", "workflow_run.completed.failure", "del-wr"),
    );
    w.clock.now += 20_000;
    await processDelivery(
      w.deps,
      await w.ingest("workflow_run", "workflow_run.completed.timed_out", "del-wr2"),
    );
    expect(prompts(w)).toEqual([]);

    const items = await w.repo.queryInbox(SESSION);
    expect(items).toHaveLength(1);
    expect(items[0].deliveryIds).toEqual(["del-cs", "del-wr", "del-wr2"]);
    expect((items[0].data as { checks: unknown[] }).checks).toHaveLength(3);

    w.clock.now += 100_000; // 150 s after the first failure
    await handleQueueMessage(w.deps, { kind: "drain", sessionId: SESSION });
    expect(prompts(w)).toHaveLength(1);
    const p = prompts(w)[0].prompt;
    expect(p).toContain("GitHub Actions (check suite)");
    expect(p).toContain("CI / build");
    expect(p).toContain("CI / e2e");
    expect(p).toContain("https://github.com/octo/repo/actions/runs/888");
    expect(p.match(/Checks failed/g)).toHaveLength(1);
    expect(prompts(w)[0].trigger?.deliveryIds).toEqual(["del-cs", "del-wr", "del-wr2"]);
  });

  it("the same failure delivered twice is listed once", async () => {
    const w = world();
    await linked(w);
    await processDelivery(
      w.deps,
      await w.ingest("workflow_run", "workflow_run.completed.failure", "del-a"),
    );
    await processDelivery(
      w.deps,
      await w.ingest("workflow_run", "workflow_run.completed.failure", "del-b"),
    );
    const [item] = await w.repo.queryInbox(SESSION);
    expect((item.data as { checks: unknown[] }).checks).toHaveLength(1);
    expect(item.deliveryIds).toEqual(["del-a", "del-b"]);
  });

  it("a failure after the window closes starts a new item", async () => {
    const w = world();
    await linked(w);
    await processDelivery(
      w.deps,
      await w.ingest("workflow_run", "workflow_run.completed.failure", "del-a"),
    );
    w.clock.now += 130_000;
    await processDelivery(
      w.deps,
      await w.ingest("workflow_run", "workflow_run.completed.timed_out", "del-b"),
    );
    expect(prompts(w)).toHaveLength(1); // the first item was due and went out
    expect(await w.repo.queryInbox(SESSION)).toHaveLength(2);
  });

  it("a failure arriving after the batch was delivered does not merge into it", async () => {
    const w = world();
    await linked(w);
    await processDelivery(
      w.deps,
      await w.ingest("workflow_run", "workflow_run.completed.failure", "del-a"),
    );
    w.clock.now += 60_000;
    const [first] = await w.repo.queryInbox(SESSION);
    await w.repo.claimInbox(SESSION, [first.id], "t-1");
    await processDelivery(
      w.deps,
      await w.ingest("workflow_run", "workflow_run.completed.timed_out", "del-b"),
    );
    const items = await w.repo.queryInbox(SESSION);
    expect(items.map((i) => i.status)).toEqual(["delivered", "pending"]);
  });
});

describe("processDelivery: unmatched", () => {
  it("stores a delivery for an unlinked PR as unmatched so it can be linked by hand", async () => {
    const w = world();
    w.seedSession(SESSION);
    const id = await w.ingest("pull_request", "pull_request.closed.merged");
    const out = await processDelivery(w.deps, id);
    expect(out?.status).toBe("unmatched");
    expect(await w.repo.listUnmatched(10)).toMatchObject([
      { deliveryId: id, event: "pull_request", repo: "octo/repo", number: 7, sender: "octocat" },
    ]);
    expect(w.metrics.sum("WebhooksUnmatched")).toBe(1);
    expect(prompts(w)).toEqual([]);
    expect((await w.repo.getDelivery(id))?.status).toBe("unmatched");
  });

  it("ignores a delivery id it does not have (acked, logged)", async () => {
    const w = world();
    expect(await processDelivery(w.deps, "nope")).toBeNull();
  });
});

describe("trailer linking", () => {
  const opened = () => event("pull_request", "pull_request.opened");

  it("links a PR whose body names a live session with the repo in repos[]", async () => {
    const w = world();
    w.seedSession(SESSION);
    await processDelivery(w.deps, await w.ingest("pull_request", "pull_request.opened"));
    expect(await w.repo.getPrLink("octo/repo#7")).toMatchObject({
      sessionId: SESSION,
      linkedBy: "trailer",
      prState: "open",
      headSha: SHA,
    });
    expect(w.metrics.sum("LinksCreated", { method: "trailer" })).toBe(1);
  });

  it("also links on pull_request.edited", async () => {
    const w = world();
    w.seedSession(SESSION);
    await processDelivery(w.deps, await w.ingest("pull_request", "pull_request.edited"));
    expect((await w.repo.getPrLink("octo/repo#7"))?.linkedBy).toBe("trailer");
  });

  it("refuses a forged trailer naming a session that is not found", async () => {
    const w = world();
    await linkFromTrailer(w.deps, opened());
    expect(await w.repo.getPrLink("octo/repo#7")).toBeNull();
    expect(w.metrics.sum("LinksRejected", { reason: "session_not_found" })).toBe(1);
  });

  it("refuses a forged trailer naming someone else's session on a repo outside its repos[]", async () => {
    const w = world();
    w.seedSession(SESSION, { repos: ["acme/private"], createdBy: "another-user" });
    await linkFromTrailer(w.deps, opened());
    expect(await w.repo.getPrLink("octo/repo#7")).toBeNull();
    expect(w.metrics.sum("LinksRejected", { reason: "repo_not_in_session" })).toBe(1);
  });

  it("refuses a deleted session", async () => {
    const w = world();
    w.seedSession(SESSION, { status: "deleted" });
    await linkFromTrailer(w.deps, opened());
    expect(await w.repo.getPrLink("octo/repo#7")).toBeNull();
  });

  it("refuses a PR created before the session", async () => {
    const w = world();
    w.seedSession(SESSION, { createdAt: "2026-02-01T10:30:00.000Z" });
    await linkFromTrailer(w.deps, opened());
    expect(await w.repo.getPrLink("octo/repo#7")).toBeNull();
    expect(w.metrics.sum("LinksRejected", { reason: "created_before_session" })).toBe(1);
  });

  it("with agent logins configured, the PR must be authored by the agent", async () => {
    const w = world({ agentLogins: ["someone-else"] });
    w.seedSession(SESSION);
    await linkFromTrailer(w.deps, opened());
    expect(await w.repo.getPrLink("octo/repo#7")).toBeNull();
    expect(w.metrics.sum("LinksRejected", { reason: "author_not_agent" })).toBe(1);
    const ok = world({ agentLogins: ["kiro-agent[bot]"] });
    ok.seedSession(SESSION);
    await linkFromTrailer(ok.deps, opened());
    expect(await ok.repo.getPrLink("octo/repo#7")).not.toBeNull();
  });

  it("never overwrites an existing link", async () => {
    const w = world();
    await linked(w, "01HZX0000000000000000000S0");
    w.seedSession(SESSION);
    await linkFromTrailer(w.deps, opened());
    expect((await w.repo.getPrLink("octo/repo#7"))?.sessionId).toBe("01HZX0000000000000000000S0");
  });

  it("ignores a body with no trailer, or an ambiguous one", async () => {
    const w = world();
    w.seedSession(SESSION);
    const ev = opened();
    (ev.payload.pull_request as { body: string }).body =
      "Kiro-Remote-Session: AAAAAAAAAA\nKiro-Remote-Session: BBBBBBBBBB";
    await linkFromTrailer(w.deps, ev);
    (ev.payload.pull_request as { body: string }).body = "nothing";
    await linkFromTrailer(w.deps, ev);
    expect(await w.repo.getPrLink("octo/repo#7")).toBeNull();
  });

  it("the PR URL in a payload is not used to guess a link (no branch or title matching)", async () => {
    const w = world();
    w.seedSession(SESSION, { title: "docs: fix typo in README" });
    const ev = opened();
    (ev.payload.pull_request as { body: string }).body = "no trailer";
    await linkFromTrailer(w.deps, ev);
    expect(await w.repo.getPrLink("octo/repo#7")).toBeNull();
  });
});

describe("queue records", () => {
  it("acks malformed records and reports transient failures per record", async () => {
    const w = world();
    const res = await processRecords(w.deps, [
      { messageId: "m1", body: "{nope" },
      { messageId: "m2", body: JSON.stringify({ kind: "mystery" }) },
      { messageId: "m3", body: JSON.stringify({ kind: "delivery", deliveryId: "gone" }) },
    ]);
    expect(res.batchItemFailures).toEqual([]);

    const boom = world();
    boom.deps.repo.getDelivery = async () => {
      throw new Error("ddb throttled");
    };
    const r2 = await processRecords(boom.deps, [
      { messageId: "m9", body: JSON.stringify({ kind: "delivery", deliveryId: "x" }) },
    ]);
    expect(r2.batchItemFailures).toEqual([{ itemIdentifier: "m9" }]);
  });
});

describe("fixtures", () => {
  it("every handled event type has a payload fixture", () => {
    for (const f of [
      "pull_request.opened",
      "pull_request.closed.merged",
      "pull_request_review.changes_requested.trusted",
      "issue_comment.created.trusted",
      "check_suite.completed.failure",
      "workflow_run.completed.failure",
    ]) {
      expect(fixture(f).repository).toBeTruthy();
    }
  });
});
