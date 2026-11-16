/**
 * The mergeability check, as pure functions.
 *
 * GitHub sends no webhook when a pull request starts to conflict, and a
 * conflicting PR gets no CI run. What does change is the PR's base branch, so
 * when one moves (see route.ts, baseMoveOf) the consumer reads each open linked
 * PR on it and calls {@link decideConflict} with the result. A `behind` PR
 * also wakes when the stack turns that on (GITHUB_WAKE_ON_BEHIND). Nothing here does
 * I/O; the consumer applies the decision.
 *
 * GitHub computes `mergeable` lazily: right after the base moved a read returns
 * `null` and starts a background job. `null` means "ask again later", never
 * "clean".
 */

/** What a PR's mergeability says. Only `conflicting` wakes a session today. */
export type MergeState = "clean" | "behind" | "conflicting" | "unknown";

/** The fields of GET /repos/{owner}/{repo}/pulls/{n} the check reads. */
export interface PullMergeability {
  state: "open" | "closed";
  merged: boolean;
  headSha: string;
  baseRef: string | null;
  /** `null` while GitHub is still computing it. */
  mergeable: boolean | null;
  /** dirty, behind, clean, blocked, unstable, has_hooks, draft, unknown. */
  mergeableState: string | null;
}

/**
 * `mergeable` false or `mergeable_state` "dirty" is a conflict. `mergeable` null
 * is unknown whatever `mergeable_state` says. A PR that merges but is behind its
 * base is "behind"; everything else that merges (clean, blocked by review rules,
 * unstable checks, ...) is "clean": those are not conflicts.
 */
export function mergeStateOf(
  pull: Pick<PullMergeability, "mergeable" | "mergeableState">,
): MergeState {
  if (pull.mergeable === false || pull.mergeableState === "dirty") {
    return "conflicting";
  }
  if (pull.mergeable === null || pull.mergeable === undefined) {
    return "unknown";
  }
  return pull.mergeableState === "behind" ? "behind" : "clean";
}

export type SkipReason = "not_found" | "closed" | "other_base" | "head_changed";
export type GiveUpReason = "still_unknown" | "read_failed";

export type ConflictDecision =
  /** The PR conflicts with its base, or is behind it and behind wakes are on: write a wake. */
  | { type: "wake"; state: "conflicting" | "behind"; headSha: string }
  /** GitHub has not computed it yet: ask again later, comparing against this head. */
  | { type: "recheck"; headSha: string }
  /** Computed, and nothing to wake for (`behind` wakes only with `wakeOnBehind`). */
  | { type: "done"; state: "clean" | "behind"; headSha: string }
  | { type: "skip"; reason: SkipReason }
  | { type: "gave_up"; reason: GiveUpReason };

export interface ConflictCheckInput {
  /** The PR as read now, or null when it does not exist or is not visible. */
  pull: PullMergeability | null;
  /** The base branch that moved. */
  base: string;
  /** This try, from 1. */
  attempt: number;
  maxAttempts: number;
  /** The head sha seen at the first try; a different head now means the agent pushed since. */
  baselineHeadSha: string | null;
  /**
   * Wake for a PR that merges but is behind its base. GitHub reports `behind`
   * when the base requires branches to be up to date before merging, so this
   * fires where the rebase is actually needed to merge.
   */
  wakeOnBehind?: boolean;
}

export function decideConflict(input: ConflictCheckInput): ConflictDecision {
  const { pull } = input;
  if (!pull) {
    return { type: "skip", reason: "not_found" };
  }
  if (pull.state !== "open" || pull.merged) {
    return { type: "skip", reason: "closed" };
  }
  if (pull.baseRef !== null && pull.baseRef !== input.base) {
    return { type: "skip", reason: "other_base" };
  }
  // A newer head than the one we first saw: the agent may already have rebased.
  if (input.baselineHeadSha !== null && input.baselineHeadSha !== pull.headSha) {
    return { type: "skip", reason: "head_changed" };
  }
  const state = mergeStateOf(pull);
  switch (state) {
    case "conflicting":
      return { type: "wake", state, headSha: pull.headSha };
    case "unknown":
      return input.attempt >= input.maxAttempts
        ? { type: "gave_up", reason: "still_unknown" }
        : { type: "recheck", headSha: pull.headSha };
    case "behind":
      return input.wakeOnBehind
        ? { type: "wake", state, headSha: pull.headSha }
        : { type: "done", state, headSha: pull.headSha };
    default:
      return { type: "done", state, headSha: pull.headSha };
  }
}
