/**
 * Run the harness steps in order and record each one exactly once.
 *
 * A step passes only when its `run()` resolves (every request was made and
 * every assertion held). A throw marks it failed with the redacted message.
 * It is skipped, with the reason, when a required env var is missing, when a
 * step it needs did not pass, or when the run was interrupted.
 */
import type { Report } from "./report.ts";

/** An environment prerequisite of a step. */
export type Requirement = "baseUrl" | "repo" | "github";

export interface Step<C> {
  id: string;
  name: string;
  requires: Requirement[];
  /** Step ids that must have passed before this one runs. */
  needs: string[];
  /** Make the requests and assert; return non-secret scalars to capture. */
  run(ctx: C): Promise<Record<string, unknown> | undefined>;
}

export interface RunStepsOptions {
  hasBaseUrl: boolean;
  hasRepo: boolean;
  /** The opt-in GitHub scenario is enabled (KIRO_API_E2E_GITHUB=1). */
  hasGithub?: boolean;
  signal?: AbortSignal;
  now(): number;
  progress(line: string): void;
}

export const REASON_NO_URL = "KIRO_REMOTE_URL is unset: there is no deployed stack to test.";
export const REASON_NO_REPO =
  "KIRO_API_E2E_REPO is unset: there is no repo to launch a session on.";
export const REASON_NO_GITHUB =
  "KIRO_API_E2E_GITHUB is unset: the GitHub wake scenario needs the GitHub App installed on the repo.";
export const REASON_INTERRUPTED = "run interrupted.";

function skipReason<C>(step: Step<C>, report: Report, opts: RunStepsOptions): string | null {
  if (opts.signal?.aborted) {
    return REASON_INTERRUPTED;
  }
  if (step.requires.includes("baseUrl") && !opts.hasBaseUrl) {
    return REASON_NO_URL;
  }
  if (step.requires.includes("repo") && !opts.hasRepo) {
    return REASON_NO_REPO;
  }
  if (step.requires.includes("github") && !opts.hasGithub) {
    return REASON_NO_GITHUB;
  }
  const unmet = step.needs.find((id) => report.statusOf(id) !== "passed");
  return unmet ? `skipped because ${unmet} did not pass.` : null;
}

/** Run every step against `ctx`, recording pass/fail/skip in `report`. */
export async function runSteps<C>(
  steps: readonly Step<C>[],
  ctx: C,
  report: Report,
  opts: RunStepsOptions,
): Promise<void> {
  for (const step of steps) {
    const reason = skipReason(step, report, opts);
    if (reason !== null) {
      report.skip(step.id, step.name, reason);
      opts.progress(report.scrub(`– ${step.id}: ${reason}`));
      continue;
    }
    opts.progress(report.scrub(`▶ ${step.id}`));
    const start = opts.now();
    try {
      const captured = await step.run(ctx);
      const ms = opts.now() - start;
      report.pass(step.id, step.name, captured, ms);
      opts.progress(report.scrub(`✔ ${step.id} (${(ms / 1000).toFixed(1)} s)`));
    } catch (err) {
      const ms = opts.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      report.fail(step.id, step.name, message, ms);
      opts.progress(report.scrub(`✘ ${step.id} (${(ms / 1000).toFixed(1)} s): ${message}`));
    }
  }
}
