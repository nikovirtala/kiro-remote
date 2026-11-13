/**
 * Bridge metrics.
 *
 * The bridge emits the operational metrics the control plane needs. The
 * {@link MetricSink} is injectable so tests assert the exact metrics wired
 * without touching CloudWatch; the default sink is backed by Powertools
 * Metrics, which writes CloudWatch Embedded Metric Format to the Lambda's own
 * stdout (the ACP JSON-RPC channel is the spawned engine's stdio, not this
 * process's). The API owns the auth/CIMD/launch-facing metrics; the bridge
 * owns the ACP-facing ones, so each lives in its own service dimension.
 */

import {
  Metrics as PowertoolsMetrics,
  MetricUnit as PtMetricUnit,
} from "@aws-lambda-powertools/metrics";

const SERVICE_NAME = "kiro-remote-bridge";
const METRICS_NAMESPACE = "KiroRemote";

/** The complete set of metric names the bridge emits. */
export const METRIC_NAMES = [
  "EventsWritten",
  "TimeToFirstEvent",
  "TurnDuration",
  "RawEventsUnmapped",
  "SessionsLaunched",
  "LaunchPath",
  "CloudLaunchFailed",
  "CloudTurnFailed",
  "TurnDetached",
  "CatchUpCompleted",
  "CatchUpExpired",
  "WakesDelivered",
  "WakesDropped",
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
  /** Publish buffered metrics (call once per invocation). Optional for in-memory sinks. */
  flush?(): void;
}

const UNIT_FOR: Record<MetricName, MetricUnit> = {
  EventsWritten: "Count",
  TimeToFirstEvent: "Milliseconds",
  TurnDuration: "Milliseconds",
  RawEventsUnmapped: "Count",
  SessionsLaunched: "Count",
  LaunchPath: "Count",
  CloudLaunchFailed: "Count",
  CloudTurnFailed: "Count",
  TurnDetached: "Count",
  CatchUpCompleted: "Count",
  CatchUpExpired: "Count",
  WakesDelivered: "Count",
  WakesDropped: "Count",
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

  /** Publish any buffered metrics; a no-op for sinks that do not buffer. */
  flush(): void {
    this.sink.flush?.();
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

const PT_UNIT = {
  Count: PtMetricUnit.Count,
  Milliseconds: PtMetricUnit.Milliseconds,
  None: PtMetricUnit.NoUnit,
} as const;

/**
 * Default sink: Powertools Metrics (EMF). Datums without dimensions are
 * buffered until {@link MetricSink.flush}; dimensioned datums go through a
 * single-metric so each keeps its own dimension set.
 */
export function powertoolsMetricSink(
  metrics: PowertoolsMetrics = new PowertoolsMetrics({
    namespace: METRICS_NAMESPACE,
    serviceName: SERVICE_NAME,
  }),
): MetricSink {
  return {
    emit(datum) {
      if (datum.dimensions && Object.keys(datum.dimensions).length > 0) {
        const single = metrics.singleMetric();
        single.addDimensions(datum.dimensions);
        single.addMetric(datum.name, PT_UNIT[datum.unit], datum.value);
        return;
      }
      metrics.addMetric(datum.name, PT_UNIT[datum.unit], datum.value);
    },
    flush() {
      if (metrics.hasStoredMetrics()) {
        metrics.publishStoredMetrics();
      }
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
