/** The reads of GitHub one sweep run may make. */

import type { RateLimit } from "../app-client.ts";

/**
 * A cap on the reads of one run, shared by every pass, that also stops when GitHub's rate limit
 * headers say the installation is nearly out of requests. A pass asks {@link room} before it reads
 * and tells {@link spend} what it read; what the budget refuses waits for the next run.
 */
export class ReadBudget {
  private used = 0;
  private limited = false;
  private readonly cap: number;
  private readonly rateLimit: () => RateLimit | null;
  private readonly reserve: number;
  private readonly now: () => number;
  private readonly parent: ReadBudget | null;

  constructor(
    args: {
      cap: number;
      /** What GitHub last said (the client's rate limit headers), or null before the first answer. */
      rateLimit: () => RateLimit | null;
      /** Stop when this few requests are left in the window. */
      reserve: number;
      now: () => number;
    },
    parent: ReadBudget | null = null,
  ) {
    this.cap = args.cap;
    this.rateLimit = args.rateLimit;
    this.reserve = args.reserve;
    this.now = args.now;
    this.parent = parent;
  }

  /**
   * A budget for one pass: at most `cap` reads of its own, taken from this one. A pass with a
   * quota cannot use the whole run's reads, so a pass after it is never starved.
   */
  child(cap: number): ReadBudget {
    return new ReadBudget(
      { cap, rateLimit: this.rateLimit, reserve: this.reserve, now: this.now },
      this,
    );
  }

  /** How many more reads this run may make: 0 once the cap is reached or the rate limit is near. */
  room(): number {
    const rate = this.rateLimit();
    if (rate && rate.remaining <= this.reserve && rate.resetAtMs > this.now()) {
      this.limited = true;
    }
    const own = this.limited ? 0 : Math.max(0, this.cap - this.used);
    return this.parent ? Math.min(own, this.parent.room()) : own;
  }

  spend(reads = 1): void {
    this.used += reads;
    this.parent?.spend(reads);
  }

  /** The run was told by GitHub (a 403 or 429 answer) that it is rate limited: read no more. */
  stop(): void {
    this.limited = true;
    this.parent?.stop();
  }

  get reads(): number {
    return this.used;
  }

  get rateLimited(): boolean {
    return this.limited;
  }
}

/** GitHub's answer when a request is refused for the rate limit: 429, or 403 with none left. */
export function isRateLimited(err: unknown): boolean {
  const e = err as { status?: unknown; response?: { headers?: Record<string, unknown> } };
  if (e.status === 429) {
    return true;
  }
  return e.status === 403 && String(e.response?.headers?.["x-ratelimit-remaining"]) === "0";
}
