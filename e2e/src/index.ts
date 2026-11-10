/**
 * @nikovirtala/kiro-remote-e2e
 *
 * The live end-to-end harness for a deployed kiro-remote stack. MCP first:
 * discovery + OAuth + tools/list through the MCP Inspector CLI, then launch,
 * turn settle, follow-up and delete through the MCP SDK client; then the same
 * flow over REST. The bearer comes from the `kiro-remote login` keychain, the
 * target repo only from the environment, and neither is ever printed.
 *
 * A step passes only after its real requests and assertions; anything failed
 * or skipped gives a non-zero exit. See docs/testing.md.
 */
export const PACKAGE_NAME = "@nikovirtala/kiro-remote-e2e";

export {
  defaultLogin,
  nodeFetch,
  type ObtainedToken,
  type ObtainTokenDeps,
  obtainToken,
  REQUIRED_SCOPES,
  stderrIo,
} from "./auth.ts";
export { type HarnessConfig, loadConfig, type Secrets } from "./config.ts";
export {
  defaultInspectorSpawn,
  INSPECTOR_PACKAGE,
  INSPECTOR_TIMEOUT_MS,
  type InspectorDeps,
  type InspectorInvocation,
  type InspectorSpawn,
  inspectorInvocation,
  parseInspectorToolNames,
  runInspectorToolsList,
} from "./inspector.ts";
export { connectMcp, type McpSession, type ToolCallResult } from "./mcp-client.ts";
export {
  makeScrubber,
  Report,
  type RunReport,
  type StepResult,
  type StepStatus,
} from "./report.ts";
export { type RunHarnessResult, runHarness } from "./run.ts";
export {
  REASON_INTERRUPTED,
  REASON_NO_REPO,
  REASON_NO_URL,
  type Requirement,
  type RunStepsOptions,
  runSteps,
  type Step,
} from "./runner.ts";
export {
  contentText,
  type EventLike,
  type EventPage,
  type TurnResult,
  type WaitForTurnOptions,
  waitForTurn,
} from "./settle.ts";
export {
  assertToolSet,
  CLEANUP_ID,
  cleanupSessions,
  type HarnessContext,
  type HarnessDeps,
  type HarnessState,
  type MarkerKind,
  markerFor,
  promptFor,
  type SessionCursor,
  STEPS,
  titleFor,
} from "./steps.ts";
