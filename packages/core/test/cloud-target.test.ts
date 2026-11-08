import { describe, expect, it } from "vitest";
import { capabilities, resolveCloudTarget } from "../src/index.ts";

/**
 * resolveCloudTarget selects the cloud execution target + remote session source
 * to request on session/new so the agent provisions a real cloud Space (visible
 * in app.kiro.dev) instead of defaulting to source='local' (FEAT-002).
 *
 * The exact ACP V3 session/new wire shape is NOT observable in-sandbox, so the
 * resolver is STRING-DRIVEN off the advertisement (confirmed on live redeploy
 * via the redacted raw-RPC logs). These tests pin the selection rules.
 */
describe("resolveCloudTarget", () => {
  it("picks cloud-sandbox + remote from the live-shaped advertisement", () => {
    const caps = capabilities({
      agentCapabilities: {
        _meta: {
          kiro: {
            executionTargets: ["local", "cloud-sandbox"],
            sessionSources: ["local", "remote"],
          },
        },
      },
    });
    const resolved = resolveCloudTarget(caps);
    expect(resolved.executionTarget).toBe("cloud-sandbox");
    expect(resolved.sessionSource).toBe("remote");
  });

  it("prefers the exact 'cloud-sandbox' / 'remote' over other matching entries", () => {
    const caps = capabilities({
      agentCapabilities: {
        _meta: {
          kiro: {
            // "cloudy" matches /cloud/i but the exact preferred string wins.
            executionTargets: ["cloudy", "cloud-sandbox"],
            sessionSources: ["remote-cloud", "remote"],
          },
        },
      },
    });
    const resolved = resolveCloudTarget(caps);
    expect(resolved.executionTarget).toBe("cloud-sandbox");
    expect(resolved.sessionSource).toBe("remote");
  });

  it("falls back to the first /cloud|remote/ match when no exact preferred string", () => {
    const caps = capabilities({
      agentCapabilities: {
        _meta: {
          kiro: {
            executionTargets: ["local", "remote-exec"],
            sessionSources: ["local", "cloud-src"],
          },
        },
      },
    });
    const resolved = resolveCloudTarget(caps);
    expect(resolved.executionTarget).toBe("remote-exec");
    expect(resolved.sessionSource).toBe("cloud-src");
  });

  it("honors explicit overrides over the advertisement", () => {
    const caps = capabilities({
      agentCapabilities: {
        _meta: {
          kiro: {
            executionTargets: ["local", "cloud-sandbox"],
            sessionSources: ["local", "remote"],
          },
        },
      },
    });
    const resolved = resolveCloudTarget(caps, {
      executionTarget: "cloud-vm",
      sessionSource: "cloud",
    });
    expect(resolved.executionTarget).toBe("cloud-vm");
    expect(resolved.sessionSource).toBe("cloud");
  });

  it("uses an override even when the advertisement has nothing suitable", () => {
    const caps = capabilities({
      agentCapabilities: {
        _meta: { kiro: { executionTargets: ["local"], sessionSources: ["local"] } },
      },
    });
    const resolved = resolveCloudTarget(caps, { executionTarget: "cloud-sandbox" });
    expect(resolved.executionTarget).toBe("cloud-sandbox");
    // No session-source override and none advertised -> null.
    expect(resolved.sessionSource).toBeNull();
  });

  it("returns null/null for a purely-local advertisement", () => {
    const caps = capabilities({
      agentCapabilities: {
        _meta: { kiro: { executionTargets: ["local"], sessionSources: ["local"] } },
      },
    });
    const resolved = resolveCloudTarget(caps);
    expect(resolved.executionTarget).toBeNull();
    expect(resolved.sessionSource).toBeNull();
  });

  it("resolves a remote session source even when no cloud execution target is advertised", () => {
    const caps = capabilities({
      agentCapabilities: {
        _meta: { kiro: { executionTargets: [], sessionSources: ["local", "remote"] } },
      },
    });
    const resolved = resolveCloudTarget(caps);
    expect(resolved.executionTarget).toBeNull();
    expect(resolved.sessionSource).toBe("remote");
  });
});
