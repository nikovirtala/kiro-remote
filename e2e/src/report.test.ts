import { describe, expect, it } from "vitest";
import { Report } from "./report.ts";

describe("Report redaction", () => {
  it("scrubs a ksk_ API key that leaks into a captured value", () => {
    const report = new Report({ ok: true });
    // Simulate a buggy caller that accidentally captures a secret.
    report.ran("launch", "launch", { leaked: "ksk_abc123SECRETkeyvalue" });
    const built = report.build();
    const json = JSON.stringify(built);
    expect(json).not.toContain("ksk_abc123SECRETkeyvalue");
    expect(json).toContain("[REDACTED]");
  });

  it("scrubs bearer tokens, OAuth codes, and OAuth URLs in blocked reasons", () => {
    const report = new Report({ ok: true });
    report.blocked(
      "login",
      "login",
      "failed with Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payloadpart.sigpart at https://host/oauth/authorize?code=secretcode&state=x",
    );
    const json = JSON.stringify(report.build());
    expect(json).not.toContain("secretcode");
    expect(json).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(json).not.toContain("oauth/authorize");
    expect(json).toContain("[REDACTED]");
  });

  it("scrubs sensitive-keyed fields wholesale", () => {
    const report = new Report({ ok: true });
    report.derive("x", "test", { access_token: "topsecret", refresh_token: "alsosecret" });
    const json = JSON.stringify(report.build());
    expect(json).not.toContain("topsecret");
    expect(json).not.toContain("alsosecret");
  });

  it("tracks whether any step ran", () => {
    const report = new Report({ ok: true });
    expect(report.anyRan).toBe(false);
    report.blocked("a", "a", "no host");
    expect(report.anyRan).toBe(false);
    report.ran("b", "b");
    expect(report.anyRan).toBe(true);
  });

  it("records step status and reasons in build()", () => {
    const report = new Report({ ok: true });
    report.blocked("login", "kiro-remote login", "kiro-cli not installed");
    report.skipped("launch", "launch", "depends on login");
    const built = report.build();
    const login = built.steps.find((s) => s.id === "login");
    expect(login?.status).toBe("blocked");
    expect(login?.reason).toContain("kiro-cli not installed");
    expect(built.steps.find((s) => s.id === "launch")?.status).toBe("skipped");
  });
});
