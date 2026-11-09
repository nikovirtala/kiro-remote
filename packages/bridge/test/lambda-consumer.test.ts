/**
 * Unit tests for the SERVERLESS bridge consumer (FEAT-003). These construct a
 * {@link LambdaConsumer} with NO AcpGateway -- only a Repository over the
 * in-memory DynamoDB/S3 fakes, a collecting metric sink, a scripted
 * HeadlessRunner, and a logger -- exactly the wiring the real Lambda uses, and
 * drive it with FAKE SQS event records.
 *
 * They prove the Lambda path:
 *  - drives headlessLaunch on a `launch` record and persists the SAME events as
 *    the ECS path (tool.call/tool.update/message.chunk, chat-cloud source),
 *    reaching idle;
 *  - resumes on a `prompt` record;
 *  - rejects an unsupported op (mid-turn steer / cancel / whenBusy=queue /
 *    adopt) by persisting a client-visible rejection and NOT returning it as a
 *    batch item failure (so SQS deletes it);
 *  - returns a GENUINE transient failure in batchItemFailures for retry;
 *  - is idempotent on a redelivered launch/prompt (a logged no-op).
 * Each assertion would FAIL if the handler logic were reverted.
 */

import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  type Command,
  Repository,
  type SessionMetaItem,
  sessionPk,
} from "@nikovirtala/kiro-remote-core";
import { describe, expect, test } from "vitest";
import type { HeadlessRunner } from "../src/headless.ts";
import { LambdaConsumer, type SQSEvent, type SQSRecord } from "../src/lambda-consumer.ts";
import { createLogger, type Logger } from "../src/logger.ts";
import { CollectingMetricSink } from "../src/metrics.ts";
import { FakeDocClient, FakeS3Client } from "./fakes.ts";
import { cloudStreams } from "./harness.ts";

const CLOUD_ID = "08047063-f7b4-4ce5-b79a-2aea9a7a1d29";

function top(ev: { payload: unknown } | undefined): Record<string, unknown> {
  return (ev?.payload ?? {}) as Record<string, unknown>;
}
function inner(ev: { payload: unknown } | undefined): Record<string, unknown> {
  return (top(ev).payload ?? {}) as Record<string, unknown>;
}

interface Wired {
  consumer: LambdaConsumer;
  repo: Repository;
  metrics: CollectingMetricSink;
  logLines: string[];
  logger: Logger;
  seed(id: string, overrides?: Partial<SessionMetaItem>): Promise<SessionMetaItem>;
}

async function wire(runner: HeadlessRunner): Promise<Wired> {
  const ddb = new FakeDocClient();
  const s3 = new FakeS3Client();
  const docClient = ddb as unknown as DynamoDBDocumentClient;
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
  let clock = 1_000;
  const now = () => (clock += 1);

  const consumer = await LambdaConsumer.create({
    config: {
      tableName: "kiro-remote-test",
      bucketName: "kiro-remote-test-bucket",
      workspaceRoot: "/workspace",
      additionalDirectories: ["/workspace/shared"],
      mcpServers: [],
      region: "us-east-1",
    },
    ddb: docClient,
    // biome-ignore lint/suspicious/noExplicitAny: fake S3 client.
    s3: s3 as any,
    headlessRunner: runner,
    logger,
    metricSink: metrics,
    env: {},
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

  return { consumer, repo, metrics, logLines, logger, seed };
}

/** A runner returning fixed plain-text cloud streams with a given exit code. */
function fixedRunner(opts: {
  code?: number | null;
  cloudSessionId?: string;
  tools?: { title: string; status?: string }[];
  assistant?: string;
}): HeadlessRunner {
  return async () => ({
    code: opts.code ?? 0,
    ...cloudStreams({
      cloudSessionId: opts.cloudSessionId ?? CLOUD_ID,
      tools: opts.tools,
      assistant: opts.assistant,
    }),
  });
}

/** Wrap a command as a single-record SQS event. */
function event(command: Command, messageId = "m-1", groupId = command.sessionId): SQSEvent {
  const record: SQSRecord = {
    messageId,
    body: JSON.stringify(command),
    attributes: { MessageGroupId: groupId },
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

describe("LambdaConsumer launch", () => {
  test("a launch record drives headlessLaunch and persists the same events as the ECS path", async () => {
    const w = await wire(
      fixedRunner({
        tools: [{ title: "fs_read /workspace/README.md", status: "Completed" }],
        assistant: "Here is the answer.",
      }),
    );
    await w.seed("sl");

    const res = await w.consumer.handleEvent(event(launchCmd("sl")));
    // Synchronous settlement: the turn is DONE when handleEvent returns.
    expect(res.batchItemFailures).toEqual([]);

    const session = await w.repo.getSession("sl");
    expect(session?.status).toBe("idle");
    expect(session?.kiroSessionId).toBe(CLOUD_ID);
    expect(w.metrics.sum("SessionsLaunched")).toBe(1);
    const launchPath = w.metrics.data.find((d) => d.name === "LaunchPath");
    expect(launchPath?.dimensions?.path).toBe("headless");

    const events = await w.repo.queryEvents("sl", 0, { limit: 100 });
    const call = events.find((e) => e.type === "tool.call");
    expect(top(call).toolCallId).toBe("1");
    expect(inner(call).source).toBe("chat-cloud");
    expect(top(events.find((e) => e.type === "tool.update")).status).toBe("Completed");
    const message = events.find((e) => e.type === "message.chunk");
    expect((top(message).content as { text?: string }).text).toBe("Here is the answer.");
  });

  test("an idempotent redelivered launch is a no-op (still acked, one launch)", async () => {
    const w = await wire(fixedRunner({ assistant: "a" }));
    await w.seed("sdup");

    const first = await w.consumer.handleEvent(event(launchCmd("sdup"), "m-1"));
    expect(first.batchItemFailures).toEqual([]);
    const second = await w.consumer.handleEvent(event(launchCmd("sdup"), "m-2"));
    expect(second.batchItemFailures).toEqual([]);

    expect(w.logLines.some((l) => l.includes("launch_idempotent_skip"))).toBe(true);
    expect(w.metrics.sum("SessionsLaunched")).toBe(1);
  });
});

describe("LambdaConsumer prompt (follow-up)", () => {
  async function launched(w: Wired, id: string): Promise<void> {
    await w.seed(id);
    await w.consumer.handleEvent(event(launchCmd(id)));
  }

  test("a prompt record resumes the session and persists the answer", async () => {
    const w = await wire(fixedRunner({ assistant: "follow up answer" }));
    await launched(w, "sr");

    const prompt: Command = {
      kind: "prompt",
      sub: "user-sub-1",
      sessionId: "sr",
      commandId: "cmd-prompt",
      turnId: "turn-1",
      prompt: "again",
      whenBusy: "steer",
    };
    const res = await w.consumer.handleEvent(event(prompt, "m-prompt"));
    expect(res.batchItemFailures).toEqual([]);

    expect((await w.repo.getSession("sr"))?.status).toBe("idle");
    const events = await w.repo.queryEvents("sr", 0, { limit: 100 });
    const texts = events
      .filter((e) => e.type === "message.chunk")
      .map((e) => (top(e).content as { text?: string }).text);
    expect(texts).toContain("follow up answer");
  });

  test("an idempotent redelivered prompt (same turn id) is a no-op", async () => {
    const w = await wire(fixedRunner({ assistant: "x" }));
    await launched(w, "sdd");

    const prompt: Command = {
      kind: "prompt",
      sub: "user-sub-1",
      sessionId: "sdd",
      commandId: "cmd-prompt",
      turnId: "t-7",
      prompt: "p",
      whenBusy: "steer",
    };
    const first = await w.consumer.handleEvent(event(prompt, "m-1"));
    expect(first.batchItemFailures).toEqual([]);
    const second = await w.consumer.handleEvent(event(prompt, "m-2"));
    expect(second.batchItemFailures).toEqual([]);
    expect(w.logLines.some((l) => l.includes("prompt_idempotent_skip"))).toBe(true);
  });
});

describe("LambdaConsumer unsupported operations (permanent, acked)", () => {
  /**
   * Make a session busy by beginning a resume WITHOUT settling it: drive a
   * launch to idle, then reach into the runtime to begin a follow-up turn that
   * leaves the machine turn=running (so a mid-turn op is rejected). We use a
   * gated runner so the launch settles but the resume parks.
   */
  async function busy(w: Wired, id: string): Promise<void> {
    await w.seed(id);
    await w.consumer.handleEvent(event(launchCmd(id)));
    // Force the runtime into a running turn by starting (not settling) a resume.
    const rt = w.consumer.runtime(id);
    if (!rt) {
      throw new Error("runtime missing");
    }
    rt.machine = { session: "running", turn: "running" };
  }

  test("a mid-turn steer is persisted as a rejection and NOT a batch failure", async () => {
    const w = await wire(fixedRunner({ assistant: "a" }));
    await busy(w, "sste");

    const steer: Command = {
      kind: "steer",
      sub: "user-sub-1",
      sessionId: "sste",
      commandId: "cmd-steer",
      content: "interrupt",
    };
    const res = await w.consumer.handleEvent(event(steer, "m-steer"));
    // PERMANENT rejection: acked (no batch failure), loud log + persisted event.
    expect(res.batchItemFailures).toEqual([]);
    expect(w.logLines.some((l) => l.includes("command_unsupported_cloud"))).toBe(true);
    const events = await w.repo.queryEvents("sste", 0, { limit: 100 });
    const rej = events.find((e) => e.type === "turn.failed" && e.rawType === "operation_rejected");
    expect(inner(rej).operation).toBe("steer");
  });

  test("a mid-turn cancel is persisted as a rejection and NOT a batch failure", async () => {
    const w = await wire(fixedRunner({ assistant: "a" }));
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
    const w = await wire(fixedRunner({ assistant: "a" }));
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
  });

  test("adopt on the Lambda path is rejected loudly as unsupported (deferred to Fargate)", async () => {
    const w = await wire(fixedRunner({ assistant: "a" }));
    await w.seed("sad");

    const adopt: Command = {
      kind: "adopt",
      sub: "user-sub-1",
      sessionId: "sad",
      commandId: "cmd-adopt",
      kiroSessionId: "existing-cloud-id",
    };
    const res = await w.consumer.handleEvent(event(adopt, "m-adopt"));
    // Acked (not retried) but persisted as a client-visible rejection.
    expect(res.batchItemFailures).toEqual([]);
    expect(w.logLines.some((l) => l.includes("command_unsupported_cloud"))).toBe(true);
    const events = await w.repo.queryEvents("sad", 0, { limit: 100 });
    const rej = events.find((e) => e.type === "turn.failed" && e.rawType === "operation_rejected");
    expect(rej).toBeDefined();
    expect(inner(rej).operation).toBe("adopt");
    // The rejection reason names the Fargate (ACP) bridge as the adopt host.
    expect(String(inner(rej).reason)).toContain("Fargate");
  });
});

describe("LambdaConsumer transient failures (retried via batchItemFailures)", () => {
  test("a transient dispatch failure returns the record id in batchItemFailures", async () => {
    // Model a genuine TRANSIENT infrastructure failure: the consumer's repo read
    // throws (e.g. DynamoDB throttling). settleLaunch swallows a runner throw
    // (it drives the session to `failed`, never rethrows), so to exercise a
    // RETHROWN transient we make a repo READ on the delete path throw a plain
    // Error. We inject a ddb fake that throws once on a GetCommand so the error
    // propagates out of dispatch into handleRecord -> batchItemFailures.
    const ddb = new FakeDocClient();
    const s3 = new FakeS3Client();
    const docClient = ddb as unknown as DynamoDBDocumentClient;
    const logLines: string[] = [];
    const logger = createLogger({ level: "debug", sink: (l) => logLines.push(l) });

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

    const repo = new Repository({
      ddb: docClient,
      // biome-ignore lint/suspicious/noExplicitAny: fake S3 client.
      s3: s3 as any,
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

    const consumer = await LambdaConsumer.create({
      config: {
        tableName: "kiro-remote-test",
        bucketName: "kiro-remote-test-bucket",
        workspaceRoot: "/workspace",
        region: "us-east-1",
      },
      ddb: throwingDdb,
      // biome-ignore lint/suspicious/noExplicitAny: fake S3 client.
      s3: s3 as any,
      headlessRunner: fixedRunner({ assistant: "a" }),
      logger,
      metricSink: new CollectingMetricSink(),
      env: {},
    });

    throwNext = true;
    const del: Command = {
      kind: "delete",
      sub: "user-sub-1",
      sessionId: "st",
      commandId: "cmd-del",
    };
    const res = await consumer.handleEvent(event(del, "m-del"));
    // The transient error is returned for retry.
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: "m-del" }]);
    expect(logLines.some((l) => l.includes("command_dispatch_error"))).toBe(true);
  });
});

describe("LambdaConsumer batch ordering", () => {
  test("processes multiple records of the same group sequentially and reports only transient failures", async () => {
    const w = await wire(fixedRunner({ assistant: "a" }));
    await w.seed("sb");

    const steerAfterLaunch: Command = {
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
          body: JSON.stringify(steerAfterLaunch),
          attributes: { MessageGroupId: "sb" },
        },
      ],
    };
    const res = await w.consumer.handleEvent(ev);
    expect(res.batchItemFailures).toEqual([]);
    expect((await w.repo.getSession("sb"))?.status).toBe("idle");
  });
});
