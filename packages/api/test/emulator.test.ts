/**
 * The facade's DynamoDB paths against the AWS Emulator (a real DynamoDB API:
 * conditional deletes, ReturnValues ALL_OLD, ConsistentRead, UpdateItem
 * conditions), with the real Repository and the real auth handlers. Only
 * Cognito and KMS are faked.
 *
 * Skipped unless KIRO_REMOTE_EMULATOR_TEST=1. It then needs the emulator's
 * connection variables (AWS_ENDPOINT_URL, credentials and config files,
 * NODE_EXTRA_CA_CERTS) and refuses to run against anything but a loopback
 * endpoint, so it can never reach real AWS. See docs/testing.md.
 */

import { randomBytes } from "node:crypto";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  ClientResolver,
  type CognitoPort,
  type DynamicClientStore,
  type FacadeConfig,
  handleAuthorize,
  handleCallback,
  handleToken,
  type KmsPort,
  s256Challenge,
} from "@nikovirtala/kiro-remote-auth";
import { Repository } from "@nikovirtala/kiro-remote-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const ENABLED = process.env.KIRO_REMOTE_EMULATOR_TEST === "1";
const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

const config: FacadeConfig = {
  publicBaseUrl: "https://kiro.example.com",
  mcpResource: "https://kiro.example.com/mcp",
  scopesSupported: ["sessions:read", "sessions:write", "sessions:delete"],
  cognitoDomain: "https://kiro-pool.auth.us-east-1.amazoncognito.com",
  cognitoClientId: "facadeclient123",
  cognitoJwksUri: "https://cognito-idp/jwks.json",
  cimdAllowedHosts: [],
  kmsKeyId: "kms-key",
};

const cognito: CognitoPort = {
  async exchangeCode() {
    return { access_token: "ACCESS", token_type: "Bearer", expires_in: 900 };
  },
  async refresh() {
    return { access_token: "ACCESS2", token_type: "Bearer", expires_in: 900 };
  },
  async revoke() {},
};
const kms: KmsPort = {
  async encrypt(plaintext) {
    return Buffer.from(plaintext).toString("base64");
  },
  async decrypt(ciphertext) {
    return Buffer.from(ciphertext, "base64").toString("utf8");
  },
};

describe.skipIf(!ENABLED)("OAuth facade storage against the AWS Emulator", () => {
  const table = `kr-oauth-${randomBytes(4).toString("hex")}`;
  const raw = new DynamoDBClient({});
  const ddb = DynamoDBDocumentClient.from(raw);
  /** Every DynamoDB request body that went over the wire, parsed. */
  const wire: Array<{ target: string; body: Record<string, unknown> }> = [];
  let now = T0;
  let repo: Repository;

  beforeAll(async () => {
    const endpoint = process.env.AWS_ENDPOINT_URL ?? "";
    if (!/^https:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/?$/.test(endpoint)) {
      throw new Error(`refusing to run: AWS_ENDPOINT_URL=${endpoint} is not a loopback emulator`);
    }
    raw.middlewareStack.add(
      (next) => async (args) => {
        const req = args.request as { headers?: Record<string, string>; body?: unknown };
        const text =
          req.body instanceof Uint8Array
            ? Buffer.from(req.body).toString("utf8")
            : typeof req.body === "string"
              ? req.body
              : undefined;
        if (text) {
          wire.push({
            target: req.headers?.["x-amz-target"] ?? "",
            body: JSON.parse(text) as Record<string, unknown>,
          });
        }
        return next(args);
      },
      { step: "finalizeRequest", name: "captureWire" },
    );
    await raw.send(
      new CreateTableCommand({
        TableName: table,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "PK", AttributeType: "S" },
          { AttributeName: "SK", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
      }),
    );
    for (let i = 0; i < 30; i++) {
      const d = await raw.send(new DescribeTableCommand({ TableName: table }));
      if (d.Table?.TableStatus === "ACTIVE") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    repo = new Repository({
      ddb,
      s3: {} as never,
      tableName: table,
      bucketName: "unused",
      now: () => now,
    });
  });

  afterAll(async () => {
    if (ENABLED) await raw.send(new DeleteTableCommand({ TableName: table }));
  });

  const dynStore = (): DynamicClientStore => ({
    async getClient(clientId) {
      const item = await repo.getClient(clientId);
      return item ? { ...item } : null;
    },
    async putClient(client) {
      await repo.putClient({ PK: `CLIENT#${client.clientId}`, SK: "A", ...client });
    },
    async renewClient(clientId, currentTtl) {
      await repo.renewClient(clientId, currentTtl);
    },
  });

  const authorizeReq = (clientId: string, redirectUri: string, verifier: string) => ({
    method: "GET",
    path: "/oauth/authorize",
    query: {
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: s256Challenge(verifier),
      code_challenge_method: "S256",
      resource: config.mcpResource,
      state: "client-state",
    },
    headers: {},
  });
  const callbackReq = (state: string) => ({
    method: "GET",
    path: "/oauth/callback",
    query: { code: "cognito-code", state },
    headers: {},
  });

  test("a replayed callback is refused: the transaction is a conditional delete", async () => {
    now = T0;
    const clients = new ClientResolver({
      cimd: {} as never,
      preRegistered: [
        { clientId: "pre", clientName: "Pre", redirectUris: ["https://pre.example/cb"] },
      ],
    });
    const auth = await handleAuthorize(
      authorizeReq("pre", "https://pre.example/cb", "v".repeat(43)),
      {
        config,
        repo,
        clients,
        generateState: () => "state-replay",
        generateVerifier: () => "up-verifier",
      },
    );
    expect(auth.status).toBe(302);

    const deps = { config, repo, cognito, kms, generateCode: () => "our-code-replay" };
    const first = await handleCallback(callbackReq("state-replay"), deps);
    expect(first.status).toBe(302);
    expect(new URL(first.headers.location).searchParams.get("code")).toBe("our-code-replay");

    const replay = await handleCallback(callbackReq("state-replay"), deps);
    console.log(
      `replayed callback: status=${replay.status} branch=${replay.logContext?.branch} location=${replay.headers.location}`,
    );
    expect(replay.status).toBe(400);
    expect(replay.headers.location).toBeUndefined();
    expect(replay.logContext).toEqual({ branch: "tx_not_found" });

    const del = wire.filter(
      (w) =>
        w.target.endsWith("DeleteItem") &&
        JSON.stringify(w.body.Key).includes("OAUTH#TX#state-replay"),
    );
    expect(del).toHaveLength(2);
    for (const d of del) {
      expect(d.body.ConditionExpression).toBe("attribute_exists(PK)");
      expect(d.body.ReturnValues).toBe("ALL_OLD");
    }
  });

  test("of two concurrent callbacks with one state, exactly one consumes it", async () => {
    now = T0;
    await repo.putOAuthTx("state-race", { clientId: "c" });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => repo.consumeOAuthTx("state-race")),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  test("a code consumed twice is refused the second time", async () => {
    now = T0;
    await repo.putOAuthCode("hash-twice", {
      encryptedTokens: "x",
      clientId: "c",
      redirectUri: "https://a/cb",
      codeChallenge: "h",
    });
    expect((await repo.consumeOAuthCode("hash-twice"))?.clientId).toBe("c");
    expect(await repo.consumeOAuthCode("hash-twice")).toBeNull();
  });

  test("an expired code and an expired transaction are refused, though DynamoDB still holds them", async () => {
    now = T0;
    const verifier = "v".repeat(43);
    const clients = new ClientResolver({
      cimd: {} as never,
      preRegistered: [
        { clientId: "pre", clientName: "Pre", redirectUris: ["https://pre.example/cb"] },
      ],
    });
    await handleAuthorize(authorizeReq("pre", "https://pre.example/cb", verifier), {
      config,
      repo,
      clients,
      generateState: () => "state-expired-code",
      generateVerifier: () => "up-verifier",
    });
    await handleCallback(callbackReq("state-expired-code"), {
      config,
      repo,
      cognito,
      kms,
      generateCode: () => "our-code-expired",
    });
    // A second transaction that nobody calls back for 11 minutes.
    await repo.putOAuthTx("state-expired-tx", { clientId: "pre" });

    now = T0 + 11 * 60_000;
    const tx = await handleCallback(callbackReq("state-expired-tx"), {
      config,
      repo,
      cognito,
      kms,
    });
    console.log(`expired transaction: status=${tx.status} branch=${tx.logContext?.branch}`);
    expect(tx.status).toBe(400);

    now = T0 + 61_000;
    const token = await handleToken(
      {
        method: "POST",
        path: "/oauth/token",
        query: {},
        headers: {},
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "our-code-expired",
          code_verifier: verifier,
          client_id: "pre",
          redirect_uri: "https://pre.example/cb",
        }).toString(),
      },
      { repo, cognito, kms },
    );
    console.log(`expired code: status=${token.status} body=${token.body}`);
    expect(token.status).toBe(400);
    expect(JSON.parse(token.body).error).toBe("invalid_grant");
  });

  test("the reads that follow a write are ConsistentRead on the wire", async () => {
    now = T0;
    wire.length = 0;
    await repo.putOAuthTx("state-cr", {});
    await repo.getOAuthTx("state-cr");
    await repo.putClient({
      PK: "CLIENT#mcp_cr",
      SK: "A",
      clientId: "mcp_cr",
      clientName: null,
      redirectUris: ["https://app/cb"],
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
      tokenEndpointAuthMethod: "none",
      createdAt: T0,
    });
    await repo.getClient("mcp_cr");
    const gets = wire.filter((w) => w.target.endsWith("GetItem"));
    expect(gets).toHaveLength(2);
    for (const g of gets) {
      expect(g.body.ConsistentRead).toBe(true);
    }
  });

  test("a registered client expires, is extended at most once a day, and keeps a ttl-less registration", async () => {
    now = T0;
    const store = dynStore();
    await store.putClient({
      clientId: "mcp_ttl",
      clientName: "T",
      redirectUris: ["https://app/cb"],
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
      tokenEndpointAuthMethod: "none",
      createdAt: T0,
    });
    const clients = new ClientResolver({ cimd: {} as never, preRegistered: [], dynamic: store });
    const updates = () => wire.filter((w) => w.target.endsWith("UpdateItem")).length;
    wire.length = 0;

    now = T0 + 60_000;
    await clients.resolve("mcp_ttl");
    expect(updates()).toBe(0);

    now = T0 + 25 * 60 * 60_000;
    await clients.resolve("mcp_ttl");
    await clients.resolve("mcp_ttl");
    expect(updates()).toBe(1);
    expect((await repo.getClient("mcp_ttl"))?.ttl).toBe(Math.floor((now + 180 * DAY) / 1000));

    // A registration with no ttl (made before clients expired) never expires and is not written to.
    await ddb.send(
      new PutCommand({
        TableName: table,
        Item: {
          PK: "CLIENT#mcp_old",
          SK: "A",
          clientId: "mcp_old",
          clientName: null,
          redirectUris: ["https://old/cb"],
          grantTypes: [],
          responseTypes: [],
          tokenEndpointAuthMethod: "none",
          createdAt: T0,
        },
      }),
    );
    now = T0 + 500 * DAY;
    wire.length = 0;
    expect((await clients.resolve("mcp_old")).clientId).toBe("mcp_old");
    expect(updates()).toBe(0);
    // ... while the one that was used 475 days ago has expired.
    await expect(clients.resolve("mcp_ttl")).rejects.toMatchObject({
      oauthError: "invalid_client",
    });
  });
});
