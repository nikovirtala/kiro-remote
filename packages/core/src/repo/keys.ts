/**
 * Single-table key helpers. One place that knows the PK/SK layout so the
 * repository and any migration tooling stay consistent.
 */

import { EVENT_SEQ_WIDTH } from "../config.ts";

export const sessionPk = (id: string): string => `SESSION#${id}`;
export const META_SK = "META";
export const turnSk = (ulid: string): string => `TURN#${ulid}`;
export const eventSk = (seq: number): string => `EVT#${padSeq(seq)}`;
export const permSk = (requestId: string): string => `PERM#${requestId}`;

export const CONFIG_PK = "CONFIG";
export const CAPS_SK = "CAPS";
export const MODELS_SK = "MODELS";

export const oauthTxPk = (id: string): string => `OAUTH#TX#${id}`;
export const oauthCodePk = (sha256Code: string): string => `OAUTH#CODE#${sha256Code}`;
export const oauthCimdPk = (sha256ClientId: string): string => `OAUTH#CIMD#${sha256ClientId}`;
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
