/**
 * KMS port + real adapter for envelope-encrypting the Cognito token set that
 * is stashed in the one-time OAUTH#CODE item. The stored ciphertext is opaque;
 * plaintext tokens never touch DynamoDB. Injected so tests run offline.
 *
 * ENVELOPE ENCRYPTION (why, not a raw KMS Encrypt): the KMS `Encrypt` API caps
 * its plaintext at 4096 bytes, but the Cognito token set (access + id + refresh
 * tokens as JSON) is larger than that. So we ask KMS only to mint/unwrap a
 * small 32-byte data key (`GenerateDataKey` / `Decrypt` -- both well under the
 * limit) and encrypt the real plaintext LOCALLY with AES-256-GCM. KMS never
 * sees the token plaintext, and there is no size limit on what we can store.
 *
 * STORED FORMAT: a single self-describing JSON object, base64-encoded:
 *   { v: 1, k: <b64 KMS-wrapped data key>, iv: <b64 12-byte IV>,
 *     tag: <b64 16-byte GCM auth tag>, ct: <b64 AES-GCM ciphertext> }
 * The wrapped data key, IV, tag, and ciphertext are all safe at rest (that is
 * the point of envelope encryption); only the unwrapped data key and the token
 * plaintext are secret, and both are discarded as soon as they are used. The
 * `v` field reserves room for future format changes. NOTE: this format differs
 * from the previous raw-KMS-base64 ciphertext, but no persisted OAUTH#CODE
 * items outlive their 60 s TTL, so no migration is required.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DecryptCommand, GenerateDataKeyCommand, type KMSClient } from "@aws-sdk/client-kms";

/** The crypto surface the facade depends on. */
export interface KmsPort {
  /** Encrypt UTF-8 plaintext, returning an opaque base64 string. */
  encrypt(plaintext: string): Promise<string>;
  /** Decrypt an opaque base64 string back to UTF-8 plaintext. */
  decrypt(ciphertextB64: string): Promise<string>;
}

export interface KmsAdapterConfig {
  client: KMSClient;
  keyId: string;
}

interface Envelope {
  v: 1;
  /** KMS-wrapped (encrypted) data key, base64. */
  k: string;
  /** AES-GCM IV (12 bytes), base64. */
  iv: string;
  /** AES-GCM auth tag (16 bytes), base64. */
  tag: string;
  /** AES-GCM ciphertext of the plaintext, base64. */
  ct: string;
}

/**
 * Real KMS adapter using envelope encryption: KMS wraps a per-item AES-256 data
 * key, and the plaintext is encrypted locally with AES-256-GCM.
 */
export class KmsAdapter implements KmsPort {
  private readonly client: KMSClient;
  private readonly keyId: string;

  constructor(config: KmsAdapterConfig) {
    this.client = config.client;
    this.keyId = config.keyId;
  }

  async encrypt(plaintext: string): Promise<string> {
    const res = await this.client.send(
      new GenerateDataKeyCommand({ KeyId: this.keyId, KeySpec: "AES_256" }),
    );
    if (!res.Plaintext || !res.CiphertextBlob) {
      throw new Error("kms generate data key returned no key material");
    }
    const dataKey = Buffer.from(res.Plaintext);
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
      const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      const envelope: Envelope = {
        v: 1,
        k: Buffer.from(res.CiphertextBlob).toString("base64"),
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
        ct: ct.toString("base64"),
      };
      return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
    } finally {
      // Best-effort: drop the plaintext data key from memory once used.
      dataKey.fill(0);
    }
  }

  async decrypt(ciphertextB64: string): Promise<string> {
    const envelope = JSON.parse(Buffer.from(ciphertextB64, "base64").toString("utf8")) as Envelope;
    if (envelope.v !== 1 || !envelope.k || !envelope.iv || !envelope.tag || !envelope.ct) {
      throw new Error("kms decrypt: malformed envelope");
    }

    const res = await this.client.send(
      new DecryptCommand({
        KeyId: this.keyId,
        CiphertextBlob: Buffer.from(envelope.k, "base64"),
      }),
    );
    if (!res.Plaintext) {
      throw new Error("kms decrypt returned no data key");
    }
    const dataKey = Buffer.from(res.Plaintext);
    try {
      const decipher = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(envelope.iv, "base64"));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      const pt = Buffer.concat([
        decipher.update(Buffer.from(envelope.ct, "base64")),
        decipher.final(),
      ]);
      return pt.toString("utf8");
    } finally {
      // Best-effort: drop the plaintext data key from memory once used.
      dataKey.fill(0);
    }
  }
}
