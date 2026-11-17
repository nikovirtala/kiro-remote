import type { S3Client } from "@aws-sdk/client-s3";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import {
  ConcurrentModificationError,
  capabilities as deriveCapabilities,
  type RegisteredClientItem,
  Repository,
  type SessionMetaItem,
} from "../src/index.ts";

/**
 * In-memory DynamoDB document client supporting only the command shapes the
 * Repository issues: Put/Get/Update/Delete/Query. Conditional expressions are
 * interpreted just enough to exercise optimistic locking, create-once, and
 * atomic sequence allocation.
 */
class FakeDdb {
  store = new Map<string, Record<string, unknown>>();
  /** Every command sent, for asserting on the request shape (ConsistentRead). */
  sent: Array<{ name: string; input: Record<string, unknown> }> = [];

  private key(pk: string, sk: string): string {
    return `${pk}\u0000${sk}`;
  }

  async send(cmd: {
    constructor: { name: string };
    input: Record<string, unknown>;
  }): Promise<unknown> {
    const name = cmd.constructor.name;
    const input = cmd.input;
    this.sent.push({ name, input });
    if (name === "PutCommand") {
      const item = input.Item as Record<string, string>;
      const k = this.key(item.PK, item.SK);
      if (input.ConditionExpression === "attribute_not_exists(PK)" && this.store.has(k)) {
        throw Object.assign(new Error("exists"), { name: "ConditionalCheckFailedException" });
      }
      this.store.set(k, { ...item });
      return {};
    }
    if (name === "GetCommand") {
      const key = input.Key as Record<string, string>;
      return { Item: this.store.get(this.key(key.PK, key.SK)) };
    }
    if (name === "DeleteCommand") {
      const key = input.Key as Record<string, string>;
      const k = this.key(key.PK, key.SK);
      const old = this.store.get(k);
      if (input.ConditionExpression === "attribute_exists(PK)" && !old) {
        throw Object.assign(new Error("missing"), { name: "ConditionalCheckFailedException" });
      }
      this.store.delete(k);
      return { Attributes: old };
    }
    if (name === "UpdateCommand") {
      const key = input.Key as Record<string, string>;
      const k = this.key(key.PK, key.SK);
      const item = this.store.get(k);
      const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
      if (input.ConditionExpression === "attribute_exists(PK)" && !item) {
        throw Object.assign(new Error("missing"), { name: "ConditionalCheckFailedException" });
      }
      if (input.ConditionExpression === "#version = :expected") {
        if (!item || item.version !== values[":expected"]) {
          throw Object.assign(new Error("stale"), { name: "ConditionalCheckFailedException" });
        }
      }
      if (input.ConditionExpression === "attribute_exists(#ttl) AND #ttl < :renewBelow") {
        if (!item || typeof item.ttl !== "number" || item.ttl >= Number(values[":renewBelow"])) {
          throw Object.assign(new Error("not due"), { name: "ConditionalCheckFailedException" });
        }
      }
      const current = item ?? {};
      const expr = input.UpdateExpression as string;
      if (expr.includes("eventSeq = eventSeq + :one")) {
        current.eventSeq = (Number(current.eventSeq) || 0) + 1;
      }
      if (expr.includes("#version = #version + :one")) {
        current.version = (Number(current.version) || 0) + 1;
      }
      // Apply SET #k = :k pairs generically.
      const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>;
      for (const [placeholder, attr] of Object.entries(names)) {
        const valKey = placeholder.replace("#", ":");
        if (valKey in values && placeholder !== "#version") {
          current[attr] = values[valKey];
        }
      }
      this.store.set(k, current);
      return { Attributes: { eventSeq: current.eventSeq } };
    }
    if (name === "QueryCommand") {
      return { Items: [], LastEvaluatedKey: undefined };
    }
    throw new Error(`unhandled command ${name}`);
  }
}

const fakeS3 = {
  async send(): Promise<unknown> {
    throw new Error("S3 should not be called for small payloads");
  },
} as unknown as S3Client;

function repo(now = () => 1_700_000_000_000): { r: Repository; ddb: FakeDdb } {
  const ddb = new FakeDdb();
  const r = new Repository({
    ddb: ddb as unknown as DynamoDBDocumentClient,
    s3: fakeS3,
    tableName: "t",
    bucketName: "b",
    now,
  });
  return { r, ddb };
}

function meta(): SessionMetaItem {
  return {
    PK: "SESSION#s1",
    SK: "META",
    id: "s1",
    kiroSessionId: null,
    title: null,
    repos: ["acme/x"],
    agent: null,
    mode: null,
    model: null,
    effort: null,
    status: "provisioning",
    activeTurnId: null,
    eventSeq: 0,
    createdBy: "user-1",
    createdAt: "t",
    updatedAt: "t",
    version: 0,
    GSI1PK: "USER#user-1",
    GSI1SK: "t",
  };
}

describe("repository: session create + optimistic lock", () => {
  it("creates once and rejects a duplicate create", async () => {
    const { r } = repo();
    await r.putSession(meta());
    await expect(r.putSession(meta())).rejects.toMatchObject({
      name: "ConditionalCheckFailedException",
    });
  });

  it("updates with matching version and bumps it", async () => {
    const { r } = repo();
    await r.putSession(meta());
    await r.updateSession("s1", 0, { status: "idle" });
    const s = await r.getSession("s1");
    expect(s?.status).toBe("idle");
    expect(s?.version).toBe(1);
  });

  it("throws ConcurrentModificationError on a stale version", async () => {
    const { r } = repo();
    await r.putSession(meta());
    await expect(r.updateSession("s1", 99, { status: "idle" })).rejects.toBeInstanceOf(
      ConcurrentModificationError,
    );
  });
});

describe("repository: event sequence allocation (append-only cursor)", () => {
  it("allocates gap-free increasing sequences from META.eventSeq", async () => {
    const { r } = repo();
    await r.putSession(meta());
    const seq1 = await r.appendEvent("s1", {
      turnId: "turn-1",
      ts: "t",
      type: "message.chunk",
      rawType: "agent_message_chunk",
      replay: false,
      payload: { text: "a" },
    });
    const seq2 = await r.appendEvent("s1", {
      turnId: "turn-1",
      ts: "t",
      type: "message.chunk",
      rawType: "agent_message_chunk",
      replay: false,
      payload: { text: "b" },
    });
    expect(seq1).toBe(1);
    expect(seq2).toBe(2);
  });
});

describe("repository: idempotency store (idempotent replay)", () => {
  it("stores a response once and rejects a duplicate key", async () => {
    const { r } = repo();
    await r.putIdempotency("user-1", "key-1", { ok: true });
    const got = await r.getIdempotency("user-1", "key-1");
    expect(got?.response).toEqual({ ok: true });
    // A replay with the same key must not overwrite (create-once condition).
    await expect(r.putIdempotency("user-1", "key-1", { ok: false })).rejects.toMatchObject({
      name: "ConditionalCheckFailedException",
    });
  });
});

describe("repository: CONFIG#CAPS + CONFIG#MODELS round-trip", () => {
  it("stores the raw initialize result so deriveCapabilities reproduces it", async () => {
    const { r } = repo();
    const initializeResult = {
      protocolVersion: 1,
      agentCapabilities: {
        _meta: {
          kiro: {
            extensionMethods: ["_kiro/openExternalUrl", "_kiro/session/context"],
            executionTargets: ["cloud", "local"],
            sessionSources: ["remote", "local"],
            listScopes: ["cloud"],
            replayMarking: true,
          },
        },
      },
      configOptions: [{ configId: "model", values: ["claude-sonnet"] }],
      modes: [{ modeId: "vibe", name: "Vibe" }],
    };
    await r.putCaps({
      initializeResult,
      extensionMethods: ["_kiro/openExternalUrl", "_kiro/session/context"],
      configOptions: initializeResult.configOptions,
      modes: initializeResult.modes,
    });
    const caps = await r.getCaps();
    expect(caps).not.toBeNull();
    expect(caps?.PK).toBe("CONFIG");
    expect(caps?.SK).toBe("CAPS");
    // The read side reconstructs the advertisement from the raw initialize result.
    const derived = deriveCapabilities((caps as { initializeResult: object }).initializeResult);
    expect(derived.extensionMethods).toEqual(["_kiro/openExternalUrl", "_kiro/session/context"]);
    expect(derived.executionTargets).toEqual(["cloud", "local"]);
    expect(derived.models).toEqual(["claude-sonnet"]);
    expect(derived.cloudExecution).toBe(true);
  });

  it("stores and reads CONFIG#MODELS with a source", async () => {
    const { r } = repo();
    await r.putModels(["claude-sonnet", "claude-haiku"], "config_option");
    const models = await r.getModels();
    expect(models?.models).toEqual(["claude-sonnet", "claude-haiku"]);
    expect(models?.source).toBe("config_option");
  });
});

describe("repository: OAuth code deleted on first use", () => {
  it("consumes a code exactly once", async () => {
    const { r } = repo();
    await r.putOAuthCode("hash", {
      encryptedTokens: "cipher",
      clientId: "c",
      redirectUri: "https://app/cb",
      codeChallenge: "chal",
    });
    const first = await r.consumeOAuthCode("hash");
    expect(first?.clientId).toBe("c");
    const second = await r.consumeOAuthCode("hash");
    expect(second).toBeNull();
  });
});

const T0 = 1_700_000_000_000;
const SECOND = 1000;
const MINUTE = 60 * SECOND;

describe("repository: expired OAuth state is absent (DynamoDB TTL deletes late)", () => {
  it("refuses a transaction past its 10 minute ttl, and serves it before", async () => {
    let now = T0;
    const { r, ddb } = repo(() => now);
    await r.putOAuthTx("state", { clientId: "c" });
    now = T0 + 10 * MINUTE - SECOND;
    expect((await r.getOAuthTx("state"))?.data.clientId).toBe("c");
    now = T0 + 10 * MINUTE + SECOND;
    // The item is still in the table: only the read treats it as absent.
    expect(ddb.store.size).toBe(1);
    expect(await r.getOAuthTx("state")).toBeNull();
    expect(await r.consumeOAuthTx("state")).toBeNull();
  });

  it("refuses a code past its 60 second ttl, and still deletes it", async () => {
    let now = T0;
    const { r, ddb } = repo(() => now);
    const code = {
      encryptedTokens: "x",
      clientId: "c",
      redirectUri: "https://a/cb",
      codeChallenge: "h",
    };
    await r.putOAuthCode("fresh", code);
    await r.putOAuthCode("stale", code);
    now = T0 + 30 * SECOND;
    expect((await r.consumeOAuthCode("fresh"))?.clientId).toBe("c");
    now = T0 + 61 * SECOND;
    expect(await r.consumeOAuthCode("stale")).toBeNull();
    expect(ddb.store.size).toBe(0);
  });
});

describe("repository: strongly consistent reads of just-written state", () => {
  it("reads the transaction and the client with ConsistentRead", async () => {
    const { r, ddb } = repo();
    await r.putOAuthTx("state", {});
    await r.getOAuthTx("state");
    await r.getClient("mcp_x");
    const gets = ddb.sent.filter((c) => c.name === "GetCommand");
    expect(gets).toHaveLength(2);
    expect(gets.every((g) => g.input.ConsistentRead === true)).toBe(true);
  });
});

describe("repository: OAuth transaction consumed on first use", () => {
  it("returns the transaction once, then nothing, and deletes it", async () => {
    const { r, ddb } = repo();
    await r.putOAuthTx("state", { clientId: "c" });
    expect((await r.consumeOAuthTx("state"))?.data.clientId).toBe("c");
    expect(ddb.store.size).toBe(0);
    expect(await r.consumeOAuthTx("state")).toBeNull();
    expect(await r.getOAuthTx("state")).toBeNull();
  });

  it("returns null for an unknown state (the conditional delete fails)", async () => {
    const { r, ddb } = repo();
    expect(await r.consumeOAuthTx("nope")).toBeNull();
    const del = ddb.sent.find((c) => c.name === "DeleteCommand");
    expect(del?.input.ConditionExpression).toBe("attribute_exists(PK)");
    expect(del?.input.ReturnValues).toBe("ALL_OLD");
  });
});

describe("repository: dynamically-registered CLIENT# item (RFC 7591, 180 day ttl)", () => {
  function clientItem(clientId: string): Omit<RegisteredClientItem, "ttl"> {
    return {
      PK: `CLIENT#${clientId}`,
      SK: "A",
      clientId,
      clientName: "Example MCP Client",
      redirectUris: ["https://app.example.com/cb", "http://127.0.0.1/callback"],
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      tokenEndpointAuthMethod: "none",
      createdAt: 1_700_000_000_000,
    };
  }

  it("round-trips a registered client via putClient/getClient", async () => {
    const { r } = repo();
    const item = clientItem("mcp_abc123");
    await r.putClient(item);
    const got = await r.getClient("mcp_abc123");
    expect(got?.clientId).toBe("mcp_abc123");
    expect(got?.clientName).toBe("Example MCP Client");
    expect(got?.redirectUris).toEqual(["https://app.example.com/cb", "http://127.0.0.1/callback"]);
    expect(got?.grantTypes).toEqual(["authorization_code", "refresh_token"]);
    expect(got?.responseTypes).toEqual(["code"]);
    expect(got?.tokenEndpointAuthMethod).toBe("none");
    expect(got?.createdAt).toBe(1_700_000_000_000);
    // A registration expires 180 days after it is made.
    expect(got?.ttl).toBe(1_700_000_000 + 180 * 24 * 60 * 60);
  });

  it("returns null for an unknown client_id", async () => {
    const { r } = repo();
    expect(await r.getClient("mcp_missing")).toBeNull();
  });

  it("rejects a second putClient with the same client_id (create-once)", async () => {
    const { r } = repo();
    await r.putClient(clientItem("mcp_dup"));
    await expect(r.putClient(clientItem("mcp_dup"))).rejects.toMatchObject({
      name: "ConditionalCheckFailedException",
    });
    // The first registration still persists unchanged.
    const got = await r.getClient("mcp_dup");
    expect(got?.clientId).toBe("mcp_dup");
  });
});

describe("repository: registered client expiry and renewal", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const sec = (ms: number) => Math.floor(ms / 1000);
  const base = {
    SK: "A" as const,
    clientName: null,
    redirectUris: ["https://app.example.com/cb"],
    grantTypes: ["authorization_code"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "none",
    createdAt: T0,
  };
  const client = (id: string) => ({ ...base, PK: `CLIENT#${id}`, clientId: id });
  const updates = (ddb: FakeDdb) => ddb.sent.filter((c) => c.name === "UpdateCommand");

  it("treats a client past its ttl as unknown", async () => {
    let now = T0;
    const { r } = repo(() => now);
    await r.putClient(client("mcp_a"));
    now = T0 + 179 * DAY;
    expect((await r.getClient("mcp_a"))?.clientId).toBe("mcp_a");
    now = T0 + 181 * DAY;
    expect(await r.getClient("mcp_a")).toBeNull();
  });

  it("extends the ttl at most once a day", async () => {
    let now = T0;
    const { r, ddb } = repo(() => now);
    await r.putClient(client("mcp_a"));
    const renew = async () => {
      const got = await r.getClient("mcp_a");
      await r.renewClient("mcp_a", got?.ttl);
      return (await r.getClient("mcp_a"))?.ttl;
    };

    // Registered a moment ago: no write.
    now = T0 + 60_000;
    expect(await renew()).toBe(sec(T0 + 180 * DAY));
    expect(updates(ddb)).toHaveLength(0);

    // 23 hours in: still no write, however often it is used.
    now = T0 + 23 * 60 * 60 * 1000;
    await renew();
    await renew();
    expect(updates(ddb)).toHaveLength(0);

    // 25 hours in: one write, to 180 days from now.
    now = T0 + 25 * 60 * 60 * 1000;
    expect(await renew()).toBe(sec(now + 180 * DAY));
    expect(updates(ddb)).toHaveLength(1);

    // Used again right after: no second write.
    now += 60_000;
    await renew();
    expect(updates(ddb)).toHaveLength(1);

    // A day later: the next one.
    now += DAY;
    expect(await renew()).toBe(sec(now + 180 * DAY));
    expect(updates(ddb)).toHaveLength(2);
  });

  it("loses a renewal race quietly: the stored ttl stays the newer one", async () => {
    const now = T0 + 2 * DAY;
    const { r, ddb } = repo(() => now);
    await r.putClient(client("mcp_a"));
    const stale = sec(T0 + 180 * DAY);
    // Both callers read the old ttl; the second write's condition fails.
    await r.renewClient("mcp_a", stale);
    await r.renewClient("mcp_a", stale);
    expect(updates(ddb)).toHaveLength(2);
    expect((await r.getClient("mcp_a"))?.ttl).toBe(sec(now + 180 * DAY));
  });

  it("leaves a registration made before ttls existed alone", async () => {
    let now = T0;
    const { r, ddb } = repo(() => now);
    ddb.store.set("CLIENT#mcp_old\u0000A", { ...client("mcp_old") });
    now = T0 + 400 * DAY;
    const got = await r.getClient("mcp_old");
    expect(got?.clientId).toBe("mcp_old");
    await r.renewClient("mcp_old", got?.ttl);
    expect(updates(ddb)).toHaveLength(0);
    expect((await r.getClient("mcp_old"))?.ttl).toBeUndefined();
  });
});
