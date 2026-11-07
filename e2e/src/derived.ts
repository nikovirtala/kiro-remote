/**
 * Artifacts that are producible WITHOUT a live Kiro run, assembled from the
 * code and the static registries. Each is clearly labelled with its `source`
 * so the PR cannot mistake it for the output of a real cloud session.
 *
 * These are NOT fabricated: they are read from the same code paths the running
 * system uses.
 *   - The MCP tool list is the static {@link toolListEntries} registry
 *     (FEAT-006's 14 tools) -- the identical list a live Inspector would show.
 *   - The capability matrix is {@link capabilities} applied to the fake-ACP
 *     harness's default initialize advertisement (FEAT-004 bridge tests). It is
 *     the FAKE-HARNESS advertisement, NOT a live Kiro initialize result.
 *   - The launch-path selection rule and the RFC 8707 audience binding are the
 *     exact rules the bridge (FEAT-004) and auth facade (FEAT-003) code apply.
 */

import { capabilities, type InitializeResult } from "@nikovirtala/kiro-remote-core";
import { toolListEntries } from "@nikovirtala/kiro-remote-mcp";
import type { Report } from "./report.ts";

/**
 * The fake ACP agent's DEFAULT initialize advertisement, reproduced from
 * packages/bridge/test/scenarios.ts `initResult()`. This is the fake harness's
 * advertisement used to drive the bridge integration tests -- it is NOT a live
 * Kiro initialize result.
 */
export const FAKE_HARNESS_INITIALIZE: InitializeResult = {
  protocolVersion: 1,
  agentCapabilities: {
    _meta: {
      kiro: {
        extensionMethods: ["_kiro/openExternalUrl", "_kiro/mcp/status", "_kiro/session/context"],
        executionTargets: ["cloud", "local"],
        sessionSources: ["remote", "local"],
        listScopes: ["cloud"],
        replayMarking: true,
      },
    },
  },
  configOptions: [
    { configId: "model", values: ["claude-sonnet", "claude-haiku"] },
    { configId: "effortLevel", values: ["low", "high"] },
  ],
  modes: [
    { modeId: "vibe", name: "Vibe" },
    { modeId: "planner", name: "Planner" },
  ],
};

/**
 * The launch-path SELECTION RULE the bridge applies (FEAT-004 session-manager).
 * This is the decision rule, not a live result.
 */
export const LAUNCH_PATH_RULE = {
  rule: "If the agent's initialize advertisement includes a cloud execution target (capabilities.executionTargets includes 'cloud'), the bridge launches over ACP via session/new targeting that cloud target (path = 'acp'). If NO cloud execution target is advertised, the bridge falls back to headless `kiro-cli chat --v3 --no-interactive --cloud --repo <repos> --output-format stream-json`, reads the cloud session id from the stream-json sessionUpdate/runFinished records, then session/load so all later interaction is over ACP (path = 'headless').",
  recordedInto: "session META + the LaunchPath metric {path: 'acp' | 'headless'}",
  underFakeHarness:
    "The fake-harness advertisement above advertises executionTargets ['cloud','local'], so the bridge integration tests exercise the 'acp' path; a reduced advertisement with no cloud target exercises the 'headless' fallback.",
};

/**
 * The RFC 8707 audience binding the auth facade uses (FEAT-003). This is the
 * binding rule the code applies, confirmed against the MCP 2026-07-28 spec.
 */
export const AUDIENCE_BINDING = {
  resource:
    "The canonical MCP resource URL mcpResource = https://<host>/mcp (RFC 9728 'resource' + RFC 8707 canonical server URI). /oauth/authorize requires the request's `resource` to equal mcpResource.",
  tokenValidation:
    "The resource server (core authenticate()) accepts a Cognito scope that startsWith(resourceIdentifier + '/') OR an explicit aud === resourceIdentifier, where resourceIdentifier = https://<host>/mcp (the Cognito resource-server identifier). Cognito emits scopes as '<identifier>/<scope>', e.g. 'https://<host>/mcp/sessions:read'.",
  issuerModel:
    "RFC 9207 issuer validation is CLIENT-side and binds to the AS-metadata issuer (https://<host>), which the facade also returns as iss in /oauth/callback -- those match. The access token's own iss (Cognito) is validated SEPARATELY by the resource server and is NOT required to equal the AS-metadata issuer (confirmed against MCP 2026-07-28 security-considerations). Cognito remains the ONLY token issuer; no token is minted or reshaped.",
};

/**
 * Emit all offline-derivable artifacts into the report, each labelled with its
 * source so it is never confused with a live-run artifact.
 */
export function recordDerivedArtifacts(report: Report): void {
  // 1. The 14 MCP tools from the static registry (what a live Inspector lists).
  const tools = toolListEntries().map((t) => ({
    name: t.name,
    description: t.description,
    annotations: t.annotations,
    inputSchema: t.inputSchema,
  }));
  report.derive(
    "mcp_tool_list",
    "static MCP tool registry (@nikovirtala/kiro-remote-mcp toolListEntries) -- the identical list a live MCP Inspector would show; NOT from a live Kiro run",
    { count: tools.length, tools },
  );

  // 2. The capability matrix derived from the FAKE-HARNESS advertisement.
  //    capabilities() returns the SAME configOption/mode object references that
  //    live in the initialize result, so the combined payload shares references
  //    between initializeResult and capabilityMatrix. A JSON round-trip fully
  //    duplicates every node (no shared references survive) so the redactor's
  //    circular guard does not mistake a shared reference for "[Circular]" --
  //    these are shared references, not actual cycles.
  const caps = capabilities(FAKE_HARNESS_INITIALIZE);
  const capabilityPayload = JSON.parse(
    JSON.stringify({
      initializeResult: FAKE_HARNESS_INITIALIZE,
      capabilityMatrix: caps,
    }),
  );
  report.derive(
    "capability_matrix",
    "capabilities() applied to the FAKE-ACP harness default advertisement (packages/bridge/test/scenarios.ts initResult) -- this is the fake-harness advertisement, NOT a live Kiro initialize result",
    capabilityPayload,
  );

  // 3. The launch-path selection rule the bridge code applies.
  report.derive(
    "launch_path_rule",
    "the bridge session-manager selection rule (FEAT-004) -- the decision rule, not a live launch result",
    LAUNCH_PATH_RULE,
  );

  // 4. The RFC 8707 audience binding the auth facade uses.
  report.derive(
    "audience_binding",
    "the auth facade / resource-server binding rule (FEAT-003) -- the rule the code applies, confirmed against MCP 2026-07-28",
    AUDIENCE_BINDING,
  );
}
