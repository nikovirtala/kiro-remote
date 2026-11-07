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
  IDEMPOTENCY_TTL_MS,
  INLINE_PAYLOAD_MAX_BYTES,
  INLINE_PROMPT_MAX_BYTES,
  OAUTH_CIMD_MAX_TTL_MS,
  OAUTH_CODE_TTL_MS,
  OAUTH_TX_TTL_MS,
  PERMISSION_TIMEOUT_MS,
} from "../config.ts";
import {
  CAPS_SK,
  CONFIG_PK,
  eventSk,
  idempotencyPk,
  META_SK,
  MODELS_SK,
  oauthCimdPk,
  oauthCodePk,
  oauthTxPk,
  permSk,
  SINGLETON_SK,
  sessionPk,
  ttlFromNow,
  turnSk,
  userGsi1Pk,
} from "./keys.ts";
import type {
  CapsItem,
  EventItem,
  IdempotencyItem,
  ModelsItem,
  OAuthCimdItem,
  OAuthCodeItem,
  OAuthTxItem,
  PermItem,
  S3Pointer,
  SessionMetaItem,
  TurnItem,
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

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function isS3Pointer(value: unknown): value is S3Pointer {
  return typeof value === "object" && value !== null && (value as S3Pointer).s3 === true;
}

export class Repository {
  private readonly ddb: DynamoDBDocumentClient;
  private readonly s3: S3Client;
  private readonly table: string;
  private readonly bucket: string;
  private readonly now: () => number;

  constructor(deps: RepositoryDeps) {
    this.ddb = deps.ddb;
    this.s3 = deps.s3;
    this.table = deps.tableName;
    this.bucket = deps.bucketName;
    this.now = deps.now ?? (() => Date.now());
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
    const res = await this.ddb.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "PK = :pk AND SK > :after",
        ExpressionAttributeValues: {
          ":pk": sessionPk(sessionId),
          ":after": eventSk(after),
          ":evtPrefix": "EVT#",
        },
        FilterExpression: "begins_with(SK, :evtPrefix)",
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

  async getOAuthTx(id: string): Promise<OAuthTxItem | null> {
    const res = await this.ddb.send(
      new GetCommand({ TableName: this.table, Key: { PK: oauthTxPk(id), SK: SINGLETON_SK } }),
    );
    return (res.Item as OAuthTxItem | undefined) ?? null;
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

  /** Consume an OAuth code: read-and-delete atomically (deleted on first use). */
  async consumeOAuthCode(sha256Code: string): Promise<OAuthCodeItem | null> {
    const res = await this.ddb.send(
      new DeleteCommand({
        TableName: this.table,
        Key: { PK: oauthCodePk(sha256Code), SK: SINGLETON_SK },
        ReturnValues: "ALL_OLD",
      }),
    );
    return (res.Attributes as OAuthCodeItem | undefined) ?? null;
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

  /* ----------------------------- Idempotency ----------------------------- */

  async putIdempotency(sub: string, key: string, response: Record<string, unknown>): Promise<void> {
    const item: IdempotencyItem = {
      PK: idempotencyPk(sub, key),
      SK: SINGLETON_SK,
      response,
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
