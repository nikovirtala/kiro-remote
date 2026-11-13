/** Structured logging and metrics for the GitHub functions. Everything passes through core's redactor. */

import { type LogItem, Logger as PowertoolsLogger } from "@aws-lambda-powertools/logger";
import { MetricUnit, Metrics as PowertoolsMetrics } from "@aws-lambda-powertools/metrics";
import { redact } from "@nikovirtala/kiro-remote-core";

const SERVICE_NAME = "kiro-remote-github";
const METRICS_NAMESPACE = "KiroRemote/GitHub";

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/**
 * A Powertools Logger whose whole record (keys and values) is run through
 * {@link redact} right before it is written to the sink.
 */
class RedactingLogger extends PowertoolsLogger {
  private readonly write: (line: string) => void;

  constructor(write: (line: string) => void) {
    super({ serviceName: SERVICE_NAME });
    this.write = write;
  }

  protected override printLog(_logLevel: number, log: LogItem): void {
    log.prepareForPrint();
    this.write(JSON.stringify(redact(log.getAttributes()), this.getJsonReplacer()));
  }
}

export function createLogger(write: (line: string) => void = (l) => console.log(l)): Logger {
  const pt = new RedactingLogger(write);
  return {
    info: (m, f) => pt.info(m, f ?? {}),
    warn: (m, f) => pt.warn(m, f ?? {}),
    error: (m, f) => pt.error(m, f ?? {}),
  };
}

export const METRIC_NAMES = [
  "WebhooksReceived",
  "WebhooksRejectedSignature",
  "WebhooksDuplicate",
  "WebhooksDropped",
  "WebhooksUnmatched",
  "LinksCreated",
  "LinksRejected",
  "WakesDelivered",
  "WakesDropped",
  "Redelivered",
  "AutoClosed",
  "AutoCloseSkipped",
] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

export interface Metrics {
  count(name: MetricName, value?: number, dimensions?: Record<string, string>): void;
  /** Publish buffered metrics. Handlers call this once per invocation. */
  flush(): void;
}

/**
 * Powertools Metrics (CloudWatch EMF), namespace KiroRemote/GitHub. Plain
 * counts are buffered until {@link Metrics.flush}; dimensioned counts go
 * through a single-metric so each keeps its own dimension set.
 */
export function powertoolsMetrics(
  metrics: PowertoolsMetrics = new PowertoolsMetrics({
    namespace: METRICS_NAMESPACE,
    serviceName: SERVICE_NAME,
  }),
): Metrics {
  return {
    count(name, value = 1, dimensions = {}) {
      if (Object.keys(dimensions).length > 0) {
        const single = metrics.singleMetric();
        single.addDimensions(dimensions);
        single.addMetric(name, MetricUnit.Count, value);
        return;
      }
      metrics.addMetric(name, MetricUnit.Count, value);
    },
    flush() {
      if (metrics.hasStoredMetrics()) {
        metrics.publishStoredMetrics();
      }
    },
  };
}

/** Collecting metrics for tests. */
export class CollectingMetrics implements Metrics {
  readonly data: Array<{ name: MetricName; value: number; dimensions: Record<string, string> }> =
    [];
  count(name: MetricName, value = 1, dimensions: Record<string, string> = {}): void {
    this.data.push({ name, value, dimensions });
  }
  flush(): void {}
  sum(name: MetricName, dimensions?: Record<string, string>): number {
    return this.data
      .filter((d) => d.name === name)
      .filter(
        (d) => !dimensions || Object.entries(dimensions).every(([k, v]) => d.dimensions[k] === v),
      )
      .reduce((a, d) => a + d.value, 0);
  }
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
