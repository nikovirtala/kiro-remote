import { describe, expect, it } from "vitest";
import { ReplayDeduper, type ToolCallEvent } from "../src/index.ts";

function toolCall(toolCallId: string, extra: Record<string, unknown> = {}): ToolCallEvent {
  return {
    type: "tool.call",
    toolCallId,
    title: "t",
    status: "pending",
    payload: { toolCallId, ...extra },
    sessionId: "s",
    turnId: "t1",
    replay: false,
    rawType: "tool_call",
  };
}

describe("replay dedupe by toolCallId + content", () => {
  it("accepts the first occurrence and rejects an identical replay", () => {
    const d = new ReplayDeduper();
    const first = toolCall("call-1", { arg: "a" });
    const replayed = { ...toolCall("call-1", { arg: "a" }), replay: true };
    expect(d.accept(first)).toBe(true);
    expect(d.accept(replayed)).toBe(false);
  });

  it("treats different content for the same toolCallId as distinct", () => {
    const d = new ReplayDeduper();
    expect(d.accept(toolCall("call-1", { arg: "a" }))).toBe(true);
    expect(d.accept(toolCall("call-1", { arg: "b" }))).toBe(true);
  });

  it("treats different toolCallIds as distinct", () => {
    const d = new ReplayDeduper();
    expect(d.accept(toolCall("call-1"))).toBe(true);
    expect(d.accept(toolCall("call-2"))).toBe(true);
  });
});
