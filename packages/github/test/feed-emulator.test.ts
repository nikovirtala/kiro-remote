/**
 * The change feed against the AWS Emulator (a real DynamoDB API and SQS): the transaction that
 * writes a change and its event together, the sequence under concurrent writers, reading across a
 * page boundary by cursor, and the whole path of a wait (registered through the service, fired by
 * a merge webhook, the wake delivered) read back by cursor.
 *
 * Skipped unless KIRO_REMOTE_EMULATOR_TEST=1, and refuses to run against anything but a loopback
 * endpoint. See docs/testing.md. The emulator does not evaluate IAM, so this proves the DynamoDB
 * behaviour only, never permissions.
 */

import { randomBytes } from "node:crypto";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { CreateQueueCommand, DeleteQueueCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  type Command,
  type CommandQueue,
  type FeedEnvelope,
  type InboxItem,
  type Principal,
  Repository,
  type ServiceDeps,
  SqsGithubQueue,
  waitForPullRequest,
} from "@nikovirtala/kiro-remote-core";
import {
  feedViolations,
  type LoggedCommand,
  sessionItem,
} from "@nikovirtala/kiro-remote-core/testing";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type ConsumerDeps, handleQueueMessage, processDelivery } from "../src/consumer.ts";
import { CollectingMetrics } from "../src/log.ts";
import { CONFIG, collectingLogger, fixture } from "./helpers.ts";

const ENABLED = process.env.KIRO_REMOTE_EMULATOR_TEST === "1";
const T0 = Date.parse("2026-02-01T11:00:00.000Z");
const OWNER = "user-sub-1";
const P = { sub: OWNER, scopes: ["sessions:read", "sessions:write"] } as Principal;

describe.skipIf(!ENABLED)("the change feed against the AWS Emulator", () => {
  const suffix = randomBytes(4).toString("hex");
  const table = `kr-feed-${suffix}`;
  const rawDdb = new DynamoDBClient({});
  const ddb = DynamoDBDocumentClient.from(rawDdb);
  const sqs = new SQSClient({});
  const log: LoggedCommand[] = [];
  let queueUrl = "";
  let repo: Repository;
  const clock = T0;
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
    queueUrl =
      (await sqs.send(new CreateQueueCommand({ QueueName: `kr-feed-${suffix}` }))).QueueUrl ?? "";
    // Every command goes through here, so feedViolations can check the whole run.
    const logging = {
      send: async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
        log.push({ name: cmd.constructor.name, input: cmd.input });
        return ddb.send(cmd as never);
      },
    };
    repo = new Repository({
      ddb: logging as never,
      s3: {} as never,
      tableName: table,
      bucketName: "unused",
      now: () => clock,
    });
    const githubQueue = new SqsGithubQueue({ sqs, queueUrl });
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
    service = { repo, queue: commandQueue, allowedRepos: ["octo/*", "ark/*"], githubQueue };
  });

  afterAll(async () => {
    if (ENABLED) {
      await rawDdb.send(new DeleteTableCommand({ TableName: table }));
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    }
  });

  const seed = async (id: string, owner: string, over: Record<string, unknown> = {}) => {
    await ddb.send(
      new PutCommand({
        TableName: table,
        Item: sessionItem(id, {
          createdBy: owner,
          GSI1PK: `USER#${owner}`,
          createdAt: "2026-02-01T09:00:00.000Z",
          ...over,
        }),
      }),
    );
  };

  /** Every event of an account, read in pages of `limit` by cursor. */
  async function readAll(
    owner: string,
    limit = 3,
  ): Promise<{ events: FeedEnvelope[]; pages: number }> {
    const events: FeedEnvelope[] = [];
    let after = 0;
    let pages = 0;
    for (;;) {
      const page = await repo.readFeed(owner, after, limit);
      events.push(...page.events);
      pages++;
      after = page.nextCursor;
      if (!page.hasMore) {
        return { events, pages };
      }
    }
  }

  const wakeItem = (id: string, sessionId: string, key: string): InboxItem => ({
    PK: `SESSION#${sessionId}`,
    SK: `INBOX#${id}`,
    id,
    sessionId,
    source: "github",
    deliveryId: "d1",
    deliveryIds: ["d1"],
    kind: "pr_wait_merged",
    key,
    prompt: "never in the feed",
    data: null,
    createdAt: new Date(T0).toISOString(),
    notBefore: new Date(T0).toISOString(),
    status: "pending",
    dropReason: null,
    deliveredTurnId: null,
    autoClose: false,
    ttl: 9999999999,
  });

  test("a wait registered, a PR merged through a fake webhook, the wake delivered: read back by cursor", async () => {
    await seed("A1", "acct-a", { status: "running" });
    // 1. Registered through the service (the MCP tool's path).
    await waitForPullRequest(service, { ...P, sub: "acct-a" }, "A1", "octo/repo#7", "mcp");
    for (let i = 0; i < 20 && (await repo.queryWaiters("octo/repo#7")).length < 1; i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    // 2. The PR merges: the delivery is routed, the wait fires, the wake is queued. The session is
    //    busy, so the wake stays pending.
    const payload = fixture("pull_request.closed.merged");
    await repo.putDelivery({
      deliveryId: "del-feed-1",
      event: "pull_request",
      action: "closed",
      repo: "octo/repo",
      rawBody: JSON.stringify(payload),
    });
    await processDelivery(consumer, "del-feed-1");

    // The three events, by cursor, one per page.
    const first = await repo.readFeed("acct-a", 0, 1);
    const second = await repo.readFeed("acct-a", first.nextCursor, 1);
    const third = await repo.readFeed("acct-a", second.nextCursor, 1);
    const none = await repo.readFeed("acct-a", third.nextCursor, 1);
    const three = [...first.events, ...second.events, ...third.events];
    expect(three.map((e) => [e.seq, e.type, e.pr, e.source, e.payload])).toEqual([
      [1, "wait.registered", "octo/repo#7", "mcp", { waitSource: "mcp" }],
      [2, "wait.removed", "octo/repo#7", "webhook", { reason: "merged" }],
      [
        3,
        "wake.queued",
        "octo/repo#7",
        "webhook",
        { itemId: expect.any(String), kind: "pr_wait_merged", cause: "wait", merged: false },
      ],
    ]);
    expect([first.hasMore, second.hasMore, third.hasMore]).toEqual([true, true, false]);
    expect(none).toEqual({ events: [], nextCursor: 3, hasMore: false });
    expect(JSON.stringify(three)).not.toContain("Rebase onto");

    // 3. The turn settles; the next drain delivers the wake: a fourth event after the cursor.
    await seed("A1", "acct-a", { status: "idle" });
    await handleQueueMessage(consumer, { kind: "drain", sessionId: "A1" });
    const fourth = await repo.readFeed("acct-a", 3, 10);
    expect(fourth.events.map((e) => [e.seq, e.type, e.payload.cause])).toEqual([
      [4, "wake.delivered", "wait"],
    ]);
  });

  test("a change and its event commit together, or neither does", async () => {
    await seed("B1", "acct-b");
    await repo.createWait({ sessionId: "B1", pr: "octo/repo#21", source: "rest" });
    // The same wait again fails its condition: no wait, no event, no sequence number used.
    const again = await repo.createWait({ sessionId: "B1", pr: "octo/repo#21", source: "mcp" });
    expect(again.created).toBe(false);
    await repo.createWait({ sessionId: "B1", pr: "octo/repo#22", source: "rest" });
    expect((await readAll("acct-b")).events.map((e) => [e.seq, e.pr])).toEqual([
      [1, "octo/repo#21"],
      [2, "octo/repo#22"],
    ]);
    // Firing a wait that is gone commits nothing: neither the wake nor an event.
    await repo.deleteWait("B1", "octo/repo#22");
    const fired = await repo.fireWait({
      sessionId: "B1",
      pr: "octo/repo#22",
      reason: "merged",
      item: wakeItem("w1", "B1", "octo/repo#22"),
      source: "webhook",
    });
    expect(fired).toBe(false);
    expect(await repo.queryInbox("B1")).toEqual([]);
    expect((await repo.readFeed("acct-b", 0, 10)).events.map((e) => e.type)).toEqual([
      "wait.registered",
      "wait.registered",
      "wait.removed",
    ]);
  });

  test("two fires of one wait at once: one commits, with its two events", async () => {
    await seed("C1", "acct-c");
    await repo.createWait({ sessionId: "C1", pr: "octo/repo#31", source: "rest" });
    const results = await Promise.all(
      ["x", "y"].map((id) =>
        repo.fireWait({
          sessionId: "C1",
          pr: "octo/repo#31",
          reason: "merged",
          item: wakeItem(id, "C1", "octo/repo#31"),
          source: id === "x" ? "webhook" : "sweep",
        }),
      ),
    );
    expect(results.sort()).toEqual([false, true]);
    expect(await repo.queryInbox("C1")).toHaveLength(1);
    expect((await readAll("acct-c")).events.map((e) => [e.seq, e.type])).toEqual([
      [1, "wait.registered"],
      [2, "wait.removed"],
      [3, "wake.queued"],
    ]);
  });

  test("ten writers at once on one account: seq 1..10, no gaps, no repeats", async () => {
    await seed("D1", "acct-d");
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        repo.createWait({ sessionId: "D1", pr: `octo/repo#${100 + i}`, source: "rest" }),
      ),
    );
    const { events } = await readAll("acct-d", 4);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(new Set(events.map((e) => e.pr)).size).toBe(10);
  });

  test("a page boundary: pages of 4 over 10 events return each once, in order", async () => {
    const { events, pages } = await readAll("acct-d", 4);
    expect(pages).toBe(3);
    expect(events).toHaveLength(10);
    const exact = await repo.readFeed("acct-d", 6, 4);
    expect([exact.events.length, exact.hasMore, exact.nextCursor]).toEqual([4, false, 10]);
    const edge = await repo.readFeed("acct-d", 0, 10);
    expect([edge.events.length, edge.hasMore]).toEqual([10, false]);
  });

  test("another account's feed is separate: its own numbers, none of these events", async () => {
    await seed("E1", "acct-e");
    await repo.createWait({ sessionId: "E1", pr: "octo/repo#41", source: "rest" });
    expect((await readAll("acct-e")).events.map((e) => [e.seq, e.sessionId])).toEqual([[1, "E1"]]);
    expect(await readAll("acct-nobody")).toEqual({ events: [], pages: 1 });
  });

  test("events keep a TTL of at least 30 days", async () => {
    const res = await ddb.send(
      new GetCommand({ TableName: table, Key: { PK: "FEED#acct-e", SK: "EVT#000000000001" } }),
    );
    const ttl = (res.Item as { ttl: number }).ttl;
    expect(ttl - T0 / 1000).toBeGreaterThanOrEqual(30 * 24 * 60 * 60);
  });

  test("the whole run changed no link or wait without an event", () => {
    expect(feedViolations(log)).toEqual([]);
  });
});
