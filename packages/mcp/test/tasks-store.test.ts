/**
 * The Tasks store (io.modelcontextprotocol/tasks): the task id and the store
 * that reads the turn records.
 *
 * The store runs against a real core Repository over the in-memory DynamoDB
 * fake, so what a task answers is what the turn and queued-prompt rows say.
 */

import { DetailedTaskV2Schema } from "@modelcontextprotocol/ext-tasks/core/v2";
import { sessionPk } from "@nikovirtala/kiro-remote-core";
import { describe, expect, it } from "vitest";
import { callTool } from "../src/server.ts";
import {
  decodeTaskId,
  encodeTaskId,
  TASK_POLL_INTERVAL_MS,
  TASK_TTL_MS,
  TaskNotDurableError,
  TurnTaskStore,
} from "../src/tasks/index.ts";
import { buildInProcess, type InProcHarness, principal } from "./helpers.ts";
import { failQueued, NOW, OTHER, P, putTurn, taskIdFor } from "./tasks-fixtures.ts";

const CREATED = new Date(NOW).toISOString();

function storeFor(h: InProcHarness, who = P, now = NOW) {
  return new TurnTaskStore({ client: h.client, principal: () => who, now: () => now });
}

describe("task id", () => {
  it("round-trips the session, the turn, the creation time and the ttl", () => {
    const ref = { sessionId: "01JABC", turnId: "turn-1.a_b", createdAtMs: NOW, ttlMs: 5000 };
    expect(decodeTaskId(encodeTaskId(ref))).toEqual(ref);
    expect(decodeTaskId(encodeTaskId({ ...ref, ttlMs: null }))).toEqual({ ...ref, ttlMs: null });
  });

  it.each([
    ["empty", ""],
    ["not base64url", "not a task id!"],
    ["base64url of text", Buffer.from("hello").toString("base64url")],
    ["a JSON object", Buffer.from('{"a":1}').toString("base64url")],
    ["the wrong version", Buffer.from('[2,"s","t",1,null]').toString("base64url")],
    ["a short array", Buffer.from('[1,"s","t",1]').toString("base64url")],
    ["a numeric session id", Buffer.from('[1,5,"t",1,null]').toString("base64url")],
    ["a session id with a slash", Buffer.from('[1,"a/b","t",1,null]').toString("base64url")],
    ["a negative time", Buffer.from('[1,"s","t",-1,null]').toString("base64url")],
    ["a zero ttl", Buffer.from('[1,"s","t",1,0]').toString("base64url")],
    ["a string ttl", Buffer.from('[1,"s","t",1,"9"]').toString("base64url")],
    ["a too long id", "A".repeat(600)],
  ])("a malformed id is not a task: %s", (_name, id) => {
    expect(decodeTaskId(id)).toBeUndefined();
  });

  it("refuses a second spelling of the same id (non-canonical base64url)", () => {
    const id = encodeTaskId({ sessionId: "s", turnId: "t", createdAtMs: 1, ttlMs: null });
    expect(decodeTaskId(`${id}A`)).toBeUndefined();
  });
});

describe("TurnTaskStore: every turn status", () => {
  it.each([
    ["queued", "working", "waits for the turns in front"],
    ["running", "working", "is running"],
  ] as const)("%s is %s", async (turnStatus, taskStatus, message) => {
    const h = buildInProcess();
    const s = h.seedSession({ id: "s1", status: "running" });
    await putTurn(h, s, "t1", turnStatus);
    const task = await storeFor(h).get(taskIdFor(s, "t1"));
    expect(task).toMatchObject({ status: taskStatus, ttlMs: TASK_TTL_MS, createdAt: CREATED });
    expect(task?.statusMessage).toContain(message);
    expect(DetailedTaskV2Schema.safeParse(task).success).toBe(true);
  });

  it("completed carries the turn's final text and the structured ids", async () => {
    const h = buildInProcess();
    const s = h.seedSession({ id: "s1", status: "idle" });
    await putTurn(h, s, "t1", "completed", { endedAt: "2026-11-26T12:00:09.000Z" });
    // Another turn's text must not leak in, nor a different message kind.
    h.seedEvent(s, 1, { turnId: "t0", payload: { content: { type: "text", text: "old " } } });
    h.seedEvent(s, 2, { turnId: "t1", payload: { content: { type: "text", text: "Done: " } } });
    h.seedEvent(s, 3, { turnId: "t1", type: "tool.call", payload: {} });
    h.seedEvent(s, 4, { turnId: "t1", payload: { content: { type: "text", text: "all green." } } });
    const task = await storeFor(h).get(taskIdFor(s, "t1"));
    expect(task).toMatchObject({
      status: "completed",
      lastUpdatedAt: "2026-11-26T12:00:09.000Z",
      result: {
        resultType: "complete",
        content: [{ type: "text", text: "Done: all green." }],
        structuredContent: {
          sessionId: s,
          turnId: "t1",
          status: "completed",
          text: "Done: all green.",
        },
      },
    });
    expect(DetailedTaskV2Schema.safeParse(task).success).toBe(true);
  });

  it("completed text is the same text kiro_get_transcript gives for that turn", async () => {
    const h = buildInProcess();
    const s = h.seedSession({ id: "s1", status: "idle" });
    await putTurn(h, s, "t1", "completed");
    h.seedEvent(s, 1, { turnId: "t1", payload: { content: { type: "text", text: "same text" } } });
    const task = await storeFor(h).get(taskIdFor(s, "t1"));
    const transcript = await callTool(h.client, P, "kiro_get_transcript", { sessionId: s });
    const turns = (transcript.structuredContent as { turns: { turnId: string; text: string }[] })
      .turns;
    const result = (task as { result: { content: { text: string }[] } }).result;
    expect(result.content[0]?.text).toBe(turns.find((t) => t.turnId === "t1")?.text);
  });

  it("completed with nothing said is an empty text, still a result", async () => {
    const h = buildInProcess();
    const s = h.seedSession({ id: "s1", status: "idle" });
    await putTurn(h, s, "t1", "completed");
    const task = await storeFor(h).get(taskIdFor(s, "t1"));
    expect(task).toMatchObject({ status: "completed", result: { content: [{ text: "" }] } });
  });

  it.each([
    ["failed", "error", "The Kiro turn failed: error."],
    ["failed", null, "The Kiro turn failed."],
    ["refused", "refused_by_agent", "The Kiro turn was refused: refused_by_agent."],
  ] as const)(
    "%s turn (stopReason %s) is failed with the reason",
    async (status, stopReason, message) => {
      const h = buildInProcess();
      const s = h.seedSession({ id: "s1", status: "idle" });
      await putTurn(h, s, "t1", status, { stopReason });
      const task = await storeFor(h).get(taskIdFor(s, "t1"));
      expect(task).toMatchObject({
        status: "failed",
        statusMessage: message,
        error: {
          code: -32603,
          message,
          data: {
            sessionId: s,
            turnId: "t1",
            status,
            ...(stopReason ? { reason: stopReason } : {}),
          },
        },
      });
      expect(DetailedTaskV2Schema.safeParse(task).success).toBe(true);
    },
  );

  it("cancelled is cancelled", async () => {
    const h = buildInProcess();
    const s = h.seedSession({ id: "s1", status: "idle" });
    await putTurn(h, s, "t1", "cancelled");
    const task = await storeFor(h).get(taskIdFor(s, "t1"));
    expect(task).toMatchObject({ status: "cancelled" });
    expect(DetailedTaskV2Schema.safeParse(task).success).toBe(true);
  });
});

describe("TurnTaskStore: a prompt on the session's queue", () => {
  async function queued(h: InProcHarness, sessionId: string, id: string) {
    expect(await h.repo.putQueuedPrompt({ sessionId, id, prompt: "later" })).toBe(true);
  }

  it("a waiting prompt has no turn row yet and is working", async () => {
    const h = buildInProcess();
    const s = h.seedSession({ id: "s1", status: "running" });
    await queued(h, s, "t1");
    expect(await storeFor(h).get(taskIdFor(s, "t1"))).toMatchObject({
      status: "working",
      statusMessage: expect.stringContaining("waits"),
    });
  });

  it("a delivered prompt is still working (it waits to start)", async () => {
    const h = buildInProcess();
    const s = h.seedSession({ id: "s1", status: "idle" });
    await queued(h, s, "t1");
    expect(await h.repo.claimQueuedPrompt(s, "t1")).toBe(true);
    expect(await storeFor(h).get(taskIdFor(s, "t1"))).toMatchObject({ status: "working" });
  });

  it("a started prompt is working until its turn row says otherwise", async () => {
    const h = buildInProcess();
    const s = h.seedSession({ id: "s1", status: "running" });
    await queued(h, s, "t1");
    await h.repo.claimQueuedPrompt(s, "t1");
    await h.repo.startQueuedPrompt(s, "t1");
    expect(await storeFor(h).get(taskIdFor(s, "t1"))).toMatchObject({ status: "working" });
    await putTurn(h, s, "t1", "completed");
    expect(await storeFor(h).get(taskIdFor(s, "t1"))).toMatchObject({ status: "completed" });
  });

  it.each([
    ["session_deleted", "The session was deleted before the prompt ran."],
    ["session_failed", "The session failed before the prompt ran."],
    ["not_sent", "The prompt could not be sent to the session."],
  ] as const)(
    "a prompt that failed on the queue with %s is failed, naming the reason",
    async (reason, message) => {
      const h = buildInProcess();
      const s = h.seedSession({ id: "s1", status: "running" });
      await queued(h, s, "t1");
      failQueued(h, s, "t1", reason);
      const task = await storeFor(h).get(taskIdFor(s, "t1"));
      expect(task).toMatchObject({
        status: "failed",
        statusMessage: message,
        error: {
          code: -32603,
          message,
          data: { sessionId: s, turnId: "t1", status: "failed", reason },
        },
      });
      expect(DetailedTaskV2Schema.safeParse(task).success).toBe(true);
    },
  );
});

describe("TurnTaskStore: who may read a task", () => {
  it("another principal's read is undefined, the same as a task that does not exist", async () => {
    const h = buildInProcess();
    const s = h.seedSession({ id: "s1", status: "idle" });
    await putTurn(h, s, "t1", "completed");
    const id = taskIdFor(s, "t1");
    expect(await storeFor(h, P).get(id)).toBeDefined();
    expect(await storeFor(h, OTHER).get(id)).toBeUndefined();
    expect(await storeFor(h, OTHER).update(id, {})).toBe(false);
    expect(await storeFor(h, OTHER).cancel(id)).toBe(false);
    // And the same as a turn that is not there.
    expect(await storeFor(h, P).get(taskIdFor(s, "nope"))).toBeUndefined();
    expect(await storeFor(h, P).get(taskIdFor("no-such-session", "t1"))).toBeUndefined();
  });

  it("another principal cannot cancel: nothing is enqueued", async () => {
    const h = buildInProcess();
    const s = h.seedSession({ id: "s1", status: "running" });
    await putTurn(h, s, "t1", "running");
    await storeFor(h, OTHER).cancel(taskIdFor(s, "t1"));
    expect(h.queue.commands).toEqual([]);
  });

  it("a malformed task id is undefined, and reads nothing", async () => {
    const h = buildInProcess();
    const store = storeFor(h);
    for (const bad of ["", "x", "AAAA", "../../etc"]) {
      expect(await store.get(bad)).toBeUndefined();
      expect(await store.update(bad, {})).toBe(false);
      expect(await store.cancel(bad)).toBe(false);
    }
  });

  it("a caller without sessions:read gets insufficient scope, not a task", async () => {
    const h = buildInProcess();
    const s = h.seedSession({ id: "s1", status: "idle" });
    await putTurn(h, s, "t1", "completed");
    const blind = storeFor(h, principal({ scopes: ["sessions:write"] }));
    await expect(blind.get(taskIdFor(s, "t1"))).rejects.toMatchObject({ name: "ForbiddenError" });
  });

  it("a task is not found once its ttl has passed, found just before", async () => {
    const h = buildInProcess();
    const s = h.seedSession({ id: "s1", status: "running" });
    await putTurn(h, s, "t1", "running");
    const id = taskIdFor(s, "t1", 60_000);
    expect(await storeFor(h, P, NOW + 60_000).get(id)).toBeDefined();
    expect(await storeFor(h, P, NOW + 60_001).get(id)).toBeUndefined();
    expect(await storeFor(h, P, NOW + 60_001).cancel(id)).toBe(false);
    // A task without a limit never expires.
    expect(
      await storeFor(h, P, NOW + 10 * TASK_TTL_MS).get(taskIdFor(s, "t1", null)),
    ).toBeDefined();
  });
});

describe("TurnTaskStore: a deleted session", () => {
  it("fails a running turn as session_deleted while the records can be read", async () => {
    const h = buildInProcess();
    const s = h.seedSession({ id: "s1", status: "deleted" });
    await putTurn(h, s, "t1", "running");
    expect(await storeFor(h).get(taskIdFor(s, "t1"))).toMatchObject({
      status: "failed",
      error: { data: { reason: "session_deleted" } },
    });
  });

  it("fails a queued prompt, and a completed turn whose answer went with the session, as session_deleted", async () => {
    const h = buildInProcess();
    const s = h.seedSession({ id: "s1", status: "deleted" });
    await h.repo.putQueuedPrompt({ sessionId: s, id: "q1", prompt: "never ran" });
    await putTurn(h, s, "t2", "completed");
    for (const turnId of ["q1", "t2"]) {
      expect(await storeFor(h).get(taskIdFor(s, turnId))).toMatchObject({
        status: "failed",
        error: { data: { reason: "session_deleted" } },
      });
    }
  });

  it("keeps the turn that had failed or been cancelled as stored", async () => {
    const h = buildInProcess();
    const s = h.seedSession({ id: "s1", status: "deleted" });
    await putTurn(h, s, "t1", "failed", { stopReason: "error" });
    await putTurn(h, s, "t2", "cancelled");
    expect(await storeFor(h).get(taskIdFor(s, "t1"))).toMatchObject({
      status: "failed",
      error: { data: { reason: "error" } },
    });
    expect(await storeFor(h).get(taskIdFor(s, "t2"))).toMatchObject({ status: "cancelled" });
  });

  it("is Task not found once the session's records are gone, and for another principal's", async () => {
    const h = buildInProcess();
    const s = h.seedSession({ id: "s1", status: "deleted" });
    await putTurn(h, s, "t1", "running");
    h.ddb.items.delete(`${sessionPk(s)}\u0000META`);
    expect(await storeFor(h).get(taskIdFor(s, "t1"))).toBeUndefined();
  });

  it("does not let another principal see the deleted session's task", async () => {
    const h = buildInProcess();
    const s = h.seedSession({ id: "s1", status: "deleted" });
    await putTurn(h, s, "t1", "running");
    expect(await storeFor(h, OTHER).get(taskIdFor(s, "t1"))).toBeUndefined();
  });
});

describe("TurnTaskStore: cancel and update", () => {
  it("cancel on a running turn asks the session to cancel, as kiro_cancel_turn does", async () => {
    const h = buildInProcess({ ids: ["cmd-1"] });
    const s = h.seedSession({ id: "s1", status: "running" });
    await putTurn(h, s, "t1", "running");
    expect(await storeFor(h).cancel(taskIdFor(s, "t1"))).toBe(true);
    expect(h.queue.commands).toMatchObject([{ kind: "cancel", sessionId: s }]);
  });

  it.each(["completed", "failed", "refused", "cancelled"] as const)(
    "cancel on a %s turn is acknowledged and sends nothing",
    async (status) => {
      const h = buildInProcess();
      const s = h.seedSession({ id: "s1", status: "idle" });
      await putTurn(h, s, "t1", status);
      expect(await storeFor(h).cancel(taskIdFor(s, "t1"))).toBe(true);
      expect(h.queue.commands).toEqual([]);
    },
  );

  it("cancel on a prompt still on the queue is acknowledged and does not cancel the turn in front of it", async () => {
    const h = buildInProcess();
    const s = h.seedSession({ id: "s1", status: "running" });
    await putTurn(h, s, "running-turn", "running");
    await h.repo.putQueuedPrompt({ sessionId: s, id: "q1", prompt: "later" });
    expect(await storeFor(h).cancel(taskIdFor(s, "q1"))).toBe(true);
    expect(h.queue.commands).toEqual([]);
  });

  it("update acknowledges answers to requests the task never made, whatever their keys", async () => {
    const h = buildInProcess();
    const s = h.seedSession({ id: "s1", status: "running" });
    await putTurn(h, s, "t1", "running");
    const id = taskIdFor(s, "t1");
    const noise = JSON.parse('{"never-issued":{"action":"accept"},"":{},"__proto__":{}}');
    expect(await storeFor(h).update(id, noise as never)).toBe(true);
    expect(await storeFor(h).get(id)).toMatchObject({ status: "working" });
    expect(h.queue.commands).toEqual([]);
  });
});

describe("TurnTaskStore.create", () => {
  it("returns the working task for a queued prompt (its row is written before the call answers)", async () => {
    const h = buildInProcess({ ids: ["turn-1", "cmd-1"] });
    h.seedSession({ id: "s1", status: "running" });
    const sent = await callTool(h.client, P, "kiro_send_prompt", {
      sessionId: "s1",
      prompt: "go",
      whenBusy: "queue",
    });
    expect(sent.structuredContent).toMatchObject({ turn: { id: "turn-1" } });
    const task = await storeFor(h).create({
      ttlMs: TASK_TTL_MS,
      pollIntervalMs: TASK_POLL_INTERVAL_MS,
      context: { sessionId: "s1", turnId: "turn-1" },
    });
    expect(task).toMatchObject({
      status: "working",
      ttlMs: TASK_TTL_MS,
      pollIntervalMs: TASK_POLL_INTERVAL_MS,
    });
    expect(await storeFor(h).get(task.taskId)).toMatchObject({ taskId: task.taskId });
  });

  it("refuses when the turn cannot be read yet: a steer to an idle session writes no row", async () => {
    const h = buildInProcess({ ids: ["turn-1", "cmd-1"] });
    h.seedSession({ id: "s1", status: "idle" });
    await callTool(h.client, P, "kiro_send_prompt", { sessionId: "s1", prompt: "go" });
    await expect(
      storeFor(h).create({ ttlMs: null, context: { sessionId: "s1", turnId: "turn-1" } }),
    ).rejects.toBeInstanceOf(TaskNotDurableError);
  });

  it("refuses a create without the session and the turn", async () => {
    const h = buildInProcess();
    await expect(storeFor(h).create({ ttlMs: null })).rejects.toBeInstanceOf(TaskNotDurableError);
  });
});
