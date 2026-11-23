/**
 * "Waits for" against the AWS Emulator: the wait records on a real DynamoDB API (the create-once
 * conditional put, one query per session and per PR through GSI1, the delete that only one of two
 * racing callers wins) and the GitHub queue path on a real SQS API (the API's `wait_check`
 * message reaching the consumer, a merge webhook firing a wait, one turn for a wait and the
 * waiter's own conflict).
 *
 * Skipped unless KIRO_REMOTE_EMULATOR_TEST=1, and refuses to run against anything but a loopback
 * endpoint. See docs/testing.md. The emulator does not evaluate IAM, so this proves the DynamoDB
 * and SQS behaviour only, never permissions.
 */

import { randomBytes } from "node:crypto";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  type Command,
  type CommandQueue,
  isGithubQueueMessage,
  type Principal,
  Repository,
  type ServiceDeps,
  SqsGithubQueue,
  stopWaitingForPullRequest,
  waitForPullRequest,
} from "@nikovirtala/kiro-remote-core";
import { sessionItem } from "@nikovirtala/kiro-remote-core/testing";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type ConsumerDeps, handleQueueMessage, processDelivery } from "../src/consumer.ts";
import { CollectingMetrics } from "../src/log.ts";
import { CONFIG, collectingLogger, fixture } from "./helpers.ts";

const ENABLED = process.env.KIRO_REMOTE_EMULATOR_TEST === "1";
const T0 = Date.parse("2026-02-01T11:00:00.000Z");
const H = (c: string) => c.repeat(40);

const P = {
  sub: "user-sub-1",
  scopes: ["sessions:read", "sessions:write", "sessions:delete"],
} as Principal;

describe.skipIf(!ENABLED)("waits against the AWS Emulator", () => {
  const suffix = randomBytes(4).toString("hex");
  const table = `kr-waits-${suffix}`;
  const queueName = `kr-github-${suffix}`;
  const rawDdb = new DynamoDBClient({});
  const ddb = DynamoDBDocumentClient.from(rawDdb);
  const sqs = new SQSClient({});
  let queueUrl = "";
  let repo: Repository;
  let githubQueue: SqsGithubQueue;
  let clock = T0;
  const commands: Command[] = [];
  const commandQueue: CommandQueue = {
    async enqueue(c) {
      commands.push(c);
    },
  };
  const pulls = new Map<string, unknown>();
  let consumer: ConsumerDeps;
  let service: ServiceDeps;
  let n = 0;

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
    queueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: queueName }))).QueueUrl ?? "";
    githubQueue = new SqsGithubQueue({ sqs, queueUrl });
    repo = new Repository({
      ddb,
      s3: {} as never,
      tableName: table,
      bucketName: "unused",
      now: () => clock,
    });
    consumer = {
      repo,
      github: {
        async getPull(r: string, num: number) {
          return (pulls.get(`${r}#${num}`) as never) ?? null;
        },
        async listReviewComments() {
          return [];
        },
        async listAppDeliveries() {
          return [];
        },
        async redeliver() {},
      },
      queue: commandQueue,
      githubQueue,
      config: {
        ...CONFIG,
        conflictDebounceMs: 120_000,
        conflictRecheckDelaysSec: [40, 80],
        wakeOnBehind: false,
        allowedRepos: ["octo/*"],
      },
      metrics: new CollectingMetrics(),
      logger: collectingLogger().logger,
      now: () => clock,
      newId: () => `id-${String(++n).padStart(6, "0")}`,
    };
    service = {
      repo,
      queue: commandQueue,
      allowedRepos: ["octo/*", "ark/*"],
      githubQueue,
    };
  });

  afterAll(async () => {
    if (ENABLED) {
      await rawDdb.send(new DeleteTableCommand({ TableName: table }));
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    }
  });

  const seed = async (id: string, over: Record<string, unknown> = {}) => {
    await ddb.send(
      new PutCommand({
        TableName: table,
        Item: sessionItem(id, { createdAt: "2026-02-01T09:00:00.000Z", ...over }),
      }),
    );
  };

  /** Everything currently on the queue, parsed. */
  async function receiveAll() {
    const out: unknown[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
        }),
      );
      const batch = res.Messages ?? [];
      if (batch.length === 0) {
        break;
      }
      out.push(...batch.map((m) => JSON.parse(m.Body ?? "{}")));
    }
    return out;
  }

  const deliver = async (id: string, number = 7, merged = true) => {
    const payload = fixture(
      merged ? "pull_request.closed.merged" : "pull_request.closed.unmerged",
    ) as { number: number; pull_request: { number: number } };
    payload.number = number;
    payload.pull_request.number = number;
    await repo.putDelivery({
      deliveryId: id,
      event: "pull_request",
      action: "closed",
      repo: "octo/repo",
      rawBody: JSON.stringify(payload),
    });
    return processDelivery(consumer, id);
  };
  const prompts = () => commands.filter((c) => c.kind === "prompt");

  test("a wait is one item: the session on the table key, the PR on GSI1, one query each", async () => {
    await seed("A1");
    await seed("A2");
    const first = await repo.createWait({ sessionId: "A1", pr: "octo/repo#101", source: "mcp" });
    const again = await repo.createWait({ sessionId: "A1", pr: "octo/repo#101", source: "rest" });
    expect([first.created, again.created, again.wait.source]).toEqual([true, false, "mcp"]);
    await repo.createWait({ sessionId: "A1", pr: "ark/ark#5", source: "trailer" });
    await repo.createWait({ sessionId: "A2", pr: "octo/repo#101", source: "rest" });

    expect((await repo.queryWaits("A1")).map((w) => w.pr)).toEqual(["ark/ark#5", "octo/repo#101"]);
    // The index is eventually consistent on AWS; poll briefly like a reader would.
    let waiters = await repo.queryWaiters("octo/repo#101");
    for (let i = 0; i < 20 && waiters.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 250));
      waiters = await repo.queryWaiters("octo/repo#101");
    }
    expect(waiters.map((w) => w.sessionId)).toEqual(["A1", "A2"]);
    expect(await repo.queryOpenLinks("octo/repo")).toEqual([]);
    expect(await repo.queryLinks("A1")).toEqual([]);
  });

  test("deleteWait is won by exactly one of two racing callers", async () => {
    await seed("B1");
    await repo.createWait({ sessionId: "B1", pr: "octo/repo#102", source: "mcp" });
    const results = await Promise.all([
      repo.deleteWait("B1", "octo/repo#102"),
      repo.deleteWait("B1", "octo/repo#102"),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(await repo.queryWaits("B1")).toEqual([]);
  });

  test("registering through the service sends wait_check on SQS; the consumer fires it for a merged PR", async () => {
    await seed("C1");
    await receiveAll(); // drain what earlier tests may have left
    const out = await waitForPullRequest(service, P, "C1", "octo/repo#103", "mcp");
    expect(out.created).toBe(true);
    const sent = await receiveAll();
    expect(sent).toEqual([{ kind: "wait_check", sessionId: "C1", pr: "octo/repo#103" }]);
    expect(isGithubQueueMessage(sent[0])).toBe(true);

    // Open: stored, nothing woken.
    pulls.set("octo/repo#103", {
      number: 103,
      state: "open",
      merged: false,
      createdAt: "2026-02-01T10:00:00Z",
      headSha: H("a"),
      headRef: "x",
      authorLogin: "someone",
      body: null,
      baseRef: "main",
      mergeCommitSha: null,
      mergeable: true,
      mergeableState: "clean",
    });
    await handleQueueMessage(consumer, sent[0] as never);
    expect(prompts()).toEqual([]);
    expect(await repo.queryWaits("C1")).toHaveLength(1);

    // Merged meanwhile: the same message, read again, fires it once.
    pulls.set("octo/repo#103", {
      ...(pulls.get("octo/repo#103") as object),
      state: "closed",
      merged: true,
      mergeCommitSha: H("b"),
    });
    await handleQueueMessage(consumer, sent[0] as never);
    await handleQueueMessage(consumer, sent[0] as never);
    expect(prompts()).toHaveLength(1);
    expect(prompts()[0]).toMatchObject({
      sessionId: "C1",
      whenBusy: "reject",
      trigger: { source: "github", deliveryIds: [] },
    });
    expect((prompts()[0] as { prompt: string }).prompt).toContain(
      `PR #103, which this session waits for, was merged into main at ${H("b")}.`,
    );
    expect(await repo.queryWaits("C1")).toEqual([]);
    expect(await repo.queryInbox("C1", { status: "delivered" })).toHaveLength(1);
  });

  test("a merge webhook wakes every waiter once, linked PR or not, and removes the waits", async () => {
    commands.length = 0;
    await seed("D1");
    await seed("D2");
    await repo.createWait({ sessionId: "D1", pr: "octo/repo#7", source: "mcp" });
    await repo.createWait({ sessionId: "D2", pr: "octo/repo#7", source: "trailer" });
    // The GSI is eventually consistent: let both waits show before the webhook is routed.
    for (let i = 0; i < 20 && (await repo.queryWaiters("octo/repo#7")).length < 2; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const out = await deliver("del-d1");
    expect(out?.status).toBe("processed");
    expect(
      prompts()
        .map((c) => c.sessionId)
        .sort(),
    ).toEqual(["D1", "D2"]);
    expect(await repo.queryWaits("D1")).toEqual([]);
    expect(await repo.queryWaits("D2")).toEqual([]);
    // Redelivered: nobody is woken twice.
    await deliver("del-d2");
    expect(prompts()).toHaveLength(2);
  });

  test("a waiter whose own PR conflicts after the same merge gets one turn for both", async () => {
    commands.length = 0;
    await seed("E1");
    await repo.createLink({
      repo: "octo/repo",
      number: 8,
      sessionId: "E1",
      linkedBy: "harvest",
      prState: "open",
      headSha: H("a"),
      baseRef: "main",
    });
    pulls.set("octo/repo#8", {
      number: 8,
      state: "open",
      merged: false,
      createdAt: "2026-02-01T10:00:00Z",
      headSha: H("a"),
      headRef: "kiro/pr-8",
      authorLogin: "kiro-agent[bot]",
      body: null,
      baseRef: "main",
      mergeable: false,
      mergeableState: "dirty",
    });
    await repo.createWait({ sessionId: "E1", pr: "octo/repo#7", source: "mcp" });
    for (let i = 0; i < 20 && (await repo.queryWaiters("octo/repo#7")).length < 1; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    await deliver("del-e1");
    expect(prompts()).toEqual([]); // both held
    const pending = await repo.queryInbox("E1", { status: "pending" });
    expect(pending.map((i) => i.kind)).toEqual(["pr_conflict", "pr_wait_merged"]);
    expect(pending[0].notBefore).toBe(pending[1].notBefore);

    // The held items scheduled a delayed drain (about 282 s): SQS holds it, not yet receivable.
    expect(await receiveAll()).toEqual([]);
    const attrs = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ["ApproximateNumberOfMessagesDelayed"],
      }),
    );
    expect(Number(attrs.Attributes?.ApproximateNumberOfMessagesDelayed)).toBeGreaterThanOrEqual(1);

    clock = Date.parse(pending[0].notBefore);
    await handleQueueMessage(consumer, { kind: "drain", sessionId: "E1" });
    expect(prompts()).toHaveLength(1);
    const prompt = (prompts()[0] as { prompt: string }).prompt;
    expect(prompt).toContain("PR #8 no longer merges into `main`");
    expect(prompt).toContain("PR #7, which this session waits for, was merged into main");
  });

  test("stopping a wait removes it from both queries", async () => {
    await seed("F1");
    await waitForPullRequest(service, P, "F1", "ark/ark#9", "rest");
    await stopWaitingForPullRequest(service, P, "F1", "ark/ark#9");
    expect(await repo.queryWaits("F1")).toEqual([]);
    for (let i = 0; i < 20 && (await repo.queryWaiters("ark/ark#9")).length > 0; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(await repo.queryWaiters("ark/ark#9")).toEqual([]);
    await receiveAll();
  });
});
