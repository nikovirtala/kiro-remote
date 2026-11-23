/**
 * The scheduled sweep (docs/github.md, "The sweep"): one function, one EventBridge schedule, a list of
 * passes. It reads GitHub for what a webhook should have said (a PR that closed, a base branch that
 * moved) and writes the same decisions through the same paths as the webhook consumer, so it needs
 * what the consumer needs: the table, the queues and the App secret.
 */

import { SWEEP_INTERVAL_MINUTES } from "@nikovirtala/kiro-remote-core";
import { createLogger, powertoolsMetrics } from "../log.ts";
import { runSweep, type SweepDeps } from "../sweep/index.ts";
import {
  buildQueues,
  buildRepository,
  consumerConfigFromEnv,
  deferredClient,
  lazyClient,
  secretLoader,
} from "./runtime.ts";

let deps: SweepDeps | null = null;

function getDeps(): SweepDeps {
  if (!deps) {
    const env = process.env;
    const queues = buildQueues(env);
    if (!queues.commandQueue) {
      throw new Error("missing required environment variable: COMMAND_QUEUE_URL");
    }
    deps = {
      repo: buildRepository(env),
      github: deferredClient(lazyClient(secretLoader(env))),
      queue: queues.commandQueue,
      githubQueue: queues.githubQueue,
      config: consumerConfigFromEnv(env),
      metrics: powertoolsMetrics(),
      logger: createLogger(),
      now: () => Date.now(),
    };
  }
  return deps;
}

export async function handler(): Promise<{ prsRead: number }> {
  const d = getDeps();
  try {
    const result = await runSweep(d, { intervalMs: SWEEP_INTERVAL_MINUTES * 60_000 });
    if (result.failedPasses.length > 0) {
      // After the other passes ran: the Errors metric shows it, and the next run tries again.
      throw new Error(`sweep passes failed: ${result.failedPasses.join(", ")}`);
    }
    return { prsRead: result.prsRead };
  } finally {
    d.metrics.flush();
  }
}
