/**
 * Scenario builders for the fake ACP agent. A scenario fully determines what
 * the fake agent advertises and replays, so each test asserts one behavior.
 */

export interface InitAdvertisement {
  extensionMethods?: string[];
  executionTargets?: string[];
  sessionSources?: string[];
  listScopes?: string[];
  configOptions?: { configId: string; values: string[] }[];
  modes?: { modeId: string; name?: string }[];
  replayMarking?: boolean;
}

/** A full-featured initialize result (cloud target, model/effort options, modes). */
export function initResult(adv: InitAdvertisement = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    agentCapabilities: {
      _meta: {
        kiro: {
          extensionMethods: adv.extensionMethods ?? [
            "_kiro/openExternalUrl",
            "_kiro/mcp/status",
            "_kiro/session/context",
          ],
          executionTargets: adv.executionTargets ?? ["cloud", "local"],
          sessionSources: adv.sessionSources ?? ["remote", "local"],
          listScopes: adv.listScopes ?? ["cloud"],
          replayMarking: adv.replayMarking ?? true,
        },
      },
    },
    configOptions: adv.configOptions ?? [
      { configId: "model", values: ["claude-sonnet", "claude-haiku"] },
      { configId: "effortLevel", values: ["low", "high"] },
    ],
    modes: adv.modes ?? [
      { modeId: "vibe", name: "Vibe" },
      { modeId: "planner", name: "Planner" },
    ],
  };
}
