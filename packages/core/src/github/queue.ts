/**
 * Messages on the GitHub standard SQS queue, and its producer.
 *
 * The queue is consumed by the GitHub consumer Lambda, the only function
 * besides the webhook ingress that can read the GitHub App secret. The bridge
 * has no GitHub credentials, so when a turn settles it asks the consumer to do
 * the GitHub-side work through this queue.
 */

import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";

/** A verified webhook delivery to process (its raw body is in the delivery store). */
export interface DeliveryMessage {
  kind: "delivery";
  deliveryId: string;
}

/** A turn settled: scan its events for pull request URLs and link them. */
export interface HarvestMessage {
  kind: "harvest";
  sessionId: string;
  turnId: string;
  /** META eventSeq when the turn began; the turn's events have seq > afterSeq. */
  afterSeq: number;
  /**
   * The turn was a completed post-merge wake with autoCloseOnMerge on. After
   * harvesting (so a PR opened in this very turn is linked), the consumer
   * deletes the session unless one of its linked PRs is still open, and
   * otherwise drains its inbox (the bridge skipped the drain).
   */
  autoClose?: boolean;
}

/** Drain a session's inbox (sent delayed, when a debounced item becomes due). */
export interface DrainMessage {
  kind: "drain";
  sessionId: string;
}

export type GithubQueueMessage = DeliveryMessage | HarvestMessage | DrainMessage;

export function isGithubQueueMessage(value: unknown): value is GithubQueueMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  switch (v.kind) {
    case "delivery":
      return typeof v.deliveryId === "string" && v.deliveryId.length > 0;
    case "harvest":
      return (
        typeof v.sessionId === "string" &&
        typeof v.turnId === "string" &&
        typeof v.afterSeq === "number"
      );
    case "drain":
      return typeof v.sessionId === "string";
    default:
      return false;
  }
}

export interface GithubQueue {
  send(message: GithubQueueMessage, delaySeconds?: number): Promise<void>;
}

export class SqsGithubQueue implements GithubQueue {
  private readonly sqs: SQSClient;
  private readonly queueUrl: string;

  constructor(deps: { sqs: SQSClient; queueUrl: string }) {
    this.sqs = deps.sqs;
    this.queueUrl = deps.queueUrl;
  }

  async send(message: GithubQueueMessage, delaySeconds?: number): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message),
        ...(delaySeconds
          ? { DelaySeconds: Math.min(900, Math.max(0, Math.ceil(delaySeconds))) }
          : {}),
      }),
    );
  }
}
