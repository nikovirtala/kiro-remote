/**
 * Single-table key helpers. One place that knows the PK/SK layout so the
 * repository and any migration tooling stay consistent.
 */

import { EVENT_SEQ_WIDTH } from "../config.ts";

export const sessionPk = (id: string): string => `SESSION#${id}`;
export const META_SK = "META";
export const turnSk = (ulid: string): string => `TURN#${ulid}`;
export const eventSk = (seq: number): string => `EVT#${padSeq(seq)}`;
/** The highest possible event sort key (all-nines seq), the inclusive upper bound for event range reads. */
export const EVENT_SK_MAX = `EVT#${"9".repeat(EVENT_SEQ_WIDTH)}`;
export const permSk = (requestId: string): string => `PERM#${requestId}`;

/** GitHub PR link (PK GHPR#<owner>/<repo>#<number>, SK LINK) and its reverse (SESSION#<id>, LINK#...). */
export const prKey = (owner: string, repo: string, number: number): string =>
  `${owner}/${repo}#${number}`;
export const ghPrPk = (key: string): string => `GHPR#${key}`;
export const GH_LINK_SK = "LINK";
export const sessionLinkSk = (key: string): string => `LINK#${key}`;
export const SESSION_LINK_PREFIX = "LINK#";
/**
 * GSI1 key of a PR link: every link of a repo shares one partition, and the sort
 * key puts open (or not yet known) PRs under `OPEN#`, so "the open linked PRs of
 * this repo" is one cheap query. A merged or closed PR moves to `DONE#`.
 */
export const GH_LINK_OPEN_PREFIX = "OPEN#";
export const ghRepoGsi1Pk = (repo: string): string => `GHREPO#${repo.toLowerCase()}`;
export const ghLinkGsi1Sk = (open: boolean, number: number): string =>
  `${open ? GH_LINK_OPEN_PREFIX : "DONE#"}${number}`;
/**
 * A session's wait for a pull request (PK SESSION#<id>, SK WAIT#<owner>/<repo>#<n>). One item
 * per wait: the session side is the table key, the PR side is GSI1 (below), so both "what does
 * this session wait for" and "who waits for this PR" are one query and nothing is written twice.
 */
export const waitSk = (key: string): string => `WAIT#${key}`;
export const WAIT_PREFIX = "WAIT#";
/** GSI1 key of a wait: every wait for one PR shares a partition, sorted by session id. */
export const ghWaitGsi1Pk = (key: string): string => `GHWAIT#${key.toLowerCase()}`;
/**
 * GSI2, the sweep's sparse index (docs/github.md, "The sweep"). A scheduled job has to find every
 * open wait and every open linked PR across accounts, which GSI1 cannot answer without a partition
 * key per PR or repo. Only these items carry GSI2 keys, and only while they are open, so the index
 * holds what the sweep reads and nothing else: a wait that fires, a session that is deleted and a
 * PR that closes leave it with the item.
 *
 * Every open wait is in one partition, sorted by PR so that the waits for one PR are adjacent
 * (`<owner>/<repo>#<n>|<session id>`). Every open link is in another, sorted by PR. One partition
 * is far below what DynamoDB serves from one (1,000 WCU, 3,000 RCU) for the sweep's one query per
 * run and the writes that follow a wait or a link; shard it by hash when that stops being true.
 */
export const SWEEP_WAIT_PK = "SWEEP#WAIT";
export const SWEEP_LINK_PK = "SWEEP#LINK";
export const sweepWaitSk = (pr: string, sessionId: string): string =>
  `${pr.toLowerCase()}|${sessionId}`;
export const sweepLinkSk = (pr: string): string => pr.toLowerCase();
/** Where the sweep last saw a base branch's tip (PK GHBASE#<owner>/<repo>#<branch>, SK TIP). */
export const ghBaseTipPk = (repo: string, base: string): string =>
  `GHBASE#${repo.toLowerCase()}#${base}`;
export const GH_BASE_TIP_SK = "TIP";
/** Webhook delivery record + dedupe marker (GHDLV#<X-GitHub-Delivery>). */
export const ghDeliveryPk = (deliveryId: string): string => `GHDLV#${deliveryId}`;
/** Per-session inbox of typed wake items (SESSION#<id>, INBOX#<ulid>). */
export const inboxSk = (ulid: string): string => `INBOX#${ulid}`;
export const INBOX_PREFIX = "INBOX#";
/** Per-session queue of prompts sent with whenBusy "queue" (SESSION#<id>, QPROMPT#<turn id>). */
export const queuedPromptSk = (turnId: string): string => `QPROMPT#${turnId}`;
export const QUEUED_PROMPT_PREFIX = "QPROMPT#";
/** Deliveries for allowed repos that matched no session link (one partition, newest last). */
export const GH_UNMATCHED_PK = "GHUNMATCHED";

export const CONFIG_PK = "CONFIG";
export const CAPS_SK = "CAPS";
export const MODELS_SK = "MODELS";

export const oauthTxPk = (id: string): string => `OAUTH#TX#${id}`;
export const oauthCodePk = (sha256Code: string): string => `OAUTH#CODE#${sha256Code}`;
export const oauthCimdPk = (sha256ClientId: string): string => `OAUTH#CIMD#${sha256ClientId}`;
export const clientPk = (clientId: string): string => `CLIENT#${clientId}`;
export const SINGLETON_SK = "A";

export const idempotencyPk = (sub: string, key: string): string => `IDEMP#${sub}#${key}`;

export const userGsi1Pk = (sub: string): string => `USER#${sub}`;

/** Zero-pad an event sequence to a lexicographically sortable fixed width. */
export function padSeq(seq: number): string {
  return String(seq).padStart(EVENT_SEQ_WIDTH, "0");
}

/** Compute the unix-epoch-seconds TTL value DynamoDB expects. */
export function ttlFromNow(ms: number, now: number = Date.now()): number {
  return Math.floor((now + ms) / 1000);
}
