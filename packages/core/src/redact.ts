/**
 * Secret redaction.
 *
 * Every logger in every package routes strings and structured payloads through
 * {@link redact} / {@link redactValue} before anything is written to logs,
 * events, errors, or disk. The goal is that no real secret can escape even if a
 * caller forgets to scrub a particular field.
 *
 * What is scrubbed:
 *  - Kiro API keys (ksk_ prefix)
 *  - Bearer tokens (Authorization: Bearer <...>)
 *  - OAuth authorization codes and PKCE code verifiers
 *  - Refresh tokens
 *  - OAuth URLs (authorize/callback/token endpoints and their query strings)
 */

export const REDACTED = "[REDACTED]";

/**
 * Field names whose VALUES are always replaced wholesale, regardless of their
 * shape. Matched case-insensitively against object keys.
 */
const SENSITIVE_KEYS = new Set(
  [
    "authorization",
    "access_token",
    "accesstoken",
    "id_token",
    "idtoken",
    "refresh_token",
    "refreshtoken",
    "code",
    "code_verifier",
    "codeverifier",
    "client_secret",
    "clientsecret",
    "api_key",
    "apikey",
    "kiro_api_key",
    "x-api-key",
    "password",
    "secret",
    "privatekey",
    "private_key",
    "webhooksecret",
    "webhook_secret",
    "token",
    "x-hub-signature-256",
    "x-hub-signature",
  ].map((k) => k.toLowerCase()),
);

/** Patterns applied to free-form strings. Order matters (URLs before tokens). */
const STRING_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // OAuth URLs: scrub the whole URL since the query string carries code,
  // state, code_challenge, etc.
  [
    /https?:\/\/[^\s"']*\/(?:oauth2?\/)?(?:authorize|callback|token|revoke|\.well-known\/[^\s"']*)[^\s"']*/gi,
    REDACTED,
  ],
  // Any URL carrying a sensitive query parameter.
  [
    /https?:\/\/[^\s"']*[?&](?:code|access_token|refresh_token|id_token|code_verifier|code_challenge|client_secret|state)=[^\s"']*/gi,
    REDACTED,
  ],
  // Kiro API keys.
  [/ksk_[A-Za-z0-9._-]+/g, REDACTED],
  // PEM private keys (a GitHub App key), whole block.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  // A PEM key whose END line was cut off or lost: redact from BEGIN to the end of the string.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g, REDACTED],
  // GitHub tokens: installation (ghs_), user (ghu_), OAuth (gho_), refresh (ghr_), PAT (ghp_, github_pat_).
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED],
  // Webhook signatures.
  [/sha256=[0-9a-fA-F]{64}/g, `sha256=${REDACTED}`],
  // Authorization: Bearer <token>
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`],
  // Bare JWT-looking triples (header.payload.signature).
  [/\beyJ[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/g, REDACTED],
];

/** Scrub a single free-form string. */
export function redactString(input: string): string {
  let out = input;
  for (const [pattern, replacement] of STRING_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Recursively scrub a value of any shape. Objects and arrays are copied; the
 * input is never mutated. Sensitive-keyed values are replaced wholesale, and
 * every surviving string is run through the pattern scrubber.
 */
export function redactValue(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      out[key] = REDACTED;
    } else {
      out[key] = redactValue(val, seen);
    }
  }
  return out;
}

/**
 * Convenience entry point for loggers: accepts anything, returns a scrubbed
 * copy. Strings stay strings; everything else is deep-scrubbed.
 */
export function redact<T>(value: T): T {
  return redactValue(value) as T;
}
