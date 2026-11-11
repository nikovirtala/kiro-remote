/**
 * Missed deliveries. GitHub does not retry failed webhook deliveries
 * (https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries),
 * so a scheduled function lists the App's recent deliveries, picks the ones
 * that failed and have not since succeeded, and asks GitHub to redeliver
 * them. A redelivery keeps its X-GitHub-Delivery id, so ingress dedupe still
 * applies when it arrives.
 */

import type { GithubClient, WebhookDeliverySummary } from "./app-client.ts";
import type { Logger, Metrics } from "./log.ts";

/** Per-run cap. */
export const MAX_REDELIVERIES_PER_RUN = 50;

/** Failed deliveries (status other than OK) whose guid has no successful attempt, newest first. */
export function pickFailed(
  deliveries: readonly WebhookDeliverySummary[],
  max = MAX_REDELIVERIES_PER_RUN,
) {
  const recovered = new Set(deliveries.filter((d) => d.status === "OK").map((d) => d.guid));
  const seen = new Set<string>();
  const picked: WebhookDeliverySummary[] = [];
  const newestFirst = [...deliveries].sort(
    (a, b) => Date.parse(b.deliveredAt) - Date.parse(a.deliveredAt),
  );
  for (const d of newestFirst) {
    if (d.status === "OK" || recovered.has(d.guid) || seen.has(d.guid)) {
      continue;
    }
    seen.add(d.guid);
    picked.push(d);
    if (picked.length >= max) {
      break;
    }
  }
  return picked;
}

export async function redeliverMissed(deps: {
  github: Pick<GithubClient, "listAppDeliveries" | "redeliver">;
  metrics: Metrics;
  logger: Logger;
  max?: number;
}): Promise<{ redelivered: number; failed: number }> {
  const deliveries = await deps.github.listAppDeliveries(100);
  const picked = pickFailed(deliveries, deps.max ?? MAX_REDELIVERIES_PER_RUN);
  let redelivered = 0;
  let failed = 0;
  for (const d of picked) {
    try {
      await deps.github.redeliver(d.id);
      redelivered++;
      deps.metrics.count("Redelivered");
    } catch (err) {
      failed++;
      deps.logger.warn("redeliver_failed", { deliveryId: d.guid, error: String(err) });
    }
  }
  deps.logger.info("redelivery_run", { listed: deliveries.length, redelivered, failed });
  return { redelivered, failed };
}
