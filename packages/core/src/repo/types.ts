/**
 * Item shapes stored in the single DynamoDB table. Field names match the data
 * model in the spec; TTL fields are unix-epoch seconds; `version` is the
 * optimistic-lock counter on the session META item.
 */

import type { SessionStatus, TurnStatus } from "../domain.ts";

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
 * A dynamically-registered OAuth client (RFC 7591). Unlike OAUTH#TX/CODE/CIMD
 * items these are PERMANENT: there is deliberately NO `ttl` field, so a
 * registered client never expires.
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
}

export interface IdempotencyItem {
  PK: string; // IDEMP#<sub>#<key>
  SK: "A";
  response: Record<string, unknown>;
  ttl: number;
}
