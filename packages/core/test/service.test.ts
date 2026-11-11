import { describe, expect, it } from "vitest";
import {
  answerPermission,
  type Command,
  type CommandQueue,
  ConcurrencyLimitError,
  ConcurrentModificationError,
  cancelTurn,
  deleteSession,
  InvalidStateError,
  launchSession,
  MAX_CLOUD_SESSIONS,
  type Principal,
  RepoNotAllowedError,
  type Repository,
  type ServiceDeps,
  type SessionMetaItem,
  SessionNotFoundError,
  sendPrompt,
  setConfig,
  steer,
} from "../src/index.ts";

/** Minimal in-memory repository covering only what the service calls. */
class FakeRepo {
  sessions = new Map<string, SessionMetaItem>();
  perms = new Map<string, { status: string; options: unknown[] }>();

  async putSession(item: SessionMetaItem): Promise<void> {
    this.sessions.set(item.id, item);
  }
  async getSession(id: string): Promise<SessionMetaItem | null> {
    return this.sessions.get(id) ?? null;
  }
  async listSessionsByUser(
    sub: string,
    opts: { limit: number },
  ): Promise<{ items: SessionMetaItem[] }> {
    const items = [...this.sessions.values()]
      .filter((s) => s.createdBy === sub)
      .slice(0, opts.limit);
    return { items };
  }
  async updateSession(id: string, expectedVersion: number): Promise<void> {
    const s = this.sessions.get(id);
    if (!s || s.version !== expectedVersion) {
      throw new ConcurrentModificationError();
    }
    s.version += 1;
  }
  async queryLinks(): Promise<never[]> {
    return [];
  }
  async getPermission(_sessionId: string, requestId: string) {
    return this.perms.get(requestId) ?? null;
  }
}

class FakeQueue implements CommandQueue {
  commands: Command[] = [];
  async enqueue(command: Command): Promise<void> {
    this.commands.push(command);
  }
}

function deps(over: Partial<ServiceDeps> = {}): {
  d: ServiceDeps;
  repo: FakeRepo;
  queue: FakeQueue;
} {
  const repo = new FakeRepo();
  const queue = new FakeQueue();
  let counter = 0;
  const d: ServiceDeps = {
    repo: repo as unknown as Repository,
    queue,
    allowedRepos: ["acme/*", "me/repo"],
    now: () => 1_000_000,
    newId: () => `id-${++counter}`,
    ...over,
  };
  return { d, repo, queue };
}

const principal: Principal = { sub: "user-1", clientId: "c", scopes: ["sessions:write"] };

function seed(repo: FakeRepo, id: string, patch: Partial<SessionMetaItem> = {}): SessionMetaItem {
  const item: SessionMetaItem = {
    PK: `SESSION#${id}`,
    SK: "META",
    id,
    kiroSessionId: null,
    title: null,
    repos: ["acme/x"],
    agent: null,
    mode: null,
    model: null,
    effort: null,
    status: "idle",
    activeTurnId: null,
    eventSeq: 0,
    createdBy: "user-1",
    createdAt: "t",
    updatedAt: "t",
    version: 0,
    GSI1PK: "USER#user-1",
    GSI1SK: "t",
    ...patch,
  };
  repo.sessions.set(id, item);
  return item;
}

describe("launchSession: the PR trailer", () => {
  it("with prTrailer on, the launch prompt asks the agent to put the session trailer in the PR body", async () => {
    const { d, queue } = deps({ prTrailer: "on" });
    const view = await launchSession(d, principal, { prompt: "fix the typo", repos: ["acme/web"] });
    const cmd = queue.commands[0] as { prompt: string };
    expect(cmd.prompt.startsWith("fix the typo\n\n")).toBe(true);
    expect(cmd.prompt).toContain(`Kiro-Remote-Session: ${view.id}`);
    // The line is appended once, after the user's own prompt.
    expect(cmd.prompt.match(/Kiro-Remote-Session:/g)).toHaveLength(1);
  });

  it("with prTrailer off or absent, the prompt is passed through untouched", async () => {
    for (const over of [{ prTrailer: "off" as const }, {}]) {
      const { d, queue } = deps(over);
      await launchSession(d, principal, { prompt: "fix the typo", repos: ["acme/web"] });
      expect((queue.commands[0] as { prompt: string }).prompt).toBe("fix the typo");
    }
  });
});

describe("launchSession", () => {
  it("creates a provisioning session and enqueues a launch command", async () => {
    const { d, repo, queue } = deps();
    const view = await launchSession(d, principal, { prompt: "hi", repos: ["acme/web"] });
    expect(view.status).toBe("provisioning");
    expect(repo.sessions.size).toBe(1);
    expect(queue.commands[0].kind).toBe("launch");
  });

  it("throws RepoNotAllowedError (403) for a repo outside the allow-list", async () => {
    const { d } = deps();
    await expect(
      launchSession(d, principal, { prompt: "hi", repos: ["evil/repo"] }),
    ).rejects.toBeInstanceOf(RepoNotAllowedError);
  });

  it("allows exact and glob allow-list matches", async () => {
    const { d } = deps();
    await expect(
      launchSession(d, principal, { prompt: "hi", repos: ["acme/anything", "me/repo"] }),
    ).resolves.toBeDefined();
  });

  it("throws ConcurrencyLimitError (429) at the session cap", async () => {
    const { d, repo } = deps();
    for (let i = 0; i < MAX_CLOUD_SESSIONS; i++) {
      seed(repo, `s${i}`, { status: "running" });
    }
    await expect(
      launchSession(d, principal, { prompt: "hi", repos: ["acme/web"] }),
    ).rejects.toBeInstanceOf(ConcurrencyLimitError);
  });

  it("counts only the caller's own active sessions toward the cap", async () => {
    const { d, repo } = deps();
    for (let i = 0; i < MAX_CLOUD_SESSIONS; i++) {
      seed(repo, `other${i}`, {
        status: "running",
        createdBy: "other-user",
        GSI1PK: "USER#other-user",
      });
    }
    await expect(
      launchSession(d, principal, { prompt: "hi", repos: ["acme/web"] }),
    ).resolves.toBeDefined();
  });
});

describe("sendPrompt / steer / cancel / config / delete", () => {
  it("enqueues a prompt and returns a running turn when idle", async () => {
    const { d, repo, queue } = deps();
    seed(repo, "s1");
    const turn = await sendPrompt(d, principal, "s1", { prompt: "go", whenBusy: "steer" });
    expect(turn.status).toBe("running");
    expect(queue.commands[0].kind).toBe("prompt");
  });

  it("reports a queued turn when busy with whenBusy=queue", async () => {
    const { d, repo } = deps();
    seed(repo, "s1", { status: "running" });
    const turn = await sendPrompt(d, principal, "s1", { prompt: "go", whenBusy: "queue" });
    expect(turn.status).toBe("queued");
  });

  it("rejects a prompt when busy with whenBusy=reject (409)", async () => {
    const { d, repo } = deps();
    seed(repo, "s1", { status: "running" });
    await expect(
      sendPrompt(d, principal, "s1", { prompt: "go", whenBusy: "reject" }),
    ).rejects.toBeInstanceOf(InvalidStateError);
  });

  it("enqueues steer/cancel/config/delete commands", async () => {
    const { d, repo, queue } = deps();
    seed(repo, "s1");
    await steer(d, principal, "s1", "more context");
    await cancelTurn(d, principal, "s1");
    await setConfig(d, principal, "s1", { model: "claude-sonnet" });
    await deleteSession(d, { ...principal, scopes: ["sessions:delete"] }, "s1");
    expect(queue.commands.map((c) => c.kind)).toEqual(["steer", "cancel", "setConfig", "delete"]);
  });

  it("hides other users' sessions as 404", async () => {
    const { d, repo } = deps();
    seed(repo, "s1", { createdBy: "someone-else" });
    await expect(
      sendPrompt(d, principal, "s1", { prompt: "x", whenBusy: "steer" }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});

describe("answerPermission", () => {
  it("rejects an optionId the agent did not offer", async () => {
    const { d, repo } = deps();
    seed(repo, "s1", { status: "awaiting_permission" });
    repo.perms.set("req-1", {
      status: "pending",
      options: [{ optionId: "accept" }, { optionId: "reject" }],
    });
    await expect(
      answerPermission(d, principal, "s1", "req-1", { optionId: "ghost" }),
    ).rejects.toBeInstanceOf(InvalidStateError);
  });

  it("accepts an offered optionId with persistent consent and enqueues it", async () => {
    const { d, repo, queue } = deps();
    seed(repo, "s1", { status: "awaiting_permission" });
    repo.perms.set("req-1", {
      status: "pending",
      options: [{ optionId: "always-accept" }],
    });
    await answerPermission(d, principal, "s1", "req-1", {
      optionId: "always-accept",
      consent: { scope: "workspace", resource: "npm run *", workspaceRoot: "/w" },
    });
    const cmd = queue.commands[0];
    expect(cmd.kind).toBe("answerPermission");
    if (cmd.kind === "answerPermission") {
      expect(cmd.optionId).toBe("always-accept");
      expect(cmd.consent).toEqual({
        scope: "workspace",
        resource: "npm run *",
        workspaceRoot: "/w",
      });
    }
  });

  it("rejects answering a non-pending permission", async () => {
    const { d, repo } = deps();
    seed(repo, "s1", { status: "idle" });
    repo.perms.set("req-1", { status: "answered", options: [{ optionId: "accept" }] });
    await expect(
      answerPermission(d, principal, "s1", "req-1", { optionId: "accept" }),
    ).rejects.toBeInstanceOf(InvalidStateError);
  });
});
