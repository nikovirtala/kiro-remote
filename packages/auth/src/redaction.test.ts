/**
 * Redaction discipline: no auth code, code verifier, access/refresh/id token,
 * bearer header, or OAuth URL may survive core's redact(). Every facade log
 * line must be routed through it.
 */

import { redact } from "@nikovirtala/kiro-remote-core";
import { describe, expect, test } from "vitest";

describe("redaction of facade secrets", () => {
  test("scrubs tokens, codes, verifiers, and OAuth URLs from structured logs", () => {
    const logLine = {
      msg: "authorize done",
      access_token: "ACCESS123",
      refresh_token: "REFRESH123",
      id_token: "ID123",
      code: "AUTHCODE",
      code_verifier: "VERIFIER",
      authorization: "Bearer eyJabc.def.ghi",
      redirectUrl:
        "https://claude.ai/api/mcp/auth_callback?code=AUTHCODE&state=s&iss=https://kiro.example.com",
      tokenEndpoint: "https://kiro.example.com/oauth/token",
    };
    const scrubbed = redact(logLine) as Record<string, string>;
    const serialized = JSON.stringify(scrubbed);

    expect(serialized).not.toContain("ACCESS123");
    expect(serialized).not.toContain("REFRESH123");
    expect(serialized).not.toContain("ID123");
    expect(serialized).not.toContain("AUTHCODE");
    expect(serialized).not.toContain("VERIFIER");
    expect(serialized).not.toContain("eyJabc.def.ghi");
    // The OAuth callback URL (carrying code/state) and the token endpoint are
    // scrubbed wholesale.
    expect(serialized).not.toContain("auth_callback?code=");
    expect(serialized).not.toContain("/oauth/token");
  });

  test("scrubs a free-form string containing a bearer token and a ksk key", () => {
    const out = redact("called with Authorization: Bearer abc.def.ghi and key ksk_live_123");
    expect(out).not.toContain("abc.def.ghi");
    expect(out).not.toContain("ksk_live_123");
  });
});
