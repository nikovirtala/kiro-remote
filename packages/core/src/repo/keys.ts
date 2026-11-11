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
/** Webhook delivery record + dedupe marker (GHDLV#<X-GitHub-Delivery>). */
export const ghDeliveryPk = (deliveryId: string): string => `GHDLV#${deliveryId}`;
/** Per-session inbox of typed wake items (SESSION#<id>, INBOX#<ulid>). */
export const inboxSk = (ulid: string): string => `INBOX#${ulid}`;
export const INBOX_PREFIX = "INBOX#";
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
