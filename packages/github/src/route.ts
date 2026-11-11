/**
 * route(event, links, config) => Action[]
 *
 * The one pure function that decides what a webhook delivery means. It does no
 * I/O: the consumer looks up the PR links, fetches trusted review comments,
 * calls this, and then applies the actions. That keeps the policy (what wakes a
 * session, what text may be forwarded) in one place that is easy to test, and
 * lets later producers (issue-driven launches) reuse the same events.
 *
 * Wake rules:
 *   pull_request.closed (merged)        -> wake, optionally autoClose
 *   pull_request.closed (not merged)    -> wake
 *   pull_request_review.submitted       -> wake when changes_requested or commented
 *   issue_comment.created on a PR       -> wake, bots and the agent's own identity ignored
 *   check_suite / workflow_run completed
 *     with failure or timed_out
 *     on the linked PR's head sha       -> wake (debounced; one wake for the batch)
 * Everything else changes no session; the delivery is simply kept in the store.
 */

import type { PrState } from "@nikovirtala/kiro-remote-core";
import {
  checksPrompt,
  header,
  type QuotePart,
  quoteBlock,
  safeLabel,
  safeLogin,
} from "./render.ts";
import type { Action, FailedCheck, GithubEvent, RouteConfig, RouteLink } from "./types.ts";

type Json = Record<string, unknown>;

function obj(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}
function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** owner/repo of the event, lower-cased, or null. */
export function eventRepo(event: GithubEvent): string | null {
  return str(obj(event.payload.repository).full_name)?.toLowerCase() ?? null;
}

export function eventSender(event: GithubEvent): { login: string | null; isBot: boolean } {
  const sender = obj(event.payload.sender);
  const login = str(sender.login);
  return { login, isBot: sender.type === "Bot" || (login?.endsWith("[bot]") ?? false) };
}

/** The PR numbers an event is about (check events can name several, or none for forks). */
export function eventPrNumbers(event: GithubEvent): number[] {
  const p = event.payload;
  const repo = eventRepo(event);
  switch (event.name) {
    case "pull_request":
    case "pull_request_review": {
      const n = num(obj(p.pull_request).number) ?? num(p.number);
      return n === null ? [] : [n];
    }
    case "issue_comment": {
      const issue = obj(p.issue);
      const n = num(issue.number);
      return n !== null && issue.pull_request !== undefined ? [n] : [];
    }
    case "check_suite":
    case "workflow_run": {
      const run = obj(event.name === "check_suite" ? p.check_suite : p.workflow_run);
      const prs = Array.isArray(run.pull_requests) ? run.pull_requests : [];
      const out: number[] = [];
      for (const raw of prs) {
        const pr = obj(raw);
        const n = num(pr.number);
        // The same head sha can belong to PRs in other repos; keep this repo's only.
        const baseUrl = str(obj(obj(pr.base).repo).url);
        if (
          n !== null &&
          (!baseUrl || (repo !== null && baseUrl.toLowerCase().endsWith(`/repos/${repo}`)))
        ) {
          out.push(n);
        }
      }
      return out;
    }
    default:
      return [];
  }
}

function isTrusted(login: string | null, config: RouteConfig): boolean {
  return (
    login !== null && config.trustedLogins.some((t) => t.toLowerCase() === login.toLowerCase())
  );
}

function isAgent(login: string | null, config: RouteConfig): boolean {
  return login !== null && config.agentLogins.some((a) => a.toLowerCase() === login.toLowerCase());
}

function prStateOf(pr: Json): PrState {
  if (pr.merged === true) {
    return "merged";
  }
  return pr.state === "closed" ? "closed" : "open";
}

/** Route one delivery. `links` are the stored links for the PRs the event names. */
export function route(
  event: GithubEvent,
  links: readonly RouteLink[],
  config: RouteConfig,
): Action[] {
  const repo = eventRepo(event);
  const numbers = eventPrNumbers(event);
  if (!repo || numbers.length === 0) {
    return [{ type: "ignore", reason: repo ? "no_pull_request" : "no_repository" }];
  }
  const actions: Action[] = [];
  let anyLinked = false;
  for (const number of numbers) {
    const key = `${repo}#${number}`;
    const link = links.find((l) => l.pr.toLowerCase() === key);
    if (!link) {
      continue;
    }
    anyLinked = true;
    actions.push(...routeLinked(event, link, repo, number, config));
  }
  if (!anyLinked && wouldWake(event, config)) {
    const pr = obj(event.payload.pull_request);
    const issue = obj(event.payload.issue);
    actions.push({
      type: "unmatched",
      repo,
      number: numbers[0],
      sender: eventSender(event).login,
      url: str(pr.html_url) ?? str(issue.html_url) ?? null,
    });
  }
  return actions.length > 0 ? actions : [{ type: "ignore", reason: "no_action" }];
}

/** True when a linked PR would have produced a wake: the events worth showing as unmatched. */
function wouldWake(event: GithubEvent, config: RouteConfig): boolean {
  const action = str(event.payload.action);
  const sender = eventSender(event);
  switch (event.name) {
    case "pull_request":
      return action === "opened" || action === "closed" || action === "reopened";
    case "pull_request_review": {
      const state = str(obj(event.payload.review).state)?.toLowerCase();
      return action === "submitted" && (state === "changes_requested" || state === "commented");
    }
    case "issue_comment":
      return action === "created" && !sender.isBot && !isAgent(sender.login, config);
    case "check_suite":
    case "workflow_run":
      return action === "completed" && failingConclusion(event) !== null;
    default:
      return false;
  }
}

function failingConclusion(event: GithubEvent): "failure" | "timed_out" | null {
  const run = obj(
    event.name === "check_suite" ? event.payload.check_suite : event.payload.workflow_run,
  );
  const c = run.conclusion;
  return c === "failure" || c === "timed_out" ? c : null;
}

function routeLinked(
  event: GithubEvent,
  link: RouteLink,
  repo: string,
  number: number,
  config: RouteConfig,
): Action[] {
  const p = event.payload;
  const action = str(p.action);
  const sender = eventSender(event);
  const wakeBase = {
    type: "wake" as const,
    sessionId: link.sessionId,
    key: link.pr,
    repo,
    number,
    deliveryId: event.deliveryId,
    data: null,
    debounceMs: 0,
    autoClose: false,
  };

  switch (event.name) {
    case "pull_request": {
      const pr = obj(p.pull_request);
      const out: Action[] = [
        {
          type: "updateLink",
          pr: link.pr,
          prState: prStateOf(pr),
          ...(str(obj(pr.head).sha) ? { headSha: str(obj(pr.head).sha) as string } : {}),
        },
      ];
      if (action !== "closed") {
        return out;
      }
      if (pr.merged === true) {
        const base = safeLabel(obj(pr.base).ref, 100);
        const sha = str(pr.merge_commit_sha)?.replace(/[^0-9a-f]/gi, "") || "unknown";
        out.push({
          ...wakeBase,
          kind: "pr_merged",
          autoClose: config.autoCloseOnMerge === "after_turn",
          prompt: [
            header({
              event: "pull_request.closed (merged)",
              repo,
              number,
              deliveryIds: [event.deliveryId],
            }),
            `PR #${number} was merged into ${base} at ${sha}. Finish any remaining work and summarise what's left, or say you're done.`,
          ].join("\n"),
        });
      } else {
        out.push({
          ...wakeBase,
          kind: "pr_closed",
          prompt: [
            header({
              event: "pull_request.closed (not merged)",
              repo,
              number,
              deliveryIds: [event.deliveryId],
            }),
            `PR #${number} was closed without merging.`,
          ].join("\n"),
        });
      }
      return out;
    }

    case "pull_request_review": {
      const review = obj(p.review);
      const state = str(review.state)?.toLowerCase();
      if (action !== "submitted" || (state !== "changes_requested" && state !== "commented")) {
        return [];
      }
      const reviewer = str(obj(review.user).login) ?? sender.login;
      if (isAgent(reviewer, config)) {
        return [];
      }
      const who = safeLogin(reviewer);
      const lines = [
        header({
          event: `pull_request_review.submitted (${state})`,
          repo,
          number,
          deliveryIds: [event.deliveryId],
        }),
        `@${who} submitted a review on PR #${number}: ${state === "changes_requested" ? "changes requested" : "commented"}.`,
      ];
      if (isTrusted(reviewer, config)) {
        const parts: QuotePart[] = [{ label: "review body", text: str(review.body) ?? "" }];
        for (const c of event.reviewComments ?? []) {
          parts.push({
            label: `inline comment on ${safeLabel(c.path, 200)}${c.line ? `:${c.line}` : ""}`,
            text: c.body,
          });
        }
        const quoted = quoteBlock(who, parts);
        if (quoted) {
          lines.push(quoted);
        }
      }
      return [{ ...wakeBase, kind: "review", prompt: lines.join("\n") }];
    }

    case "issue_comment": {
      const comment = obj(p.comment);
      const commenter = str(obj(comment.user).login) ?? sender.login;
      const commenterIsBot =
        obj(comment.user).type === "Bot" || (commenter?.endsWith("[bot]") ?? false);
      if (
        action !== "created" ||
        sender.isBot ||
        commenterIsBot ||
        isAgent(commenter, config) ||
        isAgent(sender.login, config)
      ) {
        return [];
      }
      const who = safeLogin(commenter);
      const lines = [
        header({ event: "issue_comment.created", repo, number, deliveryIds: [event.deliveryId] }),
        `@${who} commented on PR #${number}.`,
      ];
      if (isTrusted(commenter, config)) {
        const quoted = quoteBlock(who, [{ label: "comment", text: str(comment.body) ?? "" }]);
        if (quoted) {
          lines.push(quoted);
        }
      }
      return [{ ...wakeBase, kind: "comment", prompt: lines.join("\n") }];
    }

    case "check_suite":
    case "workflow_run": {
      if (action !== "completed") {
        return [];
      }
      const conclusion = failingConclusion(event);
      if (!conclusion) {
        return [];
      }
      const isSuite = event.name === "check_suite";
      const run = obj(isSuite ? p.check_suite : p.workflow_run);
      const sha = str(run.head_sha);
      // Only the PR's current head commit: an older sha's failure is already superseded.
      if (link.headSha && sha !== link.headSha) {
        return [];
      }
      const check: FailedCheck = isSuite
        ? {
            name: `${safeLabel(obj(run.app).name ?? obj(run.app).slug)} (check suite)`,
            url: `https://github.com/${repo}/commit/${(sha ?? "").replace(/[^0-9a-f]/gi, "")}/checks?check_suite_id=${num(run.id) ?? ""}`,
            conclusion,
          }
        : {
            name: safeLabel(run.name),
            url: str(run.html_url)?.startsWith("https://github.com/")
              ? (str(run.html_url) as string)
              : `https://github.com/${repo}/actions`,
            conclusion,
          };
      return [
        {
          ...wakeBase,
          kind: "checks_failed",
          data: { checks: [check] },
          debounceMs: config.checksDebounceMs,
          prompt: checksPrompt({
            repo,
            number,
            checks: [check],
            deliveryIds: [event.deliveryId],
            event: `${event.name}.completed (${conclusion})`,
          }),
        },
      ];
    }

    default:
      return [];
  }
}
