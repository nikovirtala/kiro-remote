/**
 * Bridge metrics.
 *
 * The bridge emits the operational metrics the control plane needs. The
 * {@link MetricSink} is injectable so tests assert the exact metrics wired
 * without touching CloudWatch; the default sink emits an EMF-style line to
 * stdout's sibling (stderr) via the logger.
 */

import type { Logger } from "./logger.ts";

/** The complete set of metric names the bridge emits. */
export const METRIC_NAMES = [
  "AcpRestarts",
  "EventsWritten",
  "TimeToFirstEvent",
  "TurnDuration",
  "PermissionWait",
  "RawEventsUnmapped",
  "SessionsLaunched",
  "LaunchPath",
  "CloudLaunchFailed",
  "CloudTurnFailed",
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

export type MetricUnit = "Count" | "Milliseconds" | "None";

export interface MetricDatum {
  name: MetricName;
  value: number;
  unit: MetricUnit;
  dimensions?: Record<string, string>;
}

export interface MetricSink {
  emit(datum: MetricDatum): void;
}

const UNIT_FOR: Record<MetricName, MetricUnit> = {
  AcpRestarts: "Count",
  EventsWritten: "Count",
  TimeToFirstEvent: "Milliseconds",
  TurnDuration: "Milliseconds",
  PermissionWait: "Milliseconds",
  RawEventsUnmapped: "Count",
  SessionsLaunched: "Count",
  LaunchPath: "Count",
  CloudLaunchFailed: "Count",
  CloudTurnFailed: "Count",
};

/** Thin recorder over a {@link MetricSink} that fills in the canonical unit. */
export class Metrics {
  private readonly sink: MetricSink;

  constructor(sink: MetricSink) {
    this.sink = sink;
  }

  count(name: MetricName, value = 1, dimensions?: Record<string, string>): void {
    this.sink.emit({ name, value, unit: UNIT_FOR[name], ...(dimensions ? { dimensions } : {}) });
  }

  duration(name: MetricName, ms: number, dimensions?: Record<string, string>): void {
    this.sink.emit({
      name,
      value: ms,
      unit: "Milliseconds",
      ...(dimensions ? { dimensions } : {}),
    });
  }
}

/** Default sink: structured log line (so metrics appear in CloudWatch Logs). */
export function loggerMetricSink(logger: Logger): MetricSink {
  return {
    emit(datum) {
      logger.info("metric", {
        metric: datum.name,
        value: datum.value,
        unit: datum.unit,
        ...(datum.dimensions ?? {}),
      });
    },
  };
}

/** Collecting sink for tests: records every datum in memory. */
export class CollectingMetricSink implements MetricSink {
  readonly data: MetricDatum[] = [];
  emit(datum: MetricDatum): void {
    this.data.push(datum);
  }
  names(): MetricName[] {
    return this.data.map((d) => d.name);
  }
  sum(name: MetricName): number {
    return this.data.filter((d) => d.name === name).reduce((a, d) => a + d.value, 0);
  }
}
