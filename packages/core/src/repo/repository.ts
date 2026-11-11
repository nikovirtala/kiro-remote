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
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  EVENT_TTL_DAYS,
  GITHUB_DELIVERY_TTL_MS,
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
  clientPk,
  EVENT_SK_MAX,
  eventSk,
  GH_LINK_SK,
  GH_UNMATCHED_PK,
  ghDeliveryPk,
  ghPrPk,
  INBOX_PREFIX,
  idempotencyPk,
  META_SK,
  MODELS_SK,
  oauthCimdPk,
  oauthCodePk,
  oauthTxPk,
  permSk,
  SESSION_LINK_PREFIX,
  SINGLETON_SK,
  sessionLinkSk,
  sessionPk,
  ttlFromNow,
  turnSk,
  userGsi1Pk,
} from "./keys.ts";
import type {
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
  RegisteredClientItem,
  S3Pointer,
  SessionLinkItem,
  SessionMetaItem,
  TurnItem,
  UnmatchedItem,
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

  /* ---------------------- Dynamic client registration -------------------- */

  /**
   * Persist a dynamically-registered OAuth client (RFC 7591). The
   * `attribute_not_exists(PK)` condition guarantees a re-used `client_id` can
   * never overwrite an existing registration. The CLIENT# item is PERMANENT
   * (no TTL): registered clients do not expire.
   */
  async putClient(item: RegisteredClientItem): Promise<void> {
    await this.ddb.send(
      new PutCommand({
        TableName: this.table,
        Item: item,
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  }

  async getClient(clientId: string): Promise<RegisteredClientItem | null> {
    const res = await this.ddb.send(
      new GetCommand({ TableName: this.table, Key: { PK: clientPk(clientId), SK: SINGLETON_SK } }),
    );
    return (res.Item as RegisteredClientItem | undefined) ?? null;
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
      await this.ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.table,
                Item: link,
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            { Put: { TableName: this.table, Item: reverse } },
          ],
        }),
      );
      return { created: true, link };
    } catch (err) {
      if ((err as { name?: string }).name !== "TransactionCanceledException") {
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

  /** Remove a link. Only the owning session can remove it. Returns false when there was none. */
  async deleteLink(key: string, sessionId: string): Promise<boolean> {
    try {
      await this.ddb.send(
        new TransactWriteCommand({
          TransactItems: [
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
        }),
      );
      return true;
    } catch (err) {
      if ((err as { name?: string }).name === "TransactionCanceledException") {
        return false;
      }
      throw err;
    }
  }

  /** Refresh the PR-side state of an existing link (from webhook payloads). */
  async updateLinkState(
    key: string,
    patch: { prState?: PrState; headSha?: string | null },
  ): Promise<void> {
    const sets: string[] = [];
    const values: Record<string, unknown> = {};
    if (patch.prState !== undefined) {
      sets.push("prState = :prState");
      values[":prState"] = patch.prState;
    }
    if (patch.headSha !== undefined) {
      sets.push("headSha = :headSha");
      values[":headSha"] = patch.headSha;
    }
    if (sets.length === 0) {
      return;
    }
    try {
      await this.ddb.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: ghPrPk(key), SK: GH_LINK_SK },
          UpdateExpression: `SET ${sets.join(", ")}`,
          ConditionExpression: "attribute_exists(PK)",
          ExpressionAttributeValues: values,
        }),
      );
    } catch (err) {
      if ((err as { name?: string }).name !== "ConditionalCheckFailedException") {
        throw err;
      }
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

  async putInboxItem(item: InboxItem): Promise<void> {
    await this.ddb.send(
      new PutCommand({
        TableName: this.table,
        Item: item,
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
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

  private async inboxTransition(
    sessionId: string,
    id: string,
    from: InboxItem["status"],
    set: Record<string, unknown>,
    extraCondition?: { name: string; value: unknown },
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
    try {
      await this.ddb.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { PK: sessionPk(sessionId), SK: `${INBOX_PREFIX}${id}` },
          UpdateExpression: `SET ${sets.join(", ")}`,
          ConditionExpression: condition,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
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

  /** Mark pending items delivered by `turnId`. Returns the ids actually claimed. */
  async claimInbox(sessionId: string, ids: string[], turnId: string): Promise<string[]> {
    const claimed: string[] = [];
    for (const id of ids) {
      if (
        await this.inboxTransition(sessionId, id, "pending", {
          status: "delivered",
          deliveredTurnId: turnId,
        })
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
      );
    }
  }

  /** Drop pending items with a recorded reason. Returns how many were dropped. */
  async dropInbox(sessionId: string, ids: string[], reason: string): Promise<number> {
    let dropped = 0;
    for (const id of ids) {
      if (
        await this.inboxTransition(sessionId, id, "pending", {
          status: "dropped",
          dropReason: reason,
        })
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
    return this.inboxTransition(sessionId, id, "pending", {
      deliveryIds: patch.deliveryIds,
      prompt: patch.prompt,
      data: patch.data,
    });
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
