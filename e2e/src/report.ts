/**
 * The e2e run report.
 *
 * A step either RAN (and may carry captured artifacts) or is BLOCKED (and
 * carries the exact reason it could not run). The harness NEVER fabricates a
 * transcript, a metric, a discovery chain, a tool list, or a connector result:
 * a value is recorded only when the step that produces it actually ran for
 * real, otherwise the artifact is written as `blocked: <reason>`.
 *
 * Every captured value is routed through core's {@link redact} before it is
 * stored, so no ksk_ key, bearer token, auth code, PKCE verifier, refresh
 * token, or OAuth URL can survive into the report even if a caller forgets to
 * scrub a particular field. The secrets themselves are surfaced ONLY as
 * presence booleans by the config layer and are never passed to the report.
 */

import { redact } from "@kiro-remote/core";

/** The outcome of a single harness step. */
export type StepStatus = "ran" | "blocked" | "skipped";

/** A single step's result. */
export interface StepResult {
  /** Stable step id, e.g. "login", "launch", "poll". */
  id: string;
  /** Human-readable step name. */
  name: string;
  status: StepStatus;
  /** For blocked/skipped steps: the exact, non-fabricated reason. */
  reason?: string;
  /**
   * Captured artifacts, present only when the step RAN for real. Routed
   * through redact on write.
   */
  captured?: Record<string, unknown>;
}

/** A derived artifact: producible WITHOUT a live Kiro run, clearly labelled. */
export interface DerivedArtifact {
  id: string;
  /** Where it was derived from (static registry, fake-ACP harness, code rule). */
  source: string;
  value: unknown;
}

/** The whole run report. Safe to print and to summarize in a PR body. */
export interface RunReport {
  startedAt: string;
  finishedAt?: string;
  /** Non-secret config snapshot (presence booleans only for secrets). */
  config: Record<string, unknown>;
  steps: StepResult[];
  /** Artifacts derivable offline, labelled as NOT from a live Kiro run. */
  derived: DerivedArtifact[];
}

/**
 * Accumulates step results and derived artifacts, redacting on every write.
 * The report is the only thing the harness emits, and it is emitted to stdout
 * (never persisted to a committed file by the harness itself).
 */
export class Report {
  private readonly steps: StepResult[] = [];
  private readonly derived: DerivedArtifact[] = [];
  private readonly startedAt = new Date().toISOString();
  private readonly configSnapshot: Record<string, unknown>;

  constructor(config: Record<string, unknown>) {
    // Redact defensively even though config carries only presence booleans.
    this.configSnapshot = redact({ ...config });
  }

  /** Record a step that ran for real, with optional captured artifacts. */
  ran(id: string, name: string, captured?: Record<string, unknown>): void {
    this.steps.push({
      id,
      name,
      status: "ran",
      ...(captured ? { captured: redact({ ...captured }) } : {}),
    });
  }

  /** Record a step that could not run, with the exact reason. */
  blocked(id: string, name: string, reason: string): void {
    this.steps.push({ id, name, status: "blocked", reason: redact(reason) });
  }

  /** Record a step that was intentionally skipped (e.g. depends on a blocked step). */
  skipped(id: string, name: string, reason: string): void {
    this.steps.push({ id, name, status: "skipped", reason: redact(reason) });
  }

  /** Record an artifact derived offline (labelled as NOT from a live Kiro run). */
  derive(id: string, source: string, value: unknown): void {
    this.derived.push({ id, source, value: redact(value) });
  }

  /** True when at least one step ran for real. */
  get anyRan(): boolean {
    return this.steps.some((s) => s.status === "ran");
  }

  /** Assemble the final report object (already fully redacted). */
  build(): RunReport {
    return {
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      config: this.configSnapshot,
      steps: this.steps,
      derived: this.derived,
    };
  }
}
