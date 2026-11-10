/**
 * The e2e run report.
 *
 * Each step is recorded once: PASSED (its run made real requests and every
 * assertion held), FAILED (a request or assertion failed; the reason is the
 * redacted error), or SKIPPED (a prerequisite was missing; the reason says
 * which). The harness never records a pass for a step that did not run.
 *
 * Every value written to the report goes through the scrubber: core's
 * {@link redact} (ksk_ keys, bearer tokens, JWTs, OAuth URLs and codes,
 * sensitive-keyed fields), then literal replacement of the configured secrets
 * (the target repo) with [REDACTED].
 */
import { REDACTED, redact } from "@nikovirtala/kiro-remote-core";

/** The outcome of a single harness step. */
export type StepStatus = "passed" | "failed" | "skipped";

/** A single step's result. */
export interface StepResult {
  /** Stable step id, e.g. "mcp-launch". */
  id: string;
  /** Human-readable step name. */
  name: string;
  status: StepStatus;
  /** For failed/skipped steps: why. */
  reason?: string;
  /** How long the step ran (passed/failed only). */
  durationMs?: number;
  /** Non-secret scalars the step observed (ids, statuses, counts, durations). */
  captured?: Record<string, unknown>;
}

/** The whole run report. Safe to print. */
export interface RunReport {
  startedAt: string;
  finishedAt?: string;
  /** Non-secret config snapshot (presence booleans only for secrets). */
  config: Record<string, unknown>;
  steps: StepResult[];
}

/** Deep-replace every non-empty literal in strings, after core redaction. */
export function makeScrubber(literals: string[]): <T>(value: T) => T {
  const secrets = literals.filter((l) => l.length > 0);
  const scrubString = (s: string): string => {
    let out = s;
    for (const secret of secrets) {
      out = out.split(secret).join(REDACTED);
    }
    return out;
  };
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      return scrubString(value);
    }
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  return <T>(value: T): T => walk(redact(value)) as T;
}

/** Accumulates step results, scrubbing on every write. */
export class Report {
  private readonly steps: StepResult[] = [];
  private readonly startedAt = new Date().toISOString();
  private readonly configSnapshot: Record<string, unknown>;
  /** The scrubber every harness output passes through. */
  readonly scrub: <T>(value: T) => T;

  constructor(config: Record<string, unknown>, opts: { literalSecrets?: string[] } = {}) {
    this.scrub = makeScrubber(opts.literalSecrets ?? []);
    this.configSnapshot = this.scrub({ ...config });
  }

  /** Record a step whose requests ran and whose assertions all held. */
  pass(id: string, name: string, captured?: Record<string, unknown>, durationMs?: number): void {
    this.steps.push({
      id,
      name,
      status: "passed",
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(captured ? { captured: this.scrub({ ...captured }) } : {}),
    });
  }

  /** Record a step that ran and failed. */
  fail(id: string, name: string, reason: string, durationMs?: number): void {
    this.steps.push({
      id,
      name,
      status: "failed",
      reason: this.scrub(reason),
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
  }

  /** Record a step that did not run. */
  skip(id: string, name: string, reason: string): void {
    this.steps.push({ id, name, status: "skipped", reason: this.scrub(reason) });
  }

  /** The status of a recorded step, if any. */
  statusOf(id: string): StepStatus | undefined {
    return this.steps.find((s) => s.id === id)?.status;
  }

  /**
   * 0 when every recorded step passed, 1 when any failed, else 2 when any was
   * skipped (or nothing was recorded at all).
   */
  get exitCode(): 0 | 1 | 2 {
    if (this.steps.some((s) => s.status === "failed")) {
      return 1;
    }
    if (this.steps.length === 0 || this.steps.some((s) => s.status === "skipped")) {
      return 2;
    }
    return 0;
  }

  /** Assemble the final report object (already scrubbed). */
  build(): RunReport {
    return {
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      config: this.configSnapshot,
      steps: this.steps,
    };
  }
}
