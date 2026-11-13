/**
 * SQS consumer for the GitHub queue (deliveries, harvest requests, delayed
 * drains). The 15-minute EventBridge schedule invokes this same function with
 * `{ "kind": "redeliver" }`, so the App secret is readable by exactly two
 * functions: the webhook ingress and this one.
 */

import { isGithubQueueMessage } from "@nikovirtala/kiro-remote-core";
import { type ConsumerDeps, handleQueueMessage } from "../consumer.ts";
import { createLogger, powertoolsMetrics } from "../log.ts";
import { redeliverMissed } from "../redelivery.ts";
import {
  buildQueues,
  buildRepository,
  consumerConfigFromEnv,
  deferredClient,
  lazyClient,
  secretLoader,
} from "./runtime.ts";

interface SqsRecord {
  messageId: string;
  body: string;
}

let deps: ConsumerDeps | null = null;

function getDeps(): ConsumerDeps {
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

export async function processRecords(
  d: ConsumerDeps,
  records: SqsRecord[],
): Promise<{ batchItemFailures: Array<{ itemIdentifier: string }> }> {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];
  for (const record of records) {
    let message: unknown;
    try {
      message = JSON.parse(record.body);
    } catch {
      d.logger.error("github_message_unparseable", { messageId: record.messageId });
      continue; // cannot ever succeed: ack
    }
    if (!isGithubQueueMessage(message)) {
      d.logger.error("github_message_unknown", { messageId: record.messageId });
      continue;
    }
    try {
      await handleQueueMessage(d, message);
    } catch (err) {
      d.logger.error("github_message_failed", { kind: message.kind, error: String(err) });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}

export async function handler(event: { Records?: SqsRecord[]; kind?: string }) {
  const d = getDeps();
  try {
    if (!event.Records) {
      if (event.kind === "redeliver") {
        return await redeliverMissed({ github: d.github, metrics: d.metrics, logger: d.logger });
      }
      d.logger.error("github_consumer_unknown_event");
      return { batchItemFailures: [] };
    }
    return await processRecords(d, event.Records);
  } finally {
    d.metrics.flush();
  }
}
