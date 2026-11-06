import { describe, expect, it } from "vitest";
import { REDACTED, redact, redactString } from "../src/index.ts";

describe("redaction", () => {
  it("scrubs ksk_ API keys", () => {
    const out = redactString("key is ksk_abc123DEF.ghi-jkl now");
    expect(out).not.toContain("ksk_abc123DEF");
    expect(out).toContain(REDACTED);
  });

  it("scrubs bearer tokens", () => {
    const out = redactString("Authorization: Bearer abc.def.ghi");
    expect(out).toContain(`Bearer ${REDACTED}`);
    expect(out).not.toContain("abc.def.ghi");
  });

  it("scrubs JWT-looking strings", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sig-value";
    expect(redactString(jwt)).toBe(REDACTED);
  });

  it("scrubs OAuth URLs (authorize/callback/token)", () => {
    expect(redactString("go to https://auth.example.com/oauth2/authorize?x=1")).toBe(
      `go to ${REDACTED}`,
    );
    expect(redactString("https://host/callback?code=secret")).toBe(REDACTED);
    expect(redactString("https://host/oauth2/token")).toBe(REDACTED);
  });

  it("scrubs URLs carrying a sensitive query parameter", () => {
    expect(redactString("https://example.com/x?code=abc&state=y")).toBe(REDACTED);
    expect(redactString("https://example.com/y?code_verifier=zzz")).toBe(REDACTED);
  });

  it("scrubs sensitive object fields wholesale", () => {
    const out = redact({
      authorization: "Bearer xyz",
      refresh_token: "rt-123",
      code_verifier: "cv-456",
      code: "auth-code-789",
      nested: { access_token: "at-000", keep: "visible" },
    }) as Record<string, unknown>;
    expect(out.authorization).toBe(REDACTED);
    expect(out.refresh_token).toBe(REDACTED);
    expect(out.code_verifier).toBe(REDACTED);
    expect(out.code).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).access_token).toBe(REDACTED);
    expect((out.nested as Record<string, unknown>).keep).toBe("visible");
  });

  it("scrubs secrets embedded in free-form string fields", () => {
    const out = redact({ msg: "using ksk_topsecret value" }) as Record<string, string>;
    expect(out.msg).not.toContain("ksk_topsecret");
  });

  it("does not mutate the input and handles arrays and cycles", () => {
    const input: Record<string, unknown> = { arr: ["ksk_a", "plain"] };
    input.self = input;
    const out = redact(input) as Record<string, unknown>;
    expect((input.arr as string[])[0]).toBe("ksk_a");
    expect((out.arr as string[])[0]).toBe(REDACTED);
    expect(out.self).toBe("[Circular]");
  });
});
