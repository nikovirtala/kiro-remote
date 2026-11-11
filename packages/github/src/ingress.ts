/**
 * Webhook ingress: POST /github/webhook.
 *
 * The request does the minimum and returns 202 well inside GitHub's 10 second
 * limit: verify the signature over the raw bytes, drop events for repos outside
 * ALLOWED_REPOS, claim the delivery id (a conditional put, 7 day TTL), store the
 * raw delivery, and enqueue its id. Everything else happens in the consumer.
 *
 * The signature is the route's only authentication; it bypasses authenticate()
 * on purpose (see SECURITY.md).
 */

import type { GithubQueue } from "@nikovirtala/kiro-remote-core";
import { matchesAllowList, type Repository } from "@nikovirtala/kiro-remote-core";
import type { Logger, Metrics } from "./log.ts";
import { verifySignature } from "./signature.ts";
import { isHandledEvent } from "./types.ts";

export interface IngressDeps {
  /** The webhook secret (Secrets Manager). */
  webhookSecret: () => Promise<string>;
  repo: Pick<Repository, "putDelivery" | "deleteDelivery">;
  queue: GithubQueue;
  allowedRepos: readonly string[];
  metrics: Metrics;
  logger: Logger;
}

export interface IngressRequest {
  /** Lower-cased header names. */
  headers: Record<string, string | undefined>;
  /** The exact bytes GitHub sent. */
  body: Buffer;
}

export interface IngressResponse {
  status: number;
  /** Only ever a short fixed string; request content is never echoed. */
  body: string;
}

export async function handleWebhook(
  deps: IngressDeps,
  req: IngressRequest,
): Promise<IngressResponse> {
  const secret = await deps.webhookSecret();
  // 1. Authenticate: signature over the raw body, before anything is parsed.
  if (!verifySignature(secret, req.body, req.headers["x-hub-signature-256"])) {
    deps.metrics.count("WebhooksRejectedSignature");
    deps.logger.warn("webhook_signature_rejected");
    return { status: 401, body: "" };
  }
  deps.metrics.count("WebhooksReceived");

  const event = req.headers["x-github-event"];
  const deliveryId = req.headers["x-github-delivery"];
  if (!event || !deliveryId || !/^[A-Za-z0-9-]{8,64}$/.test(deliveryId)) {
    return { status: 400, body: "" };
  }

  // Only the events the app subscribes to are stored. `ping` and installation
  // events are acknowledged and forgotten.
  if (!isHandledEvent(event)) {
    return { status: 202, body: "" };
  }

  const rawBody = req.body.toString("utf8");
  let payload: { action?: unknown; repository?: { full_name?: unknown } };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: "" };
  }
  const repoName =
    typeof payload.repository?.full_name === "string" ? payload.repository.full_name : null;
  if (!repoName || !matchesAllowList(repoName, deps.allowedRepos)) {
    deps.metrics.count("WebhooksDropped", 1, { reason: "repo_not_allowed" });
    deps.logger.info("webhook_repo_dropped", { event, deliveryId });
    return { status: 202, body: "" };
  }

  // 2. Dedupe + store in one conditional put.
  const stored = await deps.repo.putDelivery({
    deliveryId,
    event,
    action: typeof payload.action === "string" ? payload.action : null,
    repo: repoName.toLowerCase(),
    rawBody,
  });
  if (!stored) {
    deps.metrics.count("WebhooksDuplicate");
    return { status: 202, body: "" };
  }

  // 3. Hand off. If the hand-off fails, forget the delivery id so GitHub's
  // redelivery (or ours) is accepted instead of being dropped as a duplicate.
  try {
    await deps.queue.send({ kind: "delivery", deliveryId });
  } catch (err) {
    deps.logger.error("webhook_enqueue_failed", { deliveryId, error: String(err) });
    await deps.repo.deleteDelivery(deliveryId).catch(() => undefined);
    return { status: 500, body: "" };
  }
  return { status: 202, body: "" };
}
