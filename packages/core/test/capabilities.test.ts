import { describe, expect, it } from "vitest";
import { capabilities, hasExtensionMethod, supportsModel } from "../src/index.ts";

const fullInit = {
  agentCapabilities: {
    _meta: {
      kiro: {
        extensionMethods: ["_kiro/session/context", "_kiro/session/compact", "_session/steer"],
        sessionSources: ["local", "remote"],
        listScopes: ["account"],
        executionTargets: ["cloud"],
        replayMarking: true,
      },
    },
  },
  configOptions: [
    { configId: "model", values: ["claude-sonnet", "claude-opus"] },
    { configId: "effortLevel", values: ["low", "high"] },
  ],
  modes: [{ modeId: "vibe" }, { modeId: "planner" }],
};

describe("capabilities() derivation", () => {
  it("derives extension methods, models, and modes", () => {
    const caps = capabilities(fullInit);
    expect(caps.extensionMethods).toContain("_session/steer");
    expect(caps.models).toEqual(["claude-sonnet", "claude-opus"]);
    expect(caps.modes.map((m) => m.modeId)).toEqual(["vibe", "planner"]);
    expect(caps.replayMarking).toBe(true);
  });

  it("gates on advertised extension methods", () => {
    const caps = capabilities(fullInit);
    expect(hasExtensionMethod(caps, "_kiro/session/context")).toBe(true);
    expect(hasExtensionMethod(caps, "_kiro/session/terminate")).toBe(false);
  });

  it("gates correctly from a REDUCED extensionMethods advertisement", () => {
    const reduced = capabilities({
      agentCapabilities: { _meta: { kiro: { extensionMethods: ["_session/steer"] } } },
    });
    expect(hasExtensionMethod(reduced, "_session/steer")).toBe(true);
    // Methods present in the full deployment must NOT be assumed available.
    expect(hasExtensionMethod(reduced, "_kiro/session/context")).toBe(false);
    expect(hasExtensionMethod(reduced, "_kiro/session/compact")).toBe(false);
  });

  it("tolerates a missing advertisement with empty capabilities", () => {
    const caps = capabilities({});
    expect(caps.extensionMethods).toEqual([]);
    expect(caps.models).toEqual([]);
    expect(hasExtensionMethod(caps, "anything")).toBe(false);
  });

  it("supportsModel reflects the advertised model config option", () => {
    const caps = capabilities(fullInit);
    expect(supportsModel(caps, "claude-sonnet")).toBe(true);
    expect(supportsModel(caps, "gpt-4")).toBe(false);
  });
});
