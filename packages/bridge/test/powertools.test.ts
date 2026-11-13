/**
 * The bridge logger and metrics are backed by Powertools. These tests pin that
 * every record still passes through core's redact(), that logs stay off
 * stdout (ACP's channel), and that metrics leave as CloudWatch EMF.
 */

import { Metrics as PowertoolsMetrics } from "@aws-lambda-powertools/metrics";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createLogger } from "../src/logger.ts";
import { Metrics, powertoolsMetricSink } from "../src/metrics.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Powertools-backed logger", () => {
  test("emits Powertools-shaped records and redacts keys and values", () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l), env: {} });
    logger.error("boom ksk_live_deadbeefcafef00d", {
      authorization: "Bearer secret-token-value",
      url: "https://auth.example.com/oauth2/callback?code=abc123&state=xyz",
      err: new Error("failed with ksk_live_deadbeefcafef00d"),
    });
    const out = lines.join("\n");
    expect(out).not.toContain("secret-token-value");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("ksk_live_deadbeefcafef00d");
    expect(out).toContain("[REDACTED]");
    const rec = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(rec.level).toBe("ERROR");
    expect(rec.service).toBe("kiro-remote-bridge");
  });

  test("the default sink writes to stderr and never to stdout", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    createLogger({ env: {} }).info("hello");
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledTimes(1);
  });

  test("child bindings are persisted and redacted", () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l), env: {} }).child({
      token: "ghs_16C7e42F292c6912E7710c838347Ae178B4a",
      sessionId: "s1",
    });
    logger.info("x");
    const rec = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(rec.sessionId).toBe("s1");
    expect(lines[0]).not.toContain("ghs_16C7");
  });
});

describe("Powertools-backed metric sink", () => {
  test("buffers plain counts and publishes EMF on flush; dimensioned counts keep their own dimensions", () => {
    vi.stubEnv("POWERTOOLS_DEV", "true");
    vi.stubEnv("POWERTOOLS_METRICS_DISABLED", "false");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const metrics = new Metrics(
      powertoolsMetricSink(
        new PowertoolsMetrics({ namespace: "KiroRemote", serviceName: "kiro-remote-bridge" }),
      ),
    );
    metrics.count("EventsWritten", 3);
    metrics.count("LaunchPath", 1, { path: "engine" });
    // The dimensioned datum is emitted immediately, the plain one only on flush.
    expect(log).toHaveBeenCalledTimes(1);
    metrics.flush();
    expect(log).toHaveBeenCalledTimes(2);
    metrics.flush(); // nothing buffered: no empty blob
    expect(log).toHaveBeenCalledTimes(2);

    const emitted = log.mock.calls.map((c) => JSON.parse(String(c[0])));
    const launch = emitted.find((e) => e.LaunchPath !== undefined);
    expect(launch._aws.CloudWatchMetrics[0].Namespace).toBe("KiroRemote");
    expect(launch.path).toBe("engine");
    expect(launch.service).toBe("kiro-remote-bridge");
    const written = emitted.find((e) => e.EventsWritten !== undefined);
    expect(written.EventsWritten).toBe(3);
    vi.unstubAllEnvs();
  });
});
