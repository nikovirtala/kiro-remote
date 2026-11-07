/**
 * Offline test harness for the API package.
 *
 * A small in-memory DynamoDBDocumentClient fake (Put/Get/Delete/Query/Update,
 * including GSI1 queries and the conditional atomic event-seq increment), a
 * command-queue spy that captures every enqueued SQS command, a stub token
 * verifier, and a full {@link ApiContext} builder. NONE of this touches the
 * network or any AWS SDK transport.
 */

import type { FacadeConfig } from "@nikovirtala/kiro-remote-auth";
import type {
  AccessTokenClaims,
  Command,
  CommandQueue,
  Repository,
  TokenVerifier,
} from "@nikovirtala/kiro-remote-core";
import { Repository as CoreRepository } from "@nikovirtala/kiro-remote-core";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import type { ApiContext, FacadeDeps } from "../src/context.ts";
import { NoopObservability } from "../src/observability.ts";

/* --------------------------- In-memory DynamoDB ---------------------------- */

interface StoredItem {
  [key: string]: unknown;
  PK: string;
  SK: string;
}

/** The slice of DynamoDBDocumentClient the Repository uses. */
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
    const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;

    // event-seq increment path.
    if (typeof input.UpdateExpression === "string" && input.UpdateExpression.includes("eventSeq")) {
      if (input.ConditionExpression === "attribute_exists(PK)" && !existing) {
        throw conditionalFailure();
      }
      const next = { ...(existing as StoredItem) };
      next.eventSeq = ((next.eventSeq as number | undefined) ?? 0) + 1;
      this.items.set(k, next);
      return { Attributes: { eventSeq: next.eventSeq } };
    }

    // optimistic-lock version path.
    if (input.ConditionExpression === "#version = :expected") {
      if (!existing || existing.version !== values[":expected"]) {
        throw conditionalFailure();
      }
    }
    if (input.ConditionExpression === "#status = :pending") {
      if (!existing || existing.status !== values[":pending"]) {
        throw conditionalFailure();
      }
    }
    // Generic SET apply is not needed by the read tests; leave item as-is.
    return {};
  }

  // biome-ignore lint/suspicious/noExplicitAny: DynamoDB query input is dynamic.
  private query(input: any): Record<string, unknown> {
    const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
    const all = [...this.items.values()];

    // GSI1 query by user.
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

    // Base-table query by PK (events / permissions).
    const pk = values[":pk"];
    let rows = all.filter((i) => i.PK === pk);
    if (typeof values[":after"] === "string") {
      rows = rows.filter((i) => i.SK > (values[":after"] as string));
    }
    if (typeof values[":evtPrefix"] === "string") {
      rows = rows.filter((i) => i.SK.startsWith(values[":evtPrefix"] as string));
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

/** An S3 client that is never expected to be hit in these tests. */
export class FakeS3 {
  async send(): Promise<never> {
    throw new Error("FakeS3: unexpected S3 use");
  }
}

/* ------------------------------ Command queue ------------------------------ */

/** Captures enqueued commands so tests can assert write -> enqueue semantics. */
export class SpyQueue implements CommandQueue {
  readonly commands: Command[] = [];
  async enqueue(command: Command): Promise<void> {
    this.commands.push(command);
  }
}

/* ------------------------------ Token verifier ----------------------------- */

/** A verifier that decodes an opaque `json:<base64>` token into claims. */
export const stubVerifier: TokenVerifier = {
  async verify(token: string): Promise<AccessTokenClaims> {
    if (!token.startsWith("json:")) {
      throw new Error("bad token");
    }
    return JSON.parse(Buffer.from(token.slice(5), "base64").toString("utf8")) as AccessTokenClaims;
  },
};

export const RESOURCE = "https://kiro.example.com/mcp";
export const CLIENT_ID = "cli-client";

/** Mint a bearer token string accepted by {@link stubVerifier}. */
export function mintToken(opts: {
  sub?: string;
  scopes?: string[];
  clientId?: string;
  tokenUse?: string;
  exp?: number;
}): string {
  const scope = (opts.scopes ?? ["sessions:read", "sessions:write", "sessions:delete"])
    .map((s) => `${RESOURCE}/${s}`)
    .join(" ");
  const claims: AccessTokenClaims = {
    sub: opts.sub ?? "user-1",
    token_use: opts.tokenUse ?? "access",
    client_id: opts.clientId ?? CLIENT_ID,
    scope,
    iss: "https://cognito.example.com",
    exp: opts.exp ?? Math.floor(Date.now() / 1000) + 3600,
  };
  return `json:${Buffer.from(JSON.stringify(claims)).toString("base64")}`;
}

/** Authorization header map for a minted token. */
export function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/* ------------------------------ Facade config ------------------------------ */

export function facadeConfig(): FacadeConfig {
  return {
    publicBaseUrl: "https://kiro.example.com",
    mcpResource: RESOURCE,
    scopesSupported: ["sessions:read", "sessions:write", "sessions:delete"],
    cognitoDomain: "https://cognito.example.com",
    cognitoClientId: "cognito-app-client",
    cognitoJwksUri: "https://cognito.example.com/.well-known/jwks.json",
    cimdAllowedHosts: ["kiro.example.com"],
    kmsKeyId: "key-1",
  };
}

/* ------------------------------ Context builder ---------------------------- */

export interface Harness {
  ctx: ApiContext;
  ddb: FakeDdb;
  queue: SpyQueue;
  repo: Repository;
  seedSession(overrides?: Partial<Record<string, unknown>>): string;
}

export interface BuildOptions {
  allowedRepos?: string[];
  extensionMethods?: string[];
  kiroCliVersion?: string | null;
  now?: () => number;
  ids?: string[];
}

/** Build a complete offline {@link ApiContext} plus test handles. */
export function buildHarness(opts: BuildOptions = {}): Harness {
  const ddb = new FakeDdb();
  const queue = new SpyQueue();
  const repo = new CoreRepository({
    // biome-ignore lint/suspicious/noExplicitAny: fake DDB client.
    ddb: ddb as any,
    // biome-ignore lint/suspicious/noExplicitAny: fake S3 client.
    s3: new FakeS3() as any,
    tableName: "kiro-remote",
    bucketName: "kiro-remote-bucket",
    ...(opts.now ? { now: opts.now } : {}),
  });

  const idQueue = [...(opts.ids ?? [])];
  let idCounter = 0;
  const newId = () => idQueue.shift() ?? `id-${++idCounter}`;

  const facade: FacadeDeps = {
    config: facadeConfig(),
    // The facade handler deps below are only exercised by the facade-mount
    // tests, which pass their own; the REST tests never touch them.
    // biome-ignore lint/suspicious/noExplicitAny: filled per-test when needed.
    authorize: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: filled per-test when needed.
    callback: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: filled per-test when needed.
    token: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: filled per-test when needed.
    revoke: {} as any,
  };

  const ctx: ApiContext = {
    service: {
      repo,
      queue,
      allowedRepos: opts.allowedRepos ?? ["*/*"],
      ...(opts.now ? { now: opts.now } : {}),
      newId,
    },
    repo,
    auth: {
      verifier: stubVerifier,
      allowedClientIds: [CLIENT_ID],
      resourceIdentifier: RESOURCE,
      ...(opts.now ? { now: opts.now } : {}),
    },
    resourceMetadataUrl: "https://kiro.example.com/.well-known/oauth-protected-resource/mcp",
    capabilities: async () => ({
      extensionMethods: opts.extensionMethods ?? ["_kiro/setConfigOption", "_kiro/setMode"],
      sessionSources: [],
      listScopes: [],
      executionTargets: [],
      configOptions: [],
      modes: [],
      models: [],
      replayMarking: false,
    }),
    kiroCliVersion: async () => opts.kiroCliVersion ?? "1.2.3",
    facade,
    publicBaseUrl: "https://kiro.example.com",
    obs: new NoopObservability(),
  };

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
      status: "idle",
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

  return { ctx, ddb, queue, repo, seedSession };
}

/** Build a fake API Gateway HTTP API v2 event. */
export function makeEvent(opts: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: string;
}): APIGatewayProxyEventV2 {
  const event = {
    version: "2.0",
    routeKey: "$default",
    rawPath: opts.path,
    rawQueryString: "",
    headers: { host: "kiro.example.com", ...(opts.headers ?? {}) },
    queryStringParameters: opts.query,
    requestContext: {
      http: { method: opts.method, path: opts.path },
    },
    body: opts.body,
    isBase64Encoded: false,
  };
  return event as unknown as APIGatewayProxyEventV2;
}
