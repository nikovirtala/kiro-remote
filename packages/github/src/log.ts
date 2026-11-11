/** Structured logging and metrics for the GitHub functions. Everything passes through core's redactor. */

import { redact } from "@nikovirtala/kiro-remote-core";

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(write: (line: string) => void = (l) => console.log(l)): Logger {
  const emit = (level: string, msg: string, fields: Record<string, unknown> = {}): void => {
    write(JSON.stringify(redact({ level, msg, service: "github", ...fields })));
  };
  return {
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
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
] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

export interface Metrics {
  count(name: MetricName, value?: number, dimensions?: Record<string, string>): void;
}

/** CloudWatch Embedded Metric Format on stdout, namespace KiroRemote/GitHub. */
export function emfMetrics(write: (line: string) => void = (l) => console.log(l)): Metrics {
  return {
    count(name, value = 1, dimensions = {}) {
      const dimNames = Object.keys(dimensions);
      write(
        JSON.stringify({
          _aws: {
            Timestamp: Date.now(),
            CloudWatchMetrics: [
              {
                Namespace: "KiroRemote/GitHub",
                Dimensions: [dimNames],
                Metrics: [{ Name: name, Unit: "Count" }],
              },
            ],
          },
          [name]: value,
          ...dimensions,
        }),
      );
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
