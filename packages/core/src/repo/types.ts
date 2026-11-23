/**
 * Item shapes stored in the single DynamoDB table. Field names match the data
 * model in the spec; TTL fields are unix-epoch seconds; `version` is the
 * optimistic-lock counter on the session META item.
 */

import type { SessionStatus, TurnStatus } from "../domain.ts";
import type { FeedSource } from "../schemas/feed.ts";

/** Pointer to a value spilled to S3 when it exceeds the inline threshold. */
export interface S3Pointer {
  s3: true;
  bucket: string;
  key: string;
  bytes: number;
}

export interface SessionMetaItem {
  PK: string; // SESSION#<id>
  SK: "META";
  id: string; // our ULID
  kiroSessionId: string | null;
  title: string | null;
  repos: string[];
  agent: string | null;
  mode: string | null;
  model: string | null;
  effort: string | null;
  status: SessionStatus;
  activeTurnId: string | null;
  eventSeq: number;
  createdBy: string; // Cognito sub
  createdAt: string;
  updatedAt: string;
  version: number; // optimistic lock
  GSI1PK: string; // USER#<sub>
  GSI1SK: string; // updatedAt
  /**
   * An automatic close (autoCloseOnMerge) was due while prompts were still queued, so it waits:
   * once the queue is empty the close is decided again. Absent or false: nothing is owed.
   */
  closeAfterQueue?: boolean;
}

/**
 * A queued prompt's status. `queued`: waiting for the turn in front of it. `delivered`: claimed by
 * a drain and sent to the bridge as a prompt command; its turn has not started yet. `started`: its
 * turn exists (same id) and runs or ran. `failed`: it will not run, `failReason` says why.
 */
export type QueuedPromptStatus = "queued" | "delivered" | "started" | "failed";

/** PK SESSION#<id>, SK QPROMPT#<turn id>: a prompt sent with whenBusy "queue", and the turn id it runs under. */
export interface QueuedPromptItem {
  PK: string;
  SK: string;
  /** The turn id returned to the caller; the turn runs under it. */
  id: string;
  sessionId: string;
  prompt: string | S3Pointer;
  status: QueuedPromptStatus;
  queuedAt: string;
  /** When a drain claimed it (status `delivered`); null before. */
  claimedAt: string | null;
  /** Why it failed (status `failed`), a PromptFailReason (schemas/feed.ts); null otherwise. */
  failReason: string | null;
  failedAt: string | null;
  ttl: number;
}

/** Why a turn started. `github` turns carry the webhook delivery ids that caused them. */
export interface TurnTrigger {
  source: "user" | "github";
  deliveryIds: string[];
  /** Inbox item ids folded into this turn (wake turns only). */
  inboxIds?: string[];
  /** True when the session should be deleted once this turn completes (autoCloseOnMerge). */
  autoClose?: boolean;
}

export interface TurnItem {
  PK: string; // SESSION#<id>
  SK: string; // TURN#<ulid>
  id: string;
  sessionId: string;
  prompt: string | S3Pointer;
  status: TurnStatus;
  stopReason: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Metering stored exactly as given by turn_completion, or null. Never estimated. */
  metering: Record<string, unknown> | null;
  /** Why this turn started. Absent on turns written before triggers existed (read as user). */
  trigger?: TurnTrigger;
}

export type PrState = "open" | "closed" | "merged" | "unknown";
export type LinkMethod = "harvest" | "trailer" | "manual";

/** PK GHPR#<owner>/<repo>#<n>, SK LINK: the PR -> session link (a PR links to at most one session). */
export interface PrLinkItem {
  PK: string;
  SK: "LINK";
  /** owner/repo#n */
  pr: string;
  repo: string; // owner/repo
  number: number;
  sessionId: string;
  linkedBy: LinkMethod;
  linkedAt: string;
  prState: PrState;
  headSha: string | null;
  /** The PR's base branch, when known (refreshed from pull_request payloads). */
  baseRef?: string | null;
  /** GSI1: all links of a repo (see ghRepoGsi1Pk). Absent on links written before the index existed. */
  GSI1PK?: string;
  GSI1SK?: string;
  /** GSI2 (the sweep's index, see SWEEP_LINK_PK): present while the PR is open or not known yet. */
  GSI2PK?: string;
  GSI2SK?: string;
}

/** PK SESSION#<id>, SK LINK#<owner>/<repo>#<n>: the reverse lookup. */
export interface SessionLinkItem {
  PK: string;
  SK: string;
  pr: string;
  repo: string;
  number: number;
  sessionId: string;
  linkedBy: LinkMethod;
  linkedAt: string;
}

/** Who registered a wait. A later source (an ark issue's depends-on link) adds a value here. */
export type WaitSource = "mcp" | "rest" | "trailer";

/**
 * PK SESSION#<id>, SK WAIT#<owner>/<repo>#<n>: the session waits for that pull request to merge
 * or close. Not a link: the PR may belong to another session, or to none, and may be in a repo
 * the session does not use. GSI1 lists the sessions waiting for a PR.
 */
export interface PrWaitItem {
  PK: string;
  SK: string;
  sessionId: string;
  /** The awaited PR, owner/repo#n, lower-cased. */
  pr: string;
  repo: string; // owner/repo, lower-cased
  number: number;
  source: WaitSource;
  createdAt: string;
  GSI1PK: string; // GHWAIT#<pr>
  GSI1SK: string; // <sessionId>
  /** GSI2 (the sweep's index, see SWEEP_WAIT_PK). Absent on waits written before the index existed. */
  GSI2PK?: string;
  GSI2SK?: string;
}

/**
 * PK GHBASE#<owner>/<repo>#<branch>, SK TIP: the tip of a base branch as the last check of it saw
 * it, so the sweep can tell that a base moved while no webhook said so. It is bookkeeping, not
 * state a reader of the change feed follows.
 */
export interface BaseTipItem {
  PK: string;
  SK: "TIP";
  repo: string;
  base: string;
  /** The sha of the merge that last moved the branch, hex. */
  sha: string;
  /** The PR that merge belonged to, or null (a push). */
  afterPr: number | null;
  checkedAt: string;
}

export type DeliveryStatus = "received" | "processed" | "unmatched" | "ignored" | "failed";

/** PK GHDLV#<delivery id>, SK A: dedupe marker + the raw delivery (S3 pointer when large). */
export interface DeliveryItem {
  PK: string;
  SK: "A";
  deliveryId: string;
  event: string;
  action: string | null;
  repo: string | null;
  receivedAt: string;
  status: DeliveryStatus;
  /** The raw request body, or a pointer to it when over the inline threshold. */
  body: string | S3Pointer;
  ttl: number;
}

export type InboxStatus = "pending" | "delivered" | "dropped";

/** PK SESSION#<id>, SK INBOX#<ulid>: one typed wake item waiting for the session to be idle. */
export interface InboxItem {
  PK: string;
  SK: string;
  id: string; // the ulid
  sessionId: string;
  source: "github";
  /** First delivery that produced this item. */
  deliveryId: string;
  /** Every delivery folded into this item (debounce merge). */
  deliveryIds: string[];
  kind: string;
  /** Merge key: items with the same key and kind inside the debounce window merge. */
  key: string;
  prompt: string;
  /** Structured data the producer needs to re-render the prompt on merge. */
  data: Record<string, unknown> | null;
  createdAt: string;
  /** Not drained before this time (debounce). ISO-8601. */
  notBefore: string;
  status: InboxStatus;
  dropReason: string | null;
  deliveredTurnId: string | null;
  autoClose: boolean;
  /** What caused the wake (the change feed's `source`). Absent on items written before the feed. */
  origin?: FeedSource;
  ttl: number;
}

/** PK GHUNMATCHED, SK <ts>#<delivery id>: a delivery for an allowed repo with no linked session. */
export interface UnmatchedItem {
  PK: string;
  SK: string;
  deliveryId: string;
  event: string;
  action: string | null;
  repo: string;
  number: number | null;
  sender: string | null;
  receivedAt: string;
  url: string | null;
  ttl: number;
}

export interface EventItem {
  PK: string; // SESSION#<id>
  SK: string; // EVT#<padded seq>
  seq: number;
  turnId: string | null;
  ts: string;
  type: string;
  rawType: string;
  replay: boolean;
  payload: unknown | S3Pointer;
  ttl: number;
}

export interface PermItem {
  PK: string; // SESSION#<id>
  SK: string; // PERM#<requestId>
  requestId: string;
  toolCallId: string;
  toolCall: Record<string, unknown>;
  options: unknown[];
  consent: Record<string, unknown> | null;
  status: "pending" | "answered" | "expired";
  answer: Record<string, unknown> | null;
  ttl: number;
}

export interface CapsItem {
  PK: "CONFIG";
  SK: "CAPS";
  /** Latest redacted initialize result. */
  initializeResult: Record<string, unknown>;
  extensionMethods: string[];
  configOptions: unknown[];
  modes: unknown[];
  updatedAt: string;
}

export interface ModelsItem {
  PK: "CONFIG";
  SK: "MODELS";
  models: string[];
  /** "config_option" or "cli_list_models" so callers know the source. */
  source: string;
  updatedAt: string;
}

export interface OAuthTxItem {
  PK: string; // OAUTH#TX#<id>
  SK: "A";
  data: Record<string, unknown>;
  ttl: number;
}

export interface OAuthCodeItem {
  PK: string; // OAUTH#CODE#<sha256(code)>
  SK: "A";
  /** KMS-encrypted token set (ciphertext only; never plaintext). */
  encryptedTokens: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  ttl: number;
}

export interface OAuthCimdItem {
  PK: string; // OAUTH#CIMD#<sha256(client_id)>
  SK: "A";
  document: Record<string, unknown>;
  ttl: number;
}

/**
 * A dynamically-registered OAuth client (RFC 7591). `ttl` is set 180 days out at
 * registration and extended when the client is used. Items registered before
 * `ttl` existed have none and never expire; they are left as they are.
 */
export interface RegisteredClientItem {
  PK: string; // CLIENT#<client_id>
  SK: "A";
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: string;
  createdAt: number;
  /** Unix epoch seconds. Absent on registrations made before the TTL existed. */
  ttl?: number;
}

export interface IdempotencyItem {
  PK: string; // IDEMP#<sub>#<key>
  SK: "A";
  response: Record<string, unknown>;
  /**
   * SHA-256 (hex) of the request that produced `response`. Absent on entries
   * stored before fingerprints existed; those match any replay until they expire.
   */
  fingerprint?: string;
  ttl: number;
}
