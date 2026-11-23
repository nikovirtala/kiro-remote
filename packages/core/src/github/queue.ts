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

/**
 * Check whether one linked PR still merges into its base branch after that
 * branch moved. Sent delayed to ask GitHub again when it had not computed
 * mergeability yet (`mergeable: null`).
 */
export interface ConflictCheckMessage {
  kind: "conflict_check";
  repo: string;
  number: number;
  /** The base branch that moved. */
  base: string;
  /** The base branch's tip after the move, or "unknown". */
  baseSha: string;
  /** The PR whose merge moved the base; null for a push. */
  afterPr: number | null;
  deliveryId: string;
  /** Which try this is, starting at 1. */
  attempt: number;
  /** The PR's head sha at the first try; a different head later means the agent pushed. */
  headSha: string | null;
}

/**
 * Read an awaited PR once for a wait that was just registered: merged or closed fires the wait
 * now, open leaves it stored. The API holds no GitHub credentials, so it asks the consumer.
 */
export interface WaitCheckMessage {
  kind: "wait_check";
  sessionId: string;
  /** The awaited PR, owner/repo#n, lower-cased. */
  pr: string;
}

export type GithubQueueMessage =
  | DeliveryMessage
  | HarvestMessage
  | DrainMessage
  | ConflictCheckMessage
  | WaitCheckMessage;

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
    case "conflict_check":
      return (
        typeof v.repo === "string" &&
        typeof v.number === "number" &&
        typeof v.base === "string" &&
        typeof v.baseSha === "string" &&
        (v.afterPr === null || typeof v.afterPr === "number") &&
        typeof v.deliveryId === "string" &&
        typeof v.attempt === "number" &&
        (v.headSha === null || typeof v.headSha === "string")
      );
    case "wait_check":
      return typeof v.sessionId === "string" && typeof v.pr === "string" && v.pr.includes("#");
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
