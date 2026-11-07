/**
 * Container health.
 *
 * The health check fails if the ACP process has not answered for 60 s. The
 * gateway records the timestamp of the last successful agent message; the
 * health check compares it to `now`. A single file (HEALTH_FILE) is written so
 * an ECS/Docker `HEALTHCHECK` can read it without an HTTP server.
 */

/** Max silence (ms) from the ACP process before the container is unhealthy. */
export const ACP_SILENCE_LIMIT_MS = 60_000;

export interface HealthState {
  /** Epoch ms of the last message observed from the ACP process. */
  lastAcpActivityAt: number;
}

export class HealthMonitor {
  private lastAcpActivityAt: number;
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
    this.lastAcpActivityAt = now();
  }

  /** Call whenever the ACP process produces any message. */
  markActivity(): void {
    this.lastAcpActivityAt = this.now();
  }

  state(): HealthState {
    return { lastAcpActivityAt: this.lastAcpActivityAt };
  }

  /** True when the ACP process has answered within the silence limit. */
  isHealthy(): boolean {
    return this.now() - this.lastAcpActivityAt < ACP_SILENCE_LIMIT_MS;
  }
}
