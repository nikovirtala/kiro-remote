/**
 * E2E harness configuration, read ONLY from the environment.
 *
 * Two values are SECRETS and are never written to disk, logs, the report, or
 * any captured artifact:
 *   - KIRO_API_KEY         (ksk_ ...) the personal Kiro API key
 *   - KIRO_API_E2E_REPO    the GitHub repo the live run would target
 *
 * The harness holds them only in memory for the duration of a run. Everything
 * the harness emits goes through {@link redact} first, and the secrets are
 * surfaced to the report ONLY as presence booleans -- never their values, not
 * even a prefix or a length (a length would leak entropy).
 *
 * KIRO_REMOTE_URL is the deployed control-plane base URL (the canonical
 * https://<host>). It is NOT a secret, but in this sandbox it is unset, which
 * is the first expected blocker: with no deployed stack there is nothing to
 * target.
 */

/** The non-secret, loggable configuration. */
export interface HarnessConfig {
  /** The deployed control-plane base URL, or null when unset. */
  baseUrl: string | null;
  /** Whether KIRO_API_KEY is present in the environment (never its value). */
  hasApiKey: boolean;
  /** Whether KIRO_API_E2E_REPO is present (never its value). */
  hasRepo: boolean;
}

/**
 * A secret the harness holds in memory only. Access it exclusively through the
 * {@link Secrets} accessors so a secret value can never be spread into a log or
 * report object by accident.
 */
export interface Secrets {
  /** The Kiro API key, or null if absent. In-memory only. */
  apiKey(): string | null;
  /** The target repo, or null if absent. In-memory only. */
  repo(): string | null;
}

/** Trim and treat empty strings as absent. */
function clean(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Read the harness configuration and secrets from `env` (defaults to
 * process.env). The returned {@link HarnessConfig} is safe to log; the returned
 * {@link Secrets} must never be serialized.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): {
  config: HarnessConfig;
  secrets: Secrets;
} {
  const baseUrl = clean(env.KIRO_REMOTE_URL);
  const apiKey = clean(env.KIRO_API_KEY);
  const repo = clean(env.KIRO_API_E2E_REPO);

  const config: HarnessConfig = {
    baseUrl: baseUrl ? baseUrl.replace(/\/+$/, "") : null,
    hasApiKey: apiKey !== null,
    hasRepo: repo !== null,
  };

  const secrets: Secrets = {
    apiKey: () => apiKey,
    repo: () => repo,
  };

  return { config, secrets };
}
