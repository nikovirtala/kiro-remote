import { describe, expect, it } from "vitest";
import { recordDerivedArtifacts } from "./derived.ts";
import { Report } from "./report.ts";

function derivedOf(id: string) {
  const report = new Report({ ok: true });
  recordDerivedArtifacts(report);
  const built = report.build();
  return built.derived.find((d) => d.id === id);
}

describe("derived artifacts", () => {
  it("lists exactly the 14 MCP tools from the static registry in order", () => {
    const tools = derivedOf("mcp_tool_list");
    expect(tools).toBeDefined();
    const value = tools?.value as { count: number; tools: { name: string }[] };
    expect(value.count).toBe(14);
    expect(value.tools.map((t) => t.name)).toEqual([
      "kiro_capabilities",
      "kiro_list_models",
      "kiro_launch_session",
      "kiro_list_sessions",
      "kiro_adopt_session",
      "kiro_get_session",
      "kiro_send_prompt",
      "kiro_wait_for_events",
      "kiro_get_transcript",
      "kiro_list_permissions",
      "kiro_answer_permission",
      "kiro_set_config",
      "kiro_cancel_turn",
      "kiro_delete_session",
    ]);
    // Clearly labelled as NOT from a live Kiro run.
    expect(tools?.source).toContain("NOT from a live Kiro run");
  });

  it("labels the capability matrix as the fake-harness advertisement", () => {
    const caps = derivedOf("capability_matrix");
    expect(caps).toBeDefined();
    expect(caps?.source).toContain("FAKE-ACP harness");
    expect(caps?.source).toContain("NOT a live Kiro initialize result");
    const value = caps?.value as {
      capabilityMatrix: { executionTargets: string[]; models: string[] };
    };
    // Derived from the real capabilities() over the fake advertisement.
    expect(value.capabilityMatrix.executionTargets).toContain("cloud");
    expect(value.capabilityMatrix.models).toContain("claude-sonnet");
  });

  it("records the launch-path selection rule (acp vs headless)", () => {
    const rule = derivedOf("launch_path_rule");
    expect(rule).toBeDefined();
    const value = rule?.value as { rule: string };
    expect(value.rule).toContain("cloud execution target");
    expect(value.rule).toContain("path = 'acp'");
    expect(value.rule).toContain("headless");
  });

  it("records the RFC 8707 audience binding", () => {
    const binding = derivedOf("audience_binding");
    expect(binding).toBeDefined();
    const value = binding?.value as { resource: string };
    expect(value.resource).toContain("https://<host>/mcp");
    expect(value.resource).toContain("RFC 8707");
  });
});
