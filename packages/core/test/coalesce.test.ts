import { describe, expect, it } from "vitest";
import {
  Coalescer,
  FLUSH_BYTES,
  FLUSH_MS,
  type MessageChunkEvent,
  type NormalizedEvent,
} from "../src/index.ts";

function chunk(text: string, turnId = "t1"): MessageChunkEvent {
  return {
    type: "message.chunk",
    content: { type: "text", text },
    sessionId: "s",
    turnId,
    replay: false,
    rawType: "agent_message_chunk",
  };
}

function nonChunk(): NormalizedEvent {
  return {
    type: "tool.call",
    toolCallId: "tc-1",
    title: "t",
    status: "pending",
    payload: {},
    sessionId: "s",
    turnId: "t1",
    replay: false,
    rawType: "tool_call",
  };
}

describe("coalescer flush rules", () => {
  it("buffers chunks and flushes after FLUSH_MS", () => {
    const c = new Coalescer();
    expect(c.push(chunk("Hello "), 0)).toEqual([]);
    expect(c.push(chunk("world"), 100)).toEqual([]);
    // Not yet past the window.
    expect(c.tick(FLUSH_MS - 1)).toEqual([]);
    const out = c.tick(FLUSH_MS);
    expect(out).toHaveLength(1);
    expect((out[0] as MessageChunkEvent).content.text).toBe("Hello world");
    expect(c.isEmpty()).toBe(true);
  });

  it("flushes when buffered text reaches FLUSH_BYTES", () => {
    const c = new Coalescer();
    const big = "x".repeat(FLUSH_BYTES + 10);
    const out = c.push(chunk(big), 0);
    expect(out).toHaveLength(1);
    expect((out[0] as MessageChunkEvent).content.text).toBe(big);
  });

  it("accumulates across pushes then flushes at the byte threshold", () => {
    const c = new Coalescer();
    const half = "y".repeat(Math.ceil(FLUSH_BYTES / 2));
    expect(c.push(chunk(half), 0)).toEqual([]);
    const out = c.push(chunk(half), 10);
    expect(out).toHaveLength(1);
    expect((out[0] as MessageChunkEvent).content.text.length).toBe(half.length * 2);
  });

  it("flushes buffers before a non-chunk event, preserving order", () => {
    const c = new Coalescer();
    c.push(chunk("partial"), 0);
    const nc = nonChunk();
    const out = c.push(nc, 10);
    expect(out).toHaveLength(2);
    expect((out[0] as MessageChunkEvent).content.text).toBe("partial");
    expect(out[1]).toBe(nc);
  });

  it("coalesces message and thought chunks independently", () => {
    const c = new Coalescer();
    const thought: NormalizedEvent = {
      type: "thought.chunk",
      content: { type: "text", text: "thinking" },
      sessionId: "s",
      turnId: "t1",
      replay: false,
      rawType: "agent_thought_chunk",
    };
    c.push(chunk("msg"), 0);
    c.push(thought, 0);
    const flushed = c.flushAll();
    expect(flushed).toHaveLength(2);
    const types = flushed.map((e) => e.type).sort();
    expect(types).toEqual(["message.chunk", "thought.chunk"]);
  });

  it("passes replayed chunks straight through without coalescing", () => {
    const c = new Coalescer();
    const replayed = { ...chunk("replayed"), replay: true };
    const out = c.push(replayed, 0);
    expect(out).toEqual([replayed]);
    expect(c.isEmpty()).toBe(true);
  });
});
