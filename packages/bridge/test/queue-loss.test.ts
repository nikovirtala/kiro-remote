/**
 * The two ways a prompt sent with `whenBusy: "queue"` was lost on 23 November 2026, reproduced on
 * the bridge with the fake ACP agent as the engine and the real Repository over the in-memory
 * DynamoDB.
 *
 * Both start the same way. A launch (or a follow-up) turn runs longer than one Lambda invocation,
 * so it detaches and the session stays `running` while a catch-up waits for the turn. The FIFO
 * group is blocked behind the invocation that ran the turn, so the commands sent meanwhile are
 * delivered only after it detached, to a session that is `running`. The consumer rejected every
 * one of them (`steer_queue_unsupported_cloud`), and nothing ever started them.
 *
 *  - Session 01M84N1Z...: one queued prompt (turn 01M84N39...) behind the first turn.
 *  - Session 01M84TV2...: two queued prompts and a steer behind a turn, then the pull request
 *    merged and the post-merge wake (autoCloseOnMerge) found nothing left to wait for.
 *
 * Each test asserts what the caller was promised: a queued prompt runs as a turn after the turn in
 * front of it, once and in order.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Command,
  type CommandQueue,
  type GithubQueue,
  type GithubQueueMessage,
  type InboxItem,
  inboxSk,
  Repository,
  sessionPk,
} from "@nikovirtala/kiro-remote-core";
import { MemoryDdb, MemoryS3, sessionItem } from "@nikovirtala/kiro-remote-core/testing";
import { describe, expect, test } from "vitest";
import type { CatchUpMessage, CatchUpScheduler } from "../src/catch-up.ts";
import { LambdaConsumer, type SQSEvent } from "../src/lambda-consumer.ts";
import { createLogger } from "../src/logger.ts";
import { CollectingMetricSink } from "../src/metrics.ts";
import { fakeAgentSpawner } from "./fake-agent-spawn.ts";
import { initResult } from "./scenarios.ts";

const CLOUD_ID = "sess_08047063-f7b4-4ce5-b79a-2aea9a7a1d29";
const SID = "SQLOSS1";
const SUB = "user-sub-1";

const notify = (params: Record<string, unknown>) => ({
  kind: "notify",
  method: "session/update",
  params,
});
const info = (kind: string, extra: Record<string, unknown> = {}) =>
  notify({ sessionUpdate: "session_info_update", _meta: { kiro: { kind } }, ...extra });
const chunk = (text: string) =>
  notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const completion = () => info("turn_completion", { status: "end_turn" });

/** The first turn: it never ends within the invocation, so the consumer detaches. */
const LAUNCH_NEVER_ENDS = {
  initialize: initResult(),
  newSessionId: CLOUD_ID,
  onPrompt: { messages: [info("turn_start"), chunk("Hello wo")], neverRespond: true },
};
/** What the catch-up loads: the replay of the detached turn, now finished. */
const DETACHED_DONE = {
  initialize: initResult(),
  onLoad: {
    replayBeforeResponse: true,
    messages: [info("turn_start"), chunk("Hello world"), completion(), info("turn_end")],
  },
};
/** A follow-up turn that runs to its end. */
const FOLLOW_UP = {
  initialize: initResult(),
  onLoad: {
    replayBeforeResponse: true,
    messages: [info("turn_start"), chunk("old"), info("turn_end")],
  },
  onPrompt: {
    messages: [info("turn_start"), chunk("Done."), completion(), info("turn_end")],
    response: { stopReason: "end_turn" },
  },
};

class Commands implements CommandQueue {
  commands: Command[] = [];
  async enqueue(c: Command) {
    this.commands.push(c);
  }
}
class GithubQ implements GithubQueue {
  sent: GithubQueueMessage[] = [];
  async send(m: GithubQueueMessage) {
    this.sent.push(m);
  }
}
class Scheduler implements CatchUpScheduler {
  scheduled: CatchUpMessage[] = [];
  async start(msg: CatchUpMessage) {
    this.scheduled.push(msg);
  }
}

const ev = (c: Command | CatchUpMessage, id = "m"): SQSEvent => ({
  Records: [{ messageId: id, body: JSON.stringify(c) }],
});

async function wire(scenarios: unknown[]) {
  const ddb = new MemoryDdb();
  const s3 = new MemoryS3();
  const repo = new Repository({
    ddb: ddb as never,
    s3: s3 as never,
    tableName: "t",
    bucketName: "b",
  });
  const commands = new Commands();
  const githubQueue = new GithubQ();
  const scheduler = new Scheduler();
  const workspaceRoot = await mkdtemp(join(tmpdir(), "kiro-remote-queue-loss-"));
  let clock = 1_000;
  const consumer = await LambdaConsumer.create({
    config: { tableName: "t", bucketName: "b", workspaceRoot, region: "us-east-1" },
    ddb: ddb as never,
    s3: s3 as never,
    spawnFn: fakeAgentSpawner(scenarios).spawnFn,
    catchUpScheduler: scheduler,
    commandQueue: commands,
    githubQueue,
    detachMarginMs: 100,
    logger: createLogger({ level: "debug", sink: () => {} }),
    metricSink: new CollectingMetricSink(),
    env: { KIRO_API_KEY: "ksk_test_key" },
    now: () => (clock += 1),
  });
  ddb.put(sessionItem(SID, { status: "provisioning", kiroSessionId: null, repos: ["octo/repo"] }));
  let delivered = 0;
  return {
    consumer,
    repo,
    commands,
    githubQueue,
    scheduler,
    /** Deliver what the system enqueued since the last call, as the command queue would. */
    async pump() {
      while (delivered < commands.commands.length) {
        const c = commands.commands[delivered++];
        await consumer.handleEvent(ev(c, `m-${delivered}`));
      }
    },
    send: (c: Command, id?: string) => consumer.handleEvent(ev(c, id)),
    /** The turn ids that ran, in the order they started. */
    async turnsInOrder(ids: string[]) {
      return (await Promise.all(ids.map((id) => repo.getTurn(SID, id))))
        .filter((t) => t !== null)
        .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
        .map((t) => t.id);
    },
    async addInbox(id: string, over: Partial<InboxItem> = {}) {
      await repo.putInboxItem({
        PK: sessionPk(SID),
        SK: inboxSk(id),
        id,
        sessionId: SID,
        source: "github",
        deliveryId: `d-${id}`,
        deliveryIds: [`d-${id}`],
        kind: "pr_merged",
        key: "octo/repo#7",
        prompt: `[GitHub webhook] wake ${id}`,
        data: null,
        createdAt: new Date(0).toISOString(),
        notBefore: new Date(0).toISOString(),
        status: "pending",
        dropReason: null,
        deliveredTurnId: null,
        autoClose: false,
        ttl: 9_999_999_999,
        ...over,
      });
    },
  };
}
const launch = (): Command => ({
  kind: "launch",
  sub: SUB,
  sessionId: SID,
  commandId: "c-launch",
  prompt: "first",
  repos: ["octo/repo"],
});
const prompt = (turnId: string, whenBusy: "steer" | "queue" | "reject"): Command => ({
  kind: "prompt",
  sub: SUB,
  sessionId: SID,
  commandId: `c-${turnId}`,
  turnId,
  prompt: `prompt ${turnId}`,
  whenBusy,
});

/** The launch turn detaches: the session stays `running` and a catch-up is scheduled. */
async function detachedFirstTurn(w: Awaited<ReturnType<typeof wire>>) {
  await w.consumer.handleEvent(ev(launch()), { remainingTimeMs: () => 300 });
  expect((await w.repo.getSession(SID))?.status).toBe("running");
  expect(w.scheduler.scheduled).toHaveLength(1);
}

describe("a queued prompt behind a turn that detached", () => {
  test("01M84N1Z: the prompt runs as a turn once the first turn has ended", async () => {
    const w = await wire([LAUNCH_NEVER_ENDS, DETACHED_DONE, FOLLOW_UP]);
    await detachedFirstTurn(w);

    // Delivered to a running session, as the FIFO group delivers it after the launch invocation.
    await w.send(prompt("T-q1", "queue"));

    // The first turn ends (the catch-up sees its turn_end); the session is idle again.
    await w.consumer.catchUpOnce(w.scheduler.scheduled[0]);
    expect((await w.repo.getSession(SID))?.status).toBe("idle");
    await w.pump();

    expect(await w.repo.getTurn(SID, "T-q1")).toMatchObject({
      status: "completed",
      trigger: { source: "user" },
    });
    // It ran once: one reply in its events.
    const chunks = (await w.repo.queryEvents(SID, 0)).filter(
      (e) => e.turnId === "T-q1" && e.type === "message.chunk",
    );
    expect(chunks).toHaveLength(1);
    expect((await w.repo.getSession(SID))?.status).toBe("idle");
  });
});

describe("two queued prompts and a steer behind a turn, then a merge", () => {
  test("01M84TV2: both prompts run in order, before the post-merge wake that closes the session", async () => {
    const w = await wire([LAUNCH_NEVER_ENDS, DETACHED_DONE, FOLLOW_UP, FOLLOW_UP, FOLLOW_UP]);
    await detachedFirstTurn(w);

    // The three arrive together once the invocation that ran the turn has detached.
    await w.send(prompt("T-q1", "queue"));
    await w.send(prompt("T-q2", "queue"));
    await w.send(prompt("T-s", "steer"));
    // The linked pull request merged meanwhile: a wake that closes the session after its turn.
    await w.addInbox("01MERGED", { autoClose: true });

    await w.consumer.catchUpOnce(w.scheduler.scheduled[0]);
    await w.pump();

    // The queued prompts ran, in the order they were sent, ahead of the wake.
    const wake = (await w.repo.queryInbox(SID))[0];
    expect(wake.deliveredTurnId).not.toBeNull();
    const wakeTurnId = String(wake.deliveredTurnId);
    expect(await w.turnsInOrder(["T-q1", "T-q2", wakeTurnId])).toEqual([
      "T-q1",
      "T-q2",
      wakeTurnId,
    ]);
    for (const id of ["T-q1", "T-q2"]) {
      expect(await w.repo.getTurn(SID, id)).toMatchObject({ status: "completed" });
    }

    // Only the last turn asks for the close: nothing was queued behind it.
    const closes = w.githubQueue.sent.filter((m) => m.kind === "harvest" && m.autoClose === true);
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({ turnId: wakeTurnId });
  });
});
