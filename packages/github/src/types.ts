/** Shared types for the GitHub integration. */

import type { LinkMethod, PrState } from "@nikovirtala/kiro-remote-core";

/** The webhook events the integration handles. Anything else is acknowledged and dropped. */
export const HANDLED_EVENTS = [
  "pull_request",
  "pull_request_review",
  "issue_comment",
  "check_suite",
  "workflow_run",
] as const;
export type HandledEvent = (typeof HANDLED_EVENTS)[number];

export function isHandledEvent(name: string): name is HandledEvent {
  return (HANDLED_EVENTS as readonly string[]).includes(name);
}

type Json = Record<string, unknown>;

/** An inline review comment fetched for a trusted reviewer. */
export interface ReviewComment {
  path: string;
  line: number | null;
  body: string;
}

/** One webhook delivery, parsed. `reviewComments` is filled in by the consumer for trusted reviewers. */
export interface GithubEvent {
  /** X-GitHub-Event */
  name: string;
  /** X-GitHub-Delivery */
  deliveryId: string;
  payload: Json;
  reviewComments?: ReviewComment[];
}

/** The slice of a stored PR link that routing needs. */
export interface RouteLink {
  sessionId: string;
  /** owner/repo#n, lower-cased */
  pr: string;
  linkedBy: LinkMethod;
  prState: PrState;
  headSha: string | null;
}

export interface RouteConfig {
  /** Logins whose text may be quoted to the agent (lower-cased compare). */
  trustedLogins: readonly string[];
  /** The Kiro agent's own GitHub identities; their comments never wake a session. */
  agentLogins: readonly string[];
  autoCloseOnMerge: "off" | "after_turn";
  /** Debounce for failing-check wakes. */
  checksDebounceMs: number;
}

export type WakeKind = "pr_merged" | "pr_closed" | "review" | "comment" | "checks_failed";

export interface FailedCheck {
  name: string;
  url: string;
  conclusion: string;
}

export type Action =
  | {
      type: "wake";
      sessionId: string;
      kind: WakeKind;
      /** owner/repo#n: items with the same key and kind merge inside the debounce window. */
      key: string;
      repo: string;
      number: number;
      deliveryId: string;
      prompt: string;
      data: { checks?: FailedCheck[] } | null;
      debounceMs: number;
      autoClose: boolean;
    }
  | { type: "updateLink"; pr: string; prState?: PrState; headSha?: string }
  | {
      type: "unmatched";
      repo: string;
      number: number | null;
      sender: string | null;
      url: string | null;
    }
  | { type: "ignore"; reason: string };
