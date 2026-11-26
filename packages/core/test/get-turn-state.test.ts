import { describe, expect, it } from "vitest";
import {
  getTurnState,
  type Principal,
  type QueuedPromptItem,
  queuedPromptTurnStatus,
  type Repository,
  type ServiceDeps,
  type SessionMetaItem,
  type TurnItem,
} from "../src/index.ts";

const P: Principal = { sub: "u1", clientId: "c", scopes: ["sessions:read"] };

/** What getTurnState reads from the repository. */
class FakeRepo {
  session: Partial<SessionMetaItem> | null = { id: "s1", createdBy: "u1", status: "running" };
  turn: Partial<TurnItem> | null = null;
  queued: Partial<QueuedPromptItem> | null = null;
  async getSession() {
    return this.session;
  }
  async getTurn() {
    return this.turn;
  }
  async getQueuedPrompt() {
    return this.queued;
  }
}

const read = (repo: FakeRepo, who: Principal = P) =>
  getTurnState({ repo: repo as unknown as Repository } as ServiceDeps, who, "s1", "t1");

const turn = (status: TurnItem["status"], stopReason: string | null = null): Partial<TurnItem> => ({
  id: "t1",
  sessionId: "s1",
  status,
  stopReason,
  startedAt: "2026-11-26T12:00:00.000Z",
  endedAt: null,
});

describe("getTurnState", () => {
  it("reads the turn row", async () => {
    const repo = new FakeRepo();
    repo.turn = turn("running");
    expect(await read(repo)).toMatchObject({
      id: "t1",
      status: "running",
      trigger: { source: "user", deliveryIds: [] },
    });
  });

  it("falls back to the queued prompt while there is no turn row", async () => {
    const repo = new FakeRepo();
    repo.queued = { id: "t1", sessionId: "s1", status: "queued", failReason: null, failedAt: null };
    expect(await read(repo)).toMatchObject({ status: "queued", stopReason: null });
    repo.queued = {
      id: "t1",
      sessionId: "s1",
      status: "failed",
      failReason: "not_sent",
      failedAt: "2026-11-26T12:00:05.000Z",
    };
    expect(await read(repo)).toMatchObject({
      status: "failed",
      stopReason: "not_sent",
      endedAt: "2026-11-26T12:00:05.000Z",
    });
  });

  it("maps a queued prompt's status to the turn status it reports", () => {
    expect(queuedPromptTurnStatus({ status: "queued" })).toBe("queued");
    expect(queuedPromptTurnStatus({ status: "delivered" })).toBe("queued");
    expect(queuedPromptTurnStatus({ status: "started" })).toBe("running");
    expect(queuedPromptTurnStatus({ status: "failed" })).toBe("failed");
  });

  it("is null for a missing turn, a missing session and another user's session alike", async () => {
    const repo = new FakeRepo();
    expect(await read(repo)).toBeNull();
    repo.turn = turn("completed");
    expect(await read(repo, { ...P, sub: "u2" })).toBeNull();
    repo.session = null;
    expect(await read(repo)).toBeNull();
  });

  it("needs sessions:read", async () => {
    const repo = new FakeRepo();
    repo.turn = turn("completed");
    await expect(read(repo, { ...P, scopes: ["sessions:write"] })).rejects.toMatchObject({
      name: "ForbiddenError",
    });
  });

  it("reports a deleted session's unsettled and completed turns as session_deleted, others as stored", async () => {
    const repo = new FakeRepo();
    repo.session = { id: "s1", createdBy: "u1", status: "deleted" };
    for (const status of ["queued", "running", "completed"] as const) {
      repo.turn = turn(status);
      expect(await read(repo)).toMatchObject({ status: "failed", stopReason: "session_deleted" });
    }
    repo.turn = turn("failed", "error");
    expect(await read(repo)).toMatchObject({ status: "failed", stopReason: "error" });
    repo.turn = turn("cancelled");
    expect(await read(repo)).toMatchObject({ status: "cancelled" });
  });
});
