/**
 * The idempotency store against the AWS Emulator (a real DynamoDB API): the
 * create-once conditional put, the stored fingerprint and 24h ttl, replays,
 * refusals, entries without a fingerprint, and a lost race. The REST launch
 * route runs end to end on the real Repository.
 *
 * Skipped unless KIRO_REMOTE_EMULATOR_TEST=1, and refuses to run against
 * anything but a loopback endpoint. See docs/testing.md. The emulator does not
 * evaluate IAM, so this proves the DynamoDB behaviour only, never permissions.
 */

import { randomBytes } from "node:crypto";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { IDEMPOTENCY_TTL_MS, Repository } from "@nikovirtala/kiro-remote-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { HttpRequest, HttpResponse } from "../src/http.ts";
import {
  fingerprintRequest,
  IdempotencyKeyReuseError,
  withIdempotency,
  withIdempotentResult,
} from "../src/idempotency.ts";
import { route } from "../src/router.ts";
import { authHeader, buildHarness, mintToken } from "./helpers.ts";

const ENABLED = process.env.KIRO_REMOTE_EMULATOR_TEST === "1";
const T0 = 1_700_000_000_000;

const ok = (body: string): HttpResponse => ({ status: 202, headers: {}, body });

describe.skipIf(!ENABLED)("idempotency store against the AWS Emulator", () => {
  const table = `kr-idem-${randomBytes(4).toString("hex")}`;
  const raw = new DynamoDBClient({});
  const ddb = DynamoDBDocumentClient.from(raw);
  let repo: Repository;

  beforeAll(async () => {
    const endpoint = process.env.AWS_ENDPOINT_URL ?? "";
    if (!/^https:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/.test(endpoint)) {
      throw new Error(`refusing to run: AWS_ENDPOINT_URL=${endpoint} is not a loopback emulator`);
    }
    await raw.send(
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
      const d = await raw.send(new DescribeTableCommand({ TableName: table }));
      if (d.Table?.TableStatus === "ACTIVE") {
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    repo = new Repository({
      ddb,
      s3: {} as never,
      tableName: table,
      bucketName: "unused",
      now: () => T0,
    });
  });

  afterAll(async () => {
    if (ENABLED) {
      await raw.send(new DeleteTableCommand({ TableName: table }));
    }
  });

  const rawItem = async (sub: string, key: string) =>
    (
      await ddb.send(
        new GetCommand({ TableName: table, Key: { PK: `IDEMP#${sub}#${key}`, SK: "A" } }),
      )
    ).Item;

  test("stores the response with its fingerprint and a 24h ttl", async () => {
    await withIdempotency(repo, "u", "store-1", "fp-1", async () => ok("first"));
    const item = await rawItem("u", "store-1");
    expect(item?.fingerprint).toBe("fp-1");
    expect(item?.ttl).toBe(Math.floor((T0 + IDEMPOTENCY_TTL_MS) / 1000));
    expect(item?.response).toMatchObject({ body: "first" });
  });

  test("a replay with the same fingerprint returns the stored result without running fn", async () => {
    let runs = 0;
    const fn = async () => ok(`run-${++runs}`);
    const a = await withIdempotency(repo, "u", "replay-1", "fp", fn);
    const b = await withIdempotency(repo, "u", "replay-1", "fp", fn);
    expect([a.body, b.body, runs]).toEqual(["run-1", "run-1", 1]);
  });

  test("a replay with a different fingerprint is refused and the stored entry is untouched", async () => {
    await withIdempotency(repo, "u", "mismatch-1", "fp-a", async () => ok("a"));
    await expect(
      withIdempotency(repo, "u", "mismatch-1", "fp-b", async () => ok("b")),
    ).rejects.toBeInstanceOf(IdempotencyKeyReuseError);
    const item = await rawItem("u", "mismatch-1");
    expect(item?.fingerprint).toBe("fp-a");
  });

  test("an entry stored without a fingerprint stays valid for any replay", async () => {
    await repo.putIdempotency("u", "legacy-1", { status: 202, headers: {}, body: "legacy" });
    expect((await rawItem("u", "legacy-1"))?.fingerprint).toBeUndefined();
    let runs = 0;
    const res = await withIdempotency(repo, "u", "legacy-1", "whatever", async () => {
      runs++;
      return ok("new");
    });
    expect([res.body, runs]).toEqual(["legacy", 0]);
  });

  test("the create-once put rejects a second write of the same key", async () => {
    await repo.putIdempotency("u", "once-1", { n: 1 }, "fp");
    await expect(repo.putIdempotency("u", "once-1", { n: 2 }, "fp")).rejects.toMatchObject({
      name: "ConditionalCheckFailedException",
    });
    expect((await repo.getIdempotency("u", "once-1"))?.response).toEqual({ n: 1 });
  });

  test("two concurrent first calls with one key both observe the winner's result", async () => {
    let runs = 0;
    const fn = async () => {
      const n = ++runs;
      await new Promise((r) => setTimeout(r, 20));
      return ok(`run-${n}`);
    };
    const [a, b] = await Promise.all([
      withIdempotency(repo, "u", "race-1", "fp", fn),
      withIdempotency(repo, "u", "race-1", "fp", fn),
    ]);
    expect(a.body).toBe(b.body);
    expect((await repo.getIdempotency("u", "race-1"))?.response).toMatchObject({ body: a.body });
  });

  test("an error is not stored: a retry with the same key runs again", async () => {
    let runs = 0;
    const fn = async () => {
      if (++runs === 1) {
        throw new Error("transient");
      }
      return ok("fine");
    };
    await expect(withIdempotency(repo, "u", "err-1", "fp", fn)).rejects.toThrow("transient");
    expect(await rawItem("u", "err-1")).toBeUndefined();
    expect((await withIdempotency(repo, "u", "err-1", "fp", fn)).body).toBe("fine");
  });

  test("withIdempotentResult (the in-process MCP wrapper) stores and replays a JSON value", async () => {
    const fp = fingerprintRequest("MCP", "launchSession", { prompt: "x" });
    let runs = 0;
    const run = () => withIdempotentResult(repo, "u", "mcp-1", fp, async () => ({ n: ++runs }));
    expect(await run()).toEqual({ n: 1 });
    expect(await run()).toEqual({ n: 1 });
    expect(runs).toBe(1);
    await expect(
      withIdempotentResult(repo, "u", "mcp-1", fingerprintRequest("MCP", "launchSession", {}), run),
    ).rejects.toBeInstanceOf(IdempotencyKeyReuseError);
  });

  describe("REST launch on the real Repository", () => {
    const launch = (
      ctx: ReturnType<typeof buildHarness>["ctx"],
      key: string,
      prompt: string,
    ): Promise<HttpResponse> => {
      const req: HttpRequest = {
        method: "POST",
        path: "/v1/sessions",
        query: {},
        params: {},
        host: "kiro.example.com",
        body: JSON.stringify({ prompt, repos: ["acme/app"] }),
        headers: { ...authHeader(mintToken({})), "idempotency-key": key },
      };
      return route(ctx, req);
    };

    test("one launch per key, and a 422 for the same key with another body", async () => {
      const h = buildHarness({ ids: ["sess-1", "cmd-1", "turn-1", "sess-2", "cmd-2", "turn-2"] });
      const ctx = { ...h.ctx, repo, service: { ...h.ctx.service, repo } };

      const first = await launch(ctx, "rest-launch", "hi");
      const again = await launch(ctx, "rest-launch", "hi");
      expect(first.status).toBe(202);
      expect(again.body).toBe(first.body);
      expect(h.queue.commands).toHaveLength(1);

      const refused = await launch(ctx, "rest-launch", "something else");
      expect(refused.status).toBe(422);
      expect(JSON.parse(refused.body).type).toContain("idempotency-key-reused");
      expect(h.queue.commands).toHaveLength(1);
    });
  });
});
