/**
 * The in-process client calls the core service + repository directly (no
 * self-HTTP): writes enqueue a command, reads come from the repo, and
 * authorize() runs with the caller's own scopes.
 */

import { describe, expect, it } from "vitest";
import { buildInProcess, principal } from "./helpers.ts";

describe("InProcessClient (direct core service)", () => {
  it("launchSession enqueues a launch command and returns the new id", async () => {
    const h = buildInProcess({ ids: ["sess-1", "cmd-1"] });
    const res = await h.client.launchSession(principal(), {
      prompt: "do it",
      repos: ["acme/app"],
    });
    expect(res.sessionId).toBe("sess-1");
    expect(h.queue.commands).toHaveLength(1);
    expect(h.queue.commands[0]).toMatchObject({ kind: "launch", sub: "user-1" });
  });

  it("getEvents reads rows from the repo and derives nextCursor + turnStatus", async () => {
    const h = buildInProcess();
    const id = h.seedSession({ id: "s1", status: "running" });
    h.seedEvent(id, 1, { payload: { content: { type: "text", text: "a" } } });
    h.seedEvent(id, 2, { payload: { content: { type: "text", text: "b" } } });
    const page = await h.client.getEvents(principal(), id, { after: 0, wait: 0 });
    expect(page.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(page.nextCursor).toBe(2);
    expect(page.turnStatus).toBe("running");
  });

  it("getEvents long-polls up to wait for the first event", async () => {
    let sleeps = 0;
    const h = buildInProcess({
      sleep: async () => {
        sleeps++;
        if (sleeps === 3) {
          h.seedEvent("s1", 6);
        }
      },
    });
    h.seedSession({ id: "s1", status: "running" });
    h.seedEvent("s1", 5);
    const page = await h.client.getEvents(principal(), "s1", { after: 5, wait: 20 });
    expect(page.events.map((e) => e.seq)).toEqual([6]);
    expect(page.nextCursor).toBe(6);
    expect(sleeps).toBe(3);
  });

  it("listPermissions filters by pending status", async () => {
    const h = buildInProcess();
    const id = h.seedSession({ id: "s1" });
    h.seedPermission(id, "r1", { status: "pending" });
    h.seedPermission(id, "r2", { status: "answered" });
    const res = await h.client.listPermissions(principal(), id, { status: "pending" });
    expect(res.permissions.map((p) => p.requestId)).toEqual(["r1"]);
  });

  it("capabilities surfaces the normalized caps + cli version + active count", async () => {
    const h = buildInProcess({ kiroCliVersion: "9.9.9" });
    h.seedSession({ id: "s1", status: "running" });
    const caps = await h.client.capabilities(principal());
    expect(caps.kiroCliVersion).toBe("9.9.9");
    expect(caps.activeSessionCount).toBe(1);
  });

  it("enforces ownership: another user cannot read the session", async () => {
    const h = buildInProcess();
    h.seedSession({ id: "s1", createdBy: "user-1" });
    await expect(h.client.getSession(principal({ sub: "intruder" }), "s1")).rejects.toThrow(
      /session not found/,
    );
  });

  it("never sends the bearer token into enqueued commands", async () => {
    const h = buildInProcess({ ids: ["sess-x", "cmd-x"] });
    await h.client.launchSession(principal(), { prompt: "p", repos: ["acme/app"] });
    const serialized = JSON.stringify(h.queue.commands);
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("tok");
  });
});

describe("InProcessClient: waits", () => {
  it("waitForPullRequest stores the wait as source mcp and asks for one read", async () => {
    const h = buildInProcess();
    const id = h.seedSession({ id: "s1" });
    const wait = await h.client.waitForPullRequest(principal(), id, { pr: "other/repo#43" });
    expect(wait).toMatchObject({
      pr: "other/repo#43",
      repo: "other/repo",
      number: 43,
      source: "mcp",
    });
    expect(h.githubSent).toEqual([{ kind: "wait_check", sessionId: "s1", pr: "other/repo#43" }]);
    // The PR is in a repo the session does not use; getSession lists it.
    const session = await h.client.getSession(principal(), id);
    expect(session.waits).toMatchObject([{ pr: "other/repo#43", source: "mcp" }]);
  });

  it("an idempotencyKey replays the first answer and sends one read", async () => {
    const h = buildInProcess();
    const id = h.seedSession({ id: "s1" });
    const args = { pr: "other/repo#43" };
    const a = await h.client.waitForPullRequest(principal(), id, args, { idempotencyKey: "k-1" });
    const b = await h.client.waitForPullRequest(principal(), id, args, { idempotencyKey: "k-1" });
    expect(b).toEqual(a);
    expect(h.githubSent).toHaveLength(1);
  });

  it("stopWaitingForPullRequest removes it", async () => {
    const h = buildInProcess();
    const id = h.seedSession({ id: "s1" });
    await h.client.waitForPullRequest(principal(), id, { pr: "other/repo#43" });
    await h.client.stopWaitingForPullRequest(principal(), id, { pr: "other/repo#43" });
    expect((await h.client.getSession(principal(), id)).waits).toEqual([]);
  });

  it("is refused without the GitHub feature, and for another user's session", async () => {
    const off = buildInProcess({ noGithubQueue: true });
    const id = off.seedSession({ id: "s1" });
    await expect(
      off.client.waitForPullRequest(principal(), id, { pr: "other/repo#43" }),
    ).rejects.toThrow(/not enabled/);
    const h = buildInProcess();
    h.seedSession({ id: "s2", createdBy: "user-1" });
    await expect(
      h.client.waitForPullRequest(principal({ sub: "intruder" }), "s2", { pr: "o/r#1" }),
    ).rejects.toThrow(/session not found/);
  });
});

describe("InProcessClient: the change feed", () => {
  it("lists what the caller changed over MCP, with the source mcp, and nothing of another account", async () => {
    const h = buildInProcess();
    const id = h.seedSession({ id: "s1" });
    await h.client.waitForPullRequest(principal(), id, { pr: "other/repo#43" });
    await h.client.stopWaitingForPullRequest(principal(), id, { pr: "other/repo#43" });
    const page = await h.client.listFeedEvents(principal(), { after: 0, limit: 10 });
    expect(page.events.map((e) => [e.type, e.source])).toEqual([
      ["wait.registered", "mcp"],
      ["wait.removed", "mcp"],
    ]);
    expect(page.nextCursor).toBe(2);
    const other = await h.client.listFeedEvents(principal({ sub: "intruder" }), {
      after: 0,
      limit: 10,
    });
    expect(other.events).toEqual([]);
  });
});
