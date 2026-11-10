import { describe, expect, it } from "vitest";
import { type EventLike, type EventPage, waitForTurn } from "./settle.ts";

function ev(seq: number, type: string, turnId: string | null = "t1", payload: unknown = {}) {
  return { seq, type, turnId, payload } satisfies EventLike;
}

function page(events: EventLike[], turnStatus: string | null, truncated = false): EventPage {
  return { events, nextCursor: events.at(-1)?.seq ?? 0, turnStatus, truncated };
}

/** A scripted reader over a fake clock; the last page repeats once the script runs out. */
function scripted(pages: EventPage[]) {
  let t = 0;
  const afters: number[] = [];
  let i = 0;
  return {
    afters,
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    read: async (after: number) => {
      afters.push(after);
      t += 100;
      const p = pages[Math.min(i, pages.length - 1)];
      i++;
      return p;
    },
  };
}

describe("waitForTurn", () => {
  it("settles a launch after running, a chunk, and idle, accumulating text", async () => {
    const s = scripted([
      page([], "running"),
      page([ev(1, "message.chunk", "t1", { content: { text: "hel" } })], "running"),
      page([ev(2, "message.chunk", "t1", { text: "lo" })], "running"),
      page([ev(3, "turn.completed")], "idle"),
    ]);
    const res = await waitForTurn({ after: 0, timeoutMs: 60_000, ...s });
    expect(res.text).toBe("hello");
    expect(res.cursor).toBe(3);
    expect(res.eventCount).toBe(3);
    expect(res.polls).toBe(4);
    expect(res.firstEventMs).not.toBeNull();
    expect(s.afters).toEqual([0, 0, 1, 2]);
  });

  it("a follow-up ignores other turns and does not settle on idle before its own events", async () => {
    const s = scripted([
      page([ev(5, "message.chunk", "old", { text: "stale" })], "idle"),
      page([], "idle"),
      page([ev(6, "message.chunk", "t2", { text: "new" })], "running"),
      page([], "idle"),
    ]);
    const res = await waitForTurn({ after: 4, turnId: "t2", timeoutMs: 60_000, ...s });
    expect(res.text).toBe("new");
    expect(res.cursor).toBe(6);
    expect(res.polls).toBe(4);
  });

  it("throws with the payload error on a matching turn.failed", async () => {
    const s = scripted([page([ev(1, "turn.failed", "t1", { error: "sandbox died" })], "idle")]);
    await expect(waitForTurn({ after: 0, timeoutMs: 60_000, ...s })).rejects.toThrow(
      "turn failed: sandbox died",
    );
    const nested = scripted([
      page(
        [ev(1, "turn.failed", "t1", { failureReason: "error", payload: { error: "engine gone" } })],
        "idle",
      ),
    ]);
    await expect(waitForTurn({ after: 0, timeoutMs: 60_000, ...nested })).rejects.toThrow(
      "turn failed: engine gone",
    );
  });

  it("throws when turnStatus is null", async () => {
    const s = scripted([page([], null)]);
    await expect(waitForTurn({ after: 0, timeoutMs: 60_000, ...s })).rejects.toThrow(
      /turnStatus is null/,
    );
  });

  it("keeps reading while the page is truncated even when idle", async () => {
    const s = scripted([
      page([ev(1, "message.chunk", "t1", { text: "a" })], "idle", true),
      page([ev(2, "message.chunk", "t1", { text: "b" })], "idle"),
    ]);
    const res = await waitForTurn({ after: 0, timeoutMs: 60_000, ...s });
    expect(res.text).toBe("ab");
    expect(res.polls).toBe(2);
  });

  it("times out when the turn never settles", async () => {
    const s = scripted([page([], "running")]);
    await expect(
      waitForTurn({ after: 0, timeoutMs: 5_000, emptyPageDelayMs: 1_000, ...s }),
    ).rejects.toThrow(/did not settle within 5 s/);
  });

  it("throws aborted when the signal is aborted", async () => {
    const s = scripted([page([], "running")]);
    const ac = new AbortController();
    ac.abort();
    await expect(
      waitForTurn({ after: 0, timeoutMs: 60_000, signal: ac.signal, ...s }),
    ).rejects.toThrow("aborted");
  });

  it("does not double-count an event at or below the cursor", async () => {
    const chunk = ev(1, "message.chunk", "t1", { text: "x" });
    const s = scripted([page([chunk], "running"), page([chunk], "running"), page([], "idle")]);
    const res = await waitForTurn({ after: 0, timeoutMs: 60_000, ...s });
    expect(res.text).toBe("x");
    expect(res.eventCount).toBe(1);
  });
});
