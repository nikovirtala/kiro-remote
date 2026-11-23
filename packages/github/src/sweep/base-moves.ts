/**
 * The sweep's second pass: base moves. A base branch that moved while the webhook that says so was
 * failing still gets its conflict check.
 *
 * Reader: the open linked PRs from the sweep's index (GSI2) grouped by repo and base branch, and per
 * group the merge most recently made into the branch (one read of GitHub; the pulls permission the
 * App has, since reading the branch needs Contents). Decide: {@link decideBaseMove}, comparing that
 * merge with the tip the last check recorded. A moved base runs the same `checkBase` the webhook
 * runs, with `source: "sweep"`, then records the tip.
 */

import { checkBase } from "../consumer.ts";
import { isRateLimited } from "./budget.ts";
import type { Pass } from "./index.ts";
import { decideBaseMove, groupLinksByBase, type LatestMerge, planReads } from "./plan.ts";

export const baseMovesPass: Pass = {
  name: "base_moves",
  async run(ctx) {
    const { deps } = ctx;
    const links = await deps.repo.queryOpenLinkIndex();
    const active = new Map<string, boolean>();
    for (const l of links) {
      if (!active.has(l.sessionId)) {
        active.set(l.sessionId, await ctx.sessionActive(l.sessionId));
      }
    }
    const { groups, withoutBase } = groupLinksByBase(links, (id) => active.get(id) === true);
    if (withoutBase > 0) {
      deps.logger.info("sweep_links_without_base", { links: withoutBase });
    }
    const { read, skipped } = planReads(groups, ctx.budget.room(), ctx.runIndex);
    let skippedForCap = skipped.length;
    let checkedOne = false;
    for (const group of read) {
      if (ctx.budget.room() <= 0) {
        skippedForCap++;
        continue;
      }
      let latest: LatestMerge | null;
      ctx.budget.spend();
      try {
        const merged = await deps.github.latestMergedPull(group.repo, group.base);
        latest = merged && {
          number: merged.number,
          mergedAt: merged.mergedAt,
          sha: merged.mergeCommitSha,
        };
      } catch (err) {
        deps.metrics.count("SweepReadsFailed", 1, { pass: "base_moves" });
        deps.logger.warn("sweep_base_read_failed", {
          repo: group.repo,
          base: group.base,
          error: String(err),
        });
        if (isRateLimited(err)) {
          ctx.budget.stop();
        }
        continue;
      }
      const decision = decideBaseMove({
        stored: await deps.repo.getBaseTip(group.repo, group.base),
        latest,
        oldestLinkedAt: group.links.reduce(
          (oldest, l) => (Date.parse(l.linkedAt) < Date.parse(oldest) ? l.linkedAt : oldest),
          group.links[0]?.linkedAt ?? new Date(deps.now()).toISOString(),
        ),
      });
      if (decision.type === "baseline") {
        await deps.repo.putBaseTip({
          repo: group.repo,
          base: group.base,
          sha: decision.sha,
          afterPr: decision.afterPr,
        });
        continue;
      }
      if (decision.type !== "moved") {
        continue;
      }
      // Checking a moved base reads each open PR on it. Never start one the run cannot finish,
      // except the first this pass checks: a base with more PRs than the cap must still be checked.
      // The check reads every open linked PR of the repo on that base or on none known.
      const cost = links.filter(
        (l) => l.repo.toLowerCase() === group.repo && (!l.baseRef || l.baseRef === group.base),
      ).length;
      if (checkedOne && ctx.budget.room() < cost) {
        skippedForCap++;
        continue;
      }
      deps.metrics.count("SweepBaseMovesFound", 1);
      deps.logger.info("sweep_base_moved", {
        repo: group.repo,
        base: group.base,
        afterPr: decision.afterPr,
        openPrs: cost,
      });
      checkedOne = true;
      ctx.budget.spend(cost);
      // checkBase records the tip once every candidate has been checked or queued for a re-check.
      await checkBase(
        deps,
        {
          type: "checkBase",
          deliveryId: "",
          repo: group.repo,
          base: group.base,
          baseSha: decision.sha,
          afterPr: decision.afterPr,
        },
        ctx.touched,
        "sweep",
      );
    }
    if (skippedForCap > 0) {
      deps.metrics.count("SweepSkippedForCap", skippedForCap, { pass: "base_moves" });
      deps.logger.info("sweep_bases_skipped_for_cap", { bases: skippedForCap });
    }
  },
};
