import { describe, expect, it } from "vitest";
import {
  deriveTurnStatus,
  EVENTS_MAX_WAIT_SECONDS,
  EVENTS_POLL_INTERVAL_MS,
  type EventItem,
  type Principal,
  type Repository,
  readEvents,
  type ServiceDeps,
  type SessionMetaItem,
  SessionNotFoundError,
} from "../src/index.ts";

/** In-memory repository covering what readEvents calls. */
class FakeRepo {
  sessions = new Map<string, SessionMetaItem>();
  events: EventItem[] = [];
  queries = 0;

  async getSession(id: string): Promise<SessionMetaItem | null> {
    return this.sessions.get(id) ?? null;
  }
  async queryEvents(
    sessionId: string,
    after: number,
    opts: { types?: string[] } = {},
  ): Promise<EventItem[]> {
    this.queries++;
    return this.events
      .filter((e) => e.PK === `SESSION#${sessionId}` && e.seq > after)
      .filter((e) => !opts.types || opts.types.includes(e.type))
      .sort((a, b) => a.seq - b.seq);
  }
}

function seedSession(repo: FakeRepo, id: string, patch: Partial<SessionMetaItem> = {}): void {
  repo.sessions.set(id, {
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
    status: "running",
    activeTurnId: null,
    eventSeq: 0,
    createdBy: "user-1",
    createdAt: "t",
    updatedAt: "t",
    version: 0,
    GSI1PK: "USER#user-1",
    GSI1SK: "t",
    ...patch,
  });
}

function addEvent(repo: FakeRepo, sessionId: string, seq: number, type = "message.chunk"): void {
  repo.events.push({
    PK: `SESSION#${sessionId}`,
    SK: `EVT#${String(seq).padStart(12, "0")}`,
    seq,
    turnId: "t1",
    ts: "2024-01-01T00:00:00.000Z",
    type,
    rawType: "agent_message_chunk",
    replay: false,
    payload: { seq },
    ttl: 0,
  });
}

/**
 * Deps with a fake clock: sleep advances the clock instead of waiting, then
 * runs `onSleep` (with the 1-based sleep count) to simulate concurrent writes.
 */
function setup(onSleep?: (n: number, repo: FakeRepo) => void) {
  const repo = new FakeRepo();
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const deps: ServiceDeps = {
    repo: repo as unknown as Repository,
    queue: { enqueue: async () => {} },
    allowedRepos: ["*/*"],
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
      onSleep?.(sleeps.length, repo);
    },
  };
  return { repo, deps, sleeps, elapsed: () => clock - 1_000_000 };
}

const principal: Principal = { sub: "user-1", clientId: "c", scopes: ["sessions:read"] };

describe("readEvents", () => {
  it("returns events already present without sleeping", async () => {
    const { repo, deps, sleeps } = setup();
    seedSession(repo, "s1");
    addEvent(repo, "s1", 1);
    addEvent(repo, "s1", 2);

    const page = await readEvents(deps, principal, "s1", { after: 0, wait: 20 });

    expect(page.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(page.events[0]).toMatchObject({ sessionId: "s1", turnId: "t1", type: "message.chunk" });
    expect(page.nextCursor).toBe(2);
    expect(page.turnStatus).toBe("running");
    expect(sleeps).toEqual([]);
  });

  it("returns as soon as an event arrives mid-wait", async () => {
    const { repo, deps, sleeps, elapsed } = setup((n, r) => {
      if (n === 3) {
        addEvent(r, "s1", 5);
      }
    });
    seedSession(repo, "s1");
    addEvent(repo, "s1", 4);

    const page = await readEvents(deps, principal, "s1", { after: 4, wait: 20 });

    expect(page.events.map((e) => e.seq)).toEqual([5]);
    expect(page.nextCursor).toBe(5);
    expect(sleeps).toEqual([1000, 1000, 1000]);
    expect(elapsed()).toBe(3 * EVENTS_POLL_INTERVAL_MS);
  });

  it("times out with an empty page and an unchanged cursor", async () => {
    const { repo, deps, sleeps, elapsed } = setup();
    seedSession(repo, "s1", { status: "idle" });
    addEvent(repo, "s1", 7);

    const page = await readEvents(deps, principal, "s1", { after: 7, wait: 3 });

    expect(page).toEqual({ events: [], nextCursor: 7, turnStatus: "idle" });
    expect(sleeps).toEqual([1000, 1000, 1000]);
    expect(elapsed()).toBe(3000);
    // One read per sleep plus the first and the final read at the deadline.
    expect(repo.queries).toBe(4);
  });

  it("does a single read when wait=0", async () => {
    const { repo, deps, sleeps } = setup();
    seedSession(repo, "s1");

    const page = await readEvents(deps, principal, "s1", { after: 0, wait: 0 });

    expect(page).toEqual({ events: [], nextCursor: 0, turnStatus: "running" });
    expect(sleeps).toEqual([]);
    expect(repo.queries).toBe(1);
  });

  it("throws SessionNotFoundError when the session is deleted mid-wait", async () => {
    const { repo, deps } = setup((n, r) => {
      if (n === 2) {
        seedSession(r, "s1", { status: "deleted" });
      }
    });
    seedSession(repo, "s1");

    await expect(readEvents(deps, principal, "s1", { after: 0, wait: 20 })).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });

  it("reports the current turnStatus after the session changes mid-wait", async () => {
    const { repo, deps } = setup((n, r) => {
      if (n === 1) {
        seedSession(r, "s1", { status: "awaiting_permission" });
        addEvent(r, "s1", 1);
      }
    });
    seedSession(repo, "s1", { status: "provisioning" });

    const page = await readEvents(deps, principal, "s1", { after: 0, wait: 20 });

    expect(page.turnStatus).toBe("awaiting_permission");
  });

  it("hides another user's session as 404", async () => {
    const { repo, deps } = setup();
    seedSession(repo, "s1", { createdBy: "someone-else" });

    await expect(readEvents(deps, principal, "s1", { after: 0, wait: 0 })).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });

  it("clamps wait to EVENTS_MAX_WAIT_SECONDS", async () => {
    const { repo, deps, elapsed } = setup();
    seedSession(repo, "s1");

    await readEvents(deps, principal, "s1", { after: 0, wait: 600 });

    expect(elapsed()).toBe(EVENTS_MAX_WAIT_SECONDS * 1000);
  });

  it("stops at the iteration bound even if the clock never advances", async () => {
    const repo = new FakeRepo();
    seedSession(repo, "s1");
    let slept = 0;
    const deps: ServiceDeps = {
      repo: repo as unknown as Repository,
      queue: { enqueue: async () => {} },
      allowedRepos: ["*/*"],
      now: () => 1_000_000,
      sleep: async () => {
        slept++;
      },
    };

    const page = await readEvents(deps, principal, "s1", { after: 0, wait: 2 });

    expect(page.events).toEqual([]);
    expect(slept).toBe(2);
  });

  it("keeps waiting for events matching the types filter", async () => {
    const { repo, deps, sleeps } = setup((n, r) => {
      if (n === 1) {
        addEvent(r, "s1", 2, "tool.call");
      }
      if (n === 2) {
        addEvent(r, "s1", 3, "turn.completed");
      }
    });
    seedSession(repo, "s1");
    addEvent(repo, "s1", 1, "message.chunk");

    const page = await readEvents(deps, principal, "s1", {
      after: 0,
      wait: 20,
      types: ["turn.completed"],
    });

    expect(page.events.map((e) => e.seq)).toEqual([3]);
    expect(sleeps).toHaveLength(2);
  });
});

describe("deriveTurnStatus", () => {
  it("passes through live statuses and maps the rest to null", () => {
    for (const s of ["running", "awaiting_permission", "idle", "provisioning"]) {
      expect(deriveTurnStatus(s)).toBe(s);
    }
    expect(deriveTurnStatus("failed")).toBeNull();
    expect(deriveTurnStatus("deleted")).toBeNull();
  });
});
