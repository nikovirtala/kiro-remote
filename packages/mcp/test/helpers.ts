/**
 * Offline test harness for the MCP package.
 *
 * Reuses a small in-memory DynamoDB fake + command-queue spy to back a real
 * core {@link Repository} and the {@link InProcessClient}, so tool calls run
 * end-to-end against the core service with no network/AWS. Also provides a fake
 * REST API (for the HTTP client) and a fake OAuth facade (for the CLI flows).
 */

import type { Command, CommandQueue, Repository } from "@nikovirtala/kiro-remote-core";
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
    if (name === "QueryCommand") {
      return this.query(input);
    }
    throw new Error(`FakeDdb: unsupported command ${name}`);
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

  const client = new InProcessClient({
    service: {
      repo,
      queue,
      allowedRepos: opts.allowedRepos ?? ["*/*"],
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

  return { client, ddb, queue, repo, seedSession, seedEvent, seedPermission };
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
