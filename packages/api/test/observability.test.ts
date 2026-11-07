import { Logger } from "@aws-lambda-powertools/logger";
import { describe, expect, test, vi } from "vitest";
import { PowertoolsObservability } from "../src/observability.ts";

/**
 * The error() path is the diagnostic surface for unexpected 500s, so it MUST
 * scrub any secret an exception carries before anything reaches CloudWatch.
 * These tests pin that behaviour: the attributes handed to the underlying
 * logger are always redacted, and a thrown Error is normalized to
 * `{ name, message, stack }` (whose message/stack are otherwise non-enumerable
 * and would be silently dropped by redact()).
 */
describe("PowertoolsObservability.error", () => {
  test("redacts secrets in the structured attributes", () => {
    const logger = new Logger({ serviceName: "test" });
    const spy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const obs = new PowertoolsObservability({ logger });

    obs.error("unhandled_error", {
      authorization: "Bearer secret-token-value",
      callbackUrl: "https://auth.example.com/oauth2/callback?code=abc123&state=xyz",
      apiKey: "ksk_live_deadbeefcafef00d",
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(spy.mock.calls[0][1]);
    expect(logged).not.toContain("secret-token-value");
    expect(logged).not.toContain("abc123");
    expect(logged).not.toContain("ksk_live_deadbeefcafef00d");
    expect(logged).toContain("[REDACTED]");
  });

  test("normalizes a thrown Error and redacts secrets in its message and stack", () => {
    const logger = new Logger({ serviceName: "test" });
    const spy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const obs = new PowertoolsObservability({ logger });

    const err = new Error("token exchange failed: ksk_live_deadbeefcafef00d");
    err.name = "TokenExchangeError";
    obs.error("unhandled_error", { err, path: "/oauth/callback", method: "GET" });

    expect(spy).toHaveBeenCalledTimes(1);
    const attrs = spy.mock.calls[0][1] as { err: Record<string, unknown> };
    // The Error became a plain object with its (otherwise non-enumerable) fields.
    expect(attrs.err.name).toBe("TokenExchangeError");
    expect(typeof attrs.err.message).toBe("string");
    expect(typeof attrs.err.stack).toBe("string");
    // The secret in the message is scrubbed.
    expect(attrs.err.message).not.toContain("ksk_live_deadbeefcafef00d");
    expect(String(attrs.err.message)).toContain("[REDACTED]");
    expect(String(attrs.err.stack)).not.toContain("ksk_live_deadbeefcafef00d");
  });

  test("normalizes a non-Error thrown value", () => {
    const logger = new Logger({ serviceName: "test" });
    const spy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const obs = new PowertoolsObservability({ logger });

    obs.error("unhandled_error", { err: "plain string failure" });

    const attrs = spy.mock.calls[0][1] as { err: Record<string, unknown> };
    expect(attrs.err.value).toBe("plain string failure");
  });
});
