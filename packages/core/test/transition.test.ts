import { describe, expect, it } from "vitest";
import {
  IllegalTransitionError,
  initialState,
  type MachineState,
  transition,
} from "../src/index.ts";

const idle: MachineState = { session: "idle", turn: null };
const running: MachineState = { session: "running", turn: "running" };
const awaiting: MachineState = { session: "awaiting_permission", turn: "running" };

describe("transition: legal moves", () => {
  it("provisioning -> idle on provisioned", () => {
    expect(transition(initialState(), { kind: "provisioned" })).toEqual(idle);
  });

  it("provisioning -> failed on provision_failed", () => {
    expect(transition(initialState(), { kind: "provision_failed" })).toEqual({
      session: "failed",
      turn: null,
    });
  });

  it("idle -> running on prompt.sent", () => {
    expect(transition(idle, { kind: "prompt.sent" })).toEqual(running);
  });

  it("running -> idle/completed on prompt.response (no stopReason)", () => {
    expect(transition(running, { kind: "prompt.response" })).toEqual({
      session: "idle",
      turn: "completed",
    });
  });

  it("running -> idle/refused on prompt.response stopReason=refusal", () => {
    expect(transition(running, { kind: "prompt.response", stopReason: "refusal" })).toEqual({
      session: "idle",
      turn: "refused",
    });
  });

  it("running -> idle/cancelled on prompt.response stopReason=cancelled", () => {
    expect(transition(running, { kind: "prompt.response", stopReason: "cancelled" })).toEqual({
      session: "idle",
      turn: "cancelled",
    });
  });

  it("running -> idle/failed on prompt.error", () => {
    expect(transition(running, { kind: "prompt.error" })).toEqual({
      session: "idle",
      turn: "failed",
    });
  });

  it("running -> awaiting_permission on permission.requested and back", () => {
    const a = transition(running, { kind: "permission.requested" });
    expect(a).toEqual(awaiting);
    expect(transition(a, { kind: "permission.answered" })).toEqual(running);
  });

  it("queue a prompt while running leaves state unchanged", () => {
    expect(transition(running, { kind: "prompt.queued" })).toEqual(running);
  });

  it("deleted from any active state", () => {
    expect(transition(idle, { kind: "deleted" })).toEqual({ session: "deleted", turn: null });
  });
});

describe("transition: a turn is settled ONLY by the prompt response", () => {
  it("turn_end does NOT settle a running turn", () => {
    expect(transition(running, { kind: "turn_end" })).toEqual(running);
  });

  it("only prompt.response moves the turn out of running", () => {
    const afterTurnEnd = transition(running, { kind: "turn_end" });
    expect(afterTurnEnd.turn).toBe("running");
    const settled = transition(afterTurnEnd, { kind: "prompt.response" });
    expect(settled.turn).toBe("completed");
  });
});

describe("transition: illegal moves throw", () => {
  it("prompt.sent while running throws", () => {
    expect(() => transition(running, { kind: "prompt.sent" })).toThrow(IllegalTransitionError);
  });

  it("prompt.response with no active turn throws", () => {
    expect(() => transition(idle, { kind: "prompt.response" })).toThrow(IllegalTransitionError);
  });

  it("permission.answered when not awaiting throws", () => {
    expect(() => transition(running, { kind: "permission.answered" })).toThrow(
      IllegalTransitionError,
    );
  });

  it("provisioned when not provisioning throws", () => {
    expect(() => transition(idle, { kind: "provisioned" })).toThrow(IllegalTransitionError);
  });

  it("any event from a terminal (deleted/failed) state throws", () => {
    const deleted: MachineState = { session: "deleted", turn: null };
    expect(() => transition(deleted, { kind: "prompt.sent" })).toThrow(IllegalTransitionError);
    const failed: MachineState = { session: "failed", turn: null };
    expect(() => transition(failed, { kind: "provisioned" })).toThrow(IllegalTransitionError);
  });

  it("permission.requested without a running turn throws", () => {
    expect(() => transition(idle, { kind: "permission.requested" })).toThrow(
      IllegalTransitionError,
    );
  });
});
