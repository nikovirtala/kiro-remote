/**
 * Offline test harness for the MCP package.
 *
 * Reuses a small in-memory DynamoDB fake + command-queue spy to back a real
 * core {@link Repository} and the {@link InProcessClient}, so tool calls run
 * end-to-end against the core service with no network/AWS. Also provides a fake
 * REST API (for the HTTP client) and a fake OAuth facade (for the CLI flows).
 */

import type { McpTransportHandler } from "@nikovirtala/kiro-remote-api";
import type {
  Command,
  CommandQueue,
  GithubQueueMessage,
  Repository,
} from "@nikovirtala/kiro-remote-core";
import { Repository as CoreRepository, type Principal } from "@nikovirtala/kiro-remote-core";
import { InProcessClient } from "../src/client.ts";
import type { FetchLike } from "../src/http-client.ts";
import type { OAuthFetch } from "../src/oauth.ts";

/* --------------------------- In-memory DynamoDB ---------------------------- */

interface StoredItem {
  [key: string]: unknown;
  PK: string;
  SK: string;
}

export class FakeDdb {
  readonly items = new Map<string, StoredItem>();

  private key(pk: string, sk: string): string {
    return `${pk}\u0000${sk}`;
  }

  put(item: StoredItem): void {
    this.items.set(this.key(item.PK, item.SK), item);
  }

  // biome-ignore lint/suspicious/noExplicitAny: command shape varies by type.
  async send(command: { constructor: { name: string }; input: any }): Promise<any> {
    const name = command.constructor.name;
    const input = command.input;

    if (name === "PutCommand") {
      const item = input.Item as StoredItem;
      const k = this.key(item.PK, item.SK);
      if (input.ConditionExpression === "attribute_not_exists(PK)" && this.items.has(k)) {
        throw conditionalFailure();
      }
      this.items.set(k, item);
      return {};
    }
    if (name === "GetCommand") {
      const key = input.Key as { PK: string; SK: string };
      return { Item: this.items.get(this.key(key.PK, key.SK)) };
    }
    if (name === "DeleteCommand") {
      const key = input.Key as { PK: string; SK: string };
      const k = this.key(key.PK, key.SK);
      const existing = this.items.get(k);
      this.items.delete(k);
      return input.ReturnValues === "ALL_OLD" ? { Attributes: existing } : {};
    }
    if (name === "UpdateCommand") {
      return this.update(input);
    }
    if (name === "TransactWriteCommand") {
      return this.transact(input.TransactItems);
    }
    if (name === "QueryCommand") {
      return this.query(input);
    }
    throw new Error(`FakeDdb: unsupported command ${name}`);
  }

  /** All-or-nothing put/delete/update with the few conditions the repository writes. */
  // biome-ignore lint/suspicious/noExplicitAny: DynamoDB transaction input is dynamic.
  private transact(ops: any[]): Record<string, unknown> {
    const reasons: Array<{ Code: string }> = [];
    for (const op of ops) {
      const body = op.Put ?? op.Delete ?? op.Update;
      const key = op.Put ? body.Item : body.Key;
      const existing = this.items.get(this.key(key.PK, key.SK));
      const cond: string | undefined = body.ConditionExpression;
      const values = body.ExpressionAttributeValues ?? {};
      let ok = true;
      if (cond === "attribute_not_exists(PK)") {
        ok = existing === undefined;
      } else if (cond === "attribute_exists(PK)") {
        ok = existing !== undefined;
      } else if (cond === "attribute_not_exists(seq)") {
        ok = existing === undefined || existing.seq === undefined;
      } else if (cond === "seq = :cur") {
        ok = existing?.seq === values[":cur"];
      } else if (cond === "sessionId = :sessionId") {
        ok = existing?.sessionId === values[":sessionId"];
      } else if (cond !== undefined) {
        throw new Error(`FakeDdb: unsupported transaction condition ${cond}`);
      }
      reasons.push({ Code: ok ? "None" : "ConditionalCheckFailed" });
    }
    if (reasons.some((r) => r.Code !== "None")) {
      throw Object.assign(new Error("transaction cancelled"), {
        name: "TransactionCanceledException",
        CancellationReasons: reasons,
      });
    }
    for (const op of ops) {
      if (op.Put) {
        this.items.set(this.key(op.Put.Item.PK, op.Put.Item.SK), op.Put.Item);
      } else if (op.Delete) {
        this.items.delete(this.key(op.Delete.Key.PK, op.Delete.Key.SK));
      } else {
        const k = this.key(op.Update.Key.PK, op.Update.Key.SK);
        this.items.set(k, {
          ...(this.items.get(k) ?? op.Update.Key),
          seq: op.Update.ExpressionAttributeValues[":next"],
        });
      }
    }
    return {};
  }

  // biome-ignore lint/suspicious/noExplicitAny: DynamoDB update input is dynamic.
  private update(input: any): Record<string, unknown> {
    const key = input.Key as { PK: string; SK: string };
    const k = this.key(key.PK, key.SK);
    const existing = this.items.get(k);
    if (typeof input.UpdateExpression === "string" && input.UpdateExpression.includes("eventSeq")) {
      if (input.ConditionExpression === "attribute_exists(PK)" && !existing) {
        throw conditionalFailure();
      }
      const next = { ...(existing as StoredItem) };
      next.eventSeq = ((next.eventSeq as number | undefined) ?? 0) + 1;
      this.items.set(k, next);
      return { Attributes: { eventSeq: next.eventSeq } };
    }
    return {};
  }

  // biome-ignore lint/suspicious/noExplicitAny: DynamoDB query input is dynamic.
  private query(input: any): Record<string, unknown> {
    const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
    const all = [...this.items.values()];
    if (input.IndexName === "GSI1") {
      const pk = values[":pk"];
      let rows = all.filter((i) => (i as { GSI1PK?: string }).GSI1PK === pk);
      rows = rows.sort((a, b) =>
        String((b as { GSI1SK?: string }).GSI1SK).localeCompare(
          String((a as { GSI1SK?: string }).GSI1SK),
        ),
      );
      if (typeof input.Limit === "number") {
        rows = rows.slice(0, input.Limit);
      }
      return { Items: rows };
    }
    // Like real DynamoDB, refuse a FilterExpression on a primary-key attribute.
    if (/\bSK\b/.test(input.FilterExpression ?? "")) {
      const err = new Error("Filter Expression can only contain non-primary key attributes");
      (err as { name: string }).name = "ValidationException";
      throw err;
    }
    const pk = values[":pk"];
    let rows = all.filter((i) => i.PK === pk);
    if (typeof values[":from"] === "string" && typeof values[":to"] === "string") {
      const from = values[":from"] as string;
      const to = values[":to"] as string;
      rows = rows.filter((i) => i.SK >= from && i.SK <= to);
    }
    if (typeof values[":p"] === "string") {
      rows = rows.filter((i) => i.SK.startsWith(values[":p"] as string));
    }
    if (typeof values[":permPrefix"] === "string") {
      rows = rows.filter((i) => i.SK.startsWith(values[":permPrefix"] as string));
    }
    rows = rows.sort((a, b) => a.SK.localeCompare(b.SK));
    if (typeof input.Limit === "number") {
      rows = rows.slice(0, input.Limit);
    }
    return { Items: rows };
  }
}

function conditionalFailure(): Error {
  const err = new Error("conditional check failed");
  (err as { name: string }).name = "ConditionalCheckFailedException";
  return err;
}

export class FakeS3 {
  async send(): Promise<never> {
    throw new Error("FakeS3: unexpected S3 use");
  }
}

export class SpyQueue implements CommandQueue {
  readonly commands: Command[] = [];
  async enqueue(command: Command): Promise<void> {
    this.commands.push(command);
  }
}

/* ------------------------------ Principals --------------------------------- */

/** Mint a Principal with the given short-form scopes. */
export function principal(
  opts: { sub?: string; scopes?: string[]; clientId?: string } = {},
): Principal {
  return {
    sub: opts.sub ?? "user-1",
    clientId: opts.clientId ?? "cli-client",
    scopes: opts.scopes ?? ["sessions:read", "sessions:write", "sessions:delete"],
  };
}

/* --------------------------- In-process harness ---------------------------- */

export interface InProcHarness {
  client: InProcessClient;
  ddb: FakeDdb;
  queue: SpyQueue;
  /** Messages the service sent to the GitHub queue. */
  githubSent: GithubQueueMessage[];
  repo: Repository;
  seedSession(overrides?: Partial<Record<string, unknown>>): string;
  seedEvent(sessionId: string, seq: number, overrides?: Partial<Record<string, unknown>>): void;
  seedPermission(
    sessionId: string,
    requestId: string,
    overrides?: Partial<Record<string, unknown>>,
  ): void;
}

export function buildInProcess(
  opts: {
    allowedRepos?: string[];
    kiroCliVersion?: string | null;
    ids?: string[];
    sleep?: (ms: number) => Promise<void>;
    /** Leave the GitHub queue out, as on a deployment without the GitHub feature. */
    noGithubQueue?: boolean;
  } = {},
): InProcHarness {
  const ddb = new FakeDdb();
  const queue = new SpyQueue();
  const repo = new CoreRepository({
    // biome-ignore lint/suspicious/noExplicitAny: fake DDB client.
    ddb: ddb as any,
    // biome-ignore lint/suspicious/noExplicitAny: fake S3 client.
    s3: new FakeS3() as any,
    tableName: "kiro-remote",
    bucketName: "kiro-remote-bucket",
  });
  const idQueue = [...(opts.ids ?? [])];
  let idCounter = 0;
  const newId = () => idQueue.shift() ?? `id-${++idCounter}`;

  const githubSent: GithubQueueMessage[] = [];
  const client = new InProcessClient({
    service: {
      repo,
      queue,
      allowedRepos: opts.allowedRepos ?? ["*/*"],
      ...(opts.noGithubQueue
        ? {}
        : {
            githubQueue: {
              async send(m: GithubQueueMessage) {
                githubSent.push(m);
              },
            },
          }),
      newId,
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
    },
    repo,
    kiroCliVersion: async () => opts.kiroCliVersion ?? "1.2.3",
  });

  function seedSession(overrides: Partial<Record<string, unknown>> = {}): string {
    const id = (overrides.id as string) ?? `sess-${Math.random().toString(36).slice(2, 8)}`;
    const ts = "2024-01-01T00:00:00.000Z";
    ddb.put({
      PK: `SESSION#${id}`,
      SK: "META",
      id,
      kiroSessionId: null,
      title: null,
      repos: ["acme/app"],
      agent: null,
      mode: null,
      model: null,
      effort: null,
      status: "running",
      activeTurnId: null,
      eventSeq: 0,
      createdBy: "user-1",
      createdAt: ts,
      updatedAt: ts,
      version: 0,
      GSI1PK: "USER#user-1",
      GSI1SK: ts,
      ...overrides,
    });
    return id;
  }

  function seedEvent(
    sessionId: string,
    seq: number,
    overrides: Partial<Record<string, unknown>> = {},
  ): void {
    const padded = String(seq).padStart(12, "0");
    ddb.put({
      PK: `SESSION#${sessionId}`,
      SK: `EVT#${padded}`,
      seq,
      turnId: null,
      ts: "2024-01-01T00:00:00.000Z",
      type: "message.chunk",
      rawType: "agent_message_chunk",
      replay: false,
      payload: { content: { type: "text", text: "hello" } },
      ttl: 9999999999,
      ...overrides,
    });
  }

  function seedPermission(
    sessionId: string,
    requestId: string,
    overrides: Partial<Record<string, unknown>> = {},
  ): void {
    ddb.put({
      PK: `SESSION#${sessionId}`,
      SK: `PERM#${requestId}`,
      requestId,
      toolCallId: "tc-1",
      toolCall: {},
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      consent: null,
      status: "pending",
      answer: null,
      ttl: 9999999999,
      ...overrides,
    });
  }

  return { client, ddb, queue, githubSent, repo, seedSession, seedEvent, seedPermission };
}

/* ------------------------------ Fake REST API ------------------------------ */

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A fake fetch that records requests and returns canned responses by path. */
export function fakeRestFetch(
  routes: Record<string, { status: number; body: unknown }>,
  recorded: RecordedRequest[] = [],
): FetchLike {
  return async (url, init) => {
    recorded.push({
      url,
      method: init.method,
      headers: init.headers,
      ...(init.body ? { body: init.body } : {}),
    });
    const path = new URL(url).pathname;
    const key = `${init.method} ${path}`;
    const match = routes[key] ?? routes[path];
    if (!match) {
      return {
        status: 404,
        async text() {
          return JSON.stringify({ error: "not found" });
        },
      };
    }
    return {
      status: match.status,
      async text() {
        return JSON.stringify(match.body);
      },
    };
  };
}

/* ------------------------------ Fake facade -------------------------------- */

export interface FakeFacadeOptions {
  clientId?: string;
  tokenResponse?: Record<string, unknown>;
  /** Called when /oauth/revoke is hit. */
  onRevoke?: (token: string) => void;
}

/** A fake OAuth facade fetch: serves the CIMD doc, /oauth/token, /oauth/revoke. */
export function fakeFacadeFetch(
  baseUrl: string,
  opts: FakeFacadeOptions = {},
  recorded: RecordedRequest[] = [],
): OAuthFetch {
  const base = baseUrl.replace(/\/+$/, "");
  const clientId = opts.clientId ?? `${base}/oauth/clients/cli.json`;
  return async (url, init) => {
    recorded.push({
      url,
      method: init.method,
      headers: init.headers,
      ...(init.body ? { body: init.body } : {}),
    });
    const path = new URL(url).pathname;
    if (path === "/oauth/clients/cli.json") {
      return {
        status: 200,
        async text() {
          return JSON.stringify({
            client_id: clientId,
            redirect_uris: ["http://127.0.0.1/callback"],
            code_challenge_methods_supported: ["S256"],
          });
        },
      };
    }
    if (path === "/oauth/token") {
      return {
        status: 200,
        async text() {
          return JSON.stringify(
            opts.tokenResponse ?? {
              access_token: fakeJwt({
                sub: "user-1",
                scope: "openid sessions:read sessions:write",
              }),
              refresh_token: "refresh-xyz",
              expires_in: 3600,
              token_type: "Bearer",
              scope: "sessions:read sessions:write",
            },
          );
        },
      };
    }
    if (path === "/oauth/revoke") {
      const token = new URLSearchParams(init.body ?? "").get("token") ?? "";
      opts.onRevoke?.(token);
      return {
        status: 200,
        async text() {
          return "";
        },
      };
    }
    return {
      status: 404,
      async text() {
        return "{}";
      },
    };
  };
}

/** Build a fake (unsigned) JWT so decodeTokenForDisplay can read claims. */
export function fakeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.sig`;
}

/* ------------------------- The /mcp seam as a fetch ------------------------ */

/**
 * A `fetch` that serves every request through an {@link McpTransportHandler},
 * the way the API router does: the caller is already authenticated, headers are
 * lower-cased and the body is a string. A real MCP client pointed at it
 * exercises the seam end to end.
 */
export function seamFetch(handler: McpTransportHandler, who: Principal): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
    const res = await handler.handle({
      principal: who,
      method: req.method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    const noBody = res.status === 202 || res.status === 204;
    return new Response(noBody ? null : res.body, { status: res.status, headers: res.headers });
  }) as typeof fetch;
}

/** The `_meta` envelope every 2026-07-28 request carries. */
export const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "0.0.0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

/** A JSON-RPC answer as a test reads it: any field may be absent, none is typed. */
// biome-ignore lint/suspicious/noExplicitAny: a test reads arbitrary result shapes.
export type RpcAnswer = Record<string, any>;

/** POST one 2026-07-28 request through the seam and parse the JSON-RPC answer. */
export async function modernCall(
  handler: McpTransportHandler,
  who: Principal,
  method: string,
  params: Record<string, unknown> = {},
  id: number = 1,
): Promise<{ status: number; json: RpcAnswer }> {
  const res = await handler.handle({
    principal: who,
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      // SEP-2243: the standard header naming the tool, resource or prompt.
      ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
      ...(typeof params.uri === "string" ? { "mcp-name": params.uri } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params: { ...params, _meta: { ...MODERN_META, ...((params._meta as object) ?? {}) } },
    }),
  });
  return { status: res.status, json: JSON.parse(res.body) };
}
