/**
 * The deploy's OpenTelemetry resource attributes, as the function's environment carries them
 * (`OTEL_RESOURCE_ATTRIBUTES`, stamped by the CDK construct from the deploy pipeline's context):
 * `vcs.ref.head.revision`, `vcs.repository.url.full`, `deployment.environment.name` and
 * `service.version`. The loggers put them on every line, so a log line says which commit wrote it.
 */

/** Parses `k=v,k=v` with percent-encoded values. Anything malformed is left out, never thrown. */
export function parseResourceAttributes(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (text ?? "").split(",")) {
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    try {
      out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
    } catch {
      // A bad escape: leave the attribute out.
    }
  }
  return out;
}

/** This process's resource attributes (empty outside a stamped function: tests, local runs). */
export function resourceAttributes(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  return parseResourceAttributes(env.OTEL_RESOURCE_ATTRIBUTES);
}
