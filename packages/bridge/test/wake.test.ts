/**
 * Bridge integration tests for the wake path, with the fake ACP agent as the
 * engine and the real Repository over the in-memory DynamoDB:
 *   - a turn settles -> the inbox is drained -> a wake turn runs,
 *   - the same from a catch-up settle,
 *   - a wake that finds the session busy puts its items back,
 *   - autoCloseOnMerge deletes the session after the post-merge turn,
 *   - a failed launch drops pending wakes,
 *   - with the feature off nothing extra happens.
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
const SID = "SWAKE1";

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

const LAUNCH = {
  initialize: initResult(),
  newSessionId: CLOUD_ID,
  onPrompt: {
    messages: [
      info("turn_start"),
      chunk("Opened https://github.com/octo/repo/pull/7"),
      completion(),
      info("turn_end"),
    ],
    response: { stopReason: "end_turn" },
  },
};
const LAUNCH_NEVER_ENDS = {
  initialize: initResult(),
  newSessionId: CLOUD_ID,
  onPrompt: { messages: [info("turn_start"), chunk("Hello wo")], neverRespond: true },
};
const WAKE_TURN = {
  initialize: initResult(),
  onLoad: {
    replayBeforeResponse: true,
    messages: [info("turn_start"), chunk("old"), info("turn_end")],
  },
  onPrompt: {
    messages: [info("turn_start"), chunk("Thanks, wrapping up."), completion(), info("turn_end")],
    response: { stopReason: "end_turn" },
  },
};
const DETACHED_DONE = [info("turn_start"), chunk("Hello world"), completion(), info("turn_end")];

class Commands implements CommandQueue {
  commands: Command[] = [];
  async enqueue(c: Command) {
    this.commands.push(c);
  }
  prompts() {
    return this.commands.filter(
      (c): c is Extract<Command, { kind: "prompt" }> => c.kind === "prompt",
    );
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
  async schedule(msg: CatchUpMessage) {
    this.scheduled.push(msg);
  }
}

async function wire(scenarios: unknown[], opts: { wake?: boolean; detachMarginMs?: number } = {}) {
  const wake = opts.wake ?? true;
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
  const metrics = new CollectingMetricSink();
  const logLines: string[] = [];
  const workspaceRoot = await mkdtemp(join(tmpdir(), "kiro-remote-wake-"));
  let clock = 1_000;
  const consumer = await LambdaConsumer.create({
    config: {
      tableName: "t",
      bucketName: "b",
      workspaceRoot,
      catchUpQueueUrl: "https://sqs.test/cu",
      region: "us-east-1",
    },
    ddb: ddb as never,
    s3: s3 as never,
    spawnFn: fakeAgentSpawner(scenarios).spawnFn,
    catchUpScheduler: scheduler,
    ...(wake ? { commandQueue: commands, githubQueue } : {}),
    ...(opts.detachMarginMs !== undefined ? { detachMarginMs: opts.detachMarginMs } : {}),
    logger: createLogger({ level: "debug", sink: (l) => logLines.push(l) }),
    metricSink: metrics,
    env: { KIRO_API_KEY: "ksk_test_key" },
    now: () => (clock += 1),
  });
  ddb.put(sessionItem(SID, { status: "provisioning", kiroSessionId: null, repos: ["octo/repo"] }));
  const addInbox = async (id: string, over: Partial<InboxItem> = {}) =>
    repo.putInboxItem({
      PK: sessionPk(SID),
      SK: inboxSk(id),
      id,
      sessionId: SID,
      source: "github",
      deliveryId: `d-${id}`,
      deliveryIds: [`d-${id}`],
      kind: "review",
      key: "octo/repo#7",
      prompt: `[GitHub webhook] This turn was started by GitHub, not by the user: wake ${id}`,
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
  return { consumer, repo, ddb, commands, githubQueue, scheduler, metrics, logLines, addInbox };
}

const ev = (c: Command | CatchUpMessage, id = "m"): SQSEvent => ({
  Records: [{ messageId: id, body: JSON.stringify(c) }],
});
const launchCmd = (): Command => ({
  kind: "launch",
  sub: "user-sub-1",
  sessionId: SID,
  commandId: "c-launch",
  prompt: "open a PR",
  repos: ["octo/repo"],
});
const inboxStatuses = async (repo: Repository) =>
  Object.fromEntries((await repo.queryInbox(SID)).map((i) => [i.id, i.status]));

describe("a turn settles and the inbox is drained", () => {
  test("pending wake items become one wake prompt turn, which then runs with its trigger recorded", async () => {
    const w = await wire([LAUNCH, WAKE_TURN]);
    await w.addInbox("01A");
    await w.addInbox("01B");

    await w.consumer.handleEvent(ev(launchCmd()));

    // The launch turn is recorded as a user turn and completed.
    const session = await w.repo.getSession(SID);
    expect(session?.status).toBe("idle");
    const [launchTurnId] = w.githubQueue.sent.map((m) => (m.kind === "harvest" ? m.turnId : ""));
    expect(await w.repo.getTurn(SID, launchTurnId)).toMatchObject({
      status: "completed",
      stopReason: "end_turn",
      trigger: { source: "user", deliveryIds: [] },
    });
    // The settle asked the GitHub consumer to harvest the turn's PR links.
    expect(w.githubQueue.sent).toEqual([
      { kind: "harvest", sessionId: SID, turnId: launchTurnId, afterSeq: 0 },
    ]);

    // ...and drained the inbox: ONE prompt for both items, claimed for that turn.
    expect(w.commands.prompts()).toHaveLength(1);
    const wake = w.commands.prompts()[0];
    expect(wake).toMatchObject({
      whenBusy: "reject",
      trigger: { source: "github", deliveryIds: ["d-01A", "d-01B"] },
    });
    expect(wake.prompt).toContain("wake 01A");
    expect(wake.prompt).toContain("wake 01B");
    expect(await inboxStatuses(w.repo)).toEqual({ "01A": "delivered", "01B": "delivered" });
    expect(w.metrics.sum("WakesDelivered")).toBe(2);

    // The wake command is processed like any other prompt and the turn runs.
    const res = await w.consumer.handleEvent(ev(wake, "m-wake"));
    expect(res.batchItemFailures).toEqual([]);
    const wakeTurn = await w.repo.getTurn(SID, wake.turnId);
    expect(wakeTurn).toMatchObject({
      status: "completed",
      trigger: { source: "github", deliveryIds: ["d-01A", "d-01B"], inboxIds: ["01A", "01B"] },
    });
    expect(wakeTurn?.prompt).toContain("This turn was started by GitHub");
    const events = (await w.repo.queryEvents(SID, 0)).filter((e) => e.turnId === wake.turnId);
    expect(events[0]).toMatchObject({ type: "session.info", rawType: "turn_started" });
    expect(
      ((events[0].payload as { payload: unknown }).payload as { trigger: unknown }).trigger,
    ).toEqual({
      source: "github",
      deliveryIds: ["d-01A", "d-01B"],
    });
    expect(events.some((e) => e.type === "message.chunk")).toBe(true);
    expect((await w.repo.getSession(SID))?.status).toBe("idle");
    // Nothing left to drain, so no further wake.
    expect(w.commands.prompts()).toHaveLength(1);
  });

  test("a settle with nothing pending starts nothing", async () => {
    const w = await wire([LAUNCH]);
    await w.consumer.handleEvent(ev(launchCmd()));
    expect(w.commands.commands).toEqual([]);
  });

  test("items that are not due yet are left for a later drain", async () => {
    const w = await wire([LAUNCH]);
    await w.addInbox("01A", { notBefore: new Date(Date.now() + 3_600_000).toISOString() });
    await w.consumer.handleEvent(ev(launchCmd()));
    expect(w.commands.commands).toEqual([]);
    expect(await inboxStatuses(w.repo)).toEqual({ "01A": "pending" });
  });

  test("the catch-up settle path drains too", async () => {
    const w = await wire(
      [
        LAUNCH_NEVER_ENDS,
        {
          initialize: initResult(),
          onLoad: { replayBeforeResponse: true, messages: DETACHED_DONE },
        },
      ],
      { detachMarginMs: 100 },
    );
    await w.addInbox("01A");
    await w.consumer.handleEvent(ev(launchCmd()), { remainingTimeMs: () => 300 });
    // Detached: the session is still running, so nothing was drained or harvested yet.
    expect((await w.repo.getSession(SID))?.status).toBe("running");
    expect(w.commands.commands).toEqual([]);
    expect(w.githubQueue.sent).toEqual([]);
    expect(w.scheduler.scheduled).toHaveLength(1);

    await w.consumer.handleEvent(ev(w.scheduler.scheduled[0], "m-cu"));
    expect((await w.repo.getSession(SID))?.status).toBe("idle");
    expect(w.githubQueue.sent).toEqual([
      { kind: "harvest", sessionId: SID, turnId: w.scheduler.scheduled[0].turnId, afterSeq: 0 },
    ]);
    expect(w.commands.prompts()).toHaveLength(1);
    expect(w.commands.prompts()[0].trigger?.deliveryIds).toEqual(["d-01A"]);
    expect(await w.repo.getTurn(SID, w.scheduler.scheduled[0].turnId)).toMatchObject({
      status: "completed",
    });
  });

  test("a failed turn also returns the session to idle and drains", async () => {
    const w = await wire([
      LAUNCH,
      { initialize: initResult(), onLoad: { error: { code: -32603, message: "load failed" } } },
    ]);
    await w.consumer.handleEvent(ev(launchCmd()));
    await w.consumer.handleEvent(
      ev({
        kind: "prompt",
        sub: "user-sub-1",
        sessionId: SID,
        commandId: "c2",
        turnId: "T-manual",
        prompt: "again",
        whenBusy: "steer",
      }),
    );
    expect((await w.repo.getSession(SID))?.status).toBe("idle");
    expect(await w.repo.getTurn(SID, "T-manual")).toMatchObject({
      status: "failed",
      trigger: { source: "user" },
    });
    await w.addInbox("01A");
    // The next settle (here: another failed turn) drains what arrived meanwhile.
    await w.consumer.handleEvent(
      ev({
        kind: "prompt",
        sub: "user-sub-1",
        sessionId: SID,
        commandId: "c3",
        turnId: "T-manual-2",
        prompt: "again",
        whenBusy: "steer",
      }),
    );
    expect(w.commands.prompts().filter((p) => p.trigger?.source === "github")).toHaveLength(1);
  });
});

describe("a wake that cannot start", () => {
  test("a wake turn that finds the session busy puts its items back to pending", async () => {
    const w = await wire([LAUNCH_NEVER_ENDS], { detachMarginMs: 100 });
    await w.consumer.handleEvent(ev(launchCmd()), { remainingTimeMs: () => 300 }); // detached: running
    await w.addInbox("01A", { status: "delivered", deliveredTurnId: "T-wake" });

    const res = await w.consumer.handleEvent(
      ev({
        kind: "prompt",
        sub: "user-sub-1",
        sessionId: SID,
        commandId: "c-wake",
        turnId: "T-wake",
        prompt: "[GitHub webhook] wake",
        whenBusy: "reject",
        trigger: { source: "github", deliveryIds: ["d-01A"], inboxIds: ["01A"] },
      }),
    );
    expect(res.batchItemFailures).toEqual([]);
    expect(await inboxStatuses(w.repo)).toEqual({ "01A": "pending" });
    expect(await w.repo.getTurn(SID, "T-wake")).toBeNull(); // no turn started
    expect((await w.repo.getSession(SID))?.status).toBe("running");
  });

  test("a failed launch drops pending wakes with the reason", async () => {
    const w = await wire([{ initialize: initResult(), emptyNewSessionId: true }]);
    await w.addInbox("01A");
    await w.consumer.handleEvent(ev(launchCmd()));
    expect((await w.repo.getSession(SID))?.status).toBe("failed");
    const [item] = await w.repo.queryInbox(SID);
    expect(item).toMatchObject({ status: "dropped", dropReason: "session_failed" });
    expect(w.metrics.sum("WakesDropped")).toBe(1);
    expect(w.commands.commands).toEqual([]);
  });

  test("deleting a session drops its pending wakes", async () => {
    const w = await wire([LAUNCH]);
    await w.consumer.handleEvent(ev(launchCmd()));
    await w.addInbox("01A");
    await w.consumer.handleEvent(
      ev({ kind: "delete", sub: "user-sub-1", sessionId: SID, commandId: "c-del" }),
    );
    expect(await inboxStatuses(w.repo)).toEqual({ "01A": "dropped" });
    expect((await w.repo.queryInbox(SID))[0].dropReason).toBe("session_deleted");
  });
});

describe("autoCloseOnMerge", () => {
  const mergedWake = (extra: Record<string, unknown> = {}): Command => ({
    kind: "prompt",
    sub: "user-sub-1",
    sessionId: SID,
    commandId: "c-wake",
    turnId: "T-merge",
    prompt: "[GitHub webhook] merged",
    whenBusy: "reject",
    trigger: { source: "github", deliveryIds: ["d-m"], inboxIds: [], autoClose: true, ...extra },
  });

  test("after the post-merge turn completes, the close is left to the GitHub consumer's harvest", async () => {
    const w = await wire([LAUNCH, WAKE_TURN]);
    await w.consumer.handleEvent(ev(launchCmd()));
    w.commands.commands.length = 0;
    w.githubQueue.sent.length = 0;
    await w.addInbox("01Z", { kind: "review" });

    await w.consumer.handleEvent(ev(mergedWake(), "m-merge"));
    // The harvest decides: the agent may have opened a follow-up PR in this turn.
    expect(w.githubQueue.sent).toEqual([
      {
        kind: "harvest",
        sessionId: SID,
        turnId: "T-merge",
        afterSeq: expect.any(Number),
        autoClose: true,
      },
    ]);
    // The bridge neither deletes nor drains; pending items wait for that decision.
    expect(w.commands.commands.filter((c) => c.kind === "delete")).toEqual([]);
    expect(w.commands.prompts()).toEqual([]);
    expect((await w.repo.queryInbox(SID))[0]).toMatchObject({ status: "pending" });
  });

  test("not when the turn failed, and not without the flag", async () => {
    const failed = await wire([
      LAUNCH,
      { initialize: initResult(), onLoad: { error: { code: -32603, message: "boom" } } },
    ]);
    await failed.consumer.handleEvent(ev(launchCmd()));
    await failed.consumer.handleEvent(ev(mergedWake(), "m-merge"));
    expect(failed.commands.commands.filter((c) => c.kind === "delete")).toEqual([]);

    const plain = await wire([LAUNCH, WAKE_TURN]);
    await plain.consumer.handleEvent(ev(launchCmd()));
    await plain.consumer.handleEvent(ev(mergedWake({ autoClose: undefined }), "m-merge"));
    expect(plain.commands.commands.filter((c) => c.kind === "delete")).toEqual([]);
  });
});

describe("feature off (no wake queues configured)", () => {
  test("settling a turn does not touch the inbox or ask for harvests, but the TURN# row is still written", async () => {
    const w = await wire([LAUNCH], { wake: false });
    await w.addInbox("01A");
    await w.consumer.handleEvent(ev(launchCmd()));
    expect(w.commands.commands).toEqual([]);
    expect(w.githubQueue.sent).toEqual([]);
    expect(await inboxStatuses(w.repo)).toEqual({ "01A": "pending" });
    const turnItems = w.ddb.items().filter((i) => String(i.SK).startsWith("TURN#"));
    expect(turnItems).toHaveLength(1);
    expect(turnItems[0]).toMatchObject({ status: "completed", trigger: { source: "user" } });
  });
});
