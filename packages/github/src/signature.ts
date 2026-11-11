/**
 * X-Hub-Signature-256 verification.
 *
 * The signature is the ONLY authentication on the webhook route, so it is
 * checked against the raw request bytes before anything is parsed, and with a
 * constant-time compare (https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_RE = /^sha256=([0-9a-f]{64})$/i;

/** `sha256=<hex>` for a body and secret. */
export function signBody(secret: string, body: Buffer | string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/**
 * True only when `header` is a well-formed `sha256=<64 hex>` value that equals
 * the HMAC-SHA256 of `body` under `secret`. Never throws.
 */
export function verifySignature(
  secret: string,
  body: Buffer | string,
  header: string | undefined | null,
): boolean {
  if (!secret || typeof header !== "string") {
    return false;
  }
  const match = SIGNATURE_RE.exec(header.trim());
  if (!match) {
    return false;
  }
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(match[1], "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
