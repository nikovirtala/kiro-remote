/**
 * Link by harvesting: after a turn settles, find the pull request the agent
 * opened by scanning the turn's events for github.com/<owner>/<repo>/pull/<n>.
 *
 * A URL only becomes a link when ALL of these hold; each failure is recorded on
 * the session as a `session.info` event with its reason:
 *   - owner/repo is one of the session's repos[]            (repo_not_in_session)
 *   - the PR is not already linked to ANOTHER session         (already_linked)
 *   - the PR exists, as the App reads it                      (pr_not_found)
 *   - the PR was created after the session was created        (created_before_session)
 * No branch-name or title matching, ever.
 */

import {
  type EventItem,
  findPrUrls,
  type PrRef,
  prKeyOf,
  type Repository,
  repoOf,
  sessionHasRepo,
} from "@nikovirtala/kiro-remote-core";
import type { GithubClient } from "./app-client.ts";
import type { Logger, Metrics } from "./log.ts";

export type RejectReason =
  | "repo_not_in_session"
  | "already_linked"
  | "pr_not_found"
  | "created_before_session";

export interface HarvestDeps {
  repo: Repository;
  github: Pick<GithubClient, "getPull">;
  metrics: Metrics;
  logger: Logger;
  now: () => number;
}

/** The event types scanned as a whole (message.chunk is handled separately, see extractCandidates). */
const SCANNED_TYPES = new Set(["tool.call", "tool.update"]);

/** The text of a message.chunk event (its content block), or "". */
function chunkText(payload: unknown): string {
  const text = (payload as { content?: { text?: unknown } } | null)?.content?.text;
  return typeof text === "string" ? text : "";
}

/**
 * Distinct PR refs found in a turn's events, in order of first appearance.
 *
 * tool.call / tool.update are scanned as a whole (command text, command output
 * and results all carry URLs). Assistant text is streamed in many small chunks
 * (and stored coalesced at flush boundaries), so a URL can straddle two
 * message.chunk events: runs of adjacent message.chunk events are joined before
 * scanning. Thoughts and every other event type are not scanned.
 */
export function extractCandidates(events: readonly Pick<EventItem, "type" | "payload">[]): PrRef[] {
  const seen = new Set<string>();
  const out: PrRef[] = [];
  const scan = (text: string): void => {
    for (const ref of findPrUrls(text)) {
      const key = prKeyOf(ref);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(ref);
      }
    }
  };
  let run = "";
  for (const ev of events) {
    if (ev.type === "message.chunk") {
      run += chunkText(ev.payload);
      continue;
    }
    scan(run);
    run = "";
    if (SCANNED_TYPES.has(ev.type)) {
      scan(typeof ev.payload === "string" ? ev.payload : JSON.stringify(ev.payload ?? ""));
    }
  }
  scan(run);
  return out;
}

async function allEventsAfter(
  repo: Repository,
  sessionId: string,
  after: number,
): Promise<EventItem[]> {
  const all: EventItem[] = [];
  let cursor = after;
  for (;;) {
    const page = await repo.queryEvents(sessionId, cursor);
    const last = page[page.length - 1];
    if (!last) {
      return all;
    }
    all.push(...page);
    cursor = last.seq;
  }
}

async function recordInfo(
  deps: HarvestDeps,
  sessionId: string,
  turnId: string,
  kind: "pr_link_rejected" | "pr_linked",
  payload: Record<string, unknown>,
): Promise<void> {
  await deps.repo.appendEvent(sessionId, {
    turnId,
    ts: new Date(deps.now()).toISOString(),
    type: "session.info",
    rawType: kind,
    replay: false,
    payload: {
      type: "session.info",
      sessionId,
      turnId,
      replay: false,
      rawType: kind,
      kind,
      payload,
    },
  });
}

export interface HarvestResult {
  linked: string[];
  rejected: Array<{ pr: string; reason: RejectReason }>;
}

/** Scan one settled turn and link what qualifies. Transient GitHub errors throw (the message is retried). */
export async function harvestTurn(
  deps: HarvestDeps,
  msg: { sessionId: string; turnId: string; afterSeq: number },
): Promise<HarvestResult> {
  const result: HarvestResult = { linked: [], rejected: [] };
  const session = await deps.repo.getSession(msg.sessionId);
  if (!session || session.status === "deleted") {
    return result;
  }
  const events = (await allEventsAfter(deps.repo, msg.sessionId, msg.afterSeq)).filter(
    (e) => e.turnId === msg.turnId,
  );
  for (const ref of extractCandidates(events)) {
    const repoName = repoOf(ref);
    const key = prKeyOf(ref);
    const url = `https://github.com/${repoName}/pull/${ref.number}`;
    const reject = async (reason: RejectReason): Promise<void> => {
      result.rejected.push({ pr: key, reason });
      deps.metrics.count("LinksRejected", 1, { reason });
      await recordInfo(deps, msg.sessionId, msg.turnId, "pr_link_rejected", {
        pr: key,
        url,
        reason,
      });
    };

    if (!sessionHasRepo(session, repoName)) {
      await reject("repo_not_in_session");
      continue;
    }
    const existing = await deps.repo.getPrLink(key);
    if (existing) {
      // Already ours (an earlier turn, the trailer, a manual link): nothing to do.
      if (existing.sessionId !== msg.sessionId) {
        await reject("already_linked");
      }
      continue;
    }
    const pull = await deps.github.getPull(repoName, ref.number);
    if (!pull) {
      await reject("pr_not_found");
      continue;
    }
    if (Date.parse(pull.createdAt) < Date.parse(session.createdAt)) {
      await reject("created_before_session");
      continue;
    }
    const created = await deps.repo.createLink({
      repo: repoName,
      number: ref.number,
      sessionId: msg.sessionId,
      linkedBy: "harvest",
      prState: pull.merged ? "merged" : pull.state,
      headSha: pull.headSha,
    });
    if (created.created) {
      result.linked.push(key);
      deps.metrics.count("LinksCreated", 1, { method: "harvest" });
      await recordInfo(deps, msg.sessionId, msg.turnId, "pr_linked", {
        pr: key,
        url,
        method: "harvest",
      });
    } else if (created.existing.sessionId !== msg.sessionId) {
      await reject("already_linked");
    }
  }
  return result;
}
