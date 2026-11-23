/**
 * The scheduled sweep: one Lambda, one schedule, a list of passes (docs/github.md, "The sweep").
 *
 * A webhook says when a PR closed or a base branch moved, and GitHub does not retry a delivery that
 * failed. The sweep reads GitHub for what the webhook should have said and writes the same decisions
 * through the same paths, with `source: "sweep"` on the change feed. Each pass is a reader and a pure
 * decide function (plan.ts). A later pass (links whose PR state drifted, waits derived from ark
 * issues' depends-on links) is one more entry in {@link PASSES}.
 */

import { SWEEP_MAX_PR_READS, SWEEP_RATE_LIMIT_RESERVE } from "@nikovirtala/kiro-remote-core";
import type { RateLimit } from "../app-client.ts";
import { type ConsumerDeps, drainSession } from "../consumer.ts";
import { baseMovesPass } from "./base-moves.ts";
import { ReadBudget } from "./budget.ts";
import { waitsPass } from "./waits.ts";

export type SweepDeps = Omit<ConsumerDeps, "github"> & {
  github: ConsumerDeps["github"] &
    Pick<import("../app-client.ts").GithubClient, "latestMergedPull"> & {
      rateLimit: () => RateLimit | null;
    };
};

export interface SweepContext {
  deps: SweepDeps;
  budget: ReadBudget;
  /** Counts the runs (the schedule's interval since the epoch), so passes rotate what they read. */
  runIndex: number;
  /** Sessions a pass wrote a wake for: drained at the end of the run. */
  touched: Set<string>;
  /** Whether a session still exists and is not deleted (read once per run). */
  sessionActive(sessionId: string): Promise<boolean>;
}

export interface Pass {
  name: string;
  /**
   * The share of the run's reads this pass may use at most (0 to 1). A pass without one may use
   * what is left, so a pass with a quota in front of it cannot starve it.
   */
  quota?: number;
  run(ctx: SweepContext): Promise<void>;
}

/** The passes, in order. Waits first: a merge it fires is held to fold with the base-move check after it. */
export const PASSES: readonly Pass[] = [waitsPass, baseMovesPass];

export interface SweepOptions {
  passes?: readonly Pass[];
  maxPrReads?: number;
  rateLimitReserve?: number;
  /** The run's length of time in ms, to number runs (the schedule's interval). */
  intervalMs: number;
}

export interface SweepResult {
  prsRead: number;
  failedPasses: string[];
}

export async function runSweep(deps: SweepDeps, opts: SweepOptions): Promise<SweepResult> {
  const budget = new ReadBudget({
    cap: opts.maxPrReads ?? SWEEP_MAX_PR_READS,
    rateLimit: () => deps.github.rateLimit(),
    reserve: opts.rateLimitReserve ?? SWEEP_RATE_LIMIT_RESERVE,
    now: deps.now,
  });
  const sessions = new Map<string, Promise<boolean>>();
  const ctx: SweepContext = {
    deps,
    budget,
    runIndex: Math.floor(deps.now() / opts.intervalMs),
    touched: new Set(),
    sessionActive(id) {
      let known = sessions.get(id);
      if (!known) {
        known = deps.repo.getSession(id).then((s) => s !== null && s.status !== "deleted");
        sessions.set(id, known);
      }
      return known;
    },
  };
  const failedPasses: string[] = [];
  for (const pass of opts.passes ?? PASSES) {
    try {
      const quota = pass.quota === undefined ? null : Math.ceil(budget.room() * pass.quota);
      await pass.run({ ...ctx, budget: quota === null ? budget : budget.child(quota) });
    } catch (err) {
      // One pass failing must not keep the others from running.
      failedPasses.push(pass.name);
      deps.metrics.count("SweepPassFailed", 1, { pass: pass.name });
      deps.logger.error("sweep_pass_failed", { pass: pass.name, error: String(err) });
    }
  }
  for (const sessionId of ctx.touched) {
    try {
      await drainSession(deps, sessionId);
    } catch (err) {
      deps.logger.error("sweep_drain_failed", { sessionId, error: String(err) });
    }
  }
  deps.metrics.count("SweepPrsRead", budget.reads);
  deps.logger.info("sweep_run", {
    prsRead: budget.reads,
    rateLimited: budget.rateLimited,
    touched: ctx.touched.size,
    failedPasses,
  });
  return { prsRead: budget.reads, failedPasses };
}
