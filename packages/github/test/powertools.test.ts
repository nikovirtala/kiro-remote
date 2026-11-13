/** The GitHub logger and metrics are backed by Powertools; redaction and EMF output are pinned here. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, powertoolsMetrics } from "../src/log.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Powertools-backed logger", () => {
  it("emits Powertools-shaped records with every value redacted", () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l));
    log.warn("webhook_odd", {
      authorization: "Bearer ghs_16C7e42F292c6912E7710c838347Ae178B4a",
      error: new Error("failed with ghs_16C7e42F292c6912E7710c838347Ae178B4a"),
    });
    expect(lines[0]).not.toContain("ghs_16C7");
    const rec = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(rec.level).toBe("WARN");
    expect(rec.message).toBe("webhook_odd");
    expect(rec.service).toBe("kiro-remote-github");
  });
});

describe("Powertools-backed metrics", () => {
  it("publishes EMF in the KiroRemote/GitHub namespace on flush", () => {
    vi.stubEnv("POWERTOOLS_DEV", "true");
    vi.stubEnv("POWERTOOLS_METRICS_DISABLED", "false");
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const m = powertoolsMetrics();
    m.count("WebhooksReceived");
    m.count("LinksRejected", 1, { reason: "untrusted" });
    m.flush();
    m.flush();
    const emitted = out.mock.calls.map((c) => JSON.parse(String(c[0])));
    expect(emitted).toHaveLength(2);
    const received = emitted.find((e) => e.WebhooksReceived !== undefined);
    expect(received._aws.CloudWatchMetrics[0].Namespace).toBe("KiroRemote/GitHub");
    expect(received.WebhooksReceived).toBe(1);
    const rejected = emitted.find((e) => e.LinksRejected !== undefined);
    expect(rejected.reason).toBe("untrusted");
  });
});
