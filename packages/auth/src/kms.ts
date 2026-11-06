/**
 * KMS port + real adapter for envelope-encrypting the Cognito token set that
 * is stashed in the one-time OAUTH#CODE item. The stored ciphertext is opaque;
 * plaintext tokens never touch DynamoDB. Injected so tests run offline.
 */

import { DecryptCommand, EncryptCommand, type KMSClient } from "@aws-sdk/client-kms";

/** The crypto surface the facade depends on. */
export interface KmsPort {
  /** Encrypt UTF-8 plaintext, returning base64 ciphertext. */
  encrypt(plaintext: string): Promise<string>;
  /** Decrypt base64 ciphertext back to UTF-8 plaintext. */
  decrypt(ciphertextB64: string): Promise<string>;
}

export interface KmsAdapterConfig {
  client: KMSClient;
  keyId: string;
}

/** Real KMS adapter using symmetric encrypt/decrypt. */
export class KmsAdapter implements KmsPort {
  private readonly client: KMSClient;
  private readonly keyId: string;

  constructor(config: KmsAdapterConfig) {
    this.client = config.client;
    this.keyId = config.keyId;
  }

  async encrypt(plaintext: string): Promise<string> {
    const res = await this.client.send(
      new EncryptCommand({
        KeyId: this.keyId,
        Plaintext: new TextEncoder().encode(plaintext),
      }),
    );
    if (!res.CiphertextBlob) {
      throw new Error("kms encrypt returned no ciphertext");
    }
    return Buffer.from(res.CiphertextBlob).toString("base64");
  }

  async decrypt(ciphertextB64: string): Promise<string> {
    const res = await this.client.send(
      new DecryptCommand({
        KeyId: this.keyId,
        CiphertextBlob: Buffer.from(ciphertextB64, "base64"),
      }),
    );
    if (!res.Plaintext) {
      throw new Error("kms decrypt returned no plaintext");
    }
    return new TextDecoder().decode(res.Plaintext);
  }
}
