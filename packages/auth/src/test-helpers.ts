/**
 * Offline test helpers: an in-memory DynamoDB document-client fake, an
 * in-memory KMS fake, a scripted fake Cognito token endpoint, and a local
 * RS256 signer + JWKS-backed verifier. NONE of these touch the network.
 *
 * This module is test-only; it is not re-exported from the package barrel.
 */

import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import type { AccessTokenClaims, TokenVerifier } from "@kiro-remote/core";
import type { CognitoPort, CognitoTokenSet, FetchLike } from "./cognito.ts";
import type { KmsPort } from "./kms.ts";

/* --------------------------- In-memory DynamoDB ---------------------------- */

interface StoredItem {
  [key: string]: unknown;
  PK: string;
  SK: string;
}

/**
 * The tiny slice of DynamoDBDocumentClient the Repository uses: a `.send()`
 * that dispatches on the command's constructor name. Supports Put/Get/Delete
 * which is all the OAuth repo paths need.
 */
export class FakeDdbClient {
  private readonly items = new Map<string, StoredItem>();

  private key(pk: string, sk: string): string {
    return `${pk}\u0000${sk}`;
  }

  async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
    const name = command.constructor.name;
    const input = command.input;
    if (name === "PutCommand") {
      const item = input.Item as StoredItem;
      const k = this.key(item.PK, item.SK);
      if (input.ConditionExpression === "attribute_not_exists(PK)" && this.items.has(k)) {
        const err = new Error("conditional check failed");
        (err as { name: string }).name = "ConditionalCheckFailedException";
        throw err;
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
      if (input.ReturnValues === "ALL_OLD") {
        return { Attributes: existing };
      }
      return {};
    }
    throw new Error(`FakeDdbClient: unsupported command ${name}`);
  }

  /** Test introspection: how many items are stored. */
  size(): number {
    return this.items.size;
  }
}

/** A no-op S3 client; the OAuth paths never spill to S3. */
export class FakeS3Client {
  async send(): Promise<never> {
    throw new Error("FakeS3Client: unexpected S3 use in OAuth paths");
  }
}

/* ------------------------------ In-memory KMS ------------------------------ */

/** Reversible "encryption" for tests: base64 with a marker prefix. */
export class FakeKms implements KmsPort {
  async encrypt(plaintext: string): Promise<string> {
    return `enc:${Buffer.from(plaintext, "utf8").toString("base64")}`;
  }
  async decrypt(ciphertextB64: string): Promise<string> {
    if (!ciphertextB64.startsWith("enc:")) {
      throw new Error("FakeKms: bad ciphertext");
    }
    return Buffer.from(ciphertextB64.slice(4), "base64").toString("utf8");
  }
}

/* -------------------------- Fake Cognito endpoint -------------------------- */

export interface FakeCognitoOptions {
  /** Token set returned on a successful authorization_code exchange. */
  codeTokenSet?: CognitoTokenSet;
  /** Token set returned on a successful refresh. */
  refreshTokenSet?: CognitoTokenSet;
  /** When set, the exchange fails with this OAuth error. */
  exchangeError?: { status: number; error: string; description?: string };
}

/**
 * A fake Cognito that records the inbound requests so tests can assert the
 * facade sent its own PKCE verifier, client_id, etc. Exposes both a FetchLike
 * (for the CognitoAdapter) and a direct CognitoPort.
 */
export class FakeCognito implements CognitoPort {
  readonly exchanges: Array<{ code: string; redirectUri: string; codeVerifier: string }> = [];
  readonly refreshes: Array<{ refreshToken: string }> = [];
  readonly revocations: Array<{ token: string }> = [];
  private readonly opts: FakeCognitoOptions;

  constructor(opts: FakeCognitoOptions = {}) {
    this.opts = opts;
  }

  async exchangeCode(params: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<CognitoTokenSet> {
    this.exchanges.push(params);
    if (this.opts.exchangeError) {
      const e = this.opts.exchangeError;
      throw Object.assign(new Error(e.error), {
        name: "CognitoTokenError",
        error: e.error,
        status: e.status,
        errorDescription: e.description,
      });
    }
    return (
      this.opts.codeTokenSet ?? {
        access_token: "cognito-access-token",
        token_type: "Bearer",
        expires_in: 900,
        refresh_token: "cognito-refresh-token",
        id_token: "cognito-id-token",
        scope: "openid",
      }
    );
  }

  async refresh(params: { refreshToken: string }): Promise<CognitoTokenSet> {
    this.refreshes.push(params);
    return (
      this.opts.refreshTokenSet ?? {
        access_token: "cognito-access-token-2",
        token_type: "Bearer",
        expires_in: 900,
        scope: "openid",
      }
    );
  }

  async revoke(params: { token: string }): Promise<void> {
    this.revocations.push(params);
  }
}

/**
 * A FetchLike that emulates the Cognito OAuth2 token endpoint for exercising
 * the real CognitoAdapter without network. Returns `tokenSet` on 2xx or an
 * OAuth error body for the configured error status.
 */
export function fakeCognitoFetch(opts: {
  tokenSet?: CognitoTokenSet;
  error?: { status: number; body: Record<string, unknown> };
  onRequest?: (url: string, body: Record<string, string>) => void;
}): FetchLike {
  return async (url, init) => {
    const body: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(init.body).entries()) {
      body[k] = v;
    }
    opts.onRequest?.(url, body);
    if (opts.error) {
      return {
        status: opts.error.status,
        json: async () => opts.error?.body ?? {},
        text: async () => JSON.stringify(opts.error?.body ?? {}),
      };
    }
    const tokenSet = opts.tokenSet ?? {
      access_token: "cognito-access-token",
      token_type: "Bearer",
      expires_in: 900,
    };
    return {
      status: 200,
      json: async () => tokenSet,
      text: async () => JSON.stringify(tokenSet),
    };
  };
}

/* ----------------------- Local RS256 signer + verifier --------------------- */

export interface LocalKeypair {
  privateKey: KeyObject;
  publicKey: KeyObject;
}

/** Generate an ephemeral RSA keypair for in-test JWT signing. */
export function generateLocalKeypair(): LocalKeypair {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKey: createPrivateKey(privateKey.export({ type: "pkcs8", format: "pem" })),
    publicKey: createPublicKey(publicKey.export({ type: "spki", format: "pem" })),
  };
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** Sign a JWT with RS256 using a local private key. */
export function signJwt(claims: Record<string, unknown>, key: KeyObject): string {
  const header = { alg: "RS256", typ: "JWT", kid: "test-key" };
  const encodedHeader = b64url(JSON.stringify(header));
  const encodedPayload = b64url(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = cryptoSign("RSA-SHA256", Buffer.from(signingInput), key);
  return `${signingInput}.${b64url(signature)}`;
}

/**
 * A local {@link TokenVerifier} that verifies the RS256 signature against the
 * local public key (the "JWKS") and enforces the expected issuer. Everything
 * else (token_use, exp, client_id, scope/aud) is left to authenticate().
 */
export function localVerifier(publicKey: KeyObject, expectedIssuer: string): TokenVerifier {
  return {
    async verify(token: string): Promise<AccessTokenClaims> {
      const parts = token.split(".");
      if (parts.length !== 3) {
        throw new Error("malformed jwt");
      }
      const [h, p, s] = parts;
      const ok = cryptoVerify(
        "RSA-SHA256",
        Buffer.from(`${h}.${p}`),
        publicKey,
        Buffer.from(s, "base64url"),
      );
      if (!ok) {
        throw new Error("bad signature");
      }
      const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as AccessTokenClaims;
      if (claims.iss !== expectedIssuer) {
        throw new Error("issuer mismatch");
      }
      return claims;
    },
  };
}
