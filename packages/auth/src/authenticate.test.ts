/**
 * Resource-server token validation + authorization tests. These exercise
 * core's authenticate()/authorize() (the only token-claim readers) with a
 * LOCAL RS256 JWKS and a fake Cognito-shaped access token, and assert the
 * facade's 401/403 header shapes. No network, no real Cognito.
 */

import {
  type AuthenticateConfig,
  authenticate,
  authorize,
  ForbiddenError,
  requiredScope,
  UnauthorizedError,
  wwwAuthenticateHeader,
} from "@nikovirtala/kiro-remote-core";
import { describe, expect, test } from "vitest";
import { generateLocalKeypair, localVerifier, signJwt } from "./test-helpers.ts";

const RESOURCE = "https://kiro.example.com/mcp";
const ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_pool";
const RESOURCE_METADATA = "https://kiro.example.com/.well-known/oauth-protected-resource/mcp";
const CLIENT_ID = "facadeclient123";

const keypair = generateLocalKeypair();

function configWith(now: number): AuthenticateConfig {
  return {
    verifier: localVerifier(keypair.publicKey, ISSUER),
    allowedClientIds: [CLIENT_ID],
    resourceIdentifier: RESOURCE,
    now: () => now,
  };
}

const NOW = 1_700_000_000_000; // fixed ms clock
const NOW_S = Math.floor(NOW / 1000);

function accessToken(overrides: Record<string, unknown> = {}): string {
  return signJwt(
    {
      sub: "user-1",
      token_use: "access",
      client_id: CLIENT_ID,
      iss: ISSUER,
      exp: NOW_S + 900,
      // Cognito emits custom resource-server scopes prefixed with the
      // resource identifier, e.g. "<resource>/sessions:read".
      scope: `${RESOURCE}/sessions:read ${RESOURCE}/sessions:write`,
      ...overrides,
    },
    keypair.privateKey,
  );
}

function req(token?: string) {
  return { headers: token ? { authorization: `Bearer ${token}` } : {} };
}

describe("authenticate()", () => {
  test("accepts a valid Cognito access token and normalizes scopes", async () => {
    const principal = await authenticate(req(accessToken()), configWith(NOW), RESOURCE_METADATA);
    expect(principal.sub).toBe("user-1");
    expect(principal.clientId).toBe(CLIENT_ID);
    expect(principal.scopes).toEqual(["sessions:read", "sessions:write"]);
  });

  test("missing bearer -> 401 carrying resource_metadata", async () => {
    try {
      await authenticate(req(), configWith(NOW), RESOURCE_METADATA);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnauthorizedError);
      const header = wwwAuthenticateHeader((err as UnauthorizedError).challenge);
      expect(header).toContain(`resource_metadata="${RESOURCE_METADATA}"`);
    }
  });

  test("expired token -> 401", async () => {
    const token = accessToken({ exp: NOW_S - 10 });
    await expect(
      authenticate(req(token), configWith(NOW), RESOURCE_METADATA),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  test("wrong issuer -> 401", async () => {
    const token = accessToken({ iss: "https://attacker.example" });
    await expect(
      authenticate(req(token), configWith(NOW), RESOURCE_METADATA),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  test("id token (token_use=id) is rejected -> 401", async () => {
    const token = accessToken({ token_use: "id" });
    await expect(
      authenticate(req(token), configWith(NOW), RESOURCE_METADATA),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  test("unknown client_id -> 401", async () => {
    const token = accessToken({ client_id: "someone-else" });
    await expect(
      authenticate(req(token), configWith(NOW), RESOURCE_METADATA),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  test("token not bound to this resource -> 403 insufficient_scope", async () => {
    const token = accessToken({ scope: "openid profile" });
    try {
      await authenticate(req(token), configWith(NOW), RESOURCE_METADATA);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).neededScope).toContain(RESOURCE);
    }
  });

  test("accepts an explicit RFC 8707 aud equal to the resource identifier", async () => {
    const token = accessToken({ scope: undefined, aud: RESOURCE });
    const principal = await authenticate(req(token), configWith(NOW), RESOURCE_METADATA);
    expect(principal.sub).toBe("user-1");
  });
});

describe("authorize()", () => {
  const principal = { sub: "owner", clientId: CLIENT_ID, scopes: ["sessions:read"] };

  test("maps actions to the right scopes", () => {
    expect(requiredScope("read")).toBe("sessions:read");
    expect(requiredScope("launch")).toBe("sessions:write");
    expect(requiredScope("prompt")).toBe("sessions:write");
    expect(requiredScope("delete")).toBe("sessions:delete");
  });

  test("allows a held scope on an owned resource", () => {
    expect(() => authorize(principal, "read", { createdBy: "owner" })).not.toThrow();
  });

  test("missing scope -> ForbiddenError with the needed scope", () => {
    try {
      authorize(principal, "delete");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).neededScope).toBe("sessions:delete");
    }
  });

  test("cross-user access is denied even with the scope", () => {
    expect(() => authorize(principal, "read", { createdBy: "someone-else" })).toThrow(
      ForbiddenError,
    );
  });

  test("403 WWW-Authenticate header shape carries error + scope + resource_metadata", () => {
    const header = wwwAuthenticateHeader({
      scheme: "Bearer",
      error: "insufficient_scope",
      scope: "sessions:write",
      resourceMetadata: RESOURCE_METADATA,
    });
    expect(header).toContain('error="insufficient_scope"');
    expect(header).toContain('scope="sessions:write"');
    expect(header).toContain(`resource_metadata="${RESOURCE_METADATA}"`);
  });
});
