import { describe, expect, it } from "vitest";
import {
  type AccessTokenClaims,
  type AuthenticateConfig,
  authenticate,
  authorize,
  ForbiddenError,
  insufficientScope,
  type Principal,
  requiredScope,
  type TokenVerifier,
  UnauthorizedError,
  unauthorized,
  wwwAuthenticateHeader,
} from "../src/index.ts";

const RESOURCE = "https://api.example.com";
const RM = "https://api.example.com/.well-known/oauth-protected-resource";

function verifierFor(claims: Partial<AccessTokenClaims>): TokenVerifier {
  return {
    async verify(token: string): Promise<AccessTokenClaims> {
      if (token === "bad") {
        throw new Error("invalid");
      }
      return {
        sub: "user-1",
        token_use: "access",
        client_id: "client-1",
        iss: "https://cognito.example.com",
        exp: 9999999999,
        scope: `${RESOURCE}/sessions:read ${RESOURCE}/sessions:write`,
        ...claims,
      };
    },
  };
}

function cfg(verifier: TokenVerifier, over: Partial<AuthenticateConfig> = {}): AuthenticateConfig {
  return {
    verifier,
    allowedClientIds: ["client-1"],
    resourceIdentifier: RESOURCE,
    now: () => 1_000_000,
    ...over,
  };
}

const req = (auth?: string) => ({ headers: auth ? { authorization: auth } : {} });

describe("authenticate()", () => {
  it("returns a Principal for a valid token with resource-bound scopes", async () => {
    const p = await authenticate(req("Bearer good"), cfg(verifierFor({})), RM);
    expect(p).toEqual<Principal>({
      sub: "user-1",
      clientId: "client-1",
      scopes: ["sessions:read", "sessions:write"],
    });
  });

  it("throws 401 when no bearer token is present", async () => {
    await expect(authenticate(req(), cfg(verifierFor({})), RM)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it("throws 401 when verification fails", async () => {
    await expect(authenticate(req("Bearer bad"), cfg(verifierFor({})), RM)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it("throws 401 when token_use is not access", async () => {
    await expect(
      authenticate(req("Bearer good"), cfg(verifierFor({ token_use: "id" })), RM),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("throws 401 when expired", async () => {
    await expect(
      authenticate(req("Bearer good"), cfg(verifierFor({ exp: 1 })), RM),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("throws 401 when client_id is not allowed", async () => {
    await expect(
      authenticate(req("Bearer good"), cfg(verifierFor({ client_id: "rogue" })), RM),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("throws 403 insufficient_scope when the token is not resource-bound (RFC 8707)", async () => {
    await expect(
      authenticate(
        req("Bearer good"),
        cfg(verifierFor({ scope: "sessions:read", aud: "other" })),
        RM,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("accepts an explicit aud resource binding (RFC 8707)", async () => {
    const p = await authenticate(
      req("Bearer good"),
      cfg(verifierFor({ scope: "sessions:read", aud: RESOURCE })),
      RM,
    );
    expect(p.scopes).toEqual(["sessions:read"]);
  });
});

describe("401/403 header + body helpers", () => {
  it("builds the exact WWW-Authenticate header for a 401", () => {
    const err = unauthorized(RM, `${RESOURCE}/sessions:read`);
    const header = wwwAuthenticateHeader(err.challenge);
    expect(header).toBe(`Bearer resource_metadata="${RM}", scope="${RESOURCE}/sessions:read"`);
  });

  it("builds an insufficient_scope 403 with the needed scope", () => {
    const err = insufficientScope("sessions:write");
    expect(err.status).toBe(403);
    expect(err.neededScope).toBe("sessions:write");
  });
});

describe("authorize(): scope-per-action mapping", () => {
  const reader: Principal = { sub: "u1", clientId: "c", scopes: ["sessions:read"] };
  const writer: Principal = { sub: "u1", clientId: "c", scopes: ["sessions:write"] };
  const deleter: Principal = { sub: "u1", clientId: "c", scopes: ["sessions:delete"] };

  it("maps each action to its required scope", () => {
    expect(requiredScope("read")).toBe("sessions:read");
    expect(requiredScope("launch")).toBe("sessions:write");
    expect(requiredScope("prompt")).toBe("sessions:write");
    expect(requiredScope("steer")).toBe("sessions:write");
    expect(requiredScope("cancel")).toBe("sessions:write");
    expect(requiredScope("config")).toBe("sessions:write");
    expect(requiredScope("answerPermission")).toBe("sessions:write");
    expect(requiredScope("delete")).toBe("sessions:delete");
  });

  it("allows read with sessions:read", () => {
    expect(() => authorize(reader, "read")).not.toThrow();
  });

  it("denies launch without sessions:write", () => {
    expect(() => authorize(reader, "launch")).toThrow(ForbiddenError);
  });

  it("allows write actions with sessions:write", () => {
    for (const a of [
      "launch",
      "prompt",
      "steer",
      "cancel",
      "config",
      "answerPermission",
    ] as const) {
      expect(() => authorize(writer, a)).not.toThrow();
    }
  });

  it("requires sessions:delete for delete", () => {
    expect(() => authorize(writer, "delete")).toThrow(ForbiddenError);
    expect(() => authorize(deleter, "delete")).not.toThrow();
  });
});

describe("authorize(): per-owner visibility", () => {
  const owner: Principal = { sub: "owner", clientId: "c", scopes: ["sessions:read"] };

  it("allows the owner to read their own session", () => {
    expect(() => authorize(owner, "read", { createdBy: "owner" })).not.toThrow();
  });

  it("denies cross-user access", () => {
    expect(() => authorize(owner, "read", { createdBy: "someone-else" })).toThrow(ForbiddenError);
  });
});
