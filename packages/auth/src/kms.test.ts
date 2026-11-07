/**
 * KmsAdapter (real envelope-encryption adapter) tests. A fake KMS client stands
 * in for the AWS SDK's KMSClient and only ever handles the two commands the
 * adapter is allowed to use on the small data key: GenerateDataKey (mint a
 * 32-byte key + a wrapped blob) and Decrypt (unwrap the blob back to the key).
 * The regression guard is the >4096-byte round-trip: a raw KMS Encrypt would
 * reject that with ValidationException, which is exactly the bug this fixes.
 */

import { randomBytes } from "node:crypto";
import { DecryptCommand, EncryptCommand, GenerateDataKeyCommand } from "@aws-sdk/client-kms";
import { describe, expect, test } from "vitest";
import { KmsAdapter } from "./kms.ts";

/**
 * In-memory KMS stand-in. GenerateDataKey returns a real random 32-byte key and
 * a "wrapped" blob that is just the key bytes with a marker prefix; Decrypt
 * reverses that. EncryptCommand is intentionally unsupported so the test fails
 * loudly if the adapter ever tries to raw-encrypt the full plaintext again.
 */
class FakeKmsClient {
  readonly calls: string[] = [];
  private readonly wrapPrefix = Buffer.from("WRAP:", "utf8");

  async send(command: unknown): Promise<unknown> {
    if (command instanceof GenerateDataKeyCommand) {
      this.calls.push("GenerateDataKey");
      const key = randomBytes(32);
      return {
        Plaintext: new Uint8Array(key),
        CiphertextBlob: new Uint8Array(Buffer.concat([this.wrapPrefix, key])),
      };
    }
    if (command instanceof DecryptCommand) {
      this.calls.push("Decrypt");
      const blob = Buffer.from(command.input.CiphertextBlob as Uint8Array);
      if (!blob.subarray(0, this.wrapPrefix.length).equals(this.wrapPrefix)) {
        throw new Error("FakeKmsClient: unknown ciphertext blob");
      }
      return { Plaintext: new Uint8Array(blob.subarray(this.wrapPrefix.length)) };
    }
    if (command instanceof EncryptCommand) {
      throw new Error("FakeKmsClient: EncryptCommand must not be used (envelope encryption only)");
    }
    throw new Error("FakeKmsClient: unexpected command");
  }
}

function makeAdapter(): { adapter: KmsAdapter; client: FakeKmsClient } {
  const client = new FakeKmsClient();
  // The adapter only uses the client's `send`; the cast keeps the fake minimal.
  const adapter = new KmsAdapter({ client: client as never, keyId: "test-key" });
  return { adapter, client };
}

describe("KmsAdapter (envelope encryption)", () => {
  test("round-trips a small string", async () => {
    const { adapter } = makeAdapter();
    const plaintext = "hello world";
    const stored = await adapter.encrypt(plaintext);
    expect(stored).not.toContain(plaintext);
    expect(await adapter.decrypt(stored)).toBe(plaintext);
  });

  test("round-trips a token set larger than the 4096-byte KMS Encrypt limit", async () => {
    const { adapter, client } = makeAdapter();
    // A realistic Cognito token set is well over 4 KB once the JWTs are packed.
    const tokenSet = JSON.stringify({
      access_token: `a.${"x".repeat(3000)}.sig`,
      id_token: `b.${"y".repeat(3000)}.sig`,
      refresh_token: `c.${"z".repeat(2000)}.sig`,
      token_type: "Bearer",
      expires_in: 3600,
    });
    expect(Buffer.byteLength(tokenSet, "utf8")).toBeGreaterThan(4096);

    const stored = await adapter.encrypt(tokenSet);
    expect(await adapter.decrypt(stored)).toBe(tokenSet);

    // KMS was only ever asked to mint and unwrap the small data key -- never to
    // encrypt the oversized plaintext directly.
    expect(client.calls).toEqual(["GenerateDataKey", "Decrypt"]);
  });

  test("the stored envelope never leaks the plaintext", async () => {
    const { adapter } = makeAdapter();
    const secret = "super-secret-refresh-token-value";
    const stored = await adapter.encrypt(secret);
    expect(stored).not.toContain(secret);
    // Decoding the outer base64 reveals the envelope JSON, not the plaintext.
    const decoded = Buffer.from(stored, "base64").toString("utf8");
    expect(decoded).not.toContain(secret);
    expect(JSON.parse(decoded).v).toBe(1);
  });

  test("tampering with the ciphertext makes decrypt fail (AES-GCM auth)", async () => {
    const { adapter } = makeAdapter();
    const stored = await adapter.encrypt("tamper target");
    const envelope = JSON.parse(Buffer.from(stored, "base64").toString("utf8"));
    const ct = Buffer.from(envelope.ct, "base64");
    ct[0] = ct[0] ^ 0xff; // flip a bit in the ciphertext
    envelope.ct = ct.toString("base64");
    const tampered = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
    await expect(adapter.decrypt(tampered)).rejects.toThrow();
  });

  test("tampering with the auth tag makes decrypt fail", async () => {
    const { adapter } = makeAdapter();
    const stored = await adapter.encrypt("tamper target");
    const envelope = JSON.parse(Buffer.from(stored, "base64").toString("utf8"));
    const tag = Buffer.from(envelope.tag, "base64");
    tag[0] = tag[0] ^ 0xff;
    envelope.tag = tag.toString("base64");
    const tampered = Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
    await expect(adapter.decrypt(tampered)).rejects.toThrow();
  });

  test("rejects a malformed envelope", async () => {
    const { adapter } = makeAdapter();
    const bad = Buffer.from(JSON.stringify({ v: 2 }), "utf8").toString("base64");
    await expect(adapter.decrypt(bad)).rejects.toThrow(/malformed envelope/);
  });
});
