/**
 * Tests for the durable catch-up handler, run on the SDK's local durable test
 * runner with skipped time. The consumer under it is the real LambdaConsumer
 * over the in-memory DynamoDB/S3 fakes and the fake ACP agent: each catch-up
 * round spawns the next scenario, so a test scripts the cloud session's
 * replay round by round.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDurableTestRunner } from "@aws/durable-execution-sdk-js-testing";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { Repository, type SessionMetaItem, sessionPk } from "@nikovirtala/kiro-remote-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CATCH_UP_MAX_AGE_MS, type CatchUpMessage } from "../src/catch-up.ts";
import { createCatchUpHandler } from "../src/catch-up-durable.ts";
import { LambdaConsumer } from "../src/lambda-consumer.ts";
import { createLogger } from "../src/logger.ts";
import { CollectingMetricSink } from "../src/metrics.ts";
import { fakeAgentSpawner } from "./fake-agent-spawn.ts";
import { FakeDocClient, FakeS3Client } from "./fakes.ts";
import { initResult } from "./scenarios.ts";

const CLOUD_ID = "sess_08047063-f7b4-4ce5-b79a-2aea9a7a1d29";
const SID = "sdur";
const TURN = "t-dur";

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

/** The replay after `n` chunks: the turn is still running. */
const running = (n: number) => ({
  initialize: initResult(),
  onLoad: {
    replayBeforeResponse: true,
    messages: [info("turn_start"), ...Array.from({ length: n }, (_, i) => chunk(`c${i} `))],
  },
});
/** The replay after `n` chunks plus the end of the turn. */
const finished = (n: number) => ({
  initialize: initResult(),
  onLoad: {
    replayBeforeResponse: true,
    messages: [
      info("turn_start"),
      ...Array.from({ length: n }, (_, i) => chunk(`c${i} `)),
      completion(),
      info("turn_end"),
    ],
  },
});
const loadFails = {
  initialize: initResult(),
  onLoad: { error: { code: -32603, message: "load failed" } },
};

const MSG: CatchUpMessage = {
  kind: "catchUp",
  sessionId: SID,
  kiroSessionId: CLOUD_ID,
  turnId: TURN,
  afterSeq: 0,
  attempt: 1,
  detachedAt: 0,
  turnOrdinal: 1,
};

async function setup(
  scenarios: unknown[],
  opts: {
    session?: Partial<SessionMetaItem>;
    env?: NodeJS.ProcessEnv;
    /** catchUpOnce throws this many times in a row before the real one runs. */
    throwTimes?: number;
  } = {},
) {
  const ddb = new FakeDocClient() as unknown as DynamoDBDocumentClient;
  const s3 = new FakeS3Client();
  const repo = new Repository({
    ddb,
    // biome-ignore lint/suspicious/noExplicitAny: fake S3 client.
    s3: s3 as any,
    tableName: "kiro-remote-test",
    bucketName: "kiro-remote-test-bucket",
  });
  const ts = new Date().toISOString();
  await repo.putSession({
    PK: sessionPk(SID),
    SK: "META",
    id: SID,
    kiroSessionId: CLOUD_ID,
    title: null,
    repos: ["octo/repo"],
    agent: null,
    mode: null,
    model: null,
    effort: null,
    status: "running",
    activeTurnId: TURN,
    eventSeq: 0,
    createdBy: "user-sub-1",
    createdAt: ts,
    updatedAt: ts,
    version: 0,
    GSI1PK: "USER#user-sub-1",
    GSI1SK: ts,
    ...opts.session,
  });
  const metrics = new CollectingMetricSink();
  const logLines: string[] = [];
  const spawner = fakeAgentSpawner(scenarios);
  let clock = 1_000;
  const consumer = await LambdaConsumer.create({
    config: {
      tableName: "kiro-remote-test",
      bucketName: "kiro-remote-test-bucket",
      workspaceRoot: await mkdtemp(join(tmpdir(), "kiro-remote-ws-")),
      region: "us-east-1",
    },
    ddb,
    // biome-ignore lint/suspicious/noExplicitAny: fake S3 client.
    s3: s3 as any,
    spawnFn: spawner.spawnFn,
    logger: createLogger({ level: "debug", sink: (l) => logLines.push(l) }),
    metricSink: metrics,
    env: { KIRO_API_KEY: "ksk_test_key" },
    now: () => (clock += 1),
  });
  let throwsLeft = opts.throwTimes ?? 0;
  const flaky = new Proxy(consumer, {
    get(target, prop, receiver) {
      if (prop === "catchUpOnce") {
        return async (msg: CatchUpMessage) => {
          if (throwsLeft > 0) {
            throwsLeft -= 1;
            throw new Error("dynamodb throttled");
          }
          return target.catchUpOnce(msg);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const runner = new LocalDurableTestRunner({
    handlerFunction: createCatchUpHandler(
      async () => flaky,
      opts.env ?? {},
      createLogger({ level: "debug", sink: (l) => logLines.push(l) }),
    ),
  });
  const turnEvents = async () =>
    (await repo.queryEvents(SID, 0, { limit: 1000 })).filter((e) => e.turnId === TURN);
  return { runner, repo, metrics, logLines, spawner, turnEvents };
}

const textOf = (ev: { payload: unknown }): string =>
  String((ev.payload as { content?: { text?: unknown } }).content?.text);

beforeAll(() => LocalDurableTestRunner.setupTestEnvironment({ skipTime: true }));
afterAll(() => LocalDurableTestRunner.teardownTestEnvironment());

describe("durable catch-up handler", () => {
  test("N pending rounds then turn_end: N+1 steps, N waits, events written once, settled once", async () => {
    const N = 3;
    const t = await setup([
      ...Array.from({ length: N }, (_, i) => running(i + 1)),
      finished(N + 1),
    ]);
    const exec = await t.runner.run({ payload: MSG });

    expect(exec.getStatus()).toBe("SUCCEEDED");
    expect(exec.getResult()).toEqual({ state: "completed", attempts: N + 1 });
    for (let i = 1; i <= N + 1; i++) {
      expect(t.runner.getOperation(`catch-up-${i}`).getStepDetails()?.result).toBeDefined();
    }
    const steps = exec.getOperations().filter((o) => o.getType() === "STEP");
    const waits = exec.getOperations().filter((o) => o.getType() === "WAIT");
    expect(steps).toHaveLength(N + 1);
    expect(waits).toHaveLength(N);
    for (const w of waits) {
      expect(w.getWaitDetails()?.waitSeconds).toBe(60);
    }
    expect(t.spawner.specs).toHaveLength(N + 1);

    const chunks = (await t.turnEvents()).filter((e) => e.type === "message.chunk");
    expect(chunks.map(textOf).join("")).toBe("c0 c1 c2 c3 ");
    expect((await t.repo.getSession(SID))?.status).toBe("idle");
    expect(t.metrics.sum("CatchUpCompleted")).toBe(1);
    expect(t.logLines.filter((l) => l.includes("catch_up_pending"))).toHaveLength(N);
    expect(t.logLines.filter((l) => l.includes("catch_up_completed"))).toHaveLength(1);
  });

  test("30 pending rounds in one execution, no event written twice", async () => {
    const N = 30;
    const t = await setup([
      ...Array.from({ length: N }, (_, i) => running(i + 1)),
      finished(N + 1),
    ]);
    const exec = await t.runner.run({ payload: MSG });

    expect(exec.getStatus()).toBe("SUCCEEDED");
    expect(exec.getResult()).toEqual({ state: "completed", attempts: N + 1 });
    expect(exec.getOperations().filter((o) => o.getType() === "WAIT")).toHaveLength(N);
    const events = await t.turnEvents();
    const chunks = events.filter((e) => e.type === "message.chunk").map(textOf);
    expect(chunks.join("")).toBe(Array.from({ length: N + 1 }, (_, i) => `c${i} `).join(""));
    expect(events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect(t.metrics.sum("CatchUpCompleted")).toBe(1);
  });

  test("the attempt number carries on from the message", async () => {
    const t = await setup([running(1), finished(1)]);
    const exec = await t.runner.run({ payload: { ...MSG, attempt: 5 } });
    expect(exec.getStatus()).toBe("SUCCEEDED");
    expect(t.runner.getOperation("catch-up-5").getStepDetails()?.result).toBeDefined();
    expect(t.runner.getOperation("catch-up-6").getStepDetails()?.result).toBeDefined();
    expect(t.runner.getOperation("wait-5").getWaitDetails()?.waitSeconds).toBe(60);
    expect(t.logLines.some((l) => l.includes('"attempt":6'))).toBe(true);
  });

  test.each([
    ["deleted", { status: "deleted" as const, activeTurnId: null }],
    ["failed", { status: "failed" as const }],
    ["another turn active", { activeTurnId: "t-other" }],
  ])("a stale turn (%s) ends at once, writes nothing, waits never", async (_name, session) => {
    const t = await setup([running(1)], { session });
    const exec = await t.runner.run({ payload: MSG });

    expect(exec.getStatus()).toBe("SUCCEEDED");
    expect(exec.getResult()).toEqual({ state: "stale", attempts: 1 });
    expect(exec.getOperations().filter((o) => o.getType() === "WAIT")).toHaveLength(0);
    expect(await t.turnEvents()).toEqual([]);
    expect(t.spawner.specs).toHaveLength(0);
    expect(t.logLines.some((l) => l.includes("catch_up_stale"))).toBe(true);
  });

  test("a turn past 6 h is failed with catch_up_expired and the execution ends", async () => {
    const t = await setup([running(1)]);
    const exec = await t.runner.run({ payload: { ...MSG, detachedAt: -CATCH_UP_MAX_AGE_MS } });

    expect(exec.getStatus()).toBe("SUCCEEDED");
    expect(exec.getResult()).toEqual({ state: "expired", attempts: 1 });
    const failed = (await t.turnEvents()).find((e) => e.type === "turn.failed");
    expect(failed?.rawType).toBe("catch_up_expired");
    expect((await t.repo.getSession(SID))?.status).toBe("idle");
    expect(t.metrics.sum("CatchUpExpired")).toBe(1);
    expect(t.spawner.specs).toHaveLength(0);
  });

  test("a load failure in one round is a round, not a failed execution", async () => {
    const t = await setup([loadFails, finished(2)]);
    const exec = await t.runner.run({ payload: MSG });

    expect(exec.getStatus()).toBe("SUCCEEDED");
    expect(exec.getResult()).toEqual({ state: "completed", attempts: 2 });
    expect(exec.getOperations().filter((o) => o.getType() === "WAIT")).toHaveLength(1);
    expect(t.logLines.some((l) => l.includes("catch_up_load_failed"))).toBe(true);
    const chunks = (await t.turnEvents()).filter((e) => e.type === "message.chunk");
    expect(chunks.map(textOf).join("")).toBe("c0 c1 ");
  });

  test("a step that exhausts its retries is a pending round, not a failed execution", async () => {
    // Three attempts of round 1 throw, then the real rounds run.
    const t = await setup([finished(1)], { throwTimes: 3 });
    const exec = await t.runner.run({ payload: MSG });

    expect(exec.getStatus()).toBe("SUCCEEDED");
    expect(exec.getResult()).toEqual({ state: "completed", attempts: 2 });
    expect(t.logLines.some((l) => l.includes("catch_up_step_failed"))).toBe(true);
    expect(exec.getOperations().filter((o) => o.getType() === "WAIT")).toHaveLength(1);
  });

  test("CATCH_UP_DELAY_SECONDS overrides the wait", async () => {
    const t = await setup([running(1), finished(1)], { env: { CATCH_UP_DELAY_SECONDS: "7" } });
    const exec = await t.runner.run({ payload: MSG });
    expect(exec.getStatus()).toBe("SUCCEEDED");
    expect(t.runner.getOperation("wait-1").getWaitDetails()?.waitSeconds).toBe(7);
  });

  test("a payload that is not a catch-up message fails the execution", async () => {
    const t = await setup([running(1)]);
    const exec = await t.runner.run({ payload: { kind: "nope" } });
    expect(exec.getStatus()).toBe("FAILED");
    expect(t.spawner.specs).toHaveLength(0);
  });
});
