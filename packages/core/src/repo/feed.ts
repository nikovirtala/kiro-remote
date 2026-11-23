/**
 * The change feed's storage: one append-only feed per account (the owner of the session an event
 * is about), written in the same DynamoDB transaction as the state change it records.
 *
 * Layout: PK `FEED#<owner sub>`. The item `SEQ` holds the last sequence number; each event is
 * `EVT#<padded seq>`. A transaction reads the counter, then writes `seq = :next` guarded by the
 * value it read (`attribute_not_exists` when there is none yet), together with the state change and
 * the events numbered `:next`, `:next + 1`, ... Two writers that read the same counter cannot both
 * commit: the second is cancelled by the guard and reads again. Commits are therefore serialised
 * in `seq` order, so an event with a lower `seq` is never committed after a higher one, and a
 * reader holding a cursor cannot miss one.
 */

import {
  type DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ulid } from "ulid";
import { EVENT_SEQ_WIDTH } from "../config.ts";
import {
  FEED_TTL_DAYS,
  FEED_TYPES,
  FEED_VERSION,
  type FeedEnvelope,
  type FeedPage,
  type FeedSource,
  type FeedType,
} from "../schemas/feed.ts";
import { padSeq, ttlFromNow } from "./keys.ts";

export const feedPk = (owner: string): string => `FEED#${owner}`;
export const FEED_COUNTER_SK = "SEQ";
export const feedSk = (seq: number): string => `EVT#${padSeq(seq)}`;
const FEED_SK_MAX = `EVT#${"9".repeat(EVENT_SEQ_WIDTH)}`;
const MAX_ATTEMPTS = 12;

/** What a state change tells the feed. The writer adds the id, sequence, time and effect. */
export interface FeedDraft {
  sessionId: string;
  /** owner/repo#n, or null. */
  pr: string | null;
  type: FeedType;
  source: FeedSource;
  payload: Record<string, unknown>;
}

/** One entry of a TransactWriteItems request (the document client's shape). */
export type TransactOp = Record<string, Record<string, unknown>>;

/** An operation of the transaction failed its condition (not the feed's own counter). */
export class FeedConflictError extends Error {
  /** Index into the operations passed to {@link FeedWriter.transact}. */
  readonly index: number;
  constructor(index: number, cause: unknown) {
    super(`transaction condition failed at operation ${index}`, { cause });
    this.name = "FeedConflictError";
    this.index = index;
  }
}

interface Cancellation {
  name?: string;
  CancellationReasons?: Array<{ Code?: string } | undefined>;
}

const failedCondition = (r: { Code?: string } | undefined): boolean =>
  r?.Code === "ConditionalCheckFailed";
const contended = (r: { Code?: string } | undefined): boolean =>
  r?.Code === "ConditionalCheckFailed" || r?.Code === "TransactionConflict";

export class FeedWriter {
  private readonly ddb: DynamoDBDocumentClient;
  private readonly table: string;
  private readonly now: () => number;

  constructor(ddb: DynamoDBDocumentClient, table: string, now: () => number) {
    this.ddb = ddb;
    this.table = table;
    this.now = now;
  }

  /**
   * Run `ops` and append `drafts` to `owner`'s feed in one transaction. Throws
   * {@link FeedConflictError} when one of `ops` fails its condition, nothing having been written.
   * With no owner (a session that no longer exists) or no drafts, only `ops` run.
   */
  async transact(
    owner: string | null,
    ops: TransactOp[],
    drafts: readonly FeedDraft[],
  ): Promise<void> {
    const withFeed = owner !== null && drafts.length > 0;
    for (let attempt = 1; ; attempt++) {
      const items: TransactOp[] = [...ops];
      if (withFeed) {
        const cur = await this.counter(owner);
        const ts = new Date(this.now()).toISOString();
        const key = { PK: feedPk(owner), SK: FEED_COUNTER_SK };
        items.push({
          Update: {
            TableName: this.table,
            Key: key,
            UpdateExpression: "SET seq = :next",
            ConditionExpression: cur === 0 ? "attribute_not_exists(seq)" : "seq = :cur",
            ExpressionAttributeValues: {
              ":next": cur + drafts.length,
              ...(cur === 0 ? {} : { ":cur": cur }),
            },
          },
        });
        drafts.forEach((d, i) => {
          const seq = cur + i + 1;
          items.push({
            Put: {
              TableName: this.table,
              Item: {
                PK: feedPk(owner),
                SK: feedSk(seq),
                v: FEED_VERSION,
                id: ulid(this.now()),
                seq,
                ts,
                type: d.type,
                effect: FEED_TYPES[d.type].effect,
                sessionId: d.sessionId,
                pr: d.pr,
                source: d.source,
                payload: d.payload,
                ttl: ttlFromNow(FEED_TTL_DAYS * 24 * 60 * 60 * 1000, this.now()),
              },
              ConditionExpression: "attribute_not_exists(PK)",
            },
          });
        });
      }
      try {
        await this.ddb.send(new TransactWriteCommand({ TransactItems: items as never }));
        return;
      } catch (err) {
        const e = err as Cancellation;
        if (e.name !== "TransactionCanceledException") {
          throw err;
        }
        const reasons = e.CancellationReasons ?? [];
        const opFailed = reasons.slice(0, ops.length).findIndex(failedCondition);
        if (opFailed >= 0) {
          throw new FeedConflictError(opFailed, err);
        }
        // Only the counter (or the events behind it) lost a race: read it again, after a short
        // random pause so that writers that collided do not collide again in step.
        if (!withFeed || attempt >= MAX_ATTEMPTS || !reasons.slice(ops.length).some(contended)) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, Math.random() * 10 * attempt));
      }
    }
  }

  private async counter(owner: string): Promise<number> {
    const res = await this.ddb.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: feedPk(owner), SK: FEED_COUNTER_SK },
        ConsistentRead: true,
      }),
    );
    const seq = (res.Item as { seq?: unknown } | undefined)?.seq;
    return typeof seq === "number" ? seq : 0;
  }

  /** Events with `seq > after`, oldest first, at most `limit`. */
  async read(owner: string, after: number, limit: number): Promise<FeedPage> {
    const res = await this.ddb.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "PK = :pk AND SK BETWEEN :from AND :to",
        ExpressionAttributeValues: {
          ":pk": feedPk(owner),
          ":from": feedSk(after + 1),
          ":to": FEED_SK_MAX,
        },
        ScanIndexForward: true,
        Limit: limit + 1,
        ConsistentRead: true,
      }),
    );
    const rows = (res.Items as Array<Record<string, unknown>> | undefined) ?? [];
    const events = rows.slice(0, limit).map(
      (r): FeedEnvelope => ({
        v: FEED_VERSION,
        id: r.id as string,
        seq: r.seq as number,
        ts: r.ts as string,
        type: r.type as string,
        effect: r.effect as FeedEnvelope["effect"],
        sessionId: r.sessionId as string,
        pr: (r.pr as string | null) ?? null,
        source: r.source as FeedSource,
        payload: r.payload as Record<string, unknown>,
      }),
    );
    return {
      events,
      nextCursor: events.length > 0 ? events[events.length - 1].seq : after,
      hasMore: rows.length > limit,
    };
  }
}
