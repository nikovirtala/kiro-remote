/**
 * Tests for the catch-up planner (dedupe of a load replay against the event
 * log), the delay setting and the Lambda catch-up scheduler.
 */

import { createHash } from "node:crypto";
import { DurableExecutionAlreadyStartedException } from "@aws-sdk/client-lambda";
import { type NormalizedEvent, normalizeUpdate } from "@nikovirtala/kiro-remote-core";
import { describe, expect, test } from "vitest";
import {
  type CatchUpMessage,
  catchUpDelaySeconds,
  countTurnStarts,
  DEFAULT_CATCH_UP_DELAY_SECONDS,
  isCatchUpMessage,
  planCatchUp,
} from "../src/catch-up.ts";
import { catchUpExecutionName, LambdaCatchUpScheduler } from "../src/catch-up-scheduler.ts";
import { createLogger } from "../src/logger.ts";

const SID = "s-1";
const TURN = "turn-b";

const info = (kind: string, extra: Record<string, unknown> = {}) => ({
  sessionUpdate: "session_info_update",
  _meta: { kiro: { kind } },
  ...extra,
});
const chunk = (text: string) => ({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text },
});
const toolCall = (id: string, status: string) => ({
  sessionUpdate: "tool_call",
  toolCallId: id,
  title: "fs_read",
  status,
});
const toolUpdate = (id: string, status: string) => ({
  sessionUpdate: "tool_call_update",
  toolCallId: id,
  status,
});

/** An older finished turn followed by the detached turn, through turn_end. */
const olderTurn = [
  info("turn_start"),
  chunk("old answer"),
  info("turn_completion", { status: "end_turn" }),
  info("turn_end"),
];
const detachedTurnRunning = [
  info("turn_start"),
  chunk("Hello "),
  chunk("world"),
  toolCall("t1", "pending"),
  toolUpdate("t1", "completed"),
];
const detachedTurnDone = [
  ...detachedTurnRunning,
  info("turn_completion", { status: "end_turn" }),
  info("turn_end"),
];

function recordedOf(updates: unknown[]): NormalizedEvent[] {
  return updates.map((u) => normalizeUpdate(SID, u, { turnId: TURN }));
}

function texts(events: NormalizedEvent[]): string[] {
  return events
    .filter((e) => e.type === "message.chunk")
    .map((e) => String((e as { content: { text?: unknown } }).content.text));
}

describe("planCatchUp", () => {
  test("emits only what the log is missing for the last turn", () => {
    // Live recording got the turn_start, part of the text, and the tool call.
    const recorded = [
      ...recordedOf([info("turn_start"), toolCall("t1", "pending")]),
      ...recordedOf([chunk("Hello wo")]),
    ];
    const plan = planCatchUp({
      sessionId: SID,
      turnId: TURN,
      updates: [...olderTurn, ...detachedTurnDone],
      recorded,
    });
    expect(plan.turnFound).toBe(true);
    expect(plan.ended).toBe(true);
    expect(plan.stopReason).toBe("end_turn");
    expect(plan.events.map((e) => e.type)).toEqual([
      "message.chunk",
      "tool.update",
      "turn.completed",
      "session.info",
    ]);
    expect(texts(plan.events)).toEqual(["rld"]);
    expect(plan.events.every((e) => e.turnId === TURN && e.replay === false)).toBe(true);
    const last = plan.events.at(-1);
    expect(last?.type === "session.info" && last.kind).toBe("turn_end");
  });

  test("a replay chunk that extends the recorded text emits only the suffix", () => {
    const plan = planCatchUp({
      sessionId: SID,
      turnId: TURN,
      updates: [info("turn_start"), chunk("Hello world")],
      recorded: recordedOf([info("turn_start"), chunk("Hello wo")]),
    });
    expect(texts(plan.events)).toEqual(["rld"]);
    expect(plan.events).toHaveLength(1);
  });

  test("marks replayed updates as new (replay false) when emitting", () => {
    const replayed = { ...chunk("x"), _meta: { kiro: { replay: true } } };
    const plan = planCatchUp({
      sessionId: SID,
      turnId: TURN,
      updates: [info("turn_start"), replayed],
      recorded: [],
    });
    expect(plan.events.map((e) => e.replay)).toEqual([false, false]);
  });

  test("no turn_start in the replay -> turnFound false and no events", () => {
    const plan = planCatchUp({
      sessionId: SID,
      turnId: TURN,
      updates: [chunk("orphan")],
      recorded: [],
    });
    expect(plan).toEqual({ turnFound: false, ended: false, events: [] });
  });

  test("a still-running turn is not ended", () => {
    const plan = planCatchUp({
      sessionId: SID,
      turnId: TURN,
      updates: [...olderTurn, ...detachedTurnRunning],
      recorded: recordedOf([info("turn_start")]),
    });
    expect(plan.turnFound).toBe(true);
    expect(plan.ended).toBe(false);
    expect(plan.stopReason).toBeUndefined();
    expect(texts(plan.events)).toEqual(["Hello ", "world"]);
  });

  test("re-planning with the previous output recorded emits nothing", () => {
    const updates = [...olderTurn, ...detachedTurnDone];
    const recorded = recordedOf([info("turn_start"), chunk("Hello wo"), toolCall("t1", "pending")]);
    const first = planCatchUp({ sessionId: SID, turnId: TURN, updates, recorded });
    expect(first.events.length).toBeGreaterThan(0);
    const second = planCatchUp({
      sessionId: SID,
      turnId: TURN,
      updates,
      recorded: [...recorded, ...first.events],
    });
    expect(second.events).toEqual([]);
    expect(second.ended).toBe(true);
  });
});

describe("planCatchUp with a turn ordinal", () => {
  const recorded = recordedOf([info("turn_start"), chunk("Hello wo")]);

  test("takes the ordinal's segment, up to the next turn_start", () => {
    const plan = planCatchUp({
      sessionId: SID,
      turnId: TURN,
      updates: [...olderTurn, ...detachedTurnDone, info("turn_start"), chunk("later")],
      recorded,
      turnOrdinal: 2,
    });
    expect(plan.turnFound).toBe(true);
    expect(plan.ended).toBe(true);
    expect(texts(plan.events)).toEqual(["rld"]);
    expect(plan.events.map((e) => e.type)).toEqual([
      "message.chunk",
      "tool.call",
      "tool.update",
      "turn.completed",
      "session.info",
    ]);
  });

  test("a replay that lacks the running turn is not found and writes nothing", () => {
    // The detached follow-up is turn 2; the replay only holds the finished turn 1.
    const plan = planCatchUp({
      sessionId: SID,
      turnId: TURN,
      updates: olderTurn,
      recorded,
      turnOrdinal: 2,
    });
    expect(plan).toEqual({ turnFound: false, ended: false, events: [] });
  });

  test("without an ordinal, a last turn whose text diverges is a mismatch", () => {
    const plan = planCatchUp({ sessionId: SID, turnId: TURN, updates: olderTurn, recorded });
    expect(plan).toEqual({ turnFound: false, ended: false, mismatch: true, events: [] });
  });

  test("countTurnStarts counts the replay's turns", () => {
    expect(countTurnStarts([])).toBe(0);
    expect(countTurnStarts([...olderTurn, ...detachedTurnRunning])).toBe(2);
  });

  test("isCatchUpMessage accepts an optional positive integer ordinal", () => {
    const base = {
      kind: "catchUp",
      sessionId: SID,
      kiroSessionId: "sess_cloud-1",
      turnId: TURN,
      afterSeq: 0,
      attempt: 1,
      detachedAt: 1,
    };
    expect(isCatchUpMessage(base)).toBe(true);
    expect(isCatchUpMessage({ ...base, turnOrdinal: 2 })).toBe(true);
    expect(isCatchUpMessage({ ...base, turnOrdinal: 0 })).toBe(false);
    expect(isCatchUpMessage({ ...base, turnOrdinal: "2" })).toBe(false);
  });
});

describe("catchUpDelaySeconds", () => {
  const warnings: string[] = [];
  const logger = { warn: (m: string) => warnings.push(m) };

  test("defaults to 60 seconds", () => {
    expect(catchUpDelaySeconds({})).toBe(DEFAULT_CATCH_UP_DELAY_SECONDS);
    expect(DEFAULT_CATCH_UP_DELAY_SECONDS).toBe(60);
    expect(catchUpDelaySeconds({ CATCH_UP_DELAY_SECONDS: "" })).toBe(60);
  });

  test("the env var overrides it", () => {
    expect(catchUpDelaySeconds({ CATCH_UP_DELAY_SECONDS: "5" })).toBe(5);
  });

  test("an invalid value warns and falls back to the default", () => {
    for (const bad of ["soon", "0", "-3", "1.5"]) {
      warnings.length = 0;
      expect(catchUpDelaySeconds({ CATCH_UP_DELAY_SECONDS: bad }, logger)).toBe(60);
      expect(warnings).toEqual(["catch_up_delay_invalid"]);
    }
  });
});

describe("LambdaCatchUpScheduler", () => {
  const ARN = "arn:aws:lambda:eu-north-1:123456789012:function:catch-up:live";
  const msg: CatchUpMessage = {
    kind: "catchUp",
    sessionId: SID,
    kiroSessionId: "sess_cloud-1",
    turnId: TURN,
    afterSeq: 4,
    attempt: 1,
    detachedAt: 1_000,
  };
  const logs: string[] = [];
  const logger = createLogger({ sink: (l) => logs.push(l) });

  function fakeLambda(result: () => unknown) {
    const inputs: Record<string, unknown>[] = [];
    return {
      inputs,
      lambda: {
        send: async (command: { input: Record<string, unknown> }) => {
          inputs.push(command.input);
          return result();
        },
      },
    };
  }

  test("starts an async durable execution on the alias with a stable name", async () => {
    const { inputs, lambda } = fakeLambda(() => ({ StatusCode: 202 }));
    const scheduler = new LambdaCatchUpScheduler({ lambda, functionArn: ARN, logger });
    await scheduler.start(msg);
    await scheduler.start({ ...msg, attempt: 9, detachedAt: 99 });
    expect(inputs[0]).toMatchObject({
      FunctionName: ARN,
      InvocationType: "Event",
      DurableExecutionName: catchUpExecutionName(msg),
    });
    expect(JSON.parse(String(inputs[0]?.Payload))).toEqual(msg);
    expect(inputs[1]?.DurableExecutionName).toBe(inputs[0]?.DurableExecutionName);
  });

  test("the name is cu- + 40 hex of sha256(session:turn), valid for UUID ids", () => {
    const uuidMsg = {
      sessionId: "0b2d5c1e-8f3a-4c7e-9a41-2f6d8b7c3e10",
      turnId: "6f1e2d3c-4b5a-4968-8777-665544332211",
    };
    const name = catchUpExecutionName(uuidMsg);
    expect(name).toBe(
      `cu-${createHash("sha256").update(`${uuidMsg.sessionId}:${uuidMsg.turnId}`).digest("hex").slice(0, 40)}`,
    );
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(catchUpExecutionName({ ...uuidMsg, turnId: "other" })).not.toBe(name);
  });

  test("an already-started execution is tolerated and logged", async () => {
    const { lambda } = fakeLambda(() => {
      throw new DurableExecutionAlreadyStartedException({
        message: "already started",
        $metadata: {},
      });
    });
    logs.length = 0;
    await new LambdaCatchUpScheduler({ lambda, functionArn: ARN, logger }).start(msg);
    expect(logs.some((l) => l.includes("catch_up_already_started"))).toBe(true);
  });

  test("other errors, a function error and a non-202 status are rethrown", async () => {
    const boom = fakeLambda(() => {
      throw new Error("throttled");
    });
    await expect(
      new LambdaCatchUpScheduler({ lambda: boom.lambda, functionArn: ARN, logger }).start(msg),
    ).rejects.toThrow("throttled");
    const fnError = fakeLambda(() => ({ StatusCode: 202, FunctionError: "Unhandled" }));
    await expect(
      new LambdaCatchUpScheduler({ lambda: fnError.lambda, functionArn: ARN, logger }).start(msg),
    ).rejects.toThrow();
    const wrong = fakeLambda(() => ({ StatusCode: 200 }));
    await expect(
      new LambdaCatchUpScheduler({ lambda: wrong.lambda, functionArn: ARN, logger }).start(msg),
    ).rejects.toThrow();
  });
});
