/**
 * The prompt queue against the AWS Emulator: the real Repository on a real DynamoDB API (the
 * conditional claim, the transaction that fails a prompt together with its feed event, the key
 * order of the queue, the TTL) and the real FIFO command queue between the API's service calls
 * and the consumer, with the fake ACP agent as the engine.
 *
 * It follows the two losses of 23 November 2026 through the whole path: the API's calls
 * (launchSession, sendPrompt, deleteSession) put commands on a FIFO queue, `pump` receives them one
 * at a time as the event-source mapping would (a session's group is blocked until the message is
 * deleted), and the consumer handles them.
 *
 * Skipped unless KIRO_REMOTE_EMULATOR_TEST=1, and refuses to run against anything but a loopback
 * endpoint. See docs/testing.md. The emulator does not evaluate IAM, so this proves the DynamoDB
 * and SQS behaviour only, never permissions. QUEUE_EVIDENCE_FILE=<path> writes what each test saw.
 */

import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  type Command,
  deleteSession,
  drainQueuedPrompts,
  type GithubQueue,
  type GithubQueueMessage,
  getSession,
  inboxSk,
  launchSession,
  type Principal,
  Repository,
  type ServiceDeps,
  SqsCommandQueue,
  sendPrompt,
  sessionPk,
} from "@nikovirtala/kiro-remote-core";
import { sessionItem } from "@nikovirtala/kiro-remote-core/testing";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { CatchUpMessage, CatchUpScheduler } from "../src/catch-up.ts";
import { LambdaConsumer } from "../src/lambda-consumer.ts";
import { createLogger } from "../src/logger.ts";
import { CollectingMetricSink } from "../src/metrics.ts";
import { fakeAgentSpawner } from "./fake-agent-spawn.ts";
import { DETACHED_DONE, FOLLOW_UP, LAUNCH_NEVER_ENDS } from "./queue-harness.ts";

const ENABLED = process.env.KIRO_REMOTE_EMULATOR_TEST === "1";
const OWNER = "user-sub-1";
const P: Principal = {
  sub: OWNER,
  clientId: "c",
  scopes: ["sessions:read", "sessions:write", "sessions:delete"],
};

describe.skipIf(!ENABLED)("the prompt queue against the AWS Emulator", () => {
  const suffix = randomBytes(4).toString("hex");
  const table = `kr-queue-${suffix}`;
  const rawDdb = new DynamoDBClient({});
  const ddb = DynamoDBDocumentClient.from(rawDdb);
  const sqs = new SQSClient({});
  let queueUrl = "";
  let repo: Repository;
  let service: ServiceDeps;
  const evidence: Record<string, unknown> = {};

  beforeAll(async () => {
    const endpoint = process.env.AWS_ENDPOINT_URL ?? "";
    if (!/^https:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/.test(endpoint)) {
      throw new Error(`refusing to run: AWS_ENDPOINT_URL=${endpoint} is not a loopback emulator`);
    }
    await rawDdb.send(
      new CreateTableCommand({
        TableName: table,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "PK", AttributeType: "S" },
          { AttributeName: "SK", AttributeType: "S" },
          { AttributeName: "GSI1PK", AttributeType: "S" },
          { AttributeName: "GSI1SK", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: "GSI1",
            KeySchema: [
              { AttributeName: "GSI1PK", KeyType: "HASH" },
              { AttributeName: "GSI1SK", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          },
        ],
      }),
    );
    for (let i = 0; i < 30; i++) {
      const d = await rawDdb.send(new DescribeTableCommand({ TableName: table }));
      if (d.Table?.TableStatus === "ACTIVE") {
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    // As the CDK construct creates the command queue: FIFO with content-based deduplication.
    queueUrl =
      (
        await sqs.send(
          new CreateQueueCommand({
            QueueName: `kr-queue-${suffix}.fifo`,
            Attributes: { FifoQueue: "true", ContentBasedDeduplication: "true" },
          }),
        )
      ).QueueUrl ?? "";
    repo = new Repository({
      ddb: ddb as never,
      s3: {} as never,
      tableName: table,
      bucketName: "b",
    });
    service = {
      repo,
      queue: new SqsCommandQueue({ sqs, queueUrl }),
      allowedRepos: ["octo/*"],
    };
  });

  afterAll(async () => {
    if (process.env.QUEUE_EVIDENCE_FILE) {
      writeFileSync(process.env.QUEUE_EVIDENCE_FILE, `${JSON.stringify(evidence, null, 2)}\n`);
    }
    await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl })).catch(() => undefined);
    await rawDdb.send(new DeleteTableCommand({ TableName: table })).catch(() => undefined);
  });

  /** A consumer on the emulator's table with the fake agent, plus the command-queue pump. */
  async function world(scenarios: unknown[]) {
    const scheduled: CatchUpMessage[] = [];
    const scheduler: CatchUpScheduler = {
      async start(m) {
        scheduled.push(m);
      },
    };
    const githubSent: GithubQueueMessage[] = [];
    const githubQueue: GithubQueue = {
      async send(m) {
        githubSent.push(m);
      },
    };
    const consumer = await LambdaConsumer.create({
      config: {
        tableName: table,
        bucketName: "b",
        workspaceRoot: await mkdtemp(join(tmpdir(), "kiro-remote-queue-emu-")),
        region: "us-east-1",
      },
      ddb: ddb as never,
      s3: {} as never,
      spawnFn: fakeAgentSpawner(scenarios).spawnFn,
      catchUpScheduler: scheduler,
      commandQueue: service.queue,
      githubQueue,
      detachMarginMs: 100,
      logger: createLogger({ level: "debug", sink: () => {} }),
      metricSink: new CollectingMetricSink(),
      env: { KIRO_API_KEY: "ksk_test_key" },
    });
    const handled: Array<{ kind: Command["kind"]; turnId?: string }> = [];
    return {
      consumer,
      scheduled,
      githubSent,
      handled,
      /**
       * Receive, handle and delete messages one at a time until the queue stays empty. `detach`
       * makes the turns of this pump run out of time (the consumer detaches from them).
       */
      async pump(detach = false) {
        let empty = 0;
        while (empty < 2) {
          const res = await sqs.send(
            new ReceiveMessageCommand({
              QueueUrl: queueUrl,
              MaxNumberOfMessages: 1,
              WaitTimeSeconds: 1,
              VisibilityTimeout: 60,
            }),
          );
          const [m] = res.Messages ?? [];
          if (!m) {
            empty++;
            continue;
          }
          empty = 0;
          const command = JSON.parse(m.Body ?? "{}") as Command;
          handled.push({
            kind: command.kind,
            ...(command.kind === "prompt" ? { turnId: command.turnId } : {}),
          });
          const out = await consumer.handleEvent(
            { Records: [{ messageId: m.MessageId ?? "m", body: m.Body ?? "" }] },
            detach ? { remainingTimeMs: () => 300 } : {},
          );
          if (out.batchItemFailures.length === 0) {
            await sqs.send(
              new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }),
            );
          }
        }
      },
    };
  }

  const startedAt = async (sessionId: string, ids: string[]) =>
    (await Promise.all(ids.map((id) => repo.getTurn(sessionId, id))))
      .filter((t) => t !== null)
      .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
      .map((t) => t.id);

  test("01M84N1Z: a prompt queued behind a detached first turn runs after it, as the turn id the caller got", async () => {
    const w = await world([LAUNCH_NEVER_ENDS, DETACHED_DONE, FOLLOW_UP]);
    const { id } = await launchSession(service, P, { prompt: "first", repos: ["octo/repo"] });
    await w.pump(true);
    expect((await repo.getSession(id))?.status).toBe("running");

    // Sent while the turn runs; the FIFO group delivers it to the consumer after the detach.
    const sent = await sendPrompt(service, P, id, { prompt: "second", whenBusy: "queue" });
    expect(sent.status).toBe("queued");
    expect((await getSession(service, P, id)).queue).toMatchObject([
      { turnId: sent.id, status: "queued" },
    ]);
    await w.pump(true);
    expect((await getSession(service, P, id)).queue).toMatchObject([
      { turnId: sent.id, status: "queued" },
    ]);
    expect(await repo.getTurn(id, sent.id)).toBeNull();

    // The first turn ends in the catch-up, whose settle starts the queued prompt.
    await w.consumer.catchUpOnce(w.scheduled[0]);
    await w.pump();
    expect(await repo.getTurn(id, sent.id)).toMatchObject({
      status: "completed",
      prompt: "second",
      trigger: { source: "user" },
    });
    const view = await getSession(service, P, id);
    expect(view.status).toBe("idle");
    expect(view.queue).toMatchObject([{ turnId: sent.id, status: "started", reason: null }]);
    evidence["01M84N1Z"] = {
      turn: sent.id,
      sentAs: sent.status,
      queueAfterSend: "queued",
      commandsHandled: w.handled,
      turnStatus: "completed",
      queueAfterRun: view.queue,
    };
  });

  test("01M84TV2: two queued prompts and a steer behind a turn, then the merge wake: the steer fails in the call, the queue runs in order, no close until it is empty", async () => {
    const w = await world([LAUNCH_NEVER_ENDS, DETACHED_DONE, FOLLOW_UP, FOLLOW_UP, FOLLOW_UP]);
    const { id } = await launchSession(service, P, { prompt: "first", repos: ["octo/repo"] });
    await w.pump(true);

    const q1 = await sendPrompt(service, P, id, { prompt: "one", whenBusy: "queue" });
    const q2 = await sendPrompt(service, P, id, { prompt: "two", whenBusy: "queue" });
    // The steer of the incident: it fails in the call, with a reason and a hint, and stores nothing.
    const steerError = await sendPrompt(service, P, id, {
      prompt: "steer",
      whenBusy: "steer",
    }).catch((e) => e);
    expect(steerError).toMatchObject({ status: 409, reason: "steer_unsupported" });
    expect(steerError.message).toContain('whenBusy "queue"');
    expect((await repo.listQueuedPrompts(id)).map((q) => q.id)).toEqual([q1.id, q2.id]);
    // The race: a steer the API saw as idle reaches the bridge when the session is busy. It is kept
    // on the queue behind the two prompts, not rejected.
    const raceId = "race-steer";
    await service.queue.enqueue({
      kind: "prompt",
      sub: OWNER,
      sessionId: id,
      commandId: "race-command",
      turnId: raceId,
      prompt: "raced steer",
      whenBusy: "steer",
    });
    await w.pump(true);
    expect((await repo.listQueuedPrompts(id)).map((q) => [q.id, q.status])).toEqual([
      [q1.id, "queued"],
      [q2.id, "queued"],
      [raceId, "queued"],
    ]);

    // The linked PR merged: a wake that closes the session after its turn.
    await repo.putInboxItem({
      PK: sessionPk(id),
      SK: inboxSk("01MERGED"),
      id: "01MERGED",
      sessionId: id,
      source: "github",
      deliveryId: "d-merged",
      deliveryIds: ["d-merged"],
      kind: "pr_merged",
      key: "octo/repo#52",
      prompt: "[GitHub webhook] merged",
      data: null,
      createdAt: new Date(0).toISOString(),
      notBefore: new Date(0).toISOString(),
      status: "pending",
      dropReason: null,
      deliveredTurnId: null,
      autoClose: true,
      ttl: 9_999_999_999,
    });

    await w.consumer.catchUpOnce(w.scheduled[0]);
    await w.pump();

    const wakeTurn = String((await repo.queryInbox(id))[0].deliveredTurnId);
    expect(await startedAt(id, [q1.id, q2.id, raceId, wakeTurn])).toEqual([
      q1.id,
      q2.id,
      raceId,
      wakeTurn,
    ]);
    // Each ran once.
    const events = await repo.queryEvents(id, 0);
    for (const t of [q1.id, q2.id, raceId]) {
      expect(events.filter((e) => e.turnId === t && e.type === "message.chunk")).toHaveLength(1);
    }
    // Nothing failed: no rejection on the event log, no prompt.failed on the feed.
    expect(events.filter((e) => e.type === "turn.failed")).toEqual([]);
    const feed = (await repo.readFeed(OWNER, 0, 200)).events.filter((e) => e.sessionId === id);
    expect(feed.filter((e) => e.type === "prompt.failed")).toEqual([]);
    // The close was asked for once, by the turn that left the queue empty.
    const closes = w.githubSent.filter((m) => m.kind === "harvest" && m.autoClose === true);
    expect(closes).toMatchObject([{ turnId: wakeTurn }]);
    expect((await repo.getSession(id))?.status).toBe("idle");
    expect((await getSession(service, P, id)).queue?.map((q) => [q.turnId, q.status])).toEqual([
      [q1.id, "started"],
      [q2.id, "started"],
      [raceId, "started"],
    ]);
    evidence["01M84TV2"] = {
      queued: [q1.id, q2.id],
      steerInTheCall: { status: steerError.status, reason: steerError.reason },
      racedSteer: raceId,
      turnsInOrder: [q1.id, q2.id, raceId, wakeTurn],
      closeAskedForTurn: (closes[0] as { turnId?: string }).turnId,
    };
  });

  test("a delete by the caller fails each queued prompt before the delete reaches the bridge; the feed has no gap", async () => {
    const w = await world([LAUNCH_NEVER_ENDS, DETACHED_DONE, FOLLOW_UP]);
    const { id } = await launchSession(service, P, { prompt: "first", repos: ["octo/repo"] });
    await w.pump(true);
    const q1 = await sendPrompt(service, P, id, { prompt: "one", whenBusy: "queue" });
    const q2 = await sendPrompt(service, P, id, { prompt: "two", whenBusy: "queue" });
    await w.pump(true);

    await deleteSession(service, P, id, { source: "mcp" });
    // Before the delete command is handled the prompts have already failed, visibly.
    expect((await getSession(service, P, id)).queue).toMatchObject([
      { turnId: q1.id, status: "failed", reason: "session_deleted" },
      { turnId: q2.id, status: "failed", reason: "session_deleted" },
    ]);
    await w.pump(true);
    expect((await repo.getSession(id))?.status).toBe("deleted");
    expect(await repo.getTurn(id, q1.id)).toBeNull();

    const events = await repo.queryEvents(id, 0);
    expect(events.filter((e) => e.rawType === "queued_prompt_failed").map((e) => e.turnId)).toEqual(
      [q1.id, q2.id],
    );
    const all = (await repo.readFeed(OWNER, 0, 500)).events;
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => all[0].seq + i));
    expect(
      all.filter((e) => e.sessionId === id).map((e) => [e.type, e.source, e.payload.reason]),
    ).toEqual([
      ["prompt.failed", "mcp", "session_deleted"],
      ["prompt.failed", "mcp", "session_deleted"],
    ]);
    evidence.deleteWithQueue = all.filter((e) => e.sessionId === id);
  });

  test("five drains at once claim the oldest prompt once and put one command on the queue", async () => {
    const id = `drain-${suffix}`;
    await ddb.send(
      new PutCommand({
        TableName: table,
        Item: sessionItem(id, { createdBy: OWNER, status: "idle", GSI1PK: `USER#${OWNER}` }),
      }),
    );
    await repo.putQueuedPrompt({ sessionId: id, id: "Q1", prompt: "one" });
    await repo.putQueuedPrompt({ sessionId: id, id: "Q2", prompt: "two" });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => drainQueuedPrompts(service, id)),
    );
    const delivered = results.filter((r) => r.status === "delivered");
    expect(delivered).toEqual([{ status: "delivered", turnId: "Q1" }]);
    expect(
      results
        .filter((r) => r.status !== "delivered")
        .every((r) => r.status === "in_flight" || r.status === "contended"),
    ).toBe(true);
    expect((await repo.getQueuedPrompt(id, "Q1"))?.status).toBe("delivered");
    expect((await repo.getQueuedPrompt(id, "Q2"))?.status).toBe("queued");
    // A turn starts from the claim once.
    expect(await repo.startQueuedPrompt(id, "Q1")).toBe(true);
    expect(await repo.startQueuedPrompt(id, "Q1")).toBe(false);
    expect(await repo.releaseQueuedPrompt(id, "Q1")).toBe(false);
    // Drain the message the claim sent, so it does not reach another test.
    const got = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: queueUrl, WaitTimeSeconds: 2, VisibilityTimeout: 1 }),
    );
    expect(got.Messages).toHaveLength(1);
    expect(JSON.parse(got.Messages?.[0].Body ?? "{}")).toMatchObject({
      kind: "prompt",
      turnId: "Q1",
      queued: true,
      whenBusy: "reject",
    });
    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: got.Messages?.[0].ReceiptHandle,
      }),
    );
  });

  test("the queue is listed in the order prompts were sent, keeps a ttl, and fails once", async () => {
    const id = `order-${suffix}`;
    await ddb.send(
      new PutCommand({
        TableName: table,
        Item: sessionItem(id, { createdBy: OWNER, status: "idle", GSI1PK: `USER#${OWNER}` }),
      }),
    );
    for (const turn of ["zzz", "mmm", "aaa"]) {
      await repo.putQueuedPrompt({ sessionId: id, id: turn, prompt: turn });
      await new Promise((r) => setTimeout(r, 3));
    }
    expect(await repo.putQueuedPrompt({ sessionId: id, id: "mmm", prompt: "again" })).toBe(false);
    const items = await repo.listQueuedPrompts(id);
    expect(items.map((i) => i.id)).toEqual(["zzz", "mmm", "aaa"]);
    const week = 7 * 24 * 60 * 60;
    const now = Math.floor(Date.now() / 1000);
    for (const i of items) {
      expect(i.ttl).toBeGreaterThan(now + week - 120);
      expect(i.ttl).toBeLessThanOrEqual(now + week + 5);
    }
    expect(await repo.failQueuedPrompt(id, "zzz", { reason: "not_sent", source: "rest" })).toBe(
      true,
    );
    expect(await repo.failQueuedPrompt(id, "zzz", { reason: "not_sent", source: "rest" })).toBe(
      false,
    );
    const feed = (await repo.readFeed(OWNER, 0, 500)).events.filter(
      (e) => e.sessionId === id && e.type === "prompt.failed",
    );
    expect(feed).toHaveLength(1);
  });
});
