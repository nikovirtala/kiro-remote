import type { S3Client } from "@aws-sdk/client-s3";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import {
  ConcurrentModificationError,
  capabilities as deriveCapabilities,
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

  private key(pk: string, sk: string): string {
    return `${pk}\u0000${sk}`;
  }

  async send(cmd: {
    constructor: { name: string };
    input: Record<string, unknown>;
  }): Promise<unknown> {
    const name = cmd.constructor.name;
    const input = cmd.input;
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
