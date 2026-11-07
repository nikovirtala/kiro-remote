/**
 * SQS FIFO command intake.
 *
 * The bridge polls the FIFO command queue, dispatches each command by its
 * `kind` to the {@link SessionManager}, and deletes the message on success.
 * Per-session ordering is already guaranteed by the producer using
 * `MessageGroupId = sessionId`; the bridge honours it by processing a batch
 * sequentially. Every resulting event carries the caller `sub` for the audit
 * trail (recorded on the session/turn/permission rows and event metadata).
 *
 * The SQS client is injected so tests run fully offline.
 */

import {
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type { Command } from "@kiro-remote/core";
import type { Logger } from "./logger.ts";
import type { SessionManager } from "./session-manager.ts";

export interface IntakeDeps {
  sqs: SQSClient;
  queueUrl: string;
  manager: SessionManager;
  logger: Logger;
  /** Max messages per receive (SQS FIFO allows up to 10). */
  batchSize?: number;
  /** Long-poll seconds. */
  waitTimeSeconds?: number;
  /** Delay between polls when a receive returns no messages (ms). */
  idleDelayMs?: number;
}

export class CommandIntake {
  private readonly sqs: SQSClient;
  private readonly queueUrl: string;
  private readonly manager: SessionManager;
  private readonly logger: Logger;
  private readonly batchSize: number;
  private readonly waitTimeSeconds: number;
  private readonly idleDelayMs: number;
  private running = false;

  constructor(deps: IntakeDeps) {
    this.sqs = deps.sqs;
    this.queueUrl = deps.queueUrl;
    this.manager = deps.manager;
    this.logger = deps.logger;
    this.batchSize = deps.batchSize ?? 10;
    this.waitTimeSeconds = deps.waitTimeSeconds ?? 20;
    this.idleDelayMs = deps.idleDelayMs ?? 250;
  }

  /** Poll once: receive a batch, dispatch in arrival order, delete on success. */
  async pollOnce(): Promise<number> {
    const res = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: this.batchSize,
        WaitTimeSeconds: this.waitTimeSeconds,
        MessageSystemAttributeNames: ["MessageGroupId"],
      }),
    );
    const messages = res.Messages ?? [];
    for (const message of messages) {
      await this.handleMessage(message);
    }
    return messages.length;
  }

  /** Run the polling loop until {@link stop} is called. */
  async run(): Promise<void> {
    this.running = true;
    while (this.running) {
      try {
        const received = await this.pollOnce();
        // When a fast/empty source returns nothing, yield briefly so the loop
        // does not spin (real SQS long-polling blocks for waitTimeSeconds).
        if (received === 0) {
          await new Promise((r) => setTimeout(r, this.idleDelayMs));
        }
      } catch (err) {
        this.logger.error("intake_poll_error", { error: String(err) });
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  private async handleMessage(message: Message): Promise<void> {
    if (!message.Body) {
      await this.deleteMessage(message);
      return;
    }
    let command: Command;
    try {
      command = JSON.parse(message.Body) as Command;
    } catch (err) {
      this.logger.error("intake_parse_error", { error: String(err) });
      await this.deleteMessage(message);
      return;
    }
    try {
      await this.dispatch(command);
      await this.deleteMessage(message);
    } catch (err) {
      // Leave the message for redelivery (visibility timeout) on failure.
      this.logger.error("command_dispatch_error", {
        kind: command.kind,
        sessionId: command.sessionId,
        error: String(err),
      });
    }
  }

  async dispatch(command: Command): Promise<void> {
    const log = this.logger.child({
      sub: command.sub,
      sessionId: command.sessionId,
      commandId: command.commandId,
      kind: command.kind,
    });
    log.info("command_received");
    switch (command.kind) {
      case "launch":
        await this.manager.launch(command.sessionId, {
          prompt: command.prompt,
          repos: command.repos,
          ...(command.mode ? { mode: command.mode } : {}),
          ...(command.model ? { model: command.model } : {}),
          ...(command.effort ? { effort: command.effort } : {}),
        });
        return;
      case "prompt":
        // During an active turn a follow-up is steering; whenBusy honored.
        await this.manager.steer(command.sessionId, command.prompt, command.whenBusy);
        return;
      case "steer":
        await this.manager.steer(command.sessionId, command.content, "steer");
        return;
      case "cancel":
        await this.manager.cancel(command.sessionId);
        return;
      case "answerPermission":
        await this.manager.answerPermission(command.sessionId, command.requestId, {
          optionId: command.optionId,
          ...(command.consent ? { consent: command.consent } : {}),
        });
        return;
      case "setConfig":
        await this.manager.setConfig(command.sessionId, {
          ...(command.model ? { model: command.model } : {}),
          ...(command.effort ? { effort: command.effort } : {}),
          ...(command.mode ? { mode: command.mode } : {}),
        });
        return;
      case "delete":
        await this.manager.markDeleted(command.sessionId);
        return;
      default: {
        const never: never = command;
        throw new Error(`unknown command kind: ${(never as { kind: string }).kind}`);
      }
    }
  }

  private async deleteMessage(message: Message): Promise<void> {
    if (!message.ReceiptHandle) {
      return;
    }
    await this.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }
}
