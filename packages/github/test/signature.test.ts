import { describe, expect, it } from "vitest";
import { signBody, verifySignature } from "../src/signature.ts";

const SECRET = "It's a Secret to Everybody";
const BODY = "Hello, World!";
// The test vector published in GitHub's "Validating webhook deliveries".
const GITHUB_VECTOR = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

describe("verifySignature", () => {
  it("matches GitHub's published test vector", () => {
    expect(signBody(SECRET, BODY)).toBe(GITHUB_VECTOR);
    expect(verifySignature(SECRET, BODY, GITHUB_VECTOR)).toBe(true);
  });

  it("accepts a valid signature over raw bytes", () => {
    const body = Buffer.from(JSON.stringify({ a: "é✓" }), "utf8");
    expect(verifySignature("s3cret", body, signBody("s3cret", body))).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(verifySignature(SECRET, `${BODY} `, GITHUB_VECTOR)).toBe(false);
    expect(verifySignature(SECRET, "Hello, World?", GITHUB_VECTOR)).toBe(false);
  });

  it("rejects a signature made with the wrong secret", () => {
    expect(verifySignature("another secret", BODY, GITHUB_VECTOR)).toBe(false);
    expect(verifySignature(SECRET, BODY, signBody("another secret", BODY))).toBe(false);
  });

  it("rejects a missing or malformed header", () => {
    for (const header of [
      undefined,
      null,
      "",
      "sha256=",
      "sha256=zz",
      GITHUB_VECTOR.slice(7),
      `sha1=${GITHUB_VECTOR.slice(7)}`,
      `${GITHUB_VECTOR}00`,
    ]) {
      expect(verifySignature(SECRET, BODY, header as never), String(header)).toBe(false);
    }
  });

  it("never accepts an empty secret", () => {
    expect(verifySignature("", BODY, signBody("", BODY))).toBe(false);
  });
});
