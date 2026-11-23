import { describe, expect, it } from "vitest";
import {
  GithubNotEnabledError,
  type GithubQueue,
  type GithubQueueMessage,
  getSession,
  isGithubQueueMessage,
  MAX_WAIT_TRAILERS,
  type Principal,
  parseTrailer,
  parseWaitTrailers,
  prKeyOf,
  RepoNotAllowedError,
  type ServiceDeps,
  SessionNotFoundError,
  stopWaitingForPullRequest,
  trailerInstruction,
  waitForPullRequest,
} from "../src/index.ts";
import { memoryRepository, sessionItem } from "../src/testing/memory-ddb.ts";

const P: Principal = {
  sub: "user-sub-1",
  scopes: ["sessions:read", "sessions:write", "sessions:delete"],
} as Principal;

class RecordingQueue implements GithubQueue {
  sent: GithubQueueMessage[] = [];
  fail = false;
  async send(message: GithubQueueMessage): Promise<void> {
    if (this.fail) {
      throw new Error("sqs down");
    }
    this.sent.push(message);
  }
}

async function setup(over: Partial<ServiceDeps> = {}) {
  const { repo, ddb } = await memoryRepository();
  ddb.put(sessionItem("S1"));
  ddb.put(sessionItem("S2"));
  const githubQueue = new RecordingQueue();
  const deps = {
    repo,
    queue: { enqueue: async () => {} },
    allowedRepos: ["octo/*", "ark/*"],
    githubQueue,
    ...over,
  } as unknown as ServiceDeps;
  return { repo, ddb, deps, githubQueue };
}

describe("Kiro-Remote-Waits-For trailer parsing", () => {
  it("reads one PR per line, distinct, in order, lower-casing the key", () => {
    const body =
      "Stacked.\n\nKiro-Remote-Session: 01HZX0000000000000000000AB\nKiro-Remote-Waits-For: nikovirtala/draft#43\nKiro-Remote-Waits-For:   Octo/Repo#41  \r\nKiro-Remote-Waits-For: nikovirtala/draft#43\n";
    expect(parseWaitTrailers(body).map(prKeyOf)).toEqual(["nikovirtala/draft#43", "octo/repo#41"]);
  });

  it("accepts a PR URL too", () => {
    expect(
      parseWaitTrailers("Kiro-Remote-Waits-For: https://github.com/octo/repo/pull/5").map(prKeyOf),
    ).toEqual(["octo/repo#5"]);
  });

  it("ignores malformed lines without failing the others", () => {
    const body = [
      "Kiro-Remote-Waits-For: nope",
      "Kiro-Remote-Waits-For:",
      "Kiro-Remote-Waits-For: octo/repo#0",
      "Kiro-Remote-Waits-For: octo/repo#12x",
      "Kiro-Remote-Waits-For: octo/repo#9 and more",
      "  Kiro-Remote-Waits-For: octo/repo#10",
      "see Kiro-Remote-Waits-For: octo/repo#11",
      "kiro-remote-waits-for: octo/repo#13",
      "Kiro-Remote-Waits-For: octo/repo#3",
    ].join("\n");
    expect(parseWaitTrailers(body).map(prKeyOf)).toEqual(["octo/repo#3"]);
  });

  it("gives nothing for no body, and caps what one body can register", () => {
    expect(parseWaitTrailers(null)).toEqual([]);
    expect(parseWaitTrailers("")).toEqual([]);
    const many = Array.from({ length: 50 }, (_, i) => `Kiro-Remote-Waits-For: octo/repo#${i + 1}`);
    expect(parseWaitTrailers(many.join("\n"))).toHaveLength(MAX_WAIT_TRAILERS);
  });

  it("does not disturb the session trailer", () => {
    const body =
      "Kiro-Remote-Session: 01HZX0000000000000000000AB\nKiro-Remote-Waits-For: octo/repo#3";
    expect(parseTrailer(body)).toBe("01HZX0000000000000000000AB");
  });

  it("the launch prompt line asks for both, and still ends with the session trailer", () => {
    const line = trailerInstruction("S1ABCDEFGH");
    expect(line).toContain("Kiro-Remote-Waits-For: owner/repo#number");
    expect(line.endsWith("Kiro-Remote-Session: S1ABCDEFGH")).toBe(true);
    expect(line).not.toContain("\n");
  });
});

describe("waits in the repository", () => {
  it("stores one item per wait with the session on the table key and the PR on GSI1", async () => {
    const { repo, ddb } = await setup();
    const a = await repo.createWait({ sessionId: "S1", pr: "octo/repo#7", source: "mcp" });
    expect(a.created).toBe(true);
    expect(ddb.get("SESSION#S1", "WAIT#octo/repo#7")).toMatchObject({
      sessionId: "S1",
      pr: "octo/repo#7",
      repo: "octo/repo",
      number: 7,
      source: "mcp",
      GSI1PK: "GHWAIT#octo/repo#7",
      GSI1SK: "S1",
    });
  });

  it("registering twice is a no-op that keeps the first source and time", async () => {
    const { repo } = await setup();
    const first = await repo.createWait({ sessionId: "S1", pr: "octo/repo#7", source: "mcp" });
    const second = await repo.createWait({ sessionId: "S1", pr: "octo/repo#7", source: "rest" });
    expect(second.created).toBe(false);
    expect(second.wait).toEqual(first.wait);
    expect(await repo.queryWaits("S1")).toHaveLength(1);
  });

  it("lists the waits of a session and the sessions waiting for a PR, many to many", async () => {
    const { repo } = await setup();
    await repo.createWait({ sessionId: "S1", pr: "octo/repo#7", source: "mcp" });
    await repo.createWait({ sessionId: "S1", pr: "ark/ark#2", source: "trailer" });
    await repo.createWait({ sessionId: "S2", pr: "octo/repo#7", source: "rest" });
    expect((await repo.queryWaits("S1")).map((w) => w.pr)).toEqual(["ark/ark#2", "octo/repo#7"]);
    expect((await repo.queryWaiters("octo/repo#7")).map((w) => w.sessionId)).toEqual(["S1", "S2"]);
    expect((await repo.queryWaiters("ark/ark#2")).map((w) => w.sessionId)).toEqual(["S1"]);
    expect(await repo.queryWaiters("octo/repo#8")).toEqual([]);
  });

  it("a wait is not a link: it does not show in the session's links or its repo's open links", async () => {
    const { repo } = await setup();
    await repo.createWait({ sessionId: "S1", pr: "octo/repo#7", source: "mcp" });
    expect(await repo.queryLinks("S1")).toEqual([]);
    expect(await repo.queryOpenLinks("octo/repo")).toEqual([]);
    expect(await repo.getPrLink("octo/repo#7")).toBeNull();
  });

  it("deleteWait is true for exactly one of two racing callers", async () => {
    const { repo } = await setup();
    await repo.createWait({ sessionId: "S1", pr: "octo/repo#7", source: "mcp" });
    const results = await Promise.all([
      repo.deleteWait("S1", "octo/repo#7"),
      repo.deleteWait("S1", "octo/repo#7"),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(await repo.queryWaiters("octo/repo#7")).toEqual([]);
  });

  it("setInboxNotBefore moves only a pending item", async () => {
    const { repo } = await setup();
    expect(await repo.setInboxNotBefore("S1", "missing", "2026-01-01T00:00:00.000Z")).toBe(false);
  });
});

describe("waitForPullRequest / stopWaitingForPullRequest (service)", () => {
  it("stores the wait and asks the GitHub consumer to read the PR once", async () => {
    const { deps, repo, githubQueue } = await setup();
    const out = await waitForPullRequest(deps, P, "S1", "Octo/Repo#7", "mcp");
    expect(out.created).toBe(true);
    expect(out.wait).toMatchObject({
      pr: "octo/repo#7",
      repo: "octo/repo",
      number: 7,
      source: "mcp",
    });
    expect(githubQueue.sent).toEqual([{ kind: "wait_check", sessionId: "S1", pr: "octo/repo#7" }]);
    expect(await repo.queryWaits("S1")).toHaveLength(1);
  });

  it("registering twice is a no-op: 200-style result, no second read", async () => {
    const { deps, githubQueue } = await setup();
    await waitForPullRequest(deps, P, "S1", "octo/repo#7", "mcp");
    const again = await waitForPullRequest(
      deps,
      P,
      "S1",
      "https://github.com/octo/repo/pull/7",
      "rest",
    );
    expect(again.created).toBe(false);
    expect(again.wait.source).toBe("mcp");
    expect(githubQueue.sent).toHaveLength(1);
  });

  it("the awaited repo only has to match ALLOWED_REPOS, not the session's repos", async () => {
    const { deps } = await setup();
    // S1 is on octo/repo only; ark/ark is allowed but not one of its repos.
    const out = await waitForPullRequest(deps, P, "S1", "ark/ark#2", "mcp");
    expect(out.created).toBe(true);
    await expect(waitForPullRequest(deps, P, "S1", "evil/repo#1", "mcp")).rejects.toBeInstanceOf(
      RepoNotAllowedError,
    );
  });

  it("many sessions may wait for one PR", async () => {
    const { deps, repo } = await setup();
    await waitForPullRequest(deps, P, "S1", "octo/repo#7", "mcp");
    await waitForPullRequest(deps, P, "S2", "octo/repo#7", "rest");
    expect(await repo.queryWaiters("octo/repo#7")).toHaveLength(2);
  });

  it("refuses a reference that is not a PR, a missing scope, a stranger's session", async () => {
    const { deps } = await setup();
    await expect(waitForPullRequest(deps, P, "S1", "nope", "mcp")).rejects.toThrow(/invalid/);
    await expect(
      waitForPullRequest(
        deps,
        { sub: "user-sub-1", scopes: ["sessions:read"] } as Principal,
        "S1",
        "octo/repo#7",
        "mcp",
      ),
    ).rejects.toThrow();
    await expect(
      waitForPullRequest(
        deps,
        { ...P, sub: "someone-else" } as Principal,
        "S1",
        "octo/repo#7",
        "mcp",
      ),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it("is refused where the GitHub feature is not deployed", async () => {
    const { deps } = await setup({ githubQueue: undefined });
    await expect(waitForPullRequest(deps, P, "S1", "octo/repo#7", "mcp")).rejects.toBeInstanceOf(
      GithubNotEnabledError,
    );
  });

  it("leaves no wait behind when the read cannot be requested", async () => {
    const { deps, repo, githubQueue } = await setup();
    githubQueue.fail = true;
    await expect(waitForPullRequest(deps, P, "S1", "octo/repo#7", "mcp")).rejects.toThrow(
      "sqs down",
    );
    expect(await repo.queryWaits("S1")).toEqual([]);
  });

  it("stops waiting, including after the session was deleted", async () => {
    const { deps, ddb } = await setup();
    await waitForPullRequest(deps, P, "S1", "octo/repo#7", "mcp");
    (ddb.get("SESSION#S1", "META") as { status: string }).status = "deleted";
    await stopWaitingForPullRequest(deps, P, "S1", "octo/repo#7");
    await expect(stopWaitingForPullRequest(deps, P, "S1", "octo/repo#7")).rejects.toThrow(
      /not waiting/,
    );
  });

  it("getSession lists the waits next to the links", async () => {
    const { deps } = await setup();
    await waitForPullRequest(deps, P, "S1", "ark/ark#2", "rest");
    const view = await getSession(deps, P, "S1");
    expect(view.waits).toMatchObject([{ pr: "ark/ark#2", source: "rest" }]);
    expect(view.links).toEqual([]);
    expect((await getSession(deps, P, "S2")).waits).toEqual([]);
  });
});

describe("wait_check queue message guard", () => {
  it("accepts a well-formed message and rejects the rest", () => {
    expect(isGithubQueueMessage({ kind: "wait_check", sessionId: "S1", pr: "octo/repo#7" })).toBe(
      true,
    );
    expect(isGithubQueueMessage({ kind: "wait_check", sessionId: "S1" })).toBe(false);
    expect(isGithubQueueMessage({ kind: "wait_check", sessionId: "S1", pr: "nonsense" })).toBe(
      false,
    );
  });
});
