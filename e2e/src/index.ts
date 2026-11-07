/**
 * @nikovirtala/e2e
 *
 * The live end-to-end harness and the offline-derivable PR artifacts. The
 * harness drives the full control-plane flow (login, launch, poll, follow-up,
 * steer, change model, answer permission, cancel, adopt, delete) plus the MCP
 * Inspector stdio / Streamable HTTP flows and the claude.ai connector step,
 * reading the target repo and API key ONLY from the environment and never
 * persisting or logging either.
 *
 * Where a step cannot run in this sandbox (no deployed host, no kiro-cli, no
 * Inspector), it is recorded as `blocked: <exact reason>` -- never fabricated.
 */

export const PACKAGE_NAME = "@nikovirtala/e2e";

export { type HarnessConfig, loadConfig, type Secrets } from "./config.ts";
export {
  AUDIENCE_BINDING,
  FAKE_HARNESS_INITIALIZE,
  LAUNCH_PATH_RULE,
  recordDerivedArtifacts,
} from "./derived.ts";
export {
  checkHost,
  checkInspector,
  checkKiroCli,
  type PreflightProbes,
  type PreflightResult,
  type PrereqCheck,
  preflight,
} from "./preflight.ts";
export {
  type DerivedArtifact,
  Report,
  type RunReport,
  type StepResult,
  type StepStatus,
} from "./report.ts";
export { type RunHarnessResult, runHarness } from "./run.ts";
export { STEPS, type Step, type StepContext } from "./steps.ts";
