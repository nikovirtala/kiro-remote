/**
 * Interop: the Tasks requester published with the extension
 * (@modelcontextprotocol/ext-tasks/client, not code of this repo) drives this
 * server over /mcp and over stdio, against turn records that move from queued
 * to running to completed (and, in one case, to failed).
 *
 * The requester decides when to poll and how to read the answers; the server
 * is only asked what a real client would ask.
 */

import { resultFromTaskOutcome, withTasks } from "@modelcontextprotocol/ext-tasks/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { sessionPk, turnSk } from "@nikovirtala/kiro-remote-core";
import { describe, expect, it, vi } from "vitest";
import { createHttpTransportHandler } from "../src/http-transport.ts";
import { createMcpServerFactory } from "../src/server.ts";
import { buildInProcess, type InProcHarness, principal, type RpcAnswer } from "./helpers.ts";
import { httpPort, pipePort } from "./tasks-port.ts";

const P = principal();
/** Fast enough for a test; the requester floors the hint at 10 ms. */
const TASKS = { defaultPollIntervalMs: 10 } as const;

const SESSION = "01KB0SESSION00000000SESSION1";
const TURN = "01KB0TURN0000000000000TURN1";

/**
 * The bridge, played by the test: every time the server reads the turn, the
 * records move one step on (queued, running, then settled), the way they do
 * while a real turn runs.
 */
function scriptedTurn(h: InProcHarness, settle: "completed" | "failed") {
  h.seedSession({ id: SESSION, status: "running" });
  const reads: string[] = [];
  const realGetTurn = h.client.getTurn.bind(h.client);
  let step = 0;
  h.client.getTurn = async (who, sessionId, turnId) => {
    const answer = await realGetTurn(who, sessionId, turnId);
    reads.push(answer?.status ?? "none");
    step++;
    if (step === 1) {
      await h.repo.claimQueuedPrompt(SESSION, TURN);
      await h.repo.startQueuedPrompt(SESSION, TURN);
      await putTurn(h, "running");
    } else if (step === 2) {
      h.seedEvent(SESSION, 1, {
        turnId: TURN,
        payload: { content: { type: "text", text: "Renamed the flag " } },
      });
      h.seedEvent(SESSION, 2, {
        turnId: TURN,
        payload: { content: { type: "text", text: "and updated the docs." } },
      });
      await putTurn(h, settle, settle === "failed" ? "sandbox_crashed" : null);
    }
    return answer;
  };
  return reads;
}

async function putTurn(h: InProcHarness, status: string, stopReason: string | null = null) {
  await h.repo.putTurn({
    PK: sessionPk(SESSION),
    SK: turnSk(TURN),
    id: TURN,
    sessionId: SESSION,
    prompt: "rename the flag",
    status: status as never,
    stopReason,
    startedAt: "2026-11-26T12:00:01.000Z",
    endedAt: status === "running" ? null : "2026-11-26T12:00:09.000Z",
    metering: null,
  });
}

const sendArgs = { sessionId: SESSION, prompt: "rename the flag", whenBusy: "queue" };

function newHarness() {
  return buildInProcess({ ids: [TURN, "cmd-1", "cmd-2"] });
}

describe("ext-tasks requester over /mcp", () => {
  it("kiro_send_prompt is a task, polled queued -> running -> completed, and its result is the turn's text", async () => {
    const h = newHarness();
    const reads = scriptedTurn(h, "completed");
    const handler = createHttpTransportHandler({ client: h.client, tasks: TASKS });
    const session = withTasks(httpPort(handler, P));

    const execution = await session.callTool("kiro_send_prompt", sendArgs);
    expect(execution.kind).toBe("task");

    const seen: string[] = [];
    const { outcome } = await execution.settle({
      onEvent: (event) => {
        if (event.type === "task") seen.push(event.task.status);
      },
    });
    expect(outcome.status).toBe("completed");
    const result = resultFromTaskOutcome(outcome) as {
      content: { type: string; text: string }[];
      structuredContent: unknown;
    };
    expect(result.content).toEqual([
      { type: "text", text: "Renamed the flag and updated the docs." },
    ]);
    expect(result.structuredContent).toEqual({
      sessionId: SESSION,
      turnId: TURN,
      status: "completed",
      text: "Renamed the flag and updated the docs.",
    });
    // The turn was read while queued, while running and when completed.
    expect(reads).toEqual(expect.arrayContaining(["queued", "running", "completed"]));
    expect(seen).toContain("working");
    // The prompt was sent once; the requester never called the wait / transcript tools.
    expect(h.queue.commands.map((c) => c.kind)).toEqual(["prompt"]);
    await session.close();
  });

  it("a turn that fails settles the task as failed with the error", async () => {
    const h = newHarness();
    scriptedTurn(h, "failed");
    const handler = createHttpTransportHandler({ client: h.client, tasks: TASKS });
    const session = withTasks(httpPort(handler, P));

    const execution = await session.callTool("kiro_send_prompt", sendArgs);
    const { outcome } = await execution.settle();
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.message).toContain("sandbox_crashed");
      expect(outcome.error.code).toBe(-32603);
    }
    await session.close();
  });

  it("cancelling through the requester asks the session to cancel the running turn", async () => {
    const h = newHarness();
    h.seedSession({ id: SESSION, status: "running" });
    const handler = createHttpTransportHandler({ client: h.client, tasks: TASKS });
    const session = withTasks(httpPort(handler, P));
    const execution = await session.callTool("kiro_send_prompt", sendArgs);
    expect(execution.kind).toBe("task");
    // The turn starts running, then the caller cancels.
    await h.repo.claimQueuedPrompt(SESSION, TURN);
    await h.repo.startQueuedPrompt(SESSION, TURN);
    await putTurn(h, "running");
    await execution.cancel();
    expect(h.queue.commands.map((c) => c.kind)).toEqual(["prompt", "cancel"]);
    await execution.detach();
    await session.close();
  });

  it("another principal's requester cannot read the task", async () => {
    const h = newHarness();
    h.seedSession({ id: SESSION, status: "running" });
    const handler = createHttpTransportHandler({ client: h.client, tasks: TASKS });
    const mine = withTasks(httpPort(handler, P));
    const execution = await mine.callTool("kiro_send_prompt", sendArgs);
    if (execution.kind !== "task") throw new Error("expected a task");
    const theirs = withTasks(httpPort(handler, principal({ sub: "user-2" })));
    await expect(theirs.task(execution.handle.taskId).snapshot()).rejects.toThrow(/Task not found/);
    await execution.detach();
    await mine.close();
    await theirs.close();
  });
});

describe("ext-tasks requester over stdio", () => {
  async function stdioPort(h: InProcHarness, who = P) {
    const [server, peer] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(
      createMcpServerFactory({ client: h.client, principal: () => who, tasks: TASKS }),
      { transport: server },
    );
    const inbox: RpcAnswer[] = [];
    peer.onmessage = (m) => {
      inbox.push(m as RpcAnswer);
    };
    await peer.start();
    let id = 0;
    const ask = async (message: Record<string, unknown>) => {
      const mine = ++id;
      await peer.send({ ...message, id: mine } as never);
      await vi.waitFor(() => expect(inbox.some((m) => m.id === mine)).toBe(true));
      return inbox.find((m) => m.id === mine) as RpcAnswer;
    };
    return { port: pipePort(ask), close: () => handle.close() };
  }

  it("kiro_send_prompt is a task, polled queued -> running -> completed, with the turn's text", async () => {
    const h = newHarness();
    const reads = scriptedTurn(h, "completed");
    const { port, close } = await stdioPort(h);
    const session = withTasks(port);
    const execution = await session.callTool("kiro_send_prompt", sendArgs);
    expect(execution.kind).toBe("task");
    const { outcome } = await execution.settle();
    expect(outcome.status).toBe("completed");
    expect(resultFromTaskOutcome(outcome)).toMatchObject({
      content: [{ type: "text", text: "Renamed the flag and updated the docs." }],
    });
    expect(reads).toEqual(expect.arrayContaining(["queued", "running", "completed"]));
    await session.close();
    await close();
  });

  it("a failed turn settles the task as failed", async () => {
    const h = newHarness();
    scriptedTurn(h, "failed");
    const { port, close } = await stdioPort(h);
    const session = withTasks(port);
    const execution = await session.callTool("kiro_send_prompt", sendArgs);
    const { outcome } = await execution.settle();
    expect(outcome.status).toBe("failed");
    await session.close();
    await close();
  });
});
