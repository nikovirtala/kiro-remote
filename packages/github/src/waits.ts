/**
 * What a pull request that others wait for means for them, as a pure function.
 *
 * A session can wait for a pull request it does not own (see "Waits for" in docs/github.md). When
 * that PR merges or closes, each waiting session gets one wake. {@link decideWait} is the whole
 * decision. It does no I/O and takes the PR as GitHub reports it, so the webhook path (route.ts),
 * the check made when a wait is registered (consumer.ts) and a later sweep of waits whose PR
 * merged while webhooks were down all share it.
 */

import type { WaitSource } from "@nikovirtala/kiro-remote-core";

/** The fields of a pull request the decision reads. */
export interface WaitPull {
  state: "open" | "closed";
  merged: boolean;
  /** The branch it was or is to be merged into. */
  baseRef: string | null;
  /** The merge commit once merged. */
  mergeCommitSha: string | null;
}

export type WaitDecision =
  /** Still open: the wait stays stored. */
  | { type: "keep" }
  /** Merged: the waiter should rebase onto the base and carry on. */
  | { type: "fire"; outcome: "merged"; base: string; sha: string }
  /** Closed without merging: the waiter says whether it can go on without it. */
  | { type: "fire"; outcome: "closed" }
  /** The PR could not be read (it does not exist, or the App cannot see it). */
  | { type: "fire"; outcome: "gone" };

/** `pull` is null when GitHub has no such PR (or the App cannot see it). */
export function decideWait(pull: WaitPull | null): WaitDecision {
  if (!pull) {
    return { type: "fire", outcome: "gone" };
  }
  if (pull.merged) {
    return {
      type: "fire",
      outcome: "merged",
      base: pull.baseRef ?? "unknown",
      sha: pull.mergeCommitSha?.replace(/[^0-9a-f]/gi, "") || "unknown",
    };
  }
  return pull.state === "closed" ? { type: "fire", outcome: "closed" } : { type: "keep" };
}

/** A stored wait, as route() sees it. */
export interface RouteWait {
  sessionId: string;
  /** The awaited PR, owner/repo#n, lower-cased. */
  pr: string;
  source: WaitSource;
  /**
   * How long to hold the wake when the PR merged. The consumer sets it for a waiter whose own
   * open PR may now conflict, so the conflict wake and this one reach the session as one turn.
   */
  holdMs: number;
}
