/**
 * Tests for the SERVERLESS bridge consumer on the direct engine path. Each
 * test builds a {@link LambdaConsumer} over the in-memory DynamoDB/S3 fakes,
 * a recording catch-up scheduler, and a spawner that runs the fake ACP agent
 * as the engine (one scenario per spawn, picked by call index), then drives it
 * with fake SQS records.
 *
 * They prove the Lambda path:
 *  - launches over a cloud-sandbox session/new and records the streamed turn;
 *  - fails a launch loudly when session/new yields no session;
 *  - runs a follow-up as a remote session/load (replay not recorded) + prompt,
 *    also from a fresh consumer instance (META hydration);
 *  - detaches near the deadline, schedules a catch-up, and finishes the turn
 *    from catch-up runs that append only what the log is missing;
 *  - ignores stale catch-ups and fails expired ones;
 *  - deletes the remote session;
 *  - rejects unsupported ops (acked) and retries transient failures.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  type Command,
  Repository,
  type SessionMetaItem,
  sessionPk,
} from "@nikovirtala/kiro-remote-core";
import { describe, expect, test } from "vitest";
import {
  CATCH_UP_DELAY_SECONDS,
  CATCH_UP_MAX_AGE_MS,
  type CatchUpMessage,
  type CatchUpScheduler,
} from "../src/catch-up.ts";
import {
  createHandler,
  LambdaConsumer,
  type SQSEvent,
  type SQSRecord,
} from "../src/lambda-consumer.ts";
import { createLogger, type Logger } from "../src/logger.ts";
import { CollectingMetricSink } from "../src/metrics.ts";
import { echoed, exited, type FakeAgentSpawner, fakeAgentSpawner } from "./fake-agent-spawn.ts";
import { FakeDocClient, FakeS3Client } from "./fakes.ts";
import { initResult } from "./scenarios.ts";

const CLOUD_ID = "sess_08047063-f7b4-4ce5-b79a-2aea9a7a1d29";

/* ------------------------------ scenario bits ----------------------------- */

const notify = (params: Record<string, unknown>) => ({
  kind: "notify",
  method: "session/update",
  params,
});
const info = (kind: string, extra: Record<string, unknown> = {}) =>
  notify({ sessionUpdate: "session_info_update", _meta: { kiro: { kind } }, ...extra });
const chunk = (text: string) =>
  notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const toolCall = (id: string, status: string) =>
  notify({ sessionUpdate: "tool_call", toolCallId: id, title: "fs_read README.md", status });
const toolUpdate = (id: string, status: string) =>
  notify({ sessionUpdate: "tool_call_update", toolCallId: id, status });
const completion = () => info("turn_completion", { status: "end_turn" });

/** A full launch turn streamed live. */
const LAUNCH = {
  initialize: initResult(),
  newSessionId: CLOUD_ID,
  onPrompt: {
    messages: [
      info("turn_start"),
      chunk("Here is "),
      chunk("the answer."),
      toolCall("t1", "pending"),
      toolUpdate("t1", "completed"),
      completion(),
      info("turn_end"),
    ],
    response: { stopReason: "end_turn" },
  },
};

/** A launch whose turn is still running when the invocation detaches. */
const LAUNCH_NEVER_ENDS = {
  initialize: initResult(),
  newSessionId: CLOUD_ID,
  onPrompt: { messages: [info("turn_start"), chunk("Hello wo")], neverRespond: true },
};

/** A finished earlier turn, and the detached turn as a later session/load replays it. */
const OLDER_TURN = [info("turn_start"), chunk("old"), completion(), info("turn_end")];
const DETACHED_RUNNING = [
  info("turn_start"),
  chunk("Hello world"),
  toolCall("t1", "pending"),
  toolUpdate("t1", "completed"),
];
const DETACHED_DONE = [...DETACHED_RUNNING, completion(), info("turn_end")];

function loadScenario(messages: unknown[]) {
  return { initialize: initResult(), onLoad: { replayBeforeResponse: true, messages } };
}

/* --------------------------------- wiring --------------------------------- */

function top(ev: { payload: unknown } | undefined): Record<string, unknown> {
  return (ev?.payload ?? {}) as Record<string, unknown>;
}
function inner(ev: { payload: unknown } | undefined): Record<string, unknown> {
  return (top(ev).payload ?? {}) as Record<string, unknown>;
}
function textOf(ev: { payload: unknown }): string {
  return String((top(ev).content as { text?: unknown } | undefined)?.text);
}

class RecordingScheduler implements CatchUpScheduler {
  readonly scheduled: { msg: CatchUpMessage; delaySeconds: number }[] = [];
  async schedule(msg: CatchUpMessage, delaySeconds: number): Promise<void> {
    this.scheduled.push({ msg, delaySeconds });
  }
}

interface Wired {
  consumer: LambdaConsumer;
  repo: Repository;
  metrics: CollectingMetricSink;
  logLines: string[];
  logger: Logger;
  scheduler: RecordingScheduler;
  spawner: FakeAgentSpawner;
  /** Build another consumer over the same table, spawner and scheduler. */
  newConsumer(): Promise<LambdaConsumer>;
  seed(id: string, overrides?: Partial<SessionMetaItem>): Promise<SessionMetaItem>;
}

interface WireOptions {
  detachMarginMs?: number;
  ddb?: DynamoDBDocumentClient;
  /** Wrap the consumer's view of the shared table (the test's repo reads it raw). */
  wrapDdb?: (inner: DynamoDBDocumentClient) => DynamoDBDocumentClient;
  env?: NodeJS.ProcessEnv;
}

async function wire(scenarios: unknown[], opts: WireOptions = {}): Promise<Wired> {
  const ddb = new FakeDocClient();
  const s3 = new FakeS3Client();
  const docClient = ddb as unknown as DynamoDBDocumentClient;
  const consumerDdb = opts.ddb ?? (opts.wrapDdb ? opts.wrapDdb(docClient) : docClient);
  const repo = new Repository({
    ddb: docClient,
    // biome-ignore lint/suspicious/noExplicitAny: fake S3 client.
    s3: s3 as any,
    tableName: "kiro-remote-test",
    bucketName: "kiro-remote-test-bucket",
  });
  const metrics = new CollectingMetricSink();
  const logLines: string[] = [];
  const logger = createLogger({ level: "debug", sink: (l) => logLines.push(l) });
  const scheduler = new RecordingScheduler();
  const spawner = fakeAgentSpawner(scenarios);
  const workspaceRoot = await mkdtemp(join(tmpdir(), "kiro-remote-ws-"));
  let clock = 1_000;
  const now = () => (clock += 1);

  const newConsumer = () =>
    LambdaConsumer.create({
      config: {
        tableName: "kiro-remote-test",
        bucketName: "kiro-remote-test-bucket",
        workspaceRoot,
        catchUpQueueUrl: "https://sqs.test/catch-up",
        region: "us-east-1",
      },
      ddb: consumerDdb,
      // biome-ignore lint/suspicious/noExplicitAny: fake S3 client.
      s3: s3 as any,
      spawnFn: spawner.spawnFn,
      catchUpScheduler: scheduler,
      ...(opts.detachMarginMs !== undefined ? { detachMarginMs: opts.detachMarginMs } : {}),
      logger,
      metricSink: metrics,
      env: { KIRO_API_KEY: "ksk_test_key", ...opts.env },
      now,
    });

  async function seed(
    id: string,
    overrides: Partial<SessionMetaItem> = {},
  ): Promise<SessionMetaItem> {
    const ts = new Date().toISOString();
    const item: SessionMetaItem = {
      PK: sessionPk(id),
      SK: "META",
      id,
      kiroSessionId: null,
      title: null,
      repos: ["octo/repo"],
      agent: null,
      mode: null,
      model: null,
      effort: null,
      status: "provisioning",
      activeTurnId: null,
      eventSeq: 0,
      createdBy: "user-sub-1",
      createdAt: ts,
      updatedAt: ts,
      version: 0,
      GSI1PK: "USER#user-sub-1",
      GSI1SK: ts,
      ...overrides,
    };
    await repo.putSession(item);
    return item;
  }

  const consumer = await newConsumer();
  return { consumer, repo, metrics, logLines, logger, scheduler, spawner, newConsumer, seed };
}

/** Wrap a command or catch-up message as a single-record SQS event. */
function event(body: Command | CatchUpMessage, messageId = "m-1"): SQSEvent {
  const record: SQSRecord = {
    messageId,
    body: JSON.stringify(body),
    attributes: { MessageGroupId: body.sessionId },
  };
  return { Records: [record] };
}

function launchCmd(id: string): Command {
  return {
    kind: "launch",
    sub: "user-sub-1",
    sessionId: id,
    commandId: "cmd-launch",
    prompt: "do it",
    repos: ["octo/repo"],
  };
}

function promptCmd(id: string, turnId: string, prompt = "again"): Command {
  return {
    kind: "prompt",
    sub: "user-sub-1",
    sessionId: id,
    commandId: `cmd-${turnId}`,
    turnId,
    prompt,
    whenBusy: "steer",
  };
}

/* ---------------------------------- tests --------------------------------- */

describe("LambdaConsumer launch", () => {
  test("a launch creates a cloud-sandbox session and records the streamed turn", async () => {
    const w = await wire([LAUNCH]);
    await w.seed("sl");

    const res = await w.consumer.handleEvent(event(launchCmd("sl")));
    expect(res.batchItemFailures).toEqual([]);

    expect(echoed(w.logLines, "fakeAgentNewSessionParams")).toEqual([
      {
        cwd: expect.any(String),
        mcpServers: [],
        _meta: {
          kiro: {
            executionTarget: { kind: "cloud-sandbox" },
            sessionSource: "remote",
            repositories: ["octo/repo"],
          },
        },
      },
    ]);
    expect(echoed(w.logLines, "fakeAgentPromptParams")).toEqual([
      { sessionId: CLOUD_ID, prompt: [{ type: "text", text: "do it" }] },
    ]);

    const session = await w.repo.getSession("sl");
    expect(session?.status).toBe("idle");
    expect(session?.activeTurnId).toBeNull();
    expect(session?.kiroSessionId).toBe(CLOUD_ID);
    expect(w.metrics.sum("SessionsLaunched")).toBe(1);
    const launchPath = w.metrics.data.find((d) => d.name === "LaunchPath");
    expect(launchPath?.dimensions?.path).toBe("engine");

    const events = await w.repo.queryEvents("sl", 0, { limit: 100 });
    expect(events.map((e) => e.type)).toEqual([
      "session.info",
      "message.chunk",
      "tool.call",
      "tool.update",
      "turn.completed",
      "session.info",
    ]);
    const turnId = events[0]?.turnId;
    expect(turnId).toEqual(expect.any(String));
    expect(events.every((e) => e.turnId === turnId)).toBe(true);
    expect(textOf(events[1] as { payload: unknown })).toBe("Here is the answer.");
    expect(top(events.find((e) => e.type === "tool.call")).toolCallId).toBe("t1");

    // The engine child was stopped and no secret reached the logs or items.
    const child = w.spawner.children[0];
    if (!child) {
      throw new Error("no engine spawned");
    }
    await exited(child);
    expect(child.killed).toBe(true);
    expect(w.logLines.join("\n")).not.toContain("ksk_");
    expect(JSON.stringify(events)).not.toContain("ksk_");
  });

  test("a launch whose session/new yields no session fails loudly", async () => {
    const w = await wire([{ initialize: initResult(), emptyNewSessionId: true }]);
    await w.seed("sf");

    const res = await w.consumer.handleEvent(event(launchCmd("sf")));
    expect(res.batchItemFailures).toEqual([]);
    expect((await w.repo.getSession("sf"))?.status).toBe("failed");
    expect(w.metrics.sum("CloudLaunchFailed")).toBe(1);
    expect(w.metrics.sum("SessionsLaunched")).toBe(0);
    expect(w.logLines.some((l) => l.includes("cloud_launch_failed"))).toBe(true);
  });

  test("an idempotent redelivered launch is a no-op (still acked, one launch)", async () => {
    const w = await wire([LAUNCH]);
    await w.seed("sdup");

    const first = await w.consumer.handleEvent(event(launchCmd("sdup"), "m-1"));
    expect(first.batchItemFailures).toEqual([]);
    const second = await w.consumer.handleEvent(event(launchCmd("sdup"), "m-2"));
    expect(second.batchItemFailures).toEqual([]);

    expect(w.logLines.some((l) => l.includes("launch_idempotent_skip"))).toBe(true);
    expect(w.metrics.sum("SessionsLaunched")).toBe(1);
    expect(w.spawner.specs).toHaveLength(1);
    expect(w.scheduler.scheduled).toEqual([]);
  });
});

describe("LambdaConsumer prompt (follow-up)", () => {
  const FOLLOW_UP = {
    initialize: initResult(),
    onLoad: {
      replayBeforeResponse: true,
      messages: [info("turn_start"), chunk("old history"), info("turn_end")],
    },
    onPrompt: {
      messages: [info("turn_start"), chunk("follow up answer"), info("turn_end")],
      response: { stopReason: "end_turn" },
    },
  };

  async function assertFollowUp(w: Wired): Promise<void> {
    expect(echoed(w.logLines, "fakeAgentLoadParams")).toEqual([
      {
        sessionId: CLOUD_ID,
        cwd: expect.any(String),
        mcpServers: [],
        _meta: { kiro: { sessionSource: "remote" } },
      },
    ]);
    const session = await w.repo.getSession("sr");
    expect(session?.status).toBe("idle");
    expect(session?.activeTurnId).toBeNull();
    const events = await w.repo.queryEvents("sr", 0, { limit: 100 });
    const texts = events.filter((e) => e.type === "message.chunk").map(textOf);
    expect(texts).toContain("follow up answer");
    // The load replay is history, never recorded.
    expect(texts).not.toContain("old history");
    const followUp = events.filter((e) => e.turnId === "turn-1");
    expect(followUp.map((e) => e.type)).toEqual(["session.info", "message.chunk", "session.info"]);
  }

  test("a prompt loads the remote session, records only the prompt stream, and ends idle", async () => {
    const w = await wire([LAUNCH, FOLLOW_UP]);
    await w.seed("sr");
    await w.consumer.handleEvent(event(launchCmd("sr")));

    const res = await w.consumer.handleEvent(event(promptCmd("sr", "turn-1"), "m-prompt"));
    expect(res.batchItemFailures).toEqual([]);
    await assertFollowUp(w);
  });

  test("a follow-up on a NEW consumer instance hydrates from META", async () => {
    const w = await wire([LAUNCH, FOLLOW_UP]);
    await w.seed("sr");
    await w.consumer.handleEvent(event(launchCmd("sr")));

    const fresh = await w.newConsumer();
    expect(fresh.runtime("sr")).toBeUndefined();
    const res = await fresh.handleEvent(event(promptCmd("sr", "turn-1"), "m-prompt"));
    expect(res.batchItemFailures).toEqual([]);
    await assertFollowUp(w);
  });

  test("a follow-up whose session/load fails fails the turn loudly and ends idle", async () => {
    const w = await wire([
      LAUNCH,
      { initialize: initResult(), onLoad: { error: { code: -32603, message: "load failed" } } },
    ]);
    await w.seed("sfl");
    await w.consumer.handleEvent(event(launchCmd("sfl")));

    const res = await w.consumer.handleEvent(event(promptCmd("sfl", "turn-1"), "m-prompt"));
    expect(res.batchItemFailures).toEqual([]);
    const events = await w.repo.queryEvents("sfl", 0, { limit: 100 });
    const failed = events.find((e) => e.type === "turn.failed");
    expect(failed?.turnId).toBe("turn-1");
    expect(inner(failed).source).toBe("kas-engine");
    expect(w.metrics.sum("CloudTurnFailed")).toBe(1);
    // Only the launch prompt reached the engine.
    expect(echoed(w.logLines, "fakeAgentPromptParams")).toHaveLength(1);
    const session = await w.repo.getSession("sfl");
    expect(session?.status).toBe("idle");
    expect(session?.activeTurnId).toBeNull();
  });

  test("an idempotent redelivered prompt (same turn id) is a no-op", async () => {
    const w = await wire([LAUNCH, FOLLOW_UP]);
    await w.seed("sdd");
    await w.consumer.handleEvent(event(launchCmd("sdd")));

    const first = await w.consumer.handleEvent(event(promptCmd("sdd", "t-7"), "m-1"));
    expect(first.batchItemFailures).toEqual([]);
    const second = await w.consumer.handleEvent(event(promptCmd("sdd", "t-7"), "m-2"));
    expect(second.batchItemFailures).toEqual([]);
    expect(w.logLines.some((l) => l.includes("prompt_idempotent_skip"))).toBe(true);
    expect(w.spawner.specs).toHaveLength(2);
  });
});

/** A consumer view of the table whose event Query pages hold at most `max` items (like the 1 MB cap). */
function pagedQueries(max: number) {
  return (inner: DynamoDBDocumentClient) =>
    ({
      // biome-ignore lint/suspicious/noExplicitAny: wrap the fake's send.
      send: async (command: any) => {
        // biome-ignore lint/suspicious/noExplicitAny: the fake returns plain objects.
        const res: any = await inner.send(command);
        if (command.constructor?.name === "QueryCommand" && !command.input.IndexName) {
          return { ...res, Items: (res.Items ?? []).slice(0, max) };
        }
        return res;
      },
    }) as unknown as DynamoDBDocumentClient;
}

/** A consumer view of the table whose next EVT# put fails once `state.armed` is set. */
function failNextEventPut(state: { armed: boolean }) {
  return (inner: DynamoDBDocumentClient) =>
    ({
      // biome-ignore lint/suspicious/noExplicitAny: wrap the fake's send.
      send: async (command: any) => {
        if (
          state.armed &&
          command.constructor?.name === "PutCommand" &&
          String(command.input?.Item?.SK).startsWith("EVT#")
        ) {
          state.armed = false;
          throw new Error("ddb put failed (transient)");
        }
        return inner.send(command);
      },
    }) as unknown as DynamoDBDocumentClient;
}

describe("LambdaConsumer detach + catch-up", () => {
  async function detached(
    scenarios: unknown[],
    opts: WireOptions = {},
  ): Promise<{ w: Wired; msg: CatchUpMessage }> {
    const w = await wire([LAUNCH_NEVER_ENDS, ...scenarios], { detachMarginMs: 100, ...opts });
    await w.seed("sd");
    const res = await w.consumer.handleEvent(event(launchCmd("sd")), {
      remainingTimeMs: () => 300,
    });
    expect(res.batchItemFailures).toEqual([]);
    const scheduled = w.scheduler.scheduled[0];
    if (!scheduled) {
      throw new Error("no catch-up scheduled");
    }
    return { w, msg: scheduled.msg };
  }

  async function turnEvents(w: Wired, turnId: string) {
    return (await w.repo.queryEvents("sd", 0, { limit: 100 })).filter((e) => e.turnId === turnId);
  }

  test("a turn still running near the deadline detaches and schedules a catch-up", async () => {
    const { w, msg } = await detached([]);

    const session = await w.repo.getSession("sd");
    expect(session?.status).toBe("running");
    expect(session?.kiroSessionId).toBe(CLOUD_ID);
    expect(session?.activeTurnId).toEqual(expect.any(String));
    expect(w.scheduler.scheduled).toHaveLength(1);
    expect(w.scheduler.scheduled[0]?.delaySeconds).toBe(CATCH_UP_DELAY_SECONDS);
    expect(msg).toEqual({
      kind: "catchUp",
      sessionId: "sd",
      kiroSessionId: CLOUD_ID,
      turnId: session?.activeTurnId,
      afterSeq: 0,
      attempt: 1,
      detachedAt: expect.any(Number),
      turnOrdinal: 1,
    });
    expect(w.metrics.sum("TurnDetached")).toBe(1);
    expect(w.logLines.some((l) => l.includes("turn_detached"))).toBe(true);

    // What streamed before detaching is recorded (the buffered chunk flushed).
    const events = await turnEvents(w, msg.turnId);
    expect(events.map((e) => e.type)).toEqual(["session.info", "message.chunk"]);
    expect(textOf(events[1] as { payload: unknown })).toBe("Hello wo");

    // The engine child was killed; the cloud turn keeps running remotely.
    const child = w.spawner.children[0];
    if (!child) {
      throw new Error("no engine spawned");
    }
    await exited(child);
    expect(child.killed).toBe(true);
  });

  test("a catch-up through turn_end appends only the missing events and settles the turn", async () => {
    // A launch turn is the session's first turn (ordinal 1); later turns in
    // the replay must be ignored.
    const { w, msg } = await detached([
      loadScenario([...DETACHED_DONE, info("turn_start"), chunk("later")]),
    ]);
    const before = (await turnEvents(w, msg.turnId)).length;

    const res = await w.consumer.handleEvent(event(msg, "m-catch-up"));
    expect(res.batchItemFailures).toEqual([]);

    expect(echoed(w.logLines, "fakeAgentLoadParams")).toEqual([
      {
        sessionId: CLOUD_ID,
        cwd: expect.any(String),
        mcpServers: [],
        _meta: { kiro: { sessionSource: "remote" } },
      },
    ]);
    const added = (await turnEvents(w, msg.turnId)).slice(before);
    expect(added.map((e) => e.type)).toEqual([
      "message.chunk",
      "tool.call",
      "tool.update",
      "turn.completed",
      "session.info",
    ]);
    expect(textOf(added[0] as { payload: unknown })).toBe("rld");
    expect(added.every((e) => e.replay === false)).toBe(true);
    // Nothing from the later turn was appended.
    const all = await w.repo.queryEvents("sd", 0, { limit: 100 });
    expect(all.filter((e) => e.type === "message.chunk").map(textOf)).not.toContain("later");

    const session = await w.repo.getSession("sd");
    expect(session?.status).toBe("idle");
    expect(session?.activeTurnId).toBeNull();
    expect(w.metrics.sum("CatchUpCompleted")).toBe(1);
    expect(w.scheduler.scheduled).toHaveLength(1);

    // Delivering the same catch-up again writes nothing (the turn settled).
    const count = (await w.repo.queryEvents("sd", 0, { limit: 100 })).length;
    await w.consumer.handleEvent(event(msg, "m-catch-up-again"));
    expect((await w.repo.queryEvents("sd", 0, { limit: 100 })).length).toBe(count);
    expect(w.logLines.some((l) => l.includes("catch_up_stale"))).toBe(true);
  });

  test("a catch-up without turn_end records progress and reschedules attempt + 1", async () => {
    const { w, msg } = await detached([
      loadScenario(DETACHED_RUNNING),
      loadScenario(DETACHED_DONE),
    ]);

    await w.consumer.handleEvent(event(msg, "m-catch-up-1"));
    expect((await w.repo.getSession("sd"))?.status).toBe("running");
    expect(w.scheduler.scheduled).toHaveLength(2);
    const next = w.scheduler.scheduled[1]?.msg;
    expect(next).toEqual({ ...msg, attempt: 2 });
    expect(w.logLines.some((l) => l.includes("catch_up_pending"))).toBe(true);
    const afterFirst = await turnEvents(w, msg.turnId);
    expect(afterFirst.map((e) => e.type)).toEqual([
      "session.info",
      "message.chunk",
      "message.chunk",
      "tool.call",
      "tool.update",
    ]);

    // The next attempt sees the same replay plus the end: only the end is new.
    if (!next) {
      throw new Error("no next catch-up");
    }
    await w.consumer.handleEvent(event(next, "m-catch-up-2"));
    const added = (await turnEvents(w, msg.turnId)).slice(afterFirst.length);
    expect(added.map((e) => e.type)).toEqual(["turn.completed", "session.info"]);
    expect((await w.repo.getSession("sd"))?.status).toBe("idle");
    expect(w.metrics.sum("CatchUpCompleted")).toBe(1);
  });

  test("a catch-up reads every page of the event log (no re-appended events)", async () => {
    // Each consumer Query returns one item, as a 1 MB page would on a long log.
    const { w, msg } = await detached([loadScenario(DETACHED_DONE)], {
      wrapDdb: pagedQueries(1),
    });
    const before = (await turnEvents(w, msg.turnId)).length;

    await w.consumer.handleEvent(event(msg, "m-catch-up"));
    const added = (await turnEvents(w, msg.turnId)).slice(before);
    expect(added.map((e) => e.type)).toEqual([
      "message.chunk",
      "tool.call",
      "tool.update",
      "turn.completed",
      "session.info",
    ]);
    expect(textOf(added[0] as { payload: unknown })).toBe("rld");
    expect((await w.repo.getSession("sd"))?.status).toBe("idle");
  });

  test("a catch-up whose session/load fails reschedules attempt + 1", async () => {
    const { w, msg } = await detached([
      { initialize: initResult(), onLoad: { error: { code: -32603, message: "load failed" } } },
    ]);
    const before = (await turnEvents(w, msg.turnId)).length;

    const res = await w.consumer.handleEvent(event(msg, "m-catch-up"));
    expect(res.batchItemFailures).toEqual([]);
    expect(w.logLines.some((l) => l.includes("catch_up_load_failed"))).toBe(true);
    expect(w.scheduler.scheduled[1]?.msg).toEqual({ ...msg, attempt: 2 });
    expect((await turnEvents(w, msg.turnId)).length).toBe(before);
    expect((await w.repo.getSession("sd"))?.status).toBe("running");
  });

  test("the handler passes the Lambda context's remaining time (detaches)", async () => {
    const w = await wire([LAUNCH_NEVER_ENDS], { detachMarginMs: 100 });
    await w.seed("sh");
    const handler = createHandler(async () => w.consumer);

    const res = await handler(event(launchCmd("sh")), { getRemainingTimeInMillis: () => 300 });
    expect(res.batchItemFailures).toEqual([]);
    expect(w.scheduler.scheduled).toHaveLength(1);
    expect((await w.repo.getSession("sh"))?.status).toBe("running");
  });

  test("the DETACH_MARGIN_MS env var overrides the detach margin", async () => {
    const w = await wire([LAUNCH_NEVER_ENDS], { env: { DETACH_MARGIN_MS: "899800" } });
    await w.seed("sm");

    // 900 s left - 899.8 s margin: detach after 200 ms (the default would wait 810 s).
    await w.consumer.handleEvent(event(launchCmd("sm")), { remainingTimeMs: () => 900_000 });
    expect(w.metrics.sum("TurnDetached")).toBe(1);
    expect(w.scheduler.scheduled).toHaveLength(1);

    const invalid = await wire([], { env: { DETACH_MARGIN_MS: "soon" } });
    expect(invalid.logLines.some((l) => l.includes("detach_margin_invalid"))).toBe(true);
  });

  test("a detached follow-up is placed by turn ordinal and is not settled from an older turn", async () => {
    const FOLLOW_UP_NEVER_ENDS = {
      initialize: initResult(),
      onLoad: { replayBeforeResponse: true, messages: OLDER_TURN },
      onPrompt: { messages: [info("turn_start"), chunk("Hello wo")], neverRespond: true },
    };
    const w = await wire(
      [
        LAUNCH,
        FOLLOW_UP_NEVER_ENDS,
        // First catch-up: the replay does not hold the running turn yet.
        loadScenario(OLDER_TURN),
        loadScenario([...OLDER_TURN, ...DETACHED_DONE]),
      ],
      { detachMarginMs: 100 },
    );
    await w.seed("sfd");
    await w.consumer.handleEvent(event(launchCmd("sfd")));
    const launchEvents = await w.repo.queryEvents("sfd", 0, { limit: 100 });

    await w.consumer.handleEvent(event(promptCmd("sfd", "turn-2"), "m-prompt"), {
      remainingTimeMs: () => 300,
    });
    const msg = w.scheduler.scheduled[0]?.msg;
    expect(msg).toEqual({
      kind: "catchUp",
      sessionId: "sfd",
      kiroSessionId: CLOUD_ID,
      turnId: "turn-2",
      afterSeq: launchEvents.length,
      attempt: 1,
      detachedAt: expect.any(Number),
      turnOrdinal: 2,
    });
    if (!msg) {
      throw new Error("no catch-up scheduled");
    }
    const followUp = async () =>
      (await w.repo.queryEvents("sfd", 0, { limit: 100 })).filter((e) => e.turnId === "turn-2");
    const recorded = (await followUp()).length;

    // A redelivered prompt for the running turn schedules a leftover catch-up.
    await w.consumer.handleEvent(event(promptCmd("sfd", "turn-2"), "m-prompt-again"));
    expect(w.logLines.some((l) => l.includes("prompt_idempotent_skip"))).toBe(true);
    expect(w.scheduler.scheduled[1]?.msg).toEqual({
      kind: "catchUp",
      sessionId: "sfd",
      kiroSessionId: CLOUD_ID,
      turnId: "turn-2",
      afterSeq: 0,
      attempt: 1,
      detachedAt: expect.any(Number),
    });

    // The replay only holds the launch turn: nothing written, still running.
    await w.consumer.handleEvent(event(msg, "m-catch-up-1"));
    expect((await followUp()).length).toBe(recorded);
    expect((await w.repo.getSession("sfd"))?.status).toBe("running");
    const next = w.scheduler.scheduled[2]?.msg;
    expect(next).toEqual({ ...msg, attempt: 2 });
    if (!next) {
      throw new Error("no next catch-up");
    }

    // The replay now holds turn 2 through turn_end.
    await w.consumer.handleEvent(event(next, "m-catch-up-2"));
    const added = (await followUp()).slice(recorded);
    expect(added.map((e) => e.type)).toEqual([
      "message.chunk",
      "tool.call",
      "tool.update",
      "turn.completed",
      "session.info",
    ]);
    expect(textOf(added[0] as { payload: unknown })).toBe("rld");
    const session = await w.repo.getSession("sfd");
    expect(session?.status).toBe("idle");
    expect(session?.activeTurnId).toBeNull();
  });

  test("a write failure mid-turn is retried, and the redelivered launch schedules a leftover catch-up", async () => {
    const state = { armed: false };
    const w = await wire(
      [
        LAUNCH,
        loadScenario([
          info("turn_start"),
          chunk("Here is the answer."),
          completion(),
          info("turn_end"),
        ]),
      ],
      { wrapDdb: failNextEventPut(state) },
    );
    await w.seed("sw");

    state.armed = true;
    const first = await w.consumer.handleEvent(event(launchCmd("sw"), "m-1"));
    expect(first.batchItemFailures).toEqual([{ itemIdentifier: "m-1" }]);
    const running = await w.repo.getSession("sw");
    expect(running?.status).toBe("running");
    expect(running?.activeTurnId).toEqual(expect.any(String));

    const second = await w.consumer.handleEvent(event(launchCmd("sw"), "m-2"));
    expect(second.batchItemFailures).toEqual([]);
    expect(w.logLines.some((l) => l.includes("launch_idempotent_skip"))).toBe(true);
    const leftover = w.scheduler.scheduled[0]?.msg;
    expect(leftover).toEqual({
      kind: "catchUp",
      sessionId: "sw",
      kiroSessionId: CLOUD_ID,
      turnId: running?.activeTurnId,
      afterSeq: 0,
      attempt: 1,
      detachedAt: expect.any(Number),
    });
    if (!leftover) {
      throw new Error("no leftover catch-up");
    }

    // The leftover catch-up (no ordinal, whole log) settles the turn.
    await w.consumer.handleEvent(event(leftover, "m-catch-up"));
    const events = (await w.repo.queryEvents("sw", 0, { limit: 100 })).filter(
      (e) => e.turnId === leftover.turnId,
    );
    expect(events.filter((e) => e.type === "message.chunk").map(textOf)).toEqual([
      "Here is the answer.",
    ]);
    expect((await w.repo.getSession("sw"))?.status).toBe("idle");
    expect(w.metrics.sum("CatchUpCompleted")).toBe(1);
  });

  test("a stale catch-up writes nothing and starts no engine", async () => {
    const w = await wire([LAUNCH]);
    await w.seed("ss", { status: "idle", kiroSessionId: CLOUD_ID, activeTurnId: null });
    const msg: CatchUpMessage = {
      kind: "catchUp",
      sessionId: "ss",
      kiroSessionId: CLOUD_ID,
      turnId: "t-old",
      afterSeq: 0,
      attempt: 3,
      detachedAt: 0,
    };
    const res = await w.consumer.handleEvent(event(msg));
    expect(res.batchItemFailures).toEqual([]);
    expect(await w.repo.queryEvents("ss", 0, { limit: 100 })).toEqual([]);
    expect(w.spawner.specs).toHaveLength(0);
    expect(w.scheduler.scheduled).toEqual([]);
    expect(w.logLines.some((l) => l.includes("catch_up_stale"))).toBe(true);
  });

  test("an expired catch-up fails the turn and returns the session to idle", async () => {
    const w = await wire([LAUNCH]);
    await w.seed("se", { status: "running", kiroSessionId: CLOUD_ID, activeTurnId: "t-long" });
    const msg: CatchUpMessage = {
      kind: "catchUp",
      sessionId: "se",
      kiroSessionId: CLOUD_ID,
      turnId: "t-long",
      afterSeq: 0,
      attempt: 360,
      detachedAt: -CATCH_UP_MAX_AGE_MS,
    };
    const res = await w.consumer.handleEvent(event(msg));
    expect(res.batchItemFailures).toEqual([]);

    const events = await w.repo.queryEvents("se", 0, { limit: 100 });
    const failed = events.find((e) => e.type === "turn.failed");
    expect(failed?.rawType).toBe("catch_up_expired");
    expect(failed?.turnId).toBe("t-long");
    const session = await w.repo.getSession("se");
    expect(session?.status).toBe("idle");
    expect(session?.activeTurnId).toBeNull();
    expect(w.metrics.sum("CatchUpExpired")).toBe(1);
    expect(w.spawner.specs).toHaveLength(0);
    expect(w.scheduler.scheduled).toEqual([]);
  });
});

describe("LambdaConsumer delete", () => {
  test("a delete sends the remote session/delete and marks the row deleted", async () => {
    const w = await wire([LAUNCH, { initialize: initResult() }]);
    await w.seed("sx");
    await w.consumer.handleEvent(event(launchCmd("sx")));

    const del: Command = {
      kind: "delete",
      sub: "user-sub-1",
      sessionId: "sx",
      commandId: "cmd-del",
    };
    const res = await w.consumer.handleEvent(event(del, "m-del"));
    expect(res.batchItemFailures).toEqual([]);
    expect(echoed(w.logLines, "fakeAgentDeleteParams")).toEqual([
      { sessionId: CLOUD_ID, _meta: { kiro: { sessionSource: "remote" } } },
    ]);
    expect((await w.repo.getSession("sx"))?.status).toBe("deleted");
  });
});

describe("LambdaConsumer unsupported operations (permanent, acked)", () => {
  /** Seed a session whose turn META says is running. */
  async function busy(w: Wired, id: string): Promise<void> {
    await w.seed(id, { status: "running", activeTurnId: "t-running", kiroSessionId: CLOUD_ID });
  }

  test("a mid-turn steer is persisted as a rejection and NOT a batch failure", async () => {
    const w = await wire([LAUNCH]);
    await busy(w, "sste");

    const steer: Command = {
      kind: "steer",
      sub: "user-sub-1",
      sessionId: "sste",
      commandId: "cmd-steer",
      content: "interrupt",
    };
    const res = await w.consumer.handleEvent(event(steer, "m-steer"));
    expect(res.batchItemFailures).toEqual([]);
    expect(w.logLines.some((l) => l.includes("command_unsupported_cloud"))).toBe(true);
    const events = await w.repo.queryEvents("sste", 0, { limit: 100 });
    const rej = events.find((e) => e.type === "turn.failed" && e.rawType === "operation_rejected");
    expect(inner(rej).operation).toBe("steer");
    expect(rej?.turnId).toBe("t-running");
  });

  test("a mid-turn cancel is persisted as a rejection and NOT a batch failure", async () => {
    const w = await wire([LAUNCH]);
    await busy(w, "sca");

    const cancel: Command = {
      kind: "cancel",
      sub: "user-sub-1",
      sessionId: "sca",
      commandId: "cmd-cancel",
    };
    const res = await w.consumer.handleEvent(event(cancel, "m-cancel"));
    expect(res.batchItemFailures).toEqual([]);
    const events = await w.repo.queryEvents("sca", 0, { limit: 100 });
    const rej = events.find((e) => e.type === "turn.failed" && e.rawType === "operation_rejected");
    expect(inner(rej).operation).toBe("cancel");
  });

  test("a whenBusy=queue follow-up is persisted as a rejection and NOT a batch failure", async () => {
    const w = await wire([LAUNCH]);
    await busy(w, "squ");

    const queued: Command = {
      kind: "prompt",
      sub: "user-sub-1",
      sessionId: "squ",
      commandId: "cmd-queue",
      turnId: "t-queue",
      prompt: "queued",
      whenBusy: "queue",
    };
    const res = await w.consumer.handleEvent(event(queued, "m-queue"));
    expect(res.batchItemFailures).toEqual([]);
    const events = await w.repo.queryEvents("squ", 0, { limit: 100 });
    const rej = events.find((e) => e.type === "turn.failed" && e.rawType === "operation_rejected");
    expect(inner(rej).operation).toBe("queue");
    expect(w.spawner.specs).toHaveLength(0);
  });

  test("adopt is rejected loudly as unsupported", async () => {
    const w = await wire([LAUNCH]);
    await w.seed("sad");

    const adopt: Command = {
      kind: "adopt",
      sub: "user-sub-1",
      sessionId: "sad",
      commandId: "cmd-adopt",
      kiroSessionId: "existing-cloud-id",
    };
    const res = await w.consumer.handleEvent(event(adopt, "m-adopt"));
    expect(res.batchItemFailures).toEqual([]);
    expect(w.logLines.some((l) => l.includes("command_unsupported_cloud"))).toBe(true);
    const events = await w.repo.queryEvents("sad", 0, { limit: 100 });
    const rej = events.find((e) => e.type === "turn.failed" && e.rawType === "operation_rejected");
    expect(rej).toBeDefined();
    expect(inner(rej).operation).toBe("adopt");
    expect(inner(rej).reason).toBe("adopt/session-load is not supported by the bridge");
  });
});

describe("LambdaConsumer transient failures (retried via batchItemFailures)", () => {
  test("a transient dispatch failure returns the record id in batchItemFailures", async () => {
    // A DynamoDB read that throws once (e.g. throttling) on the delete path
    // propagates out of dispatch into handleRecord -> batchItemFailures.
    const ddb = new FakeDocClient();
    let throwNext = false;
    const throwingDdb = {
      // biome-ignore lint/suspicious/noExplicitAny: wrap the fake's send to throw once.
      send: async (command: any) => {
        if (throwNext && command.constructor?.name === "GetCommand") {
          throwNext = false;
          throw new Error("ddb throttled (transient)");
        }
        return ddb.send(command);
      },
    } as unknown as DynamoDBDocumentClient;
    const w = await wire([LAUNCH], { ddb: throwingDdb });
    // Seed through the throwing client (it only throws once armed) so the
    // consumer reads the same store.
    const repo = new Repository({
      ddb: throwingDdb,
      // biome-ignore lint/suspicious/noExplicitAny: fake S3 client.
      s3: new FakeS3Client() as any,
      tableName: "kiro-remote-test",
      bucketName: "kiro-remote-test-bucket",
    });
    const ts = new Date().toISOString();
    await repo.putSession({
      PK: sessionPk("st"),
      SK: "META",
      id: "st",
      kiroSessionId: CLOUD_ID,
      title: null,
      repos: ["octo/repo"],
      agent: null,
      mode: null,
      model: null,
      effort: null,
      status: "idle",
      activeTurnId: null,
      eventSeq: 0,
      createdBy: "user-sub-1",
      createdAt: ts,
      updatedAt: ts,
      version: 0,
      GSI1PK: "USER#user-sub-1",
      GSI1SK: ts,
    });

    throwNext = true;
    const del: Command = {
      kind: "delete",
      sub: "user-sub-1",
      sessionId: "st",
      commandId: "cmd-del",
    };
    const res = await w.consumer.handleEvent(event(del, "m-del"));
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: "m-del" }]);
    expect(w.logLines.some((l) => l.includes("command_dispatch_error"))).toBe(true);
  });
});

describe("LambdaConsumer batch ordering", () => {
  test("processes multiple records of the same group sequentially and reports only transient failures", async () => {
    const w = await wire([LAUNCH]);
    await w.seed("sb");

    const cancelAfterLaunch: Command = {
      kind: "cancel",
      sub: "user-sub-1",
      sessionId: "sb",
      commandId: "cmd-cancel",
    };
    // A launch (success) followed by a cancel with no active turn (no-op), both
    // in one batch -> no batch failures.
    const ev: SQSEvent = {
      Records: [
        {
          messageId: "r1",
          body: JSON.stringify(launchCmd("sb")),
          attributes: { MessageGroupId: "sb" },
        },
        {
          messageId: "r2",
          body: JSON.stringify(cancelAfterLaunch),
          attributes: { MessageGroupId: "sb" },
        },
      ],
    };
    const res = await w.consumer.handleEvent(ev);
    expect(res.batchItemFailures).toEqual([]);
    expect((await w.repo.getSession("sb"))?.status).toBe("idle");
  });
});
