import { describe, expect, it } from "vitest";
import { makeScrubber, Report } from "./report.ts";

describe("Report redaction", () => {
  it("scrubs a ksk_ API key that leaks into a captured value", () => {
    const report = new Report({ ok: true });
    report.pass("launch", "launch", { leaked: "ksk_abc123SECRETkeyvalue" });
    const json = JSON.stringify(report.build());
    expect(json).not.toContain("ksk_abc123SECRETkeyvalue");
    expect(json).toContain("[REDACTED]");
  });

  it("scrubs bearer tokens, OAuth codes, and OAuth URLs in failure reasons", () => {
    const report = new Report({ ok: true });
    report.fail(
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
    report.pass("x", "x", { access_token: "topsecret", refresh_token: "alsosecret" });
    const json = JSON.stringify(report.build());
    expect(json).not.toContain("topsecret");
    expect(json).not.toContain("alsosecret");
  });

  it("scrubs the literal repo from captured values and reasons", () => {
    const report = new Report({ ok: true }, { literalSecrets: ["acme/secret-repo", ""] });
    report.pass("a", "a", { nested: { note: "launched on acme/secret-repo" } });
    report.fail("b", "b", "repo acme/secret-repo is not allowed");
    report.skip("c", "c", "acme/secret-repo missing");
    const json = JSON.stringify(report.build());
    expect(json).not.toContain("acme/secret-repo");
    expect(json).toContain("launched on [REDACTED]");
  });

  it("makeScrubber applies core redact before the literals", () => {
    const scrub = makeScrubber(["owner/repo"]);
    expect(scrub("ksk_abcdef owner/repo")).toBe("[REDACTED] [REDACTED]");
  });
});

describe("Report.exitCode", () => {
  it("is 0 only when every recorded step passed", () => {
    const report = new Report({});
    report.pass("a", "a");
    report.pass("b", "b");
    expect(report.exitCode).toBe(0);
  });

  it("is 1 when any step failed, even with skips", () => {
    const report = new Report({});
    report.pass("a", "a");
    report.skip("b", "b", "no host");
    report.fail("c", "c", "boom");
    expect(report.exitCode).toBe(1);
  });

  it("is 2 when nothing failed but a step was skipped, or nothing was recorded", () => {
    const report = new Report({});
    expect(report.exitCode).toBe(2);
    report.pass("a", "a");
    report.skip("b", "b", "no host");
    expect(report.exitCode).toBe(2);
  });

  it("records status, reason, and duration in build()", () => {
    const report = new Report({});
    report.fail("login", "login", "no browser", 12);
    report.skip("launch", "launch", "skipped because login did not pass.");
    const built = report.build();
    expect(built.steps[0]).toEqual({
      id: "login",
      name: "login",
      status: "failed",
      reason: "no browser",
      durationMs: 12,
    });
    expect(built.steps[1].status).toBe("skipped");
    expect(report.statusOf("login")).toBe("failed");
  });
});
