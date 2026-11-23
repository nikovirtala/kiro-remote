/**
 * DynamoDB single-table repository.
 *
 * The `DynamoDBDocumentClient` and `S3Client` are injected so tests can run
 * fully offline with mocks. Large prompts (>32 KB) and event payloads (>64 KB)
 * are spilled to S3 and stored as {@link S3Pointer}s. Event sequence numbers
 * are allocated from `META.eventSeq` via a conditional atomic update, giving a
 * durable, gap-free, cursor-orderable log.
 */

import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  EVENT_TTL_DAYS,
  GITHUB_DELIVERY_TTL_MS,
  IDEMPOTENCY_TTL_MS,
  INLINE_PAYLOAD_MAX_BYTES,
  INLINE_PROMPT_MAX_BYTES,
  OAUTH_CIMD_MAX_TTL_MS,
  OAUTH_CLIENT_RENEW_AFTER_MS,
  OAUTH_CLIENT_TTL_MS,
  OAUTH_CODE_TTL_MS,
  OAUTH_TX_TTL_MS,
  PERMISSION_TIMEOUT_MS,
  QUEUED_PROMPT_TTL_MS,
} from "../config.ts";
import type { FeedPage, FeedSource, PromptFailReason, WakeCause } from "../schemas/feed.ts";
import { FeedConflictError, type FeedDraft, FeedWriter, type TransactOp } from "./feed.ts";
import {
  CAPS_SK,
  CONFIG_PK,
  clientPk,
  EVENT_SK_MAX,
  eventSk,
  GH_BASE_TIP_SK,
  GH_LINK_OPEN_PREFIX,
  GH_LINK_SK,
  GH_UNMATCHED_PK,
  ghBaseTipPk,
  ghDeliveryPk,
  ghLinkGsi1Sk,
  ghPrPk,
  ghRepoGsi1Pk,
  ghWaitGsi1Pk,
  INBOX_PREFIX,
  idempotencyPk,
  META_SK,
  MODELS_SK,
  oauthCimdPk,
  oauthCodePk,
  oauthTxPk,
  permSk,
  QUEUED_PROMPT_PREFIX,
  queuedPromptSk,
  SESSION_LINK_PREFIX,
  SINGLETON_SK,
  SWEEP_LINK_PK,
  SWEEP_WAIT_PK,
  sessionLinkSk,
  sessionPk,
  sweepLinkSk,
  sweepWaitSk,
  ttlFromNow,
  turnSk,
  userGsi1Pk,
  WAIT_PREFIX,
  waitSk,
} from "./keys.ts";
import type {
  BaseTipItem,
  CapsItem,
  DeliveryItem,
  DeliveryStatus,
  EventItem,
  IdempotencyItem,
  InboxItem,
  LinkMethod,
  ModelsItem,
  OAuthCimdItem,
  OAuthCodeItem,
  OAuthTxItem,
  PermItem,
  PrLinkItem,
  PrState,
  PrWaitItem,
  QueuedPromptItem,
  QueuedPromptStatus,
  RegisteredClientItem,
  S3Pointer,
  SessionLinkItem,
  SessionMetaItem,
  TurnItem,
  UnmatchedItem,
  WaitSource,
} from "./types.ts";

const EVENT_TTL_MS = EVENT_TTL_DAYS * 24 * 60 * 60 * 1000;

/** Raised when an optimistic-lock conditional write fails. */
export class ConcurrentModificationError extends Error {
  constructor(message = "concurrent modification") {
    super(message);
    this.name = "ConcurrentModificationError";
  }
}

export interface RepositoryDeps {
  ddb: DynamoDBDocumentClient;
  s3: S3Client;
  tableName: string;
  bucketName: string;
  /** Injectable clock for deterministic TTLs/timestamps in tests. */
  now?: () => number;
}

/** A PR whose base branch can still move under it: open, or not known yet (a manual link). */
function isOpenState(state: PrState): boolean {
  return state === "open" || state === "unknown";
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function isS3Pointer(value: unknown): value is S3Pointer {
  return typeof value === "object" && value !== null && (value as S3Pointer).s3 === true;
}

/** Why a session is woken, by the kind of wake item. */
function wakeCauseOf(kind: string): WakeCause {
  if (kind === "pr_conflict" || kind === "pr_behind") {
    return "conflict";
  }
  return kind.startsWith("pr_wait_") ? "wait" : "linked_pr_event";
}

/** A wake event for an inbox item. The prompt and the data of the item never go into it. */
function wakeDraft(
  item: InboxItem,
  type: "wake.queued" | "wake.delivered" | "wake.released" | "wake.dropped",
  extra: Record<string, unknown>,
): FeedDraft {
  return {
    sessionId: item.sessionId,
    pr: item.key,
    type,
    source: item.origin ?? "webhook",
    payload: { itemId: item.id, kind: item.kind, cause: wakeCauseOf(item.kind), ...extra },
  };
}

export class Repository {
  private readonly ddb: DynamoDBDocumentClient;
  private readonly s3: S3Client;
  private readonly table: string;
  private readonly bucket: string;
  private readonly now: () => number;
  private readonly feed: FeedWriter;

  constructor(deps: RepositoryDeps) {
    this.ddb = deps.ddb;
    this.s3 = deps.s3;
    this.table = deps.tableName;
    this.bucket = deps.bucketName;
    this.now = deps.now ?? (() => Date.now());
    this.feed = new FeedWriter(deps.ddb, deps.tableName, this.now);
  }

  /**
   * The account a session's feed events go to: the owner of the session. Null when the session no
   * longer exists, in which case the change is made without an event (nobody could read it).
   */
  private async ownerOf(sessionId: string): Promise<string | null> {
    return (await this.getSession(sessionId))?.createdBy ?? null;
  }

  /** The owner's change feed after `after`, oldest first. */
  async readFeed(owner: string, after: number, limit: number): Promise<FeedPage> {
    return this.feed.read(owner, after, limit);
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  /* ----------------------------- S3 spillover ---------------------------- */

  private async spill(prefix: string, value: unknown, maxInline: number): Promise<unknown> {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    const bytes = byteLength(serialized);
    if (bytes <= maxInline) {
      return value;
    }
    const key = `${prefix}/${this.now()}-${Math.random().toString(36).slice(2)}.json`;
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: serialized }));
    const pointer: S3Pointer = { s3: true, bucket: this.bucket, key, bytes };
    return pointer;
  }

  private async resolve(value: unknown): Promise<unknown> {
    if (!isS3Pointer(value)) {
      return value;
    }
    const res = await this.s3.send(new GetObjectCommand({ Bucket: value.bucket, Key: value.key }));
    const body = await res.Body?.transformToString();
    if (body === undefined) {
      return null;
    }
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }

  /* ------------------------------ Sessions ------------------------------- */

  async putSession(item: SessionMetaItem): Promise<void> {
    await this.ddb.send(
      new PutCommand({
        TableName: this.table,
        Item: item,
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  }

  async getSession(id: string): Promise<SessionMetaItem | null> {
    const res = await this.ddb.send(
      new GetCommand({ TableName: this.table, Key: { PK: sessionPk(id), SK: META_SK } }),
    );
    return (res.Item as SessionMetaItem | undefined) ?? null;
  }

  /**
   * Patch a session META item with optimistic locking. `expectedVersion` must
   * match the stored `version`; on success `version` is incremented and
   * `updatedAt`/`GSI1SK` are refreshed.
   */
  async updateSession(
    id: string,
    expectedVersion: number,
    patch: Partial<Omit<SessionMetaItem, "PK" | "SK" | "id" | "version">>,
  ): Promise<void> {
    const updatedAt = this.nowIso();
    const sets: string[] = [
      "#version = #version + :one",
      "updatedAt = :updatedAt",
      "GSI1SK = :updatedAt",
    ];
    const names: Record<string, string> = { "#version": "version" };
    const values: Record<string, unknown> = {
      ":one": 1,
      ":updatedAt": updatedAt,
      ":expected": expectedVersion,
    };
    for (const [key, val] of Object.entries(patch)) {
      names[`#${key}`] = key;
      values[`:${key}`] = val;
      sets.push(`#${key} = :${key}`);
    }
    try {
      await this.ddb.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: sessionPk(id), SK: META_SK },
          UpdateExpression: `SET ${sets.join(", ")}`,
          ConditionExpression: "#version = :expected",
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }),
      );
    } catch (err) {
      if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
        throw new ConcurrentModificationError();
      }
      throw err;
    }
  }

  /**
   * Read-modify-write a session META, retrying when another writer bumps the
   * version in between (a manual prompt or a wake drain touches it too).
   * Returns the item that was read, or null when the session does not exist.
   */
  async patchSession(
    id: string,
    patch: Partial<Omit<SessionMetaItem, "PK" | "SK" | "id" | "version">>,
    attempts = 5,
  ): Promise<SessionMetaItem | null> {
    for (let i = 0; i < attempts; i++) {
      const item = await this.getSession(id);
      if (!item) {
        return null;
      }
      try {
        await this.updateSession(id, item.version, patch);
        return item;
      } catch (err) {
        if (!(err instanceof ConcurrentModificationError)) {
          throw err;
        }
      }
    }
    throw new ConcurrentModificationError(`session ${id} kept changing while patching`);
  }

  /** List a user's sessions via GSI1, newest first. */
  async listSessionsByUser(
    sub: string,
    opts: { limit: number; cursor?: string } = { limit: 20 },
  ): Promise<{ items: SessionMetaItem[]; cursor?: string }> {
    const res = await this.ddb.send(
      new QueryCommand({
        TableName: this.table,
        IndexName: "GSI1",
        KeyConditionExpression: "GSI1PK = :pk",
        ExpressionAttributeValues: { ":pk": userGsi1Pk(sub) },
        ScanIndexForward: false,
        Limit: opts.limit,
        ExclusiveStartKey: opts.cursor ? JSON.parse(decodeCursor(opts.cursor)) : undefined,
      }),
    );
    return {
      items: (res.Items as SessionMetaItem[] | undefined) ?? [],
      cursor: res.LastEvaluatedKey ? encodeCursor(JSON.stringify(res.LastEvaluatedKey)) : undefined,
    };
  }

  /* -------------------------------- Turns -------------------------------- */

  async putTurn(turn: Omit<TurnItem, "prompt"> & { prompt: string }): Promise<void> {
    const prompt = await this.spill(
      `prompts/${turn.sessionId}`,
      turn.prompt,
      INLINE_PROMPT_MAX_BYTES,
    );
    await this.ddb.send(new PutCommand({ TableName: this.table, Item: { ...turn, prompt } }));
  }

  async getTurn(sessionId: string, turnId: string): Promise<TurnItem | null> {
    const res = await this.ddb.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: sessionPk(sessionId), SK: turnSk(turnId) },
      }),
    );
    const item = res.Item as TurnItem | undefined;
    if (!item) {
      return null;
    }
    return { ...item, prompt: (await this.resolve(item.prompt)) as string };
  }

  /* -------------------------------- Events ------------------------------- */

  /**
   * Allocate the next sequence number from META.eventSeq via a conditional
   * atomic increment, then append the EVT# item at that sequence. Returns the
   * allocated sequence. Append-only; payloads over 64 KB spill to S3.
   */
  async appendEvent(
    sessionId: string,
    event: Omit<EventItem, "PK" | "SK" | "seq" | "ttl">,
  ): Promise<number> {
    const res = await this.ddb.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { PK: sessionPk(sessionId), SK: META_SK },
        UpdateExpression: "SET eventSeq = eventSeq + :one",
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeValues: { ":one": 1 },
        ReturnValues: "UPDATED_NEW",
      }),
    );
    const seq = Number((res.Attributes as { eventSeq: number }).eventSeq);
    const payload = await this.spill(
      `events/${sessionId}`,
      event.payload,
      INLINE_PAYLOAD_MAX_BYTES,
    );
    const item: EventItem = {
      PK: sessionPk(sessionId),
      SK: eventSk(seq),
      seq,
      turnId: event.turnId,
      ts: event.ts,
      type: event.type,
      rawType: event.rawType,
      replay: event.replay,
      payload,
      ttl: ttlFromNow(EVENT_TTL_MS, this.now()),
    };
    await this.ddb.send(new PutCommand({ TableName: this.table, Item: item }));
    return seq;
  }

  /** Read events with seq > after, in cursor order, optionally type-filtered. */
  async queryEvents(
    sessionId: string,
    after: number,
    opts: { limit?: number; types?: string[] } = {},
  ): Promise<EventItem[]> {
    // The EVT# range is expressed entirely in the key condition. DynamoDB
    // rejects a FilterExpression that references a primary-key attribute (SK),
    // and BETWEEN on zero-padded seqs already excludes META/TURN#/PERM# rows.
    const res = await this.ddb.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "PK = :pk AND SK BETWEEN :from AND :to",
        ExpressionAttributeValues: {
          ":pk": sessionPk(sessionId),
          ":from": eventSk(after + 1),
          ":to": EVENT_SK_MAX,
        },
        Limit: opts.limit,
      }),
    );
    let items = (res.Items as EventItem[] | undefined) ?? [];
    if (opts.types && opts.types.length > 0) {
      const set = new Set(opts.types);
      items = items.filter((e) => set.has(e.type));
    }
    return Promise.all(items.map(async (e) => ({ ...e, payload: await this.resolve(e.payload) })));
  }

  /* ----------------------------- Permissions ----------------------------- */

  async putPermission(
    sessionId: string,
    perm: Omit<PermItem, "PK" | "SK" | "ttl" | "status" | "answer"> &
      Partial<Pick<PermItem, "status" | "answer">>,
  ): Promise<void> {
    const item: PermItem = {
      PK: sessionPk(sessionId),
      SK: permSk(perm.requestId),
      requestId: perm.requestId,
      toolCallId: perm.toolCallId,
      toolCall: perm.toolCall,
      options: perm.options,
      consent: perm.consent ?? null,
      status: perm.status ?? "pending",
      answer: perm.answer ?? null,
      ttl: ttlFromNow(PERMISSION_TIMEOUT_MS, this.now()),
    };
    await this.ddb.send(new PutCommand({ TableName: this.table, Item: item }));
  }

  /** List a session's permission requests, optionally filtered by status. */
  async queryPermissions(
    sessionId: string,
    opts: { status?: PermItem["status"] } = {},
  ): Promise<PermItem[]> {
    const res = await this.ddb.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :permPrefix)",
        ExpressionAttributeValues: {
          ":pk": sessionPk(sessionId),
          ":permPrefix": "PERM#",
        },
      }),
    );
    let items = (res.Items as PermItem[] | undefined) ?? [];
    if (opts.status) {
      items = items.filter((p) => p.status === opts.status);
    }
    return items;
  }

  async getPermission(sessionId: string, requestId: string): Promise<PermItem | null> {
    const res = await this.ddb.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: sessionPk(sessionId), SK: permSk(requestId) },
      }),
    );
    return (res.Item as PermItem | undefined) ?? null;
  }

  async answerPermission(
    sessionId: string,
    requestId: string,
    answer: Record<string, unknown>,
  ): Promise<void> {
    await this.ddb.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { PK: sessionPk(sessionId), SK: permSk(requestId) },
        UpdateExpression: "SET #status = :answered, answer = :answer",
        ConditionExpression: "#status = :pending",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":answered": "answered",
          ":answer": answer,
          ":pending": "pending",
        },
      }),
    );
  }

  /* ------------------------------- Config -------------------------------- */

  async putCaps(caps: Omit<CapsItem, "PK" | "SK" | "updatedAt">): Promise<void> {
    const item: CapsItem = { PK: CONFIG_PK, SK: CAPS_SK, updatedAt: this.nowIso(), ...caps };
    await this.ddb.send(new PutCommand({ TableName: this.table, Item: item }));
  }

  async getCaps(): Promise<CapsItem | null> {
    const res = await this.ddb.send(
      new GetCommand({ TableName: this.table, Key: { PK: CONFIG_PK, SK: CAPS_SK } }),
    );
    return (res.Item as CapsItem | undefined) ?? null;
  }

  async putModels(models: string[], source: string): Promise<void> {
    const item: ModelsItem = {
      PK: CONFIG_PK,
      SK: MODELS_SK,
      models,
      source,
      updatedAt: this.nowIso(),
    };
    await this.ddb.send(new PutCommand({ TableName: this.table, Item: item }));
  }

  async getModels(): Promise<ModelsItem | null> {
    const res = await this.ddb.send(
      new GetCommand({ TableName: this.table, Key: { PK: CONFIG_PK, SK: MODELS_SK } }),
    );
    return (res.Item as ModelsItem | undefined) ?? null;
  }

  /* -------------------------------- OAuth -------------------------------- */

  async putOAuthTx(id: string, data: Record<string, unknown>): Promise<void> {
    const item: OAuthTxItem = {
      PK: oauthTxPk(id),
      SK: SINGLETON_SK,
      data,
      ttl: ttlFromNow(OAUTH_TX_TTL_MS, this.now()),
    };
    await this.ddb.send(new PutCommand({ TableName: this.table, Item: item }));
  }

  /**
   * True when an item is past its `ttl`. DynamoDB deletes expired items only
   * eventually (typically within a few days) and reads return them until then,
   * so every read of short-lived state checks this. An item with no `ttl`
   * (a client registered before clients expired) never expires.
   */
  private expired(item: { ttl?: number }): boolean {
    return item.ttl !== undefined && item.ttl <= Math.floor(this.now() / 1000);
  }

  /** The transaction, or null when it is unknown or expired. Strongly consistent. */
  async getOAuthTx(id: string): Promise<OAuthTxItem | null> {
    const res = await this.ddb.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: oauthTxPk(id), SK: SINGLETON_SK },
        ConsistentRead: true,
      }),
    );
    const item = res.Item as OAuthTxItem | undefined;
    return item && !this.expired(item) ? item : null;
  }

  /**
   * Consume a transaction: a conditional delete that returns the old item, so
   * of two callbacks with the same state exactly one gets it. Null when it is
   * unknown, already consumed or expired (an expired item is deleted too).
   */
  async consumeOAuthTx(id: string): Promise<OAuthTxItem | null> {
    let old: OAuthTxItem | undefined;
    try {
      const res = await this.ddb.send(
        new DeleteCommand({
          TableName: this.table,
          Key: { PK: oauthTxPk(id), SK: SINGLETON_SK },
          ConditionExpression: "attribute_exists(PK)",
          ReturnValues: "ALL_OLD",
        }),
      );
      old = res.Attributes as OAuthTxItem | undefined;
    } catch (err) {
      if ((err as { name?: string }).name !== "ConditionalCheckFailedException") {
        throw err;
      }
    }
    return old && !this.expired(old) ? old : null;
  }

  async putOAuthCode(
    sha256Code: string,
    code: Omit<OAuthCodeItem, "PK" | "SK" | "ttl">,
  ): Promise<void> {
    const item: OAuthCodeItem = {
      PK: oauthCodePk(sha256Code),
      SK: SINGLETON_SK,
      ttl: ttlFromNow(OAUTH_CODE_TTL_MS, this.now()),
      ...code,
    };
    await this.ddb.send(new PutCommand({ TableName: this.table, Item: item }));
  }

  /**
   * Consume an OAuth code: read-and-delete atomically (deleted on first use,
   * also when it has expired). Null when unknown, already used or expired.
   */
  async consumeOAuthCode(sha256Code: string): Promise<OAuthCodeItem | null> {
    const res = await this.ddb.send(
      new DeleteCommand({
        TableName: this.table,
        Key: { PK: oauthCodePk(sha256Code), SK: SINGLETON_SK },
        ReturnValues: "ALL_OLD",
      }),
    );
    const item = res.Attributes as OAuthCodeItem | undefined;
    return item && !this.expired(item) ? item : null;
  }

  async putCimd(
    sha256ClientId: string,
    document: Record<string, unknown>,
    maxAgeMs: number,
  ): Promise<void> {
    const ttlMs = Math.min(maxAgeMs, OAUTH_CIMD_MAX_TTL_MS);
    const item: OAuthCimdItem = {
      PK: oauthCimdPk(sha256ClientId),
      SK: SINGLETON_SK,
      document,
      ttl: ttlFromNow(ttlMs, this.now()),
    };
    await this.ddb.send(new PutCommand({ TableName: this.table, Item: item }));
  }

  async getCimd(sha256ClientId: string): Promise<OAuthCimdItem | null> {
    const res = await this.ddb.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: oauthCimdPk(sha256ClientId), SK: SINGLETON_SK },
      }),
    );
    return (res.Item as OAuthCimdItem | undefined) ?? null;
  }

  /* ---------------------- Dynamic client registration -------------------- */

  /**
   * Persist a dynamically-registered OAuth client (RFC 7591) with a `ttl`
   * {@link OAUTH_CLIENT_TTL_MS} from now. The `attribute_not_exists(PK)`
   * condition guarantees a re-used `client_id` can never overwrite an existing
   * registration.
   */
  async putClient(item: Omit<RegisteredClientItem, "ttl">): Promise<void> {
    const stored: RegisteredClientItem = {
      ...item,
      ttl: ttlFromNow(OAUTH_CLIENT_TTL_MS, this.now()),
    };
    await this.ddb.send(
      new PutCommand({
        TableName: this.table,
        Item: stored,
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  }

  /** The client, or null when it is unknown or expired. Strongly consistent. */
  async getClient(clientId: string): Promise<RegisteredClientItem | null> {
    const res = await this.ddb.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: clientPk(clientId), SK: SINGLETON_SK },
        ConsistentRead: true,
      }),
    );
    const item = res.Item as RegisteredClientItem | undefined;
    return item && !this.expired(item) ? item : null;
  }

  /**
   * Push a client's `ttl` out to {@link OAUTH_CLIENT_TTL_MS} from now, at most
   * once per {@link OAUTH_CLIENT_RENEW_AFTER_MS}. `currentTtl` is the `ttl` of
   * the item the caller just read: no write is made when it is recent enough
   * or absent (a registration made before clients expired is left as it is).
   * The write is conditional on the stored `ttl` still being old, so two
   * concurrent callers do not both write.
   */
  async renewClient(clientId: string, currentTtl: number | undefined): Promise<void> {
    if (currentTtl === undefined) {
      return;
    }
    const nowMs = this.now();
    const renewBelow = ttlFromNow(OAUTH_CLIENT_TTL_MS - OAUTH_CLIENT_RENEW_AFTER_MS, nowMs);
    if (currentTtl >= renewBelow) {
      return;
    }
    try {
      await this.ddb.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: clientPk(clientId), SK: SINGLETON_SK },
          UpdateExpression: "SET #ttl = :ttl",
          ConditionExpression: "attribute_exists(#ttl) AND #ttl < :renewBelow",
          ExpressionAttributeNames: { "#ttl": "ttl" },
          ExpressionAttributeValues: {
            ":ttl": ttlFromNow(OAUTH_CLIENT_TTL_MS, nowMs),
            ":renewBelow": renewBelow,
          },
        }),
      );
    } catch (err) {
      if ((err as { name?: string }).name !== "ConditionalCheckFailedException") {
        throw err;
      }
    }
  }

  /* ------------------------------ Turn state ----------------------------- */

  /** Settle a turn row: status, stop reason and end time. A no-op when the row is absent. */
  async finishTurn(
    sessionId: string,
    turnId: string,
    patch: { status: TurnItem["status"]; stopReason: string | null },
  ): Promise<void> {
    try {
      await this.ddb.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: sessionPk(sessionId), SK: turnSk(turnId) },
          UpdateExpression: "SET #status = :status, stopReason = :stopReason, endedAt = :endedAt",
          ConditionExpression: "attribute_exists(PK)",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":status": patch.status,
            ":stopReason": patch.stopReason,
            ":endedAt": this.nowIso(),
          },
        }),
      );
    } catch (err) {
      if ((err as { name?: string }).name !== "ConditionalCheckFailedException") {
        throw err;
      }
    }
  }

  /* ------------------------------ PR links ------------------------------- */

  async getPrLink(key: string): Promise<PrLinkItem | null> {
    const res = await this.ddb.send(
      new GetCommand({ TableName: this.table, Key: { PK: ghPrPk(key), SK: GH_LINK_SK } }),
    );
    return (res.Item as PrLinkItem | undefined) ?? null;
  }

  /**
   * Link a PR to a session. A PR links to at most one session: the PR row is
   * written with `attribute_not_exists(PK)`, together with the reverse row, in
   * one transaction. When the PR is already linked nothing is written and the
   * existing link is returned (never overwritten).
   */
  async createLink(args: {
    repo: string;
    number: number;
    sessionId: string;
    linkedBy: LinkMethod;
    prState: PrState;
    headSha: string | null;
    baseRef?: string | null;
    /** What caused the link, for the change feed. Defaults to the method (a manual link: rest). */
    source?: FeedSource;
  }): Promise<{ created: true; link: PrLinkItem } | { created: false; existing: PrLinkItem }> {
    const pr = `${args.repo}#${args.number}`;
    const linkedAt = this.nowIso();
    const link: PrLinkItem = {
      PK: ghPrPk(pr),
      SK: GH_LINK_SK,
      pr,
      repo: args.repo,
      number: args.number,
      sessionId: args.sessionId,
      linkedBy: args.linkedBy,
      linkedAt,
      prState: args.prState,
      headSha: args.headSha,
      baseRef: args.baseRef ?? null,
      GSI1PK: ghRepoGsi1Pk(args.repo),
      GSI1SK: ghLinkGsi1Sk(isOpenState(args.prState), args.number),
      ...(isOpenState(args.prState) ? { GSI2PK: SWEEP_LINK_PK, GSI2SK: sweepLinkSk(pr) } : {}),
    };
    const reverse: SessionLinkItem = {
      PK: sessionPk(args.sessionId),
      SK: sessionLinkSk(pr),
      pr,
      repo: args.repo,
      number: args.number,
      sessionId: args.sessionId,
      linkedBy: args.linkedBy,
      linkedAt,
    };
    try {
      await this.feed.transact(
        await this.ownerOf(args.sessionId),
        [
          {
            Put: {
              TableName: this.table,
              Item: link,
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          { Put: { TableName: this.table, Item: reverse } },
        ],
        [
          {
            sessionId: args.sessionId,
            pr,
            type: "link.added",
            source: args.source ?? (args.linkedBy === "manual" ? "rest" : args.linkedBy),
            payload: { method: args.linkedBy, prState: args.prState },
          },
        ],
      );
      return { created: true, link };
    } catch (err) {
      if (!(err instanceof FeedConflictError)) {
        throw err;
      }
      const existing = await this.getPrLink(pr);
      if (!existing) {
        throw err;
      }
      return { created: false, existing };
    }
  }

  /** A session's linked PRs, with the PR-side state, oldest first. */
  async queryLinks(sessionId: string): Promise<PrLinkItem[]> {
    const res = await this.ddb.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :p)",
        ExpressionAttributeValues: { ":pk": sessionPk(sessionId), ":p": SESSION_LINK_PREFIX },
      }),
    );
    const reverse = (res.Items as SessionLinkItem[] | undefined) ?? [];
    const links = await Promise.all(reverse.map((r) => this.getPrLink(r.pr)));
    return links.filter((l): l is PrLinkItem => l !== null && l.sessionId === sessionId);
  }

  /**
   * The links of a repo whose PR is open (or of unknown state), via GSI1. Links
   * written before the index existed are not found until their PR state is next
   * refreshed (see {@link updateLinkState}).
   */
  async queryOpenLinks(repo: string): Promise<PrLinkItem[]> {
    const items: PrLinkItem[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const res = await this.ddb.send(
        new QueryCommand({
          TableName: this.table,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :pk AND begins_with(GSI1SK, :p)",
          ExpressionAttributeValues: { ":pk": ghRepoGsi1Pk(repo), ":p": GH_LINK_OPEN_PREFIX },
          ExclusiveStartKey: cursor,
        }),
      );
      items.push(...((res.Items as PrLinkItem[] | undefined) ?? []));
      cursor = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (cursor);
    return items.filter((l) => isOpenState(l.prState));
  }

  /** Remove a link. Only the owning session can remove it. Returns false when there was none. */
  async deleteLink(
    key: string,
    sessionId: string,
    opts: { source?: FeedSource } = {},
  ): Promise<boolean> {
    try {
      await this.feed.transact(
        await this.ownerOf(sessionId),
        [
          {
            Delete: {
              TableName: this.table,
              Key: { PK: ghPrPk(key), SK: GH_LINK_SK },
              ConditionExpression: "sessionId = :sessionId",
              ExpressionAttributeValues: { ":sessionId": sessionId },
            },
          },
          {
            Delete: {
              TableName: this.table,
              Key: { PK: sessionPk(sessionId), SK: sessionLinkSk(key) },
            },
          },
        ],
        [
          {
            sessionId,
            pr: key,
            type: "link.removed",
            source: opts.source ?? "rest",
            payload: { reason: "unlinked" },
          },
        ],
      );
      return true;
    } catch (err) {
      if (err instanceof FeedConflictError) {
        return false;
      }
      throw err;
    }
  }

  /**
   * Refresh the PR-side state of an existing link (from webhook payloads). A change of `prState` is
   * written with its `link.state_changed` event in one transaction; a refresh of the head or base
   * alone, or of the same state, is not a change a reader follows and writes no event.
   */
  async updateLinkState(
    key: string,
    patch: { prState?: PrState; headSha?: string | null; baseRef?: string | null },
    opts: { source?: FeedSource } = {},
  ): Promise<void> {
    const sets: string[] = [];
    const removes: string[] = [];
    const values: Record<string, unknown> = {};
    if (patch.prState !== undefined) {
      sets.push("prState = :prState");
      values[":prState"] = patch.prState;
      // Keep GSI1 in step with the state (this also indexes links that predate it).
      const hash = key.lastIndexOf("#");
      const number = Number(key.slice(hash + 1));
      if (hash > 0 && Number.isInteger(number)) {
        sets.push("GSI1PK = :gsi1pk", "GSI1SK = :gsi1sk");
        values[":gsi1pk"] = ghRepoGsi1Pk(key.slice(0, hash));
        values[":gsi1sk"] = ghLinkGsi1Sk(isOpenState(patch.prState), number);
        // The sweep's index holds a link only while its PR is open (or not known yet).
        if (isOpenState(patch.prState)) {
          sets.push("GSI2PK = :gsi2pk", "GSI2SK = :gsi2sk");
          values[":gsi2pk"] = SWEEP_LINK_PK;
          values[":gsi2sk"] = sweepLinkSk(key);
        } else {
          removes.push("GSI2PK", "GSI2SK");
        }
      }
    }
    if (patch.baseRef !== undefined) {
      sets.push("baseRef = :baseRef");
      values[":baseRef"] = patch.baseRef;
    }
    if (patch.headSha !== undefined) {
      sets.push("headSha = :headSha");
      values[":headSha"] = patch.headSha;
    }
    if (sets.length === 0) {
      return;
    }
    const updateExpression = `SET ${sets.join(", ")}${removes.length > 0 ? ` REMOVE ${removes.join(", ")}` : ""}`;
    const Key = { PK: ghPrPk(key), SK: GH_LINK_SK };
    for (let attempt = 1; ; attempt++) {
      const current = patch.prState !== undefined ? await this.getPrLink(key) : null;
      const changes = current !== null && patch.prState !== current.prState;
      try {
        if (changes && current) {
          await this.feed.transact(
            await this.ownerOf(current.sessionId),
            [
              {
                Update: {
                  TableName: this.table,
                  Key,
                  UpdateExpression: updateExpression,
                  ConditionExpression: "attribute_exists(PK) AND prState = :prevState",
                  ExpressionAttributeValues: { ...values, ":prevState": current.prState },
                },
              },
            ],
            [
              {
                sessionId: current.sessionId,
                pr: key,
                type: "link.state_changed",
                source: opts.source ?? "webhook",
                payload: { from: current.prState, to: patch.prState },
              },
            ],
          );
        } else {
          await this.ddb.send(
            new UpdateCommand({
              TableName: this.table,
              Key,
              UpdateExpression: updateExpression,
              ConditionExpression: "attribute_exists(PK)",
              ExpressionAttributeValues: values,
            }),
          );
        }
        return;
      } catch (err) {
        // The link is gone, or (with an event) its state moved under us: read it again.
        const name = (err as { name?: string }).name;
        if (err instanceof FeedConflictError) {
          if (attempt >= 3 || (await this.getPrLink(key)) === null) {
            return;
          }
          continue;
        }
        if (name !== "ConditionalCheckFailedException") {
          throw err;
        }
        return;
      }
    }
  }

  /* ------------------------------ PR waits ------------------------------- */

  /**
   * Register a wait: the session wants a wake when the PR merges or closes. One item, written
   * with `attribute_not_exists(PK)`, so registering twice is a no-op that returns the first one.
   * `pr` is the canonical lower-cased `owner/repo#n` (see prKeyOf).
   */
  async createWait(args: {
    sessionId: string;
    pr: string;
    source: WaitSource;
  }): Promise<{ created: true; wait: PrWaitItem } | { created: false; wait: PrWaitItem }> {
    const hash = args.pr.lastIndexOf("#");
    const wait: PrWaitItem = {
      PK: sessionPk(args.sessionId),
      SK: waitSk(args.pr),
      sessionId: args.sessionId,
      pr: args.pr,
      repo: args.pr.slice(0, hash),
      number: Number(args.pr.slice(hash + 1)),
      source: args.source,
      createdAt: this.nowIso(),
      GSI1PK: ghWaitGsi1Pk(args.pr),
      GSI1SK: args.sessionId,
      GSI2PK: SWEEP_WAIT_PK,
      GSI2SK: sweepWaitSk(args.pr, args.sessionId),
    };
    try {
      await this.feed.transact(
        await this.ownerOf(args.sessionId),
        [
          {
            Put: {
              TableName: this.table,
              Item: wait,
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
        ],
        [
          {
            sessionId: args.sessionId,
            pr: args.pr,
            type: "wait.registered",
            source: args.source,
            payload: { waitSource: args.source },
          },
        ],
      );
      return { created: true, wait };
    } catch (err) {
      if (!(err instanceof FeedConflictError)) {
        throw err;
      }
      const existing = await this.getWait(args.sessionId, args.pr);
      if (!existing) {
        throw err;
      }
      return { created: false, wait: existing };
    }
  }

  async getWait(sessionId: string, pr: string): Promise<PrWaitItem | null> {
    const res = await this.ddb.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: sessionPk(sessionId), SK: waitSk(pr) },
        ConsistentRead: true,
      }),
    );
    return (res.Item as PrWaitItem | undefined) ?? null;
  }

  /** The PRs a session waits for, oldest PR key first. */
  async queryWaits(sessionId: string): Promise<PrWaitItem[]> {
    const items: PrWaitItem[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const res = await this.ddb.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :p)",
          ExpressionAttributeValues: { ":pk": sessionPk(sessionId), ":p": WAIT_PREFIX },
          ConsistentRead: true,
          ExclusiveStartKey: cursor,
        }),
      );
      items.push(...((res.Items as PrWaitItem[] | undefined) ?? []));
      cursor = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (cursor);
    return items;
  }

  /**
   * The sessions waiting for a PR, via GSI1. A global index read is eventually consistent: a wait
   * written a moment ago may be missing. Registering a wait therefore always reads the PR after
   * storing it (the `wait_check` message), which covers the PR having merged in that window.
   */
  async queryWaiters(pr: string): Promise<PrWaitItem[]> {
    const items: PrWaitItem[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const res = await this.ddb.send(
        new QueryCommand({
          TableName: this.table,
          IndexName: "GSI1",
          KeyConditionExpression: "GSI1PK = :pk",
          ExpressionAttributeValues: { ":pk": ghWaitGsi1Pk(pr) },
          ExclusiveStartKey: cursor,
        }),
      );
      items.push(...((res.Items as PrWaitItem[] | undefined) ?? []));
      cursor = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (cursor);
    return items;
  }

  /**
   * Every open wait, across accounts, from the sweep's sparse index (GSI2), sorted by PR so that
   * the waits for one PR are adjacent. A global index read is eventually consistent: a wait written
   * a moment ago may be missing, and the next run finds it. Waits written before the index existed
   * are not in it until `backfillSweepIndex` has run (tasks/).
   */
  async queryOpenWaits(): Promise<PrWaitItem[]> {
    return this.querySweepIndex<PrWaitItem>(SWEEP_WAIT_PK);
  }

  /**
   * Every linked PR that is open or not known yet, across accounts and repos, from GSI2. The
   * sweep groups them by repo and base branch.
   */
  async queryOpenLinkIndex(): Promise<PrLinkItem[]> {
    const links = await this.querySweepIndex<PrLinkItem>(SWEEP_LINK_PK);
    return links.filter((l) => isOpenState(l.prState));
  }

  private async querySweepIndex<T>(pk: string): Promise<T[]> {
    const items: T[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const res = await this.ddb.send(
        new QueryCommand({
          TableName: this.table,
          IndexName: "GSI2",
          KeyConditionExpression: "GSI2PK = :pk",
          ExpressionAttributeValues: { ":pk": pk },
          ExclusiveStartKey: cursor,
        }),
      );
      items.push(...((res.Items as T[] | undefined) ?? []));
      cursor = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (cursor);
    return items;
  }

  /**
   * Remove every wait of a session, each with its `wait.removed` event (`session_deleted`) in one
   * transaction. A wait that went meanwhile (it fired, or the caller removed it) is not counted.
   * Returns the number removed. Called when a session is deleted, so no wait outlives its session.
   */
  async deleteSessionWaits(sessionId: string, opts: { source?: FeedSource } = {}): Promise<number> {
    let removed = 0;
    for (const wait of await this.queryWaits(sessionId)) {
      if (await this.deleteWait(sessionId, wait.pr, { reason: "session_deleted", ...opts })) {
        removed++;
      }
    }
    return removed;
  }

  /** The tip a base branch had when it was last checked, or null. */
  async getBaseTip(repo: string, base: string): Promise<BaseTipItem | null> {
    const res = await this.ddb.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: ghBaseTipPk(repo, base), SK: GH_BASE_TIP_SK },
        ConsistentRead: true,
      }),
    );
    return (res.Item as BaseTipItem | undefined) ?? null;
  }

  /** Record the tip a base branch had when it was checked. Last write wins. */
  async putBaseTip(args: {
    repo: string;
    base: string;
    sha: string;
    afterPr: number | null;
  }): Promise<void> {
    const item: BaseTipItem = {
      PK: ghBaseTipPk(args.repo, args.base),
      SK: GH_BASE_TIP_SK,
      repo: args.repo.toLowerCase(),
      base: args.base,
      sha: args.sha,
      afterPr: args.afterPr,
      checkedAt: this.nowIso(),
    };
    await this.ddb.send(new PutCommand({ TableName: this.table, Item: item }));
  }

  /**
   * Remove a wait, with its `wait.removed` event. True for the one caller whose delete removed it,
   * false when there was none, so a wait removed by a webhook and by a re-check at once is removed
   * once. `reason` is why: `stopped` by the caller (the default), `registration_failed`, or
   * `session_deleted` (the session is gone, so nothing is left to wake). A wait that fires goes
   * through {@link fireWait}, which also writes the wake.
   */
  async deleteWait(
    sessionId: string,
    pr: string,
    opts: {
      reason?: "stopped" | "registration_failed" | "session_deleted";
      source?: FeedSource;
    } = {},
  ): Promise<boolean> {
    try {
      await this.feed.transact(
        await this.ownerOf(sessionId),
        [this.waitDelete(sessionId, pr)],
        [
          {
            sessionId,
            pr,
            type: "wait.removed",
            source: opts.source ?? "rest",
            payload: { reason: opts.reason ?? "stopped" },
          },
        ],
      );
      return true;
    } catch (err) {
      if (err instanceof FeedConflictError) {
        return false;
      }
      throw err;
    }
  }

  private waitDelete(sessionId: string, pr: string): TransactOp {
    return {
      Delete: {
        TableName: this.table,
        Key: { PK: sessionPk(sessionId), SK: waitSk(pr) },
        ConditionExpression: "attribute_exists(PK)",
      },
    };
  }

  /**
   * Fire a wait: remove it and write the wake that tells the session, with both events, in one
   * transaction. The delete is the claim: of a webhook and a check that fire the same wait at once,
   * only one commits, and a wake that cannot be written leaves the wait where it was. False when
   * the wait was already gone (nothing is written).
   */
  async fireWait(args: {
    sessionId: string;
    pr: string;
    /** Why it fired: the awaited PR merged, was closed, or could not be read. */
    reason: "merged" | "closed" | "unreadable";
    item: InboxItem;
    /** What read GitHub: a webhook, or the check made on registration (a sweep). */
    source: FeedSource;
  }): Promise<boolean> {
    const item: InboxItem = { ...args.item, origin: args.source };
    try {
      await this.feed.transact(
        await this.ownerOf(args.sessionId),
        [
          this.waitDelete(args.sessionId, args.pr),
          {
            Put: {
              TableName: this.table,
              Item: item,
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
        ],
        [
          {
            sessionId: args.sessionId,
            pr: args.pr,
            type: "wait.removed",
            source: args.source,
            payload: { reason: args.reason },
          },
          wakeDraft(item, "wake.queued", { merged: false }),
        ],
      );
      return true;
    } catch (err) {
      if (err instanceof FeedConflictError && err.index === 0) {
        return false;
      }
      throw err;
    }
  }

  /* ----------------------------- GitHub deliveries ----------------------- */

  /**
   * Store a verified delivery and claim its id in one conditional put. Returns
   * false when the id was already seen (a duplicate or a redelivery). Bodies
   * over the inline threshold are written to S3 under a key derived from the
   * delivery id, so a duplicate rewrites the same object instead of leaking.
   */
  async putDelivery(args: {
    deliveryId: string;
    event: string;
    action: string | null;
    repo: string | null;
    rawBody: string;
  }): Promise<boolean> {
    let body: string | S3Pointer = args.rawBody;
    const bytes = byteLength(args.rawBody);
    if (bytes > INLINE_PAYLOAD_MAX_BYTES) {
      const key = `github/deliveries/${args.deliveryId}.json`;
      await this.s3.send(
        new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: args.rawBody }),
      );
      body = { s3: true, bucket: this.bucket, key, bytes };
    }
    const item: DeliveryItem = {
      PK: ghDeliveryPk(args.deliveryId),
      SK: "A",
      deliveryId: args.deliveryId,
      event: args.event,
      action: args.action,
      repo: args.repo,
      receivedAt: this.nowIso(),
      status: "received",
      body,
      ttl: ttlFromNow(GITHUB_DELIVERY_TTL_MS, this.now()),
    };
    try {
      await this.ddb.send(
        new PutCommand({
          TableName: this.table,
          Item: item,
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
      return true;
    } catch (err) {
      if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
        return false;
      }
      throw err;
    }
  }

  /** Forget a delivery id, so GitHub's redelivery of it is accepted again (used when it could not be enqueued). */
  async deleteDelivery(deliveryId: string): Promise<void> {
    await this.ddb.send(
      new DeleteCommand({
        TableName: this.table,
        Key: { PK: ghDeliveryPk(deliveryId), SK: "A" },
      }),
    );
  }

  /** Read a delivery; `rawBody` is the original request body (resolved from S3 when spilled). */
  async getDelivery(deliveryId: string): Promise<(DeliveryItem & { rawBody: string }) | null> {
    const res = await this.ddb.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: ghDeliveryPk(deliveryId), SK: "A" },
      }),
    );
    const item = res.Item as DeliveryItem | undefined;
    if (!item) {
      return null;
    }
    if (typeof item.body === "string") {
      return { ...item, rawBody: item.body };
    }
    const obj = await this.s3.send(
      new GetObjectCommand({ Bucket: item.body.bucket, Key: item.body.key }),
    );
    return { ...item, rawBody: (await obj.Body?.transformToString()) ?? "" };
  }

  async setDeliveryStatus(deliveryId: string, status: DeliveryStatus): Promise<void> {
    await this.ddb.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { PK: ghDeliveryPk(deliveryId), SK: "A" },
        UpdateExpression: "SET #status = :status",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":status": status },
      }),
    );
  }

  /* -------------------------------- Inbox -------------------------------- */

  /** Add a wake to the session's inbox, with its `wake.queued` event. */
  async putInboxItem(item: InboxItem, opts: { source?: FeedSource } = {}): Promise<void> {
    const stored: InboxItem = { ...item, origin: opts.source ?? item.origin ?? "webhook" };
    await this.feed.transact(
      await this.ownerOf(item.sessionId),
      [
        {
          Put: {
            TableName: this.table,
            Item: stored,
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
      ],
      [wakeDraft(stored, "wake.queued", { merged: false })],
    );
  }

  async getInboxItem(sessionId: string, id: string): Promise<InboxItem | null> {
    const res = await this.ddb.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: sessionPk(sessionId), SK: `${INBOX_PREFIX}${id}` },
        ConsistentRead: true,
      }),
    );
    return (res.Item as InboxItem | undefined) ?? null;
  }

  /** A session's inbox items, oldest first, optionally only one status. */
  async queryInbox(
    sessionId: string,
    opts: { status?: InboxItem["status"] } = {},
  ): Promise<InboxItem[]> {
    const res = await this.ddb.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :p)",
        ExpressionAttributeValues: { ":pk": sessionPk(sessionId), ":p": INBOX_PREFIX },
        ScanIndexForward: true,
      }),
    );
    let items = (res.Items as InboxItem[] | undefined) ?? [];
    if (opts.status) {
      items = items.filter((i) => i.status === opts.status);
    }
    return items;
  }

  /**
   * Move an inbox item from one status to another. With `event`, the item is read first and the
   * update is written with the event it returns (null for none) in one transaction.
   */
  private async inboxTransition(
    sessionId: string,
    id: string,
    from: InboxItem["status"],
    set: Record<string, unknown>,
    extraCondition?: { name: string; value: unknown },
    event?: (item: InboxItem) => FeedDraft | null,
  ): Promise<boolean> {
    const sets: string[] = [];
    const names: Record<string, string> = { "#status": "status" };
    const values: Record<string, unknown> = { ":from": from };
    for (const [k, v] of Object.entries(set)) {
      names[`#${k}`] = k;
      values[`:${k}`] = v;
      sets.push(`#${k} = :${k}`);
    }
    let condition = "#status = :from";
    if (extraCondition) {
      names[`#${extraCondition.name}`] = extraCondition.name;
      values[`:c_${extraCondition.name}`] = extraCondition.value;
      condition += ` AND #${extraCondition.name} = :c_${extraCondition.name}`;
    }
    const Key = { PK: sessionPk(sessionId), SK: `${INBOX_PREFIX}${id}` };
    try {
      const item = event ? await this.getInboxItem(sessionId, id) : null;
      const draft = item && event ? event(item) : null;
      if (event && !item) {
        return false;
      }
      if (draft) {
        // ExpressionAttributeNames are only valid when a name is used, which they all are.
        await this.feed.transact(
          await this.ownerOf(sessionId),
          [
            {
              Update: {
                TableName: this.table,
                Key,
                UpdateExpression: `SET ${sets.join(", ")}`,
                ConditionExpression: condition,
                ExpressionAttributeNames: names,
                ExpressionAttributeValues: values,
              },
            },
          ],
          [draft],
        );
      } else {
        await this.ddb.send(
          new UpdateCommand({
            TableName: this.table,
            Key,
            UpdateExpression: `SET ${sets.join(", ")}`,
            ConditionExpression: condition,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          }),
        );
      }
      return true;
    } catch (err) {
      if (
        err instanceof FeedConflictError ||
        (err as { name?: string }).name === "ConditionalCheckFailedException"
      ) {
        return false;
      }
      throw err;
    }
  }

  /** Mark pending items delivered by `turnId`. Returns the ids actually claimed. */
  async claimInbox(sessionId: string, ids: string[], turnId: string): Promise<string[]> {
    const claimed: string[] = [];
    for (const id of ids) {
      if (
        await this.inboxTransition(
          sessionId,
          id,
          "pending",
          { status: "delivered", deliveredTurnId: turnId },
          undefined,
          (item) => wakeDraft(item, "wake.delivered", { turnId }),
        )
      ) {
        claimed.push(id);
      }
    }
    return claimed;
  }

  /** Undo a claim (the wake turn never started): delivered by `turnId` -> pending again. */
  async releaseInbox(sessionId: string, ids: string[], turnId: string): Promise<void> {
    for (const id of ids) {
      await this.inboxTransition(
        sessionId,
        id,
        "delivered",
        { status: "pending", deliveredTurnId: null },
        { name: "deliveredTurnId", value: turnId },
        (item) => wakeDraft(item, "wake.released", { turnId }),
      );
    }
  }

  /** Drop pending items with a recorded reason. Returns how many were dropped. */
  async dropInbox(sessionId: string, ids: string[], reason: string): Promise<number> {
    let dropped = 0;
    for (const id of ids) {
      if (
        await this.inboxTransition(
          sessionId,
          id,
          "pending",
          { status: "dropped", dropReason: reason },
          undefined,
          (item) => wakeDraft(item, "wake.dropped", { reason }),
        )
      ) {
        dropped++;
      }
    }
    return dropped;
  }

  /** Merge into a still-pending item (debounce). False when it was drained meanwhile. */
  async mergeInboxItem(
    sessionId: string,
    id: string,
    patch: { deliveryIds: string[]; prompt: string; data: Record<string, unknown> | null },
  ): Promise<boolean> {
    return this.inboxTransition(
      sessionId,
      id,
      "pending",
      { deliveryIds: patch.deliveryIds, prompt: patch.prompt, data: patch.data },
      undefined,
      (item) => wakeDraft(item, "wake.queued", { merged: true }),
    );
  }

  /** Move a still-pending item's due time (ISO-8601). False when it was drained meanwhile. */
  async setInboxNotBefore(sessionId: string, id: string, notBefore: string): Promise<boolean> {
    return this.inboxTransition(sessionId, id, "pending", { notBefore });
  }

  /* ---------------------------- Queued prompts --------------------------- */

  /**
   * Store a prompt sent with whenBusy "queue", under the turn id its caller was given. False when
   * that id is already stored (a retried call, a command delivered twice): the first write stands.
   */
  async putQueuedPrompt(args: { sessionId: string; id: string; prompt: string }): Promise<boolean> {
    const prompt = await this.spill(
      `prompts/${args.sessionId}`,
      args.prompt,
      INLINE_PROMPT_MAX_BYTES,
    );
    const item: QueuedPromptItem = {
      PK: sessionPk(args.sessionId),
      SK: queuedPromptSk(args.id),
      id: args.id,
      sessionId: args.sessionId,
      prompt: prompt as QueuedPromptItem["prompt"],
      status: "queued",
      queuedAt: this.nowIso(),
      claimedAt: null,
      failReason: null,
      failedAt: null,
      ttl: ttlFromNow(QUEUED_PROMPT_TTL_MS, this.now()),
    };
    try {
      await this.ddb.send(
        new PutCommand({
          TableName: this.table,
          Item: item,
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
      return true;
    } catch (err) {
      if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
        return false;
      }
      throw err;
    }
  }

  async getQueuedPrompt(sessionId: string, id: string): Promise<QueuedPromptItem | null> {
    const res = await this.ddb.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: sessionPk(sessionId), SK: queuedPromptSk(id) },
        ConsistentRead: true,
      }),
    );
    return (res.Item as QueuedPromptItem | undefined) ?? null;
  }

  /** A session's queued prompts in the order they were sent (oldest first), whatever their status. */
  async listQueuedPrompts(sessionId: string): Promise<QueuedPromptItem[]> {
    const items: QueuedPromptItem[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const res = await this.ddb.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :p)",
          ExpressionAttributeValues: { ":pk": sessionPk(sessionId), ":p": QUEUED_PROMPT_PREFIX },
          ConsistentRead: true,
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      );
      items.push(...((res.Items as QueuedPromptItem[] | undefined) ?? []));
      start = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (start);
    // The turn id is a ULID made when the prompt was sent, but two made in one millisecond are not
    // ordered by it, so the time the record was written comes first.
    return items.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt) || a.id.localeCompare(b.id));
  }

  /** The prompt text of a queued prompt (read back from S3 when it was too large to keep inline). */
  async queuedPromptText(item: QueuedPromptItem): Promise<string> {
    return (await this.resolve(item.prompt)) as string;
  }

  /**
   * Move a queued prompt from one status to another, optionally with a feed event in the same
   * transaction. False when it was not in the `from` status (another writer moved it first).
   */
  private async queuedPromptTransition(
    sessionId: string,
    id: string,
    from: QueuedPromptStatus,
    to: QueuedPromptStatus,
    extra: Record<string, unknown>,
    draft?: FeedDraft,
  ): Promise<boolean> {
    const set: Record<string, unknown> = { status: to, ...extra };
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = { ":from": from };
    const sets: string[] = [];
    for (const [k, v] of Object.entries(set)) {
      names[`#${k}`] = k;
      values[`:${k}`] = v;
      sets.push(`#${k} = :${k}`);
    }
    names["#status"] = "status";
    const update = {
      TableName: this.table,
      Key: { PK: sessionPk(sessionId), SK: queuedPromptSk(id) },
      UpdateExpression: `SET ${sets.join(", ")}`,
      ConditionExpression: "#status = :from",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    };
    try {
      if (draft) {
        await this.feed.transact(await this.ownerOf(sessionId), [{ Update: update }], [draft]);
      } else {
        await this.ddb.send(new UpdateCommand(update));
      }
      return true;
    } catch (err) {
      if (
        err instanceof FeedConflictError ||
        (err as { name?: string }).name === "ConditionalCheckFailedException"
      ) {
        return false;
      }
      throw err;
    }
  }

  /** queued -> delivered: the one drain that wins this claim sends the prompt. */
  async claimQueuedPrompt(sessionId: string, id: string): Promise<boolean> {
    return this.queuedPromptTransition(sessionId, id, "queued", "delivered", {
      claimedAt: this.nowIso(),
    });
  }

  /** delivered -> queued: the turn could not start yet, so the prompt keeps its place in the queue. */
  async releaseQueuedPrompt(sessionId: string, id: string): Promise<boolean> {
    return this.queuedPromptTransition(sessionId, id, "delivered", "queued", { claimedAt: null });
  }

  /** delivered -> started: the turn exists. False when it was not delivered (a redelivered command). */
  async startQueuedPrompt(sessionId: string, id: string): Promise<boolean> {
    return this.queuedPromptTransition(sessionId, id, "delivered", "started", {});
  }

  /**
   * queued or delivered -> failed, with `prompt.failed` on the change feed in the same
   * transaction. False when the prompt was neither (it started, or already failed).
   */
  async failQueuedPrompt(
    sessionId: string,
    id: string,
    args: { reason: PromptFailReason; source: FeedSource },
  ): Promise<boolean> {
    const draft: FeedDraft = {
      sessionId,
      pr: null,
      type: "prompt.failed",
      source: args.source,
      payload: { turnId: id, whenBusy: "queue", reason: args.reason },
    };
    const extra = { failReason: args.reason, failedAt: this.nowIso() };
    for (const from of ["queued", "delivered"] as const) {
      if (await this.queuedPromptTransition(sessionId, id, from, "failed", extra, draft)) {
        return true;
      }
    }
    return false;
  }

  /* ------------------------- Unmatched GitHub deliveries ----------------- */

  async putUnmatched(item: Omit<UnmatchedItem, "PK" | "SK" | "ttl">): Promise<void> {
    const full: UnmatchedItem = {
      ...item,
      PK: GH_UNMATCHED_PK,
      SK: `${item.receivedAt}#${item.deliveryId}`,
      ttl: ttlFromNow(EVENT_TTL_MS, this.now()),
    };
    await this.ddb.send(new PutCommand({ TableName: this.table, Item: full }));
  }

  /** Newest unmatched deliveries first. */
  async listUnmatched(limit: number): Promise<UnmatchedItem[]> {
    const res = await this.ddb.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": GH_UNMATCHED_PK },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (res.Items as UnmatchedItem[] | undefined) ?? [];
  }

  /* ----------------------------- Idempotency ----------------------------- */

  async putIdempotency(
    sub: string,
    key: string,
    response: Record<string, unknown>,
    fingerprint?: string,
  ): Promise<void> {
    const item: IdempotencyItem = {
      PK: idempotencyPk(sub, key),
      SK: SINGLETON_SK,
      response,
      ...(fingerprint !== undefined ? { fingerprint } : {}),
      ttl: ttlFromNow(IDEMPOTENCY_TTL_MS, this.now()),
    };
    await this.ddb.send(
      new PutCommand({
        TableName: this.table,
        Item: item,
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  }

  async getIdempotency(sub: string, key: string): Promise<IdempotencyItem | null> {
    const res = await this.ddb.send(
      new GetCommand({
        TableName: this.table,
        Key: { PK: idempotencyPk(sub, key), SK: SINGLETON_SK },
      }),
    );
    return (res.Item as IdempotencyItem | undefined) ?? null;
  }
}

function encodeCursor(json: string): string {
  return Buffer.from(json, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, "base64url").toString("utf8");
}
