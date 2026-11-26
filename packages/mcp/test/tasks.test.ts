/**
 * The Tasks extension on the /mcp handler (io.modelcontextprotocol/tasks): the
 * capability, the task handle kiro_send_prompt answers with, tasks/get,
 * tasks/update and tasks/cancel, and their refusals on each protocol era.
 *
 * The store behind it is covered in tasks-store.test.ts. Here it reads a real core
 * Repository over the in-memory DynamoDB fake, so what a task answers is what the
 * turn and queued-prompt rows say.
 */

import {
  CreateTaskResultV2Schema,
  GetTaskResultV2Schema,
} from "@modelcontextprotocol/ext-tasks/core/v2";
import { describe, expect, it } from "vitest";
import { createHttpTransportHandler } from "../src/http-transport.ts";
import { callTool } from "../src/server.ts";
import { decodeTaskId, TASK_POLL_INTERVAL_MS, TASK_TTL_MS } from "../src/tasks/index.ts";
import {
  buildInProcess,
  type InProcHarness,
  modernCall,
  principal,
  type RpcAnswer,
  TASKS_CAPABILITY,
} from "./helpers.ts";
import { failQueued, OTHER, P, putTurn, taskIdFor } from "./tasks-fixtures.ts";

/* ------------------------------ the extension ------------------------------ */

function server(h: InProcHarness) {
  return createHttpTransportHandler({ client: h.client });
}

const send = (
  handler: ReturnType<typeof server>,
  who = P,
  args: Record<string, unknown> = {},
  declared = true,
) =>
  modernCall(
    handler,
    who,
    "tools/call",
    {
      name: "kiro_send_prompt",
      arguments: { sessionId: "s1", prompt: "go", whenBusy: "queue", ...args },
      ...(declared ? { _meta: TASKS_CAPABILITY } : {}),
    },
    7,
  );

const tasks = (
  handler: ReturnType<typeof server>,
  method: "tasks/get" | "tasks/update" | "tasks/cancel",
  taskId: string,
  who = P,
  declared = true,
  extra: Record<string, unknown> = {},
) =>
  modernCall(handler, who, method, {
    taskId,
    ...extra,
    ...(declared ? { _meta: TASKS_CAPABILITY } : {}),
  });

describe("the extension on /mcp (2026-07-28)", () => {
  it("server/discover advertises the capability", async () => {
    const h = buildInProcess();
    const { json } = await modernCall(server(h), P, "server/discover");
    expect(json.result.capabilities.extensions).toHaveProperty("io.modelcontextprotocol/tasks");
  });

  it("kiro_send_prompt answers with a task handle for a client that declared the extension", async () => {
    const h = buildInProcess({ ids: ["turn-1", "cmd-1"] });
    h.seedSession({ id: "s1", status: "running" });
    const { status, json } = await send(server(h));
    expect(status).toBe(200);
    expect(json.result).toMatchObject({
      resultType: "task",
      status: "working",
      ttlMs: TASK_TTL_MS,
      pollIntervalMs: TASK_POLL_INTERVAL_MS,
    });
    expect(CreateTaskResultV2Schema.safeParse(json.result).success).toBe(true);
    expect(decodeTaskId(json.result.taskId)).toMatchObject({ sessionId: "s1", turnId: "turn-1" });
    // The prompt was sent exactly once.
    expect(h.queue.commands).toMatchObject([{ kind: "prompt", turnId: "turn-1" }]);
  });

  it("the same call without the extension is today's result", async () => {
    const h = buildInProcess({ ids: ["turn-1", "cmd-1", "turn-2", "cmd-2"] });
    h.seedSession({ id: "s1", status: "running" });
    const { json } = await send(server(h), P, {}, false);
    const today = await callTool(h.client, P, "kiro_send_prompt", {
      sessionId: "s1",
      prompt: "go",
      whenBusy: "queue",
    });
    expect(json.result.resultType).toBe("complete");
    expect(json.result.taskId).toBeUndefined();
    expect(json.result.content).toEqual(
      today.content.map((c) => ({ ...c, text: expect.any(String) })),
    );
    expect(json.result.structuredContent).toMatchObject({
      turn: { id: "turn-1", sessionId: "s1", status: "queued" },
    });
    expect(Object.keys(json.result.structuredContent)).toEqual(
      Object.keys(today.structuredContent ?? {}),
    );
  });

  it("only kiro_send_prompt answers with a task: another tool is unchanged for a declaring client", async () => {
    const h = buildInProcess();
    h.seedSession({ id: "s1", status: "running" });
    const { json } = await modernCall(server(h), P, "tools/call", {
      name: "kiro_get_session",
      arguments: { sessionId: "s1" },
      _meta: TASKS_CAPABILITY,
    });
    expect(json.result.resultType).toBe("complete");
    expect(json.result.taskId).toBeUndefined();
  });

  it("a send that fails is the tool's own error result, not a task", async () => {
    const h = buildInProcess();
    const { json } = await send(server(h), P, { sessionId: "nope" });
    expect(json.result).toMatchObject({ resultType: "complete", isError: true });
  });

  it("a steer to an idle session has no durable record, so it answers as without Tasks", async () => {
    const h = buildInProcess({ ids: ["turn-1", "cmd-1"] });
    h.seedSession({ id: "s1", status: "idle" });
    const { json } = await send(server(h), P, { whenBusy: "steer" });
    expect(json.result.resultType).toBe("complete");
    expect(json.result.taskId).toBeUndefined();
    expect(json.result.structuredContent).toMatchObject({ turn: { id: "turn-1" } });
    expect(h.queue.commands).toHaveLength(1);
  });

  it("tasks/get answers working, then completed with the final text", async () => {
    const h = buildInProcess({ ids: ["turn-1", "cmd-1"] });
    h.seedSession({ id: "s1", status: "running" });
    const handler = server(h);
    const taskId = (await send(handler)).json.result.taskId as string;

    const working = await tasks(handler, "tasks/get", taskId);
    expect(working.status).toBe(200);
    expect(working.json.result).toMatchObject({
      resultType: "complete",
      status: "working",
      taskId,
    });
    expect(GetTaskResultV2Schema.safeParse(working.json.result).success).toBe(true);

    // The bridge picks the prompt up, runs the turn and finishes it.
    await h.repo.claimQueuedPrompt("s1", "turn-1");
    await h.repo.startQueuedPrompt("s1", "turn-1");
    await putTurn(h, "s1", "turn-1", "running");
    expect((await tasks(handler, "tasks/get", taskId)).json.result.status).toBe("working");
    h.seedEvent("s1", 1, {
      turnId: "turn-1",
      payload: { content: { type: "text", text: "Fixed it." } },
    });
    await putTurn(h, "s1", "turn-1", "completed");

    const done = await tasks(handler, "tasks/get", taskId);
    expect(done.json.result).toMatchObject({
      resultType: "complete",
      status: "completed",
      result: {
        content: [{ type: "text", text: "Fixed it." }],
        structuredContent: {
          sessionId: "s1",
          turnId: "turn-1",
          status: "completed",
          text: "Fixed it.",
        },
      },
    });
    expect(GetTaskResultV2Schema.safeParse(done.json.result).success).toBe(true);
  });

  it("tasks/get on a turn that failed answers failed with the error", async () => {
    const h = buildInProcess({ ids: ["turn-1", "cmd-1"] });
    h.seedSession({ id: "s1", status: "running" });
    const handler = server(h);
    const taskId = (await send(handler)).json.result.taskId as string;
    failQueued(h, "s1", "turn-1", "session_failed");
    const { json } = await tasks(handler, "tasks/get", taskId);
    expect(json.result).toMatchObject({
      status: "failed",
      error: { code: -32603, data: { reason: "session_failed" } },
    });
    expect(GetTaskResultV2Schema.safeParse(json.result).success).toBe(true);
  });

  it("tasks/cancel on a running turn acknowledges with an empty result and cancels it", async () => {
    const h = buildInProcess({ ids: ["turn-1", "cmd-1", "cmd-2"] });
    h.seedSession({ id: "s1", status: "idle" });
    const handler = server(h);
    const taskId = (await send(handler)).json.result.taskId as string;
    await putTurn(h, "s1", "turn-1", "running");
    const { status, json } = await tasks(handler, "tasks/cancel", taskId);
    expect(status).toBe(200);
    expect(json.result).toMatchObject({ resultType: "complete" });
    expect(
      Object.keys(json.result).filter((k) => !k.startsWith("_") && k !== "resultType"),
    ).toEqual([]);
    expect(h.queue.commands.map((c) => c.kind)).toEqual(["prompt", "cancel"]);
  });

  it("tasks/cancel on a settled task is acknowledged and sends nothing", async () => {
    const h = buildInProcess({ ids: ["turn-1", "cmd-1"] });
    h.seedSession({ id: "s1", status: "idle" });
    const handler = server(h);
    const taskId = (await send(handler)).json.result.taskId as string;
    await putTurn(h, "s1", "turn-1", "completed");
    const { json } = await tasks(handler, "tasks/cancel", taskId);
    expect(json.result).toMatchObject({ resultType: "complete" });
    expect(h.queue.commands.map((c) => c.kind)).toEqual(["prompt"]);
  });

  it("tasks/update acknowledges keys it never issued", async () => {
    const h = buildInProcess({ ids: ["turn-1", "cmd-1"] });
    h.seedSession({ id: "s1", status: "running" });
    const handler = server(h);
    const taskId = (await send(handler)).json.result.taskId as string;
    for (const inputResponses of [
      { unknown: { action: "accept", content: { name: "x" } } },
      { other: { roots: [{ uri: "file:///" }] } },
      {},
    ]) {
      const { status, json } = await tasks(handler, "tasks/update", taskId, P, true, {
        inputResponses,
      });
      expect(status).toBe(200);
      expect(json.result).toMatchObject({ resultType: "complete" });
    }
    // And the task is untouched.
    expect((await tasks(handler, "tasks/get", taskId)).json.result.status).toBe("working");
  });

  it("another principal's task id answers Task not found, as a nonexistent one does", async () => {
    const h = buildInProcess({ ids: ["turn-1", "cmd-1"] });
    h.seedSession({ id: "s1", status: "running" });
    const handler = server(h);
    const taskId = (await send(handler)).json.result.taskId as string;
    const missing = taskIdFor("s1", "no-such-turn");
    for (const method of ["tasks/get", "tasks/update", "tasks/cancel"] as const) {
      const theirs = await tasks(handler, method, taskId, OTHER);
      const nothing = await tasks(handler, method, missing, P);
      expect(theirs.json.error).toMatchObject({ code: -32602, message: "Task not found" });
      expect(theirs.json.error).toEqual(nothing.json.error);
      expect(theirs.status).toBe(nothing.status);
    }
    expect(h.queue.commands.map((c) => c.kind)).toEqual(["prompt"]);
  });

  it("a caller without sessions:read gets insufficient_scope from tasks/*, not a task", async () => {
    const h = buildInProcess({ ids: ["turn-1", "cmd-1"] });
    h.seedSession({ id: "s1", status: "running" });
    const handler = server(h);
    const taskId = (await send(handler)).json.result.taskId as string;
    const writeOnly = principal({ scopes: ["sessions:write"] });
    for (const method of ["tasks/get", "tasks/update", "tasks/cancel"] as const) {
      const { json } = await tasks(handler, method, taskId, writeOnly);
      expect(json.error).toMatchObject({
        code: -32600,
        message: expect.stringContaining("insufficient_scope"),
        data: { error: "insufficient_scope", scope: "sessions:read" },
      });
    }
  });

  it("a send by a caller who cannot read answers as without Tasks (no task it could poll)", async () => {
    const h = buildInProcess({ ids: ["turn-1", "cmd-1"] });
    h.seedSession({ id: "s1", status: "running" });
    const { json } = await send(server(h), principal({ scopes: ["sessions:write"] }));
    expect(json.result.resultType).toBe("complete");
    expect(json.result.taskId).toBeUndefined();
    expect(h.queue.commands).toHaveLength(1);
  });

  it("a malformed task id answers Task not found", async () => {
    const h = buildInProcess();
    for (const method of ["tasks/get", "tasks/update", "tasks/cancel"] as const) {
      const { json } = await tasks(server(h), method, "not-a-task");
      expect(json.error).toMatchObject({ code: -32602, message: "Task not found" });
    }
  });

  it("a request that did not declare the extension is refused with -32021", async () => {
    const h = buildInProcess({ ids: ["turn-1", "cmd-1"] });
    h.seedSession({ id: "s1", status: "running" });
    const handler = server(h);
    const taskId = (await send(handler)).json.result.taskId as string;
    for (const method of ["tasks/get", "tasks/update", "tasks/cancel"] as const) {
      const { status, json } = await tasks(handler, method, taskId, P, false, {
        inputResponses: {},
      });
      expect(status).toBe(400);
      expect(json.error).toMatchObject({
        code: -32021,
        data: { requiredCapabilities: { extensions: { "io.modelcontextprotocol/tasks": {} } } },
      });
    }
    expect(h.queue.commands.map((c) => c.kind)).toEqual(["prompt"]);
  });

  it("the refusal does not depend on whether the task exists", async () => {
    const h = buildInProcess();
    const { json } = await tasks(server(h), "tasks/get", taskIdFor("s1", "t1"), OTHER, false);
    expect(json.error.code).toBe(-32021);
  });
});

describe("the extension on the 2025 era", () => {
  async function legacy(handler: ReturnType<typeof server>, method: string, params: object) {
    const res = await handler.handle({
      principal: P,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return JSON.parse(res.body.replace(/^event: message\ndata: /, "")) as RpcAnswer;
  }

  it.each(["tasks/get", "tasks/update", "tasks/cancel"])("%s answers -32601", async (method) => {
    const h = buildInProcess();
    const json = await legacy(server(h), method, { taskId: taskIdFor("s1", "t1") });
    expect(json.error).toMatchObject({ code: -32601 });
  });

  it("kiro_send_prompt is today's result, never a task, even with the capability in params", async () => {
    const h = buildInProcess({ ids: ["turn-1", "cmd-1"] });
    h.seedSession({ id: "s1", status: "running" });
    const json = await legacy(server(h), "tools/call", {
      name: "kiro_send_prompt",
      arguments: { sessionId: "s1", prompt: "go", whenBusy: "queue" },
      _meta: TASKS_CAPABILITY,
    });
    expect(json.result.resultType).toBeUndefined();
    expect(json.result.taskId).toBeUndefined();
    expect(json.result.structuredContent).toMatchObject({ turn: { id: "turn-1" } });
  });
});
