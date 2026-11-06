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

export interface IdempotencyItem {
  PK: string; // IDEMP#<sub>#<key>
  SK: "A";
  response: Record<string, unknown>;
  ttl: number;
}
