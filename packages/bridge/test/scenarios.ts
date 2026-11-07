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

/** A standard four-option permission request for a shell tool call. */
export const SHELL_PERMISSION_PARAMS = {
  toolCall: { toolCallId: "call-1", title: "Run tests", status: "pending" },
  options: [
    { optionId: "accept", name: "Allow", kind: "allow_once" },
    { optionId: "always-accept", name: "Always allow", kind: "allow_always" },
    { optionId: "reject", name: "Deny", kind: "reject_once" },
    { optionId: "always-reject", name: "Always deny", kind: "reject_always" },
  ],
  requestId: "perm-1",
  _meta: {
    kiro: {
      consent: {
        capability: "shell",
        resource: "npm run test",
        workspaceRoot: "/workspace/project",
        persistableConsent: true,
      },
    },
  },
};
