import { describe, expect, it } from "vitest";
import { CognitoTokenVerifier } from "../src/index.ts";

describe("CognitoTokenVerifier", () => {
  it("adapts the aws-jwt-verify payload to the core AccessTokenClaims shape", async () => {
    const fakeVerifier = {
      async verify(_token: string) {
        return {
          sub: "user-1",
          token_use: "access",
          client_id: "cli-client",
          scope: "https://kiro.example.com/mcp/sessions:read",
          aud: "https://kiro.example.com/mcp",
          iss: "https://cognito.example.com/pool",
          exp: 1_700_000_000,
          auth_time: 1_699_990_000,
        };
      },
    };
    const verifier = new CognitoTokenVerifier({ verifier: fakeVerifier });

    const claims = await verifier.verify("token");
    expect(claims.sub).toBe("user-1");
    expect(claims.token_use).toBe("access");
    expect(claims.client_id).toBe("cli-client");
    expect(claims.scope).toBe("https://kiro.example.com/mcp/sessions:read");
    expect(claims.aud).toBe("https://kiro.example.com/mcp");
    expect(claims.iss).toBe("https://cognito.example.com/pool");
    expect(claims.exp).toBe(1_700_000_000);
    // Extra claims are preserved on the pass-through.
    expect(claims.auth_time).toBe(1_699_990_000);
  });

  it("throws when the underlying verifier rejects", async () => {
    const verifier = new CognitoTokenVerifier({
      verifier: {
        async verify() {
          throw new Error("expired");
        },
      },
    });
    await expect(verifier.verify("bad")).rejects.toThrow("expired");
  });

  it("throws when required claims are missing", async () => {
    const verifier = new CognitoTokenVerifier({
      verifier: {
        async verify() {
          return { sub: "", token_use: "access", iss: "x", exp: 1 };
        },
      },
    });
    await expect(verifier.verify("t")).rejects.toThrow("missing required claims");
  });

  it("requires a verifier or a userPoolId", () => {
    expect(() => new CognitoTokenVerifier({})).toThrow("verifier or userPoolId");
  });
});
