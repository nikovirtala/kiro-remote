/**
 * The `pnpm e2e` entry point.
 *
 * It wires the real prerequisite probes, loads config + secrets from the
 * environment, runs every step in order (each recording a real result or a
 * precise `blocked: <reason>`), adds the offline-derivable artifacts, and
 * prints the fully-redacted report to stdout. It persists nothing.
 *
 * Exit code:
 *   0  -- at least one live step ran for real (a genuine live e2e happened).
 *   2  -- no live step could run; every live step is blocked with a recorded
 *         reason. This is the EXPECTED outcome in a sandbox with no deployed
 *         stack: the harness did its job (attempt + precise record), but the
 *         live e2e did not execute, so CI sees a non-zero code rather than a
 *         false green. No output is fabricated in either case.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { redact } from "@nikovirtala/kiro-remote-core";
import { loadConfig } from "./config.ts";
import { recordDerivedArtifacts } from "./derived.ts";
import { type PreflightProbes, preflight } from "./preflight.ts";
import { Report } from "./report.ts";
import { STEPS, type StepContext } from "./steps.ts";

const execFileAsync = promisify(execFile);

/** Real PATH probe: `command -v <binary>` via the shell, no secret involved. */
export const realProbes: PreflightProbes = {
  async which(binary) {
    try {
      const { stdout } = await execFileAsync("sh", ["-c", `command -v ${binary}`]);
      const path = stdout.trim();
      return path.length > 0 ? path : null;
    } catch {
      return null;
    }
  },
};

/** The result of a harness run (used by the CLI exit-code decision + tests). */
export interface RunHarnessResult {
  report: ReturnType<Report["build"]>;
  anyLiveStepRan: boolean;
}

/**
 * Run the full harness with injectable probes/env, returning the built report.
 * Pure enough to test: the caller decides what to do with the result.
 */
export async function runHarness(opts: {
  env?: NodeJS.ProcessEnv;
  probes?: PreflightProbes;
}): Promise<RunHarnessResult> {
  const { config, secrets } = loadConfig(opts.env ?? process.env);
  const probes = opts.probes ?? realProbes;

  const report = new Report({
    deployedHostConfigured: config.baseUrl !== null,
    kiroApiKeyPresent: config.hasApiKey,
    e2eRepoPresent: config.hasRepo,
  });

  const pf = await preflight(config.baseUrl, probes);

  const ctx: StepContext = {
    report,
    preflight: pf,
    baseUrl: config.baseUrl,
    repo: secrets.repo,
    apiKey: secrets.apiKey,
  };

  for (const step of STEPS) {
    await step.run(ctx);
  }

  recordDerivedArtifacts(report);

  return { report: report.build(), anyLiveStepRan: report.anyRan };
}

/** CLI main: run, print the redacted report, pick the exit code. */
async function main(): Promise<void> {
  const { report, anyLiveStepRan } = await runHarness({});

  // The report is already fully redacted; redact once more defensively before
  // it touches stdout.
  process.stdout.write(`${JSON.stringify(redact(report), null, 2)}\n`);

  const blocked = report.steps.filter((s) => s.status === "blocked").length;
  const ran = report.steps.filter((s) => s.status === "ran").length;
  process.stderr.write(
    `\ne2e summary: ${ran} step(s) ran, ${blocked} step(s) blocked, ${report.derived.length} derived artifact(s).\n`,
  );

  if (!anyLiveStepRan) {
    process.stderr.write(
      "No live step could run in this environment; every live step is recorded as blocked with its exact reason (no output fabricated). Exiting 2.\n",
    );
    process.exit(2);
  }
}

// Only run main() when invoked directly (not when imported by a test).
if (process.argv[1]?.endsWith("run.ts")) {
  main().catch((err) => {
    process.stderr.write(
      `e2e harness error: ${redact(err instanceof Error ? err.message : String(err))}\n`,
    );
    process.exit(1);
  });
}
