/**
 * Central configuration constants for the kiro-remote control plane.
 *
 * This is the ONE place every tunable lives so there is no drift between the
 * coalescer, the repository TTLs, the concurrency guard, and the S3 pointer
 * thresholds.
 */

/** Flush coalesced chunk buffers after this many milliseconds of quiet. */
export const FLUSH_MS = 750;

/** Flush coalesced chunk buffers once the buffered text reaches this size. */
export const FLUSH_BYTES = 4096;

/** TTL applied to EVT# items (and other event-derived rows) in days. */
export const EVENT_TTL_DAYS = 30;

/** How long a pending permission request stays answerable, in milliseconds. */
export const PERMISSION_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** Hard cap on concurrent cloud sessions per account (includes IDE/Web). */
export const MAX_CLOUD_SESSIONS = 10;

/**
 * Prompts larger than this many bytes are spilled to S3 and stored as a
 * pointer on the TURN# item instead of inline.
 */
export const INLINE_PROMPT_MAX_BYTES = 32 * 1024;

/**
 * Event payloads larger than this many bytes are spilled to S3 and stored as a
 * pointer on the EVT# item instead of inline.
 */
export const INLINE_PAYLOAD_MAX_BYTES = 64 * 1024;

/** TTL for OAuth transaction (OAUTH#TX#) items, in milliseconds. */
export const OAUTH_TX_TTL_MS = 10 * 60 * 1000;

/** TTL for OAuth authorization-code (OAUTH#CODE#) items, in milliseconds. */
export const OAUTH_CODE_TTL_MS = 60 * 1000;

/** Maximum TTL for cached CIMD (OAUTH#CIMD#) documents, in milliseconds. */
export const OAUTH_CIMD_MAX_TTL_MS = 24 * 60 * 60 * 1000;

/** TTL for per-subject idempotency keys, in milliseconds. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** Event-cursor sequence numbers are stored zero-padded to this width. */
export const EVENT_SEQ_WIDTH = 12;
