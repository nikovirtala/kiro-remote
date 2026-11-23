/**
 * The sweep's first pass: waits. Whatever created a wait, a PR that closed while no webhook said
 * so still fires it, and a wait whose session was deleted is removed.
 *
 * Reader: every open wait from the sweep's index (GSI2), one read of GitHub per distinct awaited
 * PR (not per wait), and the session of each wait. Decide: {@link decideSweptWait}, which is
 * {@link decideWait} (the webhook's decision) plus the deleted-session rule. A wait fires through
 * `fireWaitDecision`, the path the registration check uses, so the wait is removed and the wake
 * written in one transaction and a webhook racing the sweep wakes the session once.
 */

import type { PrWaitItem } from "@nikovirtala/kiro-remote-core";
import { fireWaitDecision, holdMsFor } from "../consumer.ts";
import { isRateLimited } from "./budget.ts";
import type { Pass, SweepContext } from "./index.ts";
import {
  decideSweptWait,
  groupWaitsByPr,
  planReads,
  type SweptWaitDecision,
  type WaitRead,
} from "./plan.ts";

export const waitsPass: Pass = {
  name: "waits",
  // Half of the run's reads at most, so the base-move pass after it always has the other half.
  quota: 0.5,
  async run(ctx) {
    const { deps } = ctx;
    const waits = await deps.repo.queryOpenWaits();
    // Waits of a deleted session go first and cost no read of GitHub.
    const live: PrWaitItem[] = [];
    for (const w of waits) {
      const decision = decideSweptWait({
        sessionActive: await ctx.sessionActive(w.sessionId),
        read: { type: "unread" },
      });
      if (decision.type === "remove") {
        await removeWait(ctx, w, decision);
      } else {
        live.push(w);
      }
    }
    const byPr = groupWaitsByPr(live);
    const { read, skipped } = planReads([...byPr.keys()], ctx.budget.room(), ctx.runIndex);
    const reads = new Map<string, WaitRead>(skipped.map((pr) => [pr, { type: "unread" }]));
    for (const pr of read) {
      if (ctx.budget.room() <= 0) {
        reads.set(pr, { type: "unread" });
        continue;
      }
      reads.set(pr, await readPull(ctx, pr));
    }
    let skippedForCap = 0;
    for (const [pr, group] of byPr) {
      const result = reads.get(pr) ?? { type: "unread" };
      for (const w of group) {
        const decision = decideSweptWait({ sessionActive: true, read: result });
        if (decision.type === "skip" && decision.why === "cap") {
          skippedForCap++;
        }
        await apply(ctx, w, decision);
      }
    }
    if (skippedForCap > 0) {
      deps.metrics.count("SweepSkippedForCap", skippedForCap, { pass: "waits" });
      deps.logger.info("sweep_waits_skipped_for_cap", { waits: skippedForCap });
    }
  },
};

/** One read of an awaited PR. A failure is that PR's, not the run's, unless GitHub says rate limited. */
async function readPull(ctx: SweepContext, pr: string): Promise<WaitRead> {
  const { deps } = ctx;
  const hash = pr.lastIndexOf("#");
  ctx.budget.spend();
  try {
    const pull = await deps.github.getPull(pr.slice(0, hash), Number(pr.slice(hash + 1)));
    return {
      type: "pull",
      pull: pull && {
        state: pull.state,
        merged: pull.merged,
        baseRef: pull.baseRef ?? null,
        mergeCommitSha: pull.mergeCommitSha ?? null,
      },
    };
  } catch (err) {
    deps.metrics.count("SweepReadsFailed", 1, { pass: "waits" });
    deps.logger.warn("sweep_wait_read_failed", { pr, error: String(err) });
    if (isRateLimited(err)) {
      ctx.budget.stop();
    }
    return { type: "failed" };
  }
}

async function removeWait(
  ctx: SweepContext,
  w: PrWaitItem,
  decision: Extract<SweptWaitDecision, { type: "remove" }>,
): Promise<void> {
  const { deps } = ctx;
  const removed = await deps.repo.deleteWait(w.sessionId, w.pr, {
    reason: decision.reason,
    source: "sweep",
  });
  if (removed) {
    deps.metrics.count("SweepWaitsRemoved", 1, { reason: decision.reason });
    deps.logger.info("sweep_wait_removed", {
      pr: w.pr,
      sessionId: w.sessionId,
      reason: decision.reason,
    });
  }
}

async function apply(ctx: SweepContext, w: PrWaitItem, decision: SweptWaitDecision): Promise<void> {
  const { deps } = ctx;
  if (decision.type !== "fire") {
    return;
  }
  const hash = w.pr.lastIndexOf("#");
  const holdMs =
    decision.outcome === "merged"
      ? await holdMsFor(deps, {
          sessionId: w.sessionId,
          repo: w.pr.slice(0, hash),
          number: Number(w.pr.slice(hash + 1)),
          base: decision.base === "unknown" ? null : decision.base,
        })
      : 0;
  const fired = await fireWaitDecision(deps, {
    sessionId: w.sessionId,
    pr: w.pr,
    decision,
    source: "sweep",
    event:
      decision.outcome === "gone"
        ? "awaited pull request not found (found by the scheduled sweep)"
        : `awaited pull request was found ${decision.outcome === "merged" ? "merged" : "closed"} by the scheduled sweep, which no webhook announced`,
    holdMs,
  });
  if (fired) {
    ctx.touched.add(w.sessionId);
    deps.metrics.count("SweepWaitsFired", 1, { outcome: decision.outcome });
  }
}
