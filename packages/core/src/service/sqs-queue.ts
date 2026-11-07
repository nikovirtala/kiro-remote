/**
 * Production {@link CommandQueue} producer backed by an SQS FIFO queue.
 *
 * Writes enqueue a {@link Command} as a JSON body with
 * `MessageGroupId = command.sessionId` so a single session's commands are
 * processed in order by the bridge. The queue is content-based-dedup (set by
 * the CDK construct), so no explicit `MessageDeduplicationId` is sent.
 *
 * The {@link SQSClient} is injected so the producer is unit-testable with a
 * fake client (no network), mirroring the bridge's consumer fakes.
 */

import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { Command, CommandQueue } from "./commands.ts";

export interface SqsCommandQueueDeps {
  sqs: SQSClient;
  queueUrl: string;
}

/** Sends commands to the SQS FIFO command queue consumed by the bridge. */
export class SqsCommandQueue implements CommandQueue {
  private readonly sqs: SQSClient;
  private readonly queueUrl: string;

  constructor(deps: SqsCommandQueueDeps) {
    this.sqs = deps.sqs;
    this.queueUrl = deps.queueUrl;
  }

  async enqueue(command: Command): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(command),
        // Per-session ordering: the FIFO group is the session id.
        MessageGroupId: command.sessionId,
        // The queue is content-based-dedup, so no MessageDeduplicationId.
      }),
    );
  }
}
