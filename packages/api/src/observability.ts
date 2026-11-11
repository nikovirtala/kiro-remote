/**
 * Powertools for AWS Lambda wiring, with all structured log attributes routed
 * through core's {@link redact} so no token, code, verifier, key, or OAuth URL
 * can leak into CloudWatch. The API owns the auth/CIMD/launch-facing metrics;
 * the bridge owns the ACP-facing ones (TimeToFirstEvent/TurnDuration/...), so
 * we deliberately do NOT emit those here to avoid double counting.
 */

import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { redact } from "@nikovirtala/kiro-remote-core";

const SERVICE_NAME = "kiro-remote-api";
const METRICS_NAMESPACE = "KiroRemote";

/**
 * Turn an unknown thrown value into a plain, loggable object. An `Error`'s
 * `name`/`message`/`stack` are non-enumerable, so `redact()` (which walks
 * enumerable keys) would otherwise drop them; we copy them onto a plain object
 * so the subsequent {@link redact} pass scrubs any token/URL they carry.
 */
function normalizeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { value: typeof err === "string" ? err : String(err) };
}

/**
 * Normalize an `err` attribute (if present) to a plain object before the
 * attributes are handed to {@link redact}.
 */
function prepareAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  if ("err" in attributes) {
    return { ...attributes, err: normalizeError(attributes.err) };
  }
  return attributes;
}

/** The metrics the API layer owns. */
export type ApiMetricName = "SessionsLaunched" | "AuthFailures" | "CimdFetches" | "LinksCreated";

/** Outcome dimension values for {@link ApiMetricName} CimdFetches. */
export type CimdOutcome = "success" | "error" | "cached";

/** Reason dimension values for AuthFailures. */
export type AuthFailureReason = "missing_token" | "invalid_token" | "insufficient_scope";

/** How a session was launched (plain launch vs adopt). */
export type LaunchPath = "launch" | "adopt";

/**
 * An observability facade so route code depends on a tiny, redaction-safe
 * surface instead of the raw Powertools objects. Injectable for tests.
 */
export interface Observability {
  /** Log an info line with redacted structured attributes. */
  info(message: string, attributes?: Record<string, unknown>): void;
  /** Log a warning line with redacted structured attributes. */
  warn(message: string, attributes?: Record<string, unknown>): void;
  /**
   * Log an error line with redacted structured attributes. Use this for
   * unexpected failures (the 500 class); a thrown value under the `err` key is
   * normalized to `{ name, message, stack }` before redaction so a token/URL
   * carried inside an exception message or stack cannot leak into CloudWatch.
   */
  error(message: string, attributes?: Record<string, unknown>): void;
  /** Record an auth failure, dimensioned by reason. */
  authFailure(reason: AuthFailureReason): void;
  /** Record a CIMD fetch, dimensioned by outcome. */
  cimdFetch(outcome: CimdOutcome): void;
  /** Record a successful session launch, dimensioned by launch path. */
  sessionLaunched(path: LaunchPath): void;
  /** Record a PR link created through the API, dimensioned by method (always "manual" here). */
  linkCreated(method: "manual"): void;
  /** Flush buffered metrics (call once per invocation). */
  flush(): void;
}

/** Production observability backed by Powertools. */
export class PowertoolsObservability implements Observability {
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  readonly tracer: Tracer;

  constructor(deps?: { logger?: Logger; metrics?: Metrics; tracer?: Tracer }) {
    this.logger = deps?.logger ?? new Logger({ serviceName: SERVICE_NAME });
    this.metrics =
      deps?.metrics ?? new Metrics({ namespace: METRICS_NAMESPACE, serviceName: SERVICE_NAME });
    this.tracer = deps?.tracer ?? new Tracer({ serviceName: SERVICE_NAME });
  }

  info(message: string, attributes: Record<string, unknown> = {}): void {
    this.logger.info(message, redact(attributes));
  }

  warn(message: string, attributes: Record<string, unknown> = {}): void {
    this.logger.warn(message, redact(attributes));
  }

  error(message: string, attributes: Record<string, unknown> = {}): void {
    this.logger.error(message, redact(prepareAttributes(attributes)));
  }

  authFailure(reason: AuthFailureReason): void {
    this.metrics.addDimension("reason", reason);
    this.metrics.addMetric("AuthFailures", MetricUnit.Count, 1);
    this.metrics.clearDimensions();
  }

  cimdFetch(outcome: CimdOutcome): void {
    this.metrics.addDimension("outcome", outcome);
    this.metrics.addMetric("CimdFetches", MetricUnit.Count, 1);
    this.metrics.clearDimensions();
  }

  sessionLaunched(path: LaunchPath): void {
    this.metrics.addDimension("launchPath", path);
    this.metrics.addMetric("SessionsLaunched", MetricUnit.Count, 1);
    this.metrics.clearDimensions();
  }

  linkCreated(method: "manual"): void {
    this.metrics.addDimension("method", method);
    this.metrics.addMetric("LinksCreated", MetricUnit.Count, 1);
    this.metrics.clearDimensions();
  }

  flush(): void {
    this.metrics.publishStoredMetrics();
  }
}

/** A no-op observability used as a default in tests. */
export class NoopObservability implements Observability {
  info(): void {}
  warn(): void {}
  error(): void {}
  authFailure(): void {}
  cimdFetch(): void {}
  sessionLaunched(): void {}
  linkCreated(): void {}
  flush(): void {}
}
