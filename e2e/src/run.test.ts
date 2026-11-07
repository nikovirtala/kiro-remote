import { describe, expect, it } from "vitest";
import type { PreflightProbes } from "./preflight.ts";
import { runHarness } from "./run.ts";

const noBinaries: PreflightProbes = { which: async () => null };
const allBinaries: PreflightProbes = { which: async (b) => `/usr/bin/${b}` };

/** The 10 CLI-driven + 2 Inspector + 1 connector steps, in order. */
const EXPECTED_STEP_IDS = [
  "login",
  "launch",
  "poll",
  "followup",
  "steer",
  "change-model",
  "answer-permission",
  "cancel",
  "adopt",
  "delete",
  "inspector-stdio",
  "inspector-http",
  "claude-connector",
];

describe("runHarness", () => {
  it("runs every step in order and blocks them all when nothing is available", async () => {
    const { report, anyLiveStepRan } = await runHarness({
      env: { KIRO_API_KEY: "ksk_secret", KIRO_API_E2E_REPO: "owner/repo" },
      probes: noBinaries,
    });
    expect(report.steps.map((s) => s.id)).toEqual(EXPECTED_STEP_IDS);
    // Every live step is blocked; none ran; none fabricated.
    expect(report.steps.every((s) => s.status === "blocked")).toBe(true);
    expect(anyLiveStepRan).toBe(false);
    // Each blocked step carries a non-empty, precise reason.
    for (const step of report.steps) {
      expect(step.reason?.length).toBeGreaterThan(10);
    }
  });

  it("never leaks the API key or repo into the report, even when present", async () => {
    const { report } = await runHarness({
      env: { KIRO_API_KEY: "ksk_leakcheck123", KIRO_API_E2E_REPO: "secret-owner/secret-repo" },
      probes: noBinaries,
    });
    const json = JSON.stringify(report);
    expect(json).not.toContain("ksk_leakcheck123");
    expect(json).not.toContain("secret-owner/secret-repo");
    // Presence booleans are surfaced instead.
    expect(report.config.kiroApiKeyPresent).toBe(true);
    expect(report.config.e2eRepoPresent).toBe(true);
  });

  it("records the login blocker as kiro-cli + no-host when both are absent", async () => {
    const { report } = await runHarness({ env: {}, probes: noBinaries });
    const login = report.steps.find((s) => s.id === "login");
    expect(login?.status).toBe("blocked");
    expect(login?.reason).toContain("KIRO_REMOTE_URL is unset");
  });

  it("blocks login on kiro-cli even when a host is configured", async () => {
    const { report } = await runHarness({
      env: { KIRO_REMOTE_URL: "https://host.example.com" },
      probes: noBinaries,
    });
    const login = report.steps.find((s) => s.id === "login");
    expect(login?.reason).toContain("kiro-cli` is not installed");
  });

  it("always includes the four derived artifacts regardless of blockers", async () => {
    const { report } = await runHarness({ env: {}, probes: noBinaries });
    expect(report.derived.map((d) => d.id).sort()).toEqual([
      "audience_binding",
      "capability_matrix",
      "launch_path_rule",
      "mcp_tool_list",
    ]);
  });

  it("the claude.ai connector step is blocked as manual even with a host and binaries", async () => {
    const { report } = await runHarness({
      env: { KIRO_REMOTE_URL: "https://host.example.com" },
      probes: allBinaries,
    });
    const connector = report.steps.find((s) => s.id === "claude-connector");
    expect(connector?.status).toBe("blocked");
    expect(connector?.reason).toContain("manual");
  });
});
