import { describe, expect, it } from "vitest";
import { capabilities, hasExtensionMethod, kiroCliVersion, supportsModel } from "../src/index.ts";

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

  it("derives listScopes from the real kiro.sessionListScopes key", () => {
    const caps = capabilities({
      agentCapabilities: {
        _meta: { kiro: { sessionListScopes: ["workspace", "user"] } },
      },
    });
    expect(caps.listScopes).toEqual(["workspace", "user"]);
  });

  it("falls back to legacy kiro.listScopes when sessionListScopes is absent", () => {
    const caps = capabilities({
      agentCapabilities: {
        _meta: { kiro: { listScopes: ["account"] } },
      },
    });
    expect(caps.listScopes).toEqual(["account"]);
  });
});

describe("capabilities() cloudExecution derivation", () => {
  it("is true when an execution target is literally 'cloud'", () => {
    const caps = capabilities({
      agentCapabilities: { _meta: { kiro: { executionTargets: ["cloud"] } } },
    });
    expect(caps.cloudExecution).toBe(true);
  });

  it("is true when executionTargets are empty but a sessionSource is 'remote'", () => {
    const caps = capabilities({
      agentCapabilities: {
        _meta: { kiro: { executionTargets: [], sessionSources: ["remote", "local"] } },
      },
    });
    expect(caps.executionTargets).toEqual([]);
    expect(caps.cloudExecution).toBe(true);
  });

  it("is true when executionTargets are empty but a cloud/remote extensionMethod is present", () => {
    const caps = capabilities({
      agentCapabilities: {
        _meta: {
          kiro: { executionTargets: [], extensionMethods: ["_kiro/cloud/session/launch"] },
        },
      },
    });
    expect(caps.cloudExecution).toBe(true);
  });

  it("is true when a listScope matches cloud/remote", () => {
    const caps = capabilities({
      agentCapabilities: { _meta: { kiro: { executionTargets: [], listScopes: ["cloud"] } } },
    });
    expect(caps.cloudExecution).toBe(true);
  });

  it("is NOT a cloud signal when a listScope is only 'account' (no other signal)", () => {
    // A purely-local agent may advertise an `account`-scoped listing; on its
    // own that must not be mistaken for cloud execution and route to ACP.
    const caps = capabilities({
      agentCapabilities: {
        _meta: {
          kiro: {
            executionTargets: [],
            sessionSources: ["local"],
            listScopes: ["account"],
            extensionMethods: ["_session/steer"],
          },
        },
      },
    });
    expect(caps.listScopes).toEqual(["account"]);
    expect(caps.cloudExecution).toBe(false);
  });

  it("normalizes object-shaped executionTargets to string[] and derives cloud", () => {
    const caps = capabilities({
      agentCapabilities: {
        _meta: {
          kiro: {
            executionTargets: [{ id: "cloud" }, { name: "local" }, { target: "remote" }],
          },
        },
      },
    });
    expect(caps.executionTargets).toEqual(["cloud", "local", "remote"]);
    expect(caps.cloudExecution).toBe(true);
  });

  it("reads a top-level executionTargets when the kiro key is absent", () => {
    const caps = capabilities({ executionTargets: ["cloud"] });
    expect(caps.executionTargets).toEqual(["cloud"]);
    expect(caps.cloudExecution).toBe(true);
  });

  it("is NOT a cloud signal when sessionListScopes is only workspace/user", () => {
    // The real agent advertises sessionListScopes ['workspace','user']; neither
    // entry matches /cloud|remote/, so on its own it must not flip cloudExecution.
    const caps = capabilities({
      agentCapabilities: {
        _meta: {
          kiro: {
            executionTargets: [],
            sessionSources: ["local"],
            sessionListScopes: ["workspace", "user"],
            extensionMethods: ["_session/steer"],
          },
        },
      },
    });
    expect(caps.listScopes).toEqual(["workspace", "user"]);
    expect(caps.cloudExecution).toBe(false);
  });

  it("is false for a purely-local advertisement", () => {
    const caps = capabilities({
      agentCapabilities: {
        _meta: {
          kiro: {
            executionTargets: ["local"],
            sessionSources: ["local"],
            listScopes: ["local"],
            extensionMethods: ["_session/steer"],
          },
        },
      },
    });
    expect(caps.cloudExecution).toBe(false);
  });
});

describe("kiroCliVersion()", () => {
  it("returns agentInfo.version, trimmed", () => {
    expect(kiroCliVersion({ agentInfo: { name: "kiro-cli", version: " 1.2.3 " } })).toBe("1.2.3");
  });

  it("returns null when no version is known", () => {
    expect(kiroCliVersion(undefined)).toBeNull();
    expect(kiroCliVersion(null)).toBeNull();
    expect(kiroCliVersion({})).toBeNull();
    expect(kiroCliVersion({ agentInfo: {} })).toBeNull();
    expect(kiroCliVersion({ agentInfo: { version: "  " } })).toBeNull();
    expect(kiroCliVersion({ agentInfo: { version: 3 } })).toBeNull();
  });
});
