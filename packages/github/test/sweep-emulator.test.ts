/**
 * The scheduled sweep against the AWS Emulator (a real DynamoDB API and SQS): the sparse index
 * (GSI2) on a real table, the transactions that remove a deleted session's waits with their events,
 * the backfill of waits that predate the index, and the whole path of a wait whose PR merged with no
 * webhook: fired by the sweep and read back on the feed with source "sweep". Also the race between
 * a webhook and the sweep for one wait, on real conditional writes.
 *
 * Skipped unless KIRO_REMOTE_EMULATOR_TEST=1, and refuses to run against anything but a loopback
 * endpoint. See docs/testing.md. The emulator does not evaluate IAM, so this proves the DynamoDB
 * and SQS behaviour only, never permissions. Set SWEEP_EVIDENCE_FILE to write the feed it read.
 */

import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { CreateQueueCommand, DeleteQueueCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  backfillSweepIndex,
  type Command,
  type CommandQueue,
  type FeedEnvelope,
  Repository,
  SqsGithubQueue,
} from "@nikovirtala/kiro-remote-core";
import {
  feedViolations,
  type LoggedCommand,
  sessionItem,
} from "@nikovirtala/kiro-remote-core/testing";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { MergedPull } from "../src/app-client.ts";
import { processDelivery } from "../src/consumer.ts";
import { CollectingMetrics } from "../src/log.ts";
import { runSweep, type SweepDeps } from "../src/sweep/index.ts";
import { CONFIG, collectingLogger, fixture } from "./helpers.ts";

const ENABLED = process.env.KIRO_REMOTE_EMULATOR_TEST === "1";
const T0 = Date.parse("2026-02-01T11:00:00.000Z");
const OWNER = "user-sub-1";
const OTHER_OWNER = "user-sub-2";
const MERGE_SHA = "2222222222222222222222222222222222222222";
const H = (c: string) => c.repeat(40);

describe.skipIf(!ENABLED)("the sweep against the AWS Emulator", () => {
  const suffix = randomBytes(4).toString("hex");
  const table = `kr-sweep-${suffix}`;
  const rawDdb = new DynamoDBClient({});
  const ddb = DynamoDBDocumentClient.from(rawDdb);
  const sqs = new SQSClient({});
  const log: LoggedCommand[] = [];
  let queueUrl = "";
  let repo: Repository;
  let clock = T0;
  const commands: Command[] = [];
  const commandQueue: CommandQueue = {
    async enqueue(c) {
      commands.push(c);
    },
  };
  const pulls = new Map<string, unknown>();
  const merges = new Map<string, MergedPull>();
  let deps: SweepDeps;
  let n = 0;

  beforeAll(async () => {
    const endpoint = process.env.AWS_ENDPOINT_URL ?? "";
    if (!/^https:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/.test(endpoint)) {
      throw new Error(`refusing to run: AWS_ENDPOINT_URL=${endpoint} is not a loopback emulator`);
    }
    const index = (name: string) => ({
      IndexName: name,
      KeySchema: [
        { AttributeName: `${name}PK`, KeyType: "HASH" as const },
        { AttributeName: `${name}SK`, KeyType: "RANGE" as const },
      ],
      Projection: { ProjectionType: "ALL" as const },
    });
    // The table as packages/cdk creates it: GSI1 for sessions, links and waits, GSI2 for the sweep.
    await rawDdb.send(
      new CreateTableCommand({
        TableName: table,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: ["PK", "SK", "GSI1PK", "GSI1SK", "GSI2PK", "GSI2SK"].map((a) => ({
          AttributeName: a,
          AttributeType: "S" as const,
        })),
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
        GlobalSecondaryIndexes: [index("GSI1"), index("GSI2")],
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
      (await sqs.send(new CreateQueueCommand({ QueueName: `kr-sweep-${suffix}` }))).QueueUrl ?? "";
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
    deps = {
      repo,
      github: {
        async getPull(r: string, num: number) {
          return (pulls.get(`${r}#${num}`) as never) ?? null;
        },
        async latestMergedPull(r: string, base: string) {
          return merges.get(`${r}#${base}`) ?? null;
        },
        async listReviewComments() {
          return [];
        },
        async listAppDeliveries() {
          return [];
        },
        async redeliver() {},
        rateLimit: () => null,
      },
      queue: commandQueue,
      githubQueue: new SqsGithubQueue({ sqs, queueUrl }),
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
  });

  afterAll(async () => {
    if (ENABLED) {
      await rawDdb.send(new DeleteTableCommand({ TableName: table }));
      await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    }
  });

  const seed = async (id: string, owner = OWNER, over: Record<string, unknown> = {}) => {
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
  const pull = (num: number, over: Record<string, unknown> = {}) =>
    pulls.set(`octo/repo#${num}`, {
      number: num,
      state: "open",
      merged: false,
      createdAt: "2026-02-01T10:00:00Z",
      headSha: H("a"),
      headRef: `kiro/pr-${num}`,
      authorLogin: "kiro-agent[bot]",
      body: null,
      baseRef: "main",
      mergeCommitSha: null,
      mergeable: true,
      mergeableState: "clean",
      ...over,
    });
  const sweep = (run = 0) => {
    clock = T0 + run * 15 * 60_000;
    return runSweep(deps, { intervalMs: 15 * 60_000 });
  };
  const feed = async (owner = OWNER): Promise<FeedEnvelope[]> => {
    const events: FeedEnvelope[] = [];
    let after = 0;
    for (;;) {
      const page = await repo.readFeed(owner, after, 50);
      events.push(...page.events);
      after = page.nextCursor;
      if (!page.hasMore) {
        return events;
      }
    }
  };
  /** The sweep covers the whole table, so a test reads only the events of its own sessions. */
  const of = (events: FeedEnvelope[], ...sessions: string[]) =>
    events.filter((e) => sessions.includes(e.sessionId));
  const brief = (events: FeedEnvelope[]) =>
    events.map((e) => [e.type, e.sessionId, e.pr, e.source, e.payload.reason ?? e.payload.cause]);
  const prompts = (sessionId: string) =>
    commands.filter((c) => c.kind === "prompt" && c.sessionId === sessionId);

  async function webhookMerge(num: number, deliveryId: string) {
    const payload = fixture("pull_request.closed.merged") as {
      number: number;
      pull_request: { number: number; merge_commit_sha: string };
    };
    payload.number = num;
    payload.pull_request.number = num;
    payload.pull_request.merge_commit_sha = MERGE_SHA;
    await repo.putDelivery({
      deliveryId,
      event: "pull_request",
      action: "closed",
      repo: "octo/repo",
      rawBody: JSON.stringify(payload),
    });
    return processDelivery(deps, deliveryId);
  }

  test("the index lists the open waits of every account, and only those", async () => {
    await seed("IDX-A", OWNER);
    await seed("IDX-B", OTHER_OWNER);
    await repo.createWait({ sessionId: "IDX-A", pr: "octo/repo#101", source: "mcp" });
    await repo.createWait({ sessionId: "IDX-B", pr: "octo/repo#101", source: "rest" });
    await repo.createWait({ sessionId: "IDX-A", pr: "octo/repo#102", source: "trailer" });
    await repo.createLink({
      repo: "octo/repo",
      number: 101,
      sessionId: "IDX-A",
      linkedBy: "harvest",
      prState: "open",
      headSha: H("a"),
      baseRef: "main",
    });
    const mine = (await repo.queryOpenWaits()).filter((w) => w.sessionId.startsWith("IDX-"));
    expect(mine.map((w) => [w.pr, w.sessionId])).toEqual([
      ["octo/repo#101", "IDX-A"],
      ["octo/repo#101", "IDX-B"],
      ["octo/repo#102", "IDX-A"],
    ]);
    // A link is in the index while its PR is open, and out of it when it closes.
    expect((await repo.queryOpenLinkIndex()).map((l) => l.pr)).toContain("octo/repo#101");
    await repo.updateLinkState("octo/repo#101", { prState: "merged" });
    expect((await repo.queryOpenLinkIndex()).map((l) => l.pr)).not.toContain("octo/repo#101");
    const stored = await ddb.send(
      new GetCommand({ TableName: table, Key: { PK: "GHPR#octo/repo#101", SK: "LINK" } }),
    );
    expect(stored.Item).not.toHaveProperty("GSI2PK");
    // Neither a session nor an unrelated item is in a sparse index.
    for (const w of await repo.queryOpenWaits()) {
      expect(w.SK.startsWith("WAIT#")).toBe(true);
    }
  });

  test("deleting a session removes its waits with their events in one commit each, in order", async () => {
    await seed("DEL-A", OWNER);
    await seed("DEL-B", OWNER);
    await repo.createWait({ sessionId: "DEL-A", pr: "octo/repo#111", source: "mcp" });
    await repo.createWait({ sessionId: "DEL-A", pr: "ark/ark#112", source: "trailer" });
    await repo.createWait({ sessionId: "DEL-B", pr: "octo/repo#111", source: "rest" });
    const before = (await feed()).length;

    expect(await repo.deleteSessionWaits("DEL-A", { source: "mcp" })).toBe(2);
    expect(await repo.deleteSessionWaits("DEL-A", { source: "mcp" })).toBe(0);

    expect(await repo.queryWaits("DEL-A")).toEqual([]);
    expect((await repo.queryWaits("DEL-B")).map((w) => w.pr)).toEqual(["octo/repo#111"]);
    const events = (await feed()).slice(before);
    expect(brief(events)).toEqual([
      ["wait.removed", "DEL-A", "ark/ark#112", "mcp", "session_deleted"],
      ["wait.removed", "DEL-A", "octo/repo#111", "mcp", "session_deleted"],
    ]);
    // seq has no gaps: the second call, which removed nothing, burned none.
    const all = await feed();
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
    expect((await repo.queryOpenWaits()).some((w) => w.sessionId === "DEL-A")).toBe(false);
  });

  test("a wait whose PR merged with no webhook is fired by the sweep and read back on the feed", async () => {
    await seed("E2E-A", OWNER);
    await repo.createWait({ sessionId: "E2E-A", pr: "octo/repo#121", source: "mcp" });
    pull(121, { state: "closed", merged: true, mergeCommitSha: MERGE_SHA });
    const before = (await feed()).length;

    const result = await sweep();

    expect(result.failedPasses).toEqual([]);
    expect(prompts("E2E-A")).toHaveLength(1);
    expect(await repo.queryWaits("E2E-A")).toEqual([]);
    const events = of((await feed()).slice(before), "E2E-A");
    expect(brief(events)).toEqual([
      ["wait.removed", "E2E-A", "octo/repo#121", "sweep", "merged"],
      ["wake.queued", "E2E-A", "octo/repo#121", "sweep", "wait"],
      ["wake.delivered", "E2E-A", "octo/repo#121", "sweep", "wait"],
    ]);
    if (process.env.SWEEP_EVIDENCE_FILE) {
      writeFileSync(
        process.env.SWEEP_EVIDENCE_FILE,
        `${JSON.stringify(
          events.map((e) => ({
            seq: e.seq,
            type: e.type,
            session: e.sessionId,
            pr: e.pr,
            source: e.source,
            payload: e.payload,
          })),
          null,
          2,
        )}\n`,
      );
    }
  });

  test("a deleted session's wait is removed by the sweep, with no read of GitHub", async () => {
    await seed("GONE-A", OWNER, { status: "deleted" });
    await repo.createWait({ sessionId: "GONE-A", pr: "octo/repo#131", source: "mcp" });
    pull(131, { state: "closed", merged: true, mergeCommitSha: MERGE_SHA });
    const before = (await feed()).length;
    await sweep();
    expect(prompts("GONE-A")).toEqual([]);
    expect(brief(of((await feed()).slice(before), "GONE-A"))).toEqual([
      ["wait.removed", "GONE-A", "octo/repo#131", "sweep", "session_deleted"],
    ]);
  });

  test("a webhook and the sweep race for one wait: one wake, one removal, on real conditional writes", async () => {
    const ids = ["RACE-1", "RACE-2", "RACE-3", "RACE-4", "RACE-5"];
    for (const [i, id] of ids.entries()) {
      await seed(id, OWNER);
      await repo.createWait({ sessionId: id, pr: `octo/repo#${141 + i}`, source: "mcp" });
      pull(141 + i, { state: "closed", merged: true, mergeCommitSha: MERGE_SHA });
    }
    await Promise.all([sweep(), ...ids.map((_, i) => webhookMerge(141 + i, `del-race-${i}`))]);
    for (const id of ids) {
      expect(prompts(id), id).toHaveLength(1);
      expect(await repo.queryWaits(id), id).toEqual([]);
    }
    const events = (await feed()).filter((e) => ids.includes(e.sessionId));
    expect(events.filter((e) => e.type === "wait.removed")).toHaveLength(ids.length);
    expect(events.filter((e) => e.type === "wake.queued")).toHaveLength(ids.length);
    const all = await feed();
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1));
  });

  test("a base that moved with no webhook gets its conflict check, as the sweep, and the tip is kept", async () => {
    await seed("BASE-A", OWNER);
    await repo.createLink({
      repo: "octo/repo",
      number: 151,
      sessionId: "BASE-A",
      linkedBy: "harvest",
      prState: "open",
      headSha: H("a"),
      baseRef: "trunk",
    });
    pull(151, { baseRef: "trunk", mergeable: false, mergeableState: "dirty" });
    merges.set("octo/repo#trunk", {
      number: 150,
      mergedAt: "2026-02-01T12:00:00Z",
      mergeCommitSha: MERGE_SHA,
    });
    const before = (await feed()).length;

    await sweep();

    expect((await repo.getBaseTip("octo/repo", "trunk"))?.sha).toBe(MERGE_SHA);
    expect(brief(of((await feed()).slice(before), "BASE-A"))).toEqual([
      ["wake.queued", "BASE-A", "octo/repo#151", "sweep", "conflict"],
    ]);
    // The same move is not checked again.
    const second = of(await feed(), "BASE-A").length;
    await sweep(1);
    expect(of(await feed(), "BASE-A")).toHaveLength(second);
  });

  test("waits and links that predate the index are found once the backfill has run", async () => {
    await seed("OLD-A", OWNER);
    await repo.createWait({ sessionId: "OLD-A", pr: "octo/repo#161", source: "mcp" });
    await repo.createLink({
      repo: "octo/repo",
      number: 162,
      sessionId: "OLD-A",
      linkedBy: "harvest",
      prState: "open",
      headSha: H("a"),
      baseRef: "main",
    });
    // As written before the index existed: no GSI2 keys.
    for (const Key of [
      { PK: "SESSION#OLD-A", SK: "WAIT#octo/repo#161" },
      { PK: "GHPR#octo/repo#162", SK: "LINK" },
    ]) {
      await ddb.send(
        new UpdateCommand({
          TableName: table,
          Key,
          UpdateExpression: "REMOVE GSI2PK, GSI2SK",
        }),
      );
    }
    expect((await repo.queryOpenWaits()).some((w) => w.sessionId === "OLD-A")).toBe(false);
    expect((await repo.queryOpenLinkIndex()).some((l) => l.pr === "octo/repo#162")).toBe(false);

    const dry = await backfillSweepIndex(ddb, table, { dryRun: true });
    expect(dry.waits).toBeGreaterThanOrEqual(1);
    expect((await repo.queryOpenWaits()).some((w) => w.sessionId === "OLD-A")).toBe(false);

    const done = await backfillSweepIndex(ddb, table, { dryRun: false });
    expect(done.waits).toBe(dry.waits);
    expect((await repo.queryOpenWaits()).some((w) => w.sessionId === "OLD-A")).toBe(true);
    expect((await repo.queryOpenLinkIndex()).some((l) => l.pr === "octo/repo#162")).toBe(true);
    const again = await backfillSweepIndex(ddb, table, { dryRun: false });
    expect(again.waits + again.links).toBe(0);
  });

  test("every write of a link or a wait in this run committed with its event", () => {
    expect(feedViolations(log)).toEqual([]);
  });
});
