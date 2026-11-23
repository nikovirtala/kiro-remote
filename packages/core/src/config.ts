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

/**
 * TTL for dynamically-registered (CLIENT#) items, in milliseconds. A resolve at
 * /oauth/authorize (or a refresh) pushes it out again.
 */
export const OAUTH_CLIENT_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * A registered client's TTL is extended at most once per this interval, so the
 * extension does not add a write to every authorize.
 */
export const OAUTH_CLIENT_RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

/** TTL for per-subject idempotency keys, in milliseconds. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Maximum `wait` (seconds) for an events long-poll. The API Lambda times out at
 * 29s and the HTTP API integration at 30s, so a 20s poll leaves headroom.
 */
export const EVENTS_MAX_WAIT_SECONDS = 20;

/** How often an events long-poll re-reads the log while it waits, in milliseconds. */
export const EVENTS_POLL_INTERVAL_MS = 1000;

/** Event-cursor sequence numbers are stored zero-padded to this width. */
export const EVENT_SEQ_WIDTH = 12;

/**
 * How long a queued prompt's record is kept after it is created, in milliseconds. A prompt waits
 * for the turn in front of it (a turn ends within hours, see CATCH_UP_MAX_AGE_MS), so this is far
 * longer than any wait; after it the record, its status and its failure reason are gone.
 */
export const QUEUED_PROMPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a prompt handed to the bridge (`delivered`) may stay unstarted before the next drain
 * takes it back (`queued`) and sends it again. The command queue's own retries finish well inside
 * this; it only matters when a command was lost for good (a dead-letter), so that one prompt cannot
 * hold up the queue behind it for ever.
 */
export const QUEUED_PROMPT_CLAIM_STALE_MS = 30 * 60 * 1000;

/** How long a GitHub webhook delivery id is remembered for dedupe (and its raw body kept). */
export const GITHUB_DELIVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How often the scheduled sweep runs (docs/github.md, "The sweep"). It is the second line behind
 * the webhook: GitHub does not retry a failed delivery, the 15-minute redelivery job asks for the
 * ones it can still list, and the sweep reads GitHub for what no delivery will ever say (a delivery
 * GitHub has dropped, a PR that closed while the App's webhook was off). Fifteen minutes is the
 * rhythm of the redelivery job, so a lost wake is late by at most about one interval after a
 * redelivery would have been due. A run costs one GSI2 query when nothing waits, and at most
 * SWEEP_MAX_PR_READS reads of GitHub, which is about 400 reads an hour of the installation's 5,000.
 */
export const SWEEP_INTERVAL_MINUTES = 15;

/** The most pull requests (and base branches) one sweep run reads. What is left waits for the next run. */
export const SWEEP_MAX_PR_READS = 100;

/** A run stops reading when GitHub says this few requests are left in the window. */
export const SWEEP_RATE_LIMIT_RESERVE = 500;

/** Debounce window for failing-check wakes, per PR. */
export const GITHUB_CHECKS_DEBOUNCE_MS = 2 * 60 * 1000;

/** Cap on quoted GitHub text (review bodies, comments) forwarded to the agent, in characters. */
export const GITHUB_QUOTE_MAX_CHARS = 8000;
