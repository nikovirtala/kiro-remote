/**
 * What the scheduled sweep decides, as pure functions. Each pass of the sweep (waits, base moves)
 * has a reader that gets state from DynamoDB and GitHub, and a decide function here that turns what
 * was read into what to do. Nothing here does I/O. See docs/github.md, "The sweep".
 */

import type { PrLinkItem, PrWaitItem } from "@nikovirtala/kiro-remote-core";
import { decideWait, type WaitDecision, type WaitPull } from "../waits.ts";

/**
 * Which of `items` to read in this run, and which to leave for the next. `room` is how many reads
 * are left. The window moves by `room` items per run (`runIndex` counts runs), so that when more
 * items are open than a run can read, every item is read within `ceil(items / room)` runs and none
 * is starved by the ones in front of it. Items keep their given order inside the window.
 */
export function planReads<T>(
  items: readonly T[],
  room: number,
  runIndex: number,
): { read: T[]; skipped: T[] } {
  if (room <= 0) {
    return { read: [], skipped: [...items] };
  }
  if (items.length <= room) {
    return { read: [...items], skipped: [] };
  }
  const start = (runIndex * room) % items.length;
  const picked = new Set<number>();
  for (let i = 0; i < room; i++) {
    picked.add((start + i) % items.length);
  }
  return {
    read: items.filter((_, i) => picked.has(i)),
    skipped: items.filter((_, i) => !picked.has(i)),
  };
}

/** Waits by awaited PR, in the index's order (sorted by PR), one entry per distinct PR. */
export function groupWaitsByPr(waits: readonly PrWaitItem[]): Map<string, PrWaitItem[]> {
  const out = new Map<string, PrWaitItem[]>();
  for (const w of waits) {
    const key = w.pr.toLowerCase();
    out.set(key, [...(out.get(key) ?? []), w]);
  }
  return out;
}

/** What was read for one awaited PR. */
export type WaitRead =
  /** GitHub answered; `pull` is null when there is no such PR or the App cannot see it. */
  | { type: "pull"; pull: WaitPull | null }
  /** The read failed (GitHub or the network): try again next run. */
  | { type: "failed" }
  /** This run did not read it (its cap was reached). */
  | { type: "unread" };

export type SweptWaitDecision =
  /** The session is deleted or gone: remove the wait, wake nobody. */
  | { type: "remove"; reason: "session_deleted" }
  /** Still open: leave it for the webhook or the next run. */
  | { type: "keep" }
  /** Not decided this run. */
  | { type: "skip"; why: "cap" | "read_failed" }
  /** Merged, closed, or unreadable: the wait fires, exactly as for a webhook (decideWait). */
  | Extract<WaitDecision, { type: "fire" }>;

/**
 * The sweep's decision for one wait. A deleted session's wait is removed whatever the PR did
 * (nothing is left to wake). Otherwise the PR decides, through {@link decideWait}, the same
 * function the webhook and the check made on registration use.
 */
export function decideSweptWait(input: {
  sessionActive: boolean;
  read: WaitRead;
}): SweptWaitDecision {
  if (!input.sessionActive) {
    return { type: "remove", reason: "session_deleted" };
  }
  if (input.read.type === "unread") {
    return { type: "skip", why: "cap" };
  }
  if (input.read.type === "failed") {
    return { type: "skip", why: "read_failed" };
  }
  return decideWait(input.read.pull);
}

/** The open linked PRs of one repo that are on one base branch. */
export interface BaseGroup {
  repo: string;
  base: string;
  links: PrLinkItem[];
}

/**
 * The (repo, base branch) pairs that have an open linked PR whose session is active, sorted by
 * repo and base. A link whose base is not stored is left out: it cannot say which branch to watch,
 * and the next `pull_request` webhook for it stores one (the webhook path reads such a link).
 */
export function groupLinksByBase(
  links: readonly PrLinkItem[],
  sessionActive: (sessionId: string) => boolean,
): { groups: BaseGroup[]; withoutBase: number } {
  const map = new Map<string, BaseGroup>();
  let withoutBase = 0;
  for (const l of links) {
    if (!sessionActive(l.sessionId)) {
      continue;
    }
    if (!l.baseRef) {
      withoutBase++;
      continue;
    }
    const repo = l.repo.toLowerCase();
    const key = `${repo}#${l.baseRef}`;
    const group = map.get(key) ?? { repo, base: l.baseRef, links: [] };
    group.links.push(l);
    map.set(key, group);
  }
  return {
    groups: [...map.values()].sort((a, b) =>
      `${a.repo}#${a.base}`.localeCompare(`${b.repo}#${b.base}`),
    ),
    withoutBase,
  };
}

/** The merge most recently made into a base branch, as read from GitHub. */
export interface LatestMerge {
  number: number;
  mergedAt: string;
  /** The merge commit, hex, or null when GitHub gave none. */
  sha: string | null;
}

export type BaseMoveDecision =
  /** Nothing merged into the branch that the sweep can see. */
  | { type: "none" }
  /** The tip is the one the last check saw. */
  | { type: "unchanged" }
  /** First sight, and the merge is older than every open link: remember the tip, check nothing. */
  | { type: "baseline"; sha: string; afterPr: number }
  /** The base moved since the last check: run the conflict check on it. */
  | { type: "moved"; sha: string; afterPr: number };

/**
 * Has a base branch moved since it was last checked? `stored` is the tip the last check recorded
 * (by the webhook path or an earlier run). Without one, the branch is checked only when its latest
 * merge came after the oldest open link on it was made: a merge before every open PR existed cannot
 * have made one of them conflict, and checking it would read every open PR once for nothing.
 */
export function decideBaseMove(input: {
  stored: { sha: string } | null;
  latest: LatestMerge | null;
  oldestLinkedAt: string;
}): BaseMoveDecision {
  const { latest, stored } = input;
  if (!latest?.sha) {
    return { type: "none" };
  }
  if (stored?.sha === latest.sha) {
    return { type: "unchanged" };
  }
  const found = { sha: latest.sha, afterPr: latest.number };
  if (stored) {
    return { type: "moved", ...found };
  }
  return Date.parse(latest.mergedAt) > Date.parse(input.oldestLinkedAt)
    ? { type: "moved", ...found }
    : { type: "baseline", ...found };
}
