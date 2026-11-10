/**
 * E2E harness configuration, read ONLY from the environment.
 *
 *   KIRO_REMOTE_URL    the deployed stack's public base URL (https://<host>).
 *                      Not a secret. Without it no live step can run.
 *   KIRO_API_E2E_REPO  the repo the launch steps target (owner/repo). Treated
 *                      as a secret: held in memory only, surfaced to the report
 *                      as a presence boolean, and scrubbed from every line the
 *                      harness writes.
 *
 * The bearer token comes from the `kiro-remote login` keychain (see auth.ts),
 * never from the environment.
 */
/** The non-secret, loggable configuration. */
export interface HarnessConfig {
  /** The deployed control-plane base URL without a trailing slash, or null when unset. */
  baseUrl: string | null;
  /** Whether KIRO_API_E2E_REPO is present (never its value). */
  hasRepo: boolean;
}
/**
 * A secret the harness holds in memory only. Access it exclusively through the
 * {@link Secrets} accessors so a secret value can never be spread into a log or
 * report object by accident.
 */
export interface Secrets {
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
  const repo = clean(env.KIRO_API_E2E_REPO);
  const config: HarnessConfig = {
    baseUrl: baseUrl ? baseUrl.replace(/\/+$/, "") : null,
    hasRepo: repo !== null,
  };
  const secrets: Secrets = {
    repo: () => repo,
  };
  return { config, secrets };
}
