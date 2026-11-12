/**
 * Starts the durable catch-up execution for a detached turn.
 *
 * One execution per turn: the execution name is derived from the session and
 * turn ids, so a repeated start (a leftover catch-up after a hard kill, a
 * redelivered record) is an idempotent no-op on the Lambda side.
 */

import { createHash } from "node:crypto";
import { DurableExecutionAlreadyStartedException, InvokeCommand } from "@aws-sdk/client-lambda";
import type { CatchUpMessage, CatchUpScheduler } from "./catch-up.ts";
import type { Logger } from "./logger.ts";

/** The slice of `LambdaClient` the scheduler uses (injectable for tests). */
export interface LambdaInvoker {
  send(command: InvokeCommand): Promise<{ StatusCode?: number; FunctionError?: string }>;
}

/**
 * The durable execution name for a detached turn: `cu-` + the first 40 hex
 * chars of sha256(`sessionId:turnId`). Execution names are 1..64 chars of
 * `[a-zA-Z0-9-_]`; ids can be UUIDs, so they are hashed rather than joined.
 * `detachedAt` and `attempt` are left out on purpose: one execution per turn.
 */
export function catchUpExecutionName(msg: Pick<CatchUpMessage, "sessionId" | "turnId">): string {
  const digest = createHash("sha256").update(`${msg.sessionId}:${msg.turnId}`).digest("hex");
  return `cu-${digest.slice(0, 40)}`;
}

function isAlreadyStarted(err: unknown): boolean {
  return (
    err instanceof DurableExecutionAlreadyStartedException ||
    (typeof err === "object" &&
      err !== null &&
      (err as { name?: unknown }).name === "DurableExecutionAlreadyStartedException")
  );
}

/** Starts a durable execution of the catch-up function with an async (Event) invoke. */
export class LambdaCatchUpScheduler implements CatchUpScheduler {
  private readonly lambda: LambdaInvoker;
  private readonly functionArn: string;
  private readonly logger: Logger;

  /** `functionArn` must be qualified (an alias or version ARN). */
  constructor(args: { lambda: LambdaInvoker; functionArn: string; logger: Logger }) {
    this.lambda = args.lambda;
    this.functionArn = args.functionArn;
    this.logger = args.logger;
  }

  async start(msg: CatchUpMessage): Promise<void> {
    const name = catchUpExecutionName(msg);
    try {
      const res = await this.lambda.send(
        new InvokeCommand({
          FunctionName: this.functionArn,
          InvocationType: "Event",
          Payload: JSON.stringify(msg),
          DurableExecutionName: name,
        }),
      );
      if (res.FunctionError) {
        throw new Error(`catch-up start failed: ${res.FunctionError}`);
      }
      if (res.StatusCode !== 202) {
        throw new Error(`catch-up start returned status ${String(res.StatusCode)}`);
      }
    } catch (err) {
      if (isAlreadyStarted(err)) {
        // Normal for a running execution. A closed (failed or timed out)
        // execution with the same name also lands here and cannot be
        // restarted, so this is a warning; check the execution status.
        this.logger.warn("catch_up_already_started", {
          sessionId: msg.sessionId,
          turnId: msg.turnId,
          executionName: name,
        });
        return;
      }
      throw err;
    }
  }
}
