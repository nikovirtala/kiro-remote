/**
 * kiro_wait_for_events truncation limits and kiro_get_transcript final-text
 * behavior.
 */

import type {
  ClientEventsPage,
  ClientPermission,
  KiroRemoteClient,
} from "@nikovirtala/kiro-remote-api";
import type { Principal } from "@nikovirtala/kiro-remote-core";
import { describe, expect, it } from "vitest";
import {
  collectEvents,
  finalTranscript,
  MAX_EVENTS,
  MAX_TEXT_CHARS,
  MAX_WAIT_SECONDS,
} from "../src/events.ts";

/** A minimal stub client exposing just the two reads the event logic uses. */
function stubClient(opts: {
  events: ClientEventsPage;
  permissions?: ClientPermission[];
  capture?: (args: { after: number; wait: number; types?: string[] }) => void;
}): KiroRemoteClient {
  return {
    async getEvents(_p: Principal, _id: string, args) {
      opts.capture?.(args);
      return opts.events;
    },
    async listPermissions() {
      return { permissions: opts.permissions ?? [] };
    },
    // Unused by the event logic.
  } as unknown as KiroRemoteClient;
}

function textEvent(seq: number, text: string, turnId: string | null = "t1") {
  return {
    seq,
    sessionId: "s1",
    turnId,
    type: "message.chunk",
    rawType: "agent_message_chunk",
    replay: false,
    ts: "2024-01-01T00:00:00.000Z",
    payload: { content: { type: "text", text } },
  };
}

const P: Principal = { sub: "user-1", clientId: "c", scopes: ["sessions:read"] };

describe("kiro_wait_for_events", () => {
  it("clamps the underlying long-poll wait to at most 25s", async () => {
    let seenWait = -1;
    const client = stubClient({
      events: { events: [], nextCursor: 0, turnStatus: "idle" },
      capture: (a) => {
        seenWait = a.wait;
      },
    });
    await collectEvents(client, P, { sessionId: "s1", after: 0 });
    expect(seenWait).toBe(MAX_WAIT_SECONDS);
    expect(MAX_WAIT_SECONDS).toBe(25);
  });

  it("returns at most 30 events and reports how many were dropped", async () => {
    const events = Array.from({ length: 42 }, (_, i) => textEvent(i + 1, "x"));
    const client = stubClient({
      events: { events, nextCursor: 42, turnStatus: "running" },
    });
    const res = await collectEvents(client, P, { sessionId: "s1", after: 0 });
    expect(res.events).toHaveLength(MAX_EVENTS);
    expect(res.eventsTruncated).toBe(true);
    expect(res.droppedEvents).toBe(42 - 30);
    // nextCursor is the seq of the LAST RETURNED event (so poll continues at the cut).
    expect(res.nextCursor).toBe(30);
  });

  it("returns at most 8000 chars of text and reports truncation", async () => {
    // One event with 10k chars of assistant text.
    const big = "a".repeat(10000);
    const client = stubClient({
      events: { events: [textEvent(1, big)], nextCursor: 1, turnStatus: "running" },
    });
    const res = await collectEvents(client, P, { sessionId: "s1", after: 0 });
    expect(res.text).toHaveLength(MAX_TEXT_CHARS);
    expect(MAX_TEXT_CHARS).toBe(8000);
    expect(res.textTruncated).toBe(true);
    expect(res.droppedTextChars).toBe(10000 - 8000);
  });

  it("includes nextCursor, turnStatus, and the pending-permission count", async () => {
    const client = stubClient({
      events: { events: [textEvent(5, "hi")], nextCursor: 5, turnStatus: "awaiting_permission" },
      permissions: [
        {
          requestId: "r1",
          toolCallId: "tc",
          toolCall: {},
          options: [],
          consent: null,
          status: "pending",
          answer: null,
        },
        {
          requestId: "r2",
          toolCallId: "tc",
          toolCall: {},
          options: [],
          consent: null,
          status: "answered",
          answer: {},
        },
      ],
    });
    const res = await collectEvents(client, P, { sessionId: "s1", after: 0 });
    expect(res.nextCursor).toBe(5);
    expect(res.turnStatus).toBe("awaiting_permission");
    expect(res.pendingPermissionCount).toBe(1);
  });

  it("does not truncate when under the limits", async () => {
    const client = stubClient({
      events: { events: [textEvent(1, "short")], nextCursor: 1, turnStatus: "idle" },
    });
    const res = await collectEvents(client, P, { sessionId: "s1", after: 0 });
    expect(res.eventsTruncated).toBe(false);
    expect(res.textTruncated).toBe(false);
    expect(res.text).toBe("short");
  });
});

describe("kiro_get_transcript", () => {
  it("returns the assistant's FINAL text per turn, not raw events", async () => {
    const client = stubClient({
      events: {
        events: [
          textEvent(1, "Hello ", "t1"),
          textEvent(2, "world", "t1"),
          { ...textEvent(3, "ignored", "t1"), type: "tool.call" },
          textEvent(4, "Second turn", "t2"),
        ],
        nextCursor: 4,
        turnStatus: "idle",
      },
    });
    const res = await finalTranscript(client, P, "s1");
    expect(res.sessionId).toBe("s1");
    expect(res.turns).toEqual([
      { turnId: "t1", text: "Hello world" },
      { turnId: "t2", text: "Second turn" },
    ]);
  });

  it("pages through ALL events when the log exceeds one read page", async () => {
    // A paging client: each getEvents call returns the next page after `after`.
    const pages: Record<number, ClientEventsPage> = {
      0: {
        events: [textEvent(1, "turn one ", "t1"), textEvent(2, "done", "t1")],
        nextCursor: 2,
        turnStatus: "idle",
      },
      2: {
        events: [textEvent(3, "turn two ", "t2"), textEvent(4, "done", "t2")],
        nextCursor: 4,
        turnStatus: "idle",
      },
      4: { events: [], nextCursor: 4, turnStatus: "idle" },
    };
    const reads: number[] = [];
    const client = {
      async getEvents(_p: Principal, _id: string, args: { after: number; wait: number }) {
        reads.push(args.after);
        return pages[args.after] ?? { events: [], nextCursor: args.after, turnStatus: "idle" };
      },
      async listPermissions() {
        return { permissions: [] };
      },
    } as unknown as KiroRemoteClient;

    const res = await finalTranscript(client, P, "s1");
    // Later turns (page 2) are NOT omitted.
    expect(res.turns).toEqual([
      { turnId: "t1", text: "turn one done" },
      { turnId: "t2", text: "turn two done" },
    ]);
    // It read page-by-page (0 -> 2 -> 4) and stopped on the empty page.
    expect(reads).toEqual([0, 2, 4]);
  });

  it("reads the whole log from seq 0 without blocking", async () => {
    let seen: { after: number; wait: number } | null = null;
    const client = stubClient({
      events: { events: [], nextCursor: 0, turnStatus: "idle" },
      capture: (a) => {
        seen = { after: a.after, wait: a.wait };
      },
    });
    await finalTranscript(client, P, "s1");
    expect(seen).toEqual({ after: 0, wait: 0 });
  });
});
