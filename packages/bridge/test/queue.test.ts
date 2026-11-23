/**
 * Queued prompts on the bridge (see the header of lambda-consumer.ts, QUEUED PROMPTS): the order
 * they run in, that each runs once, a steer beside the queue, a delete and an automatic close with
 * a queue, and the failure of a prompt that cannot run. The fake ACP agent is the engine and the
 * real Repository runs over the in-memory DynamoDB.
 */

import type { Command } from "@nikovirtala/kiro-remote-core";
import { describe, expect, test } from "vitest";
import {
  DETACHED_DONE,
  detachedFirstTurn,
  FOLLOW_UP,
  LAUNCH,
  LAUNCH_NEVER_ENDS,
  launch,
  prompt,
  SID,
  SUB,
  wire,
} from "./queue-harness.ts";

type W = Awaited<ReturnType<typeof wire>>;

const queuedStatuses = async (w: W) =>
  Object.fromEntries((await w.repo.listQueuedPrompts(SID)).map((q) => [q.id, q.status]));
const chunksOf = async (w: W, turnId: string) =>
  (await w.repo.queryEvents(SID, 0)).filter(
    (e) => e.turnId === turnId && e.type === "message.chunk",
  );
const feedOf = async (w: W) => (await w.repo.readFeed(SUB, 0, 100)).events;
const deleteCmd = (source?: "webhook" | "rest" | "mcp"): Command => ({
  kind: "delete",
  sub: SUB,
  sessionId: SID,
  commandId: "c-delete",
  ...(source ? { source } : {}),
});
const sentPrompts = (w: W) =>
  w.commands.commands.filter((c): c is Extract<Command, { kind: "prompt" }> => c.kind === "prompt");

describe("queue order and once", () => {
  test("prompts sent to an idle session run one at a time, oldest first, each once", async () => {
    const w = await wire([LAUNCH, FOLLOW_UP]);
    await w.send(launch());
    expect((await w.repo.getSession(SID))?.status).toBe("idle");

    for (const id of ["T1", "T2", "T3"]) {
      await w.repo.putQueuedPrompt({ sessionId: SID, id, prompt: `prompt ${id}` });
      await w.send(prompt(id, "queue"));
    }
    // Only the oldest is on its way: the next two wait behind it.
    expect(sentPrompts(w).map((p) => [p.turnId, p.queued])).toEqual([["T1", true]]);
    expect(await queuedStatuses(w)).toEqual({ T1: "delivered", T2: "queued", T3: "queued" });

    await w.pump();

    expect(await w.turnsInOrder(["T1", "T2", "T3"])).toEqual(["T1", "T2", "T3"]);
    for (const id of ["T1", "T2", "T3"]) {
      expect(await w.repo.getTurn(SID, id)).toMatchObject({
        status: "completed",
        prompt: `prompt ${id}`,
        trigger: { source: "user" },
      });
      expect(await chunksOf(w, id)).toHaveLength(1);
    }
    expect(await queuedStatuses(w)).toEqual({ T1: "started", T2: "started", T3: "started" });
    expect(sentPrompts(w).map((p) => p.turnId)).toEqual(["T1", "T2", "T3"]);
    expect((await w.repo.getSession(SID))?.status).toBe("idle");
  });

  test("a command delivered twice starts the turn once", async () => {
    const w = await wire([LAUNCH, FOLLOW_UP]);
    await w.send(launch());
    await w.repo.putQueuedPrompt({ sessionId: SID, id: "T1", prompt: "prompt T1" });
    await w.send(prompt("T1", "queue"));
    const [command] = sentPrompts(w);
    await w.send(command, "first");
    await w.send(command, "redelivery");
    await w.send(prompt("T1", "queue"), "the queue command again");
    expect(await chunksOf(w, "T1")).toHaveLength(1);
    expect(sentPrompts(w)).toHaveLength(1);
    expect(await queuedStatuses(w)).toEqual({ T1: "started" });
  });

  test("a claimed prompt whose command finds the session busy goes back to the queue, unstarted", async () => {
    const w = await wire([LAUNCH_NEVER_ENDS, DETACHED_DONE, FOLLOW_UP]);
    await detachedFirstTurn(w);
    await w.repo.putQueuedPrompt({ sessionId: SID, id: "T1", prompt: "prompt T1" });
    await w.repo.claimQueuedPrompt(SID, "T1");

    // The command of a drain that ran before the session became busy.
    await w.send({ ...prompt("T1", "reject"), queued: true });
    expect(await queuedStatuses(w)).toEqual({ T1: "queued" });
    expect(await w.repo.getTurn(SID, "T1")).toBeNull();
  });
});

describe("a steer that raced the API's check (the bridge finds the session busy)", () => {
  test("is kept on the queue behind what is in front of it, not rejected, and runs once", async () => {
    const w = await wire([LAUNCH_NEVER_ENDS, DETACHED_DONE, FOLLOW_UP]);
    await detachedFirstTurn(w);

    await w.send(prompt("T1", "queue"));
    await w.send(prompt("Ts", "steer"));
    await w.send(prompt("T2", "queue"));

    // Nothing was rejected: no failure on the event log or the feed, and the steer is on the queue
    // between the two prompts, in the order the commands arrived.
    expect((await w.repo.queryEvents(SID, 0)).filter((e) => e.type === "turn.failed")).toEqual([]);
    expect(await feedOf(w)).toEqual([]);
    expect((await w.repo.listQueuedPrompts(SID)).map((q) => [q.id, q.status])).toEqual([
      ["T1", "queued"],
      ["Ts", "queued"],
      ["T2", "queued"],
    ]);

    await w.consumer.catchUpOnce(w.scheduler.scheduled[0]);
    await w.pump();
    expect(await w.turnsInOrder(["T1", "Ts", "T2"])).toEqual(["T1", "Ts", "T2"]);
    for (const id of ["T1", "Ts", "T2"]) {
      expect(await chunksOf(w, id)).toHaveLength(1);
    }
    // A redelivery of the steer, when it has run and the session is busy again, starts nothing.
    await w.send(prompt("Ts", "steer"), "redelivery");
    expect(await chunksOf(w, "Ts")).toHaveLength(1);
  });

  test("on an idle session with prompts queued it goes behind them and does not start ahead", async () => {
    const w = await wire([LAUNCH, FOLLOW_UP]);
    await w.send(launch());
    await w.repo.putQueuedPrompt({ sessionId: SID, id: "T1", prompt: "prompt T1" });
    await w.send(prompt("Ts", "steer"));
    expect(await w.repo.getTurn(SID, "Ts")).toBeNull();
    await w.pump();
    expect(await w.turnsInOrder(["T1", "Ts"])).toEqual(["T1", "Ts"]);
  });

  test("a steer to an idle session with nothing queued is an ordinary prompt", async () => {
    const w = await wire([LAUNCH, FOLLOW_UP]);
    await w.send(launch());
    await w.send(prompt("Ts", "steer"));
    expect(await w.repo.getTurn(SID, "Ts")).toMatchObject({ status: "completed" });
    expect(await w.repo.listQueuedPrompts(SID)).toEqual([]);
  });

  test("a steer command (not a prompt) on a running turn is still rejected, under the running turn", async () => {
    const w = await wire([LAUNCH_NEVER_ENDS, DETACHED_DONE, FOLLOW_UP]);
    await detachedFirstTurn(w);
    await w.send({ kind: "steer", sub: SUB, sessionId: SID, commandId: "c-s", content: "x" });
    const rejected = (await w.repo.queryEvents(SID, 0)).find(
      (e) => e.rawType === "operation_rejected",
    );
    expect(rejected).toMatchObject({ type: "turn.failed" });
    expect(await w.repo.listQueuedPrompts(SID)).toEqual([]);
  });
});

describe("deleting a session with a queue", () => {
  test("a delete by the caller fails each queued prompt first, and none of them runs", async () => {
    const w = await wire([LAUNCH_NEVER_ENDS, DETACHED_DONE, FOLLOW_UP]);
    await detachedFirstTurn(w);
    await w.send(prompt("T1", "queue"));
    await w.send(prompt("T2", "queue"));

    await w.send(deleteCmd("mcp"));

    expect((await w.repo.getSession(SID))?.status).toBe("deleted");
    expect(await queuedStatuses(w)).toEqual({ T1: "failed", T2: "failed" });
    const failedEvents = (await w.repo.queryEvents(SID, 0)).filter(
      (e) => e.rawType === "queued_prompt_failed",
    );
    expect(failedEvents.map((e) => e.turnId)).toEqual(["T1", "T2"]);
    expect((await feedOf(w)).map((e) => [e.type, e.source, e.payload])).toEqual([
      ["prompt.failed", "mcp", { turnId: "T1", whenBusy: "queue", reason: "session_deleted" }],
      ["prompt.failed", "mcp", { turnId: "T2", whenBusy: "queue", reason: "session_deleted" }],
    ]);
    await w.pump();
    expect(await w.repo.getTurn(SID, "T1")).toBeNull();
  });

  test("a prompt that arrives after the delete fails too", async () => {
    const w = await wire([LAUNCH]);
    await w.send(launch());
    await w.send(deleteCmd());
    await w.repo.putQueuedPrompt({ sessionId: SID, id: "T9", prompt: "late" });
    await w.send(prompt("T9", "queue"));
    expect(await queuedStatuses(w)).toEqual({ T9: "failed" });
    expect((await w.repo.getQueuedPrompt(SID, "T9"))?.failReason).toBe("session_deleted");
  });
});

describe("an automatic close waits for the queue", () => {
  test("a delete from the webhook is refused while prompts are queued, and owed", async () => {
    const w = await wire([LAUNCH_NEVER_ENDS, DETACHED_DONE, FOLLOW_UP]);
    await detachedFirstTurn(w);
    await w.send(prompt("T1", "queue"));

    await w.send(deleteCmd("webhook"));
    const session = await w.repo.getSession(SID);
    expect(session?.status).toBe("running");
    expect(session?.closeAfterQueue).toBe(true);
    expect(await queuedStatuses(w)).toEqual({ T1: "queued" });

    // The turn ends, the prompt runs, and only then is the close asked for again.
    await w.consumer.catchUpOnce(w.scheduler.scheduled[0]);
    const closesSoFar = w.githubQueue.sent.filter((m) => m.kind === "harvest" && m.autoClose);
    expect(closesSoFar).toEqual([]);
    await w.pump();
    expect(await w.repo.getTurn(SID, "T1")).toMatchObject({ status: "completed" });
    const closes = w.githubQueue.sent.filter((m) => m.kind === "harvest" && m.autoClose);
    expect(closes).toEqual([
      {
        kind: "harvest",
        sessionId: SID,
        turnId: "T1",
        afterSeq: expect.any(Number),
        autoClose: true,
      },
    ]);
    expect((await w.repo.getSession(SID))?.closeAfterQueue).toBe(false);
  });

  test("a post-merge turn that ends with prompts queued asks for no close: it runs them, then asks", async () => {
    const w = await wire([LAUNCH, FOLLOW_UP]);
    await w.send(launch());
    w.githubQueue.sent.length = 0;
    await w.repo.putQueuedPrompt({ sessionId: SID, id: "T1", prompt: "prompt T1" });

    await w.send({
      kind: "prompt",
      sub: SUB,
      sessionId: SID,
      commandId: "c-merge",
      turnId: "T-merge",
      prompt: "[GitHub webhook] merged",
      whenBusy: "reject",
      trigger: { source: "github", deliveryIds: ["d-m"], inboxIds: [], autoClose: true },
    });
    // The merge turn settled with a prompt queued: a plain harvest, the close is owed.
    expect(w.githubQueue.sent).toEqual([
      { kind: "harvest", sessionId: SID, turnId: "T-merge", afterSeq: expect.any(Number) },
    ]);
    expect((await w.repo.getSession(SID))?.closeAfterQueue).toBe(true);

    await w.pump();
    expect(await w.repo.getTurn(SID, "T1")).toMatchObject({ status: "completed" });
    expect(
      w.githubQueue.sent.map((m) => [
        m.kind,
        "turnId" in m ? m.turnId : "",
        "autoClose" in m ? m.autoClose : false,
      ]),
    ).toEqual([
      ["harvest", "T-merge", false],
      ["harvest", "T1", true],
    ]);
  });

  test("without a queue the close is asked for as before", async () => {
    const w = await wire([LAUNCH, FOLLOW_UP]);
    await w.send(launch());
    w.githubQueue.sent.length = 0;
    await w.send({
      kind: "prompt",
      sub: SUB,
      sessionId: SID,
      commandId: "c-merge",
      turnId: "T-merge",
      prompt: "[GitHub webhook] merged",
      whenBusy: "reject",
      trigger: { source: "github", deliveryIds: ["d-m"], inboxIds: [], autoClose: true },
    });
    expect(w.githubQueue.sent).toEqual([
      {
        kind: "harvest",
        sessionId: SID,
        turnId: "T-merge",
        afterSeq: expect.any(Number),
        autoClose: true,
      },
    ]);
  });
});

describe("a prompt that cannot run fails where the caller sees it", () => {
  test("a session that never provisioned fails its queued prompts with session_failed", async () => {
    const w = await wire([{ initialize: LAUNCH.initialize, emptyNewSessionId: true }]);
    await w.repo.putQueuedPrompt({ sessionId: SID, id: "T1", prompt: "prompt T1" });
    await w.send(launch());
    expect((await w.repo.getSession(SID))?.status).toBe("failed");
    expect(await w.repo.getQueuedPrompt(SID, "T1")).toMatchObject({
      status: "failed",
      failReason: "session_failed",
    });
    expect((await feedOf(w)).map((e) => [e.type, e.source, e.payload])).toEqual([
      ["prompt.failed", "bridge", { turnId: "T1", whenBusy: "queue", reason: "session_failed" }],
    ]);
    expect(
      (await w.repo.queryEvents(SID, 0)).filter((e) => e.rawType === "queued_prompt_failed"),
    ).toHaveLength(1);
  });
});
