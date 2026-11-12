/**
 * The durable catch-up function: follows one detached cloud turn to its end.
 *
 * The SQS consumer starts one durable execution per detached turn (see
 * LambdaCatchUpScheduler) with a {@link CatchUpMessage} payload. The execution
 * repeats "catch up once, then wait" until the turn is completed, stale or
 * expired. Nothing is held across a wait: the engine and its ACP connection
 * are opened and closed inside each step (LambdaConsumer.catchUpOnce), and the
 * function never sends to its own trigger.
 *
 * Replay safety: the handler body runs again from the top on every resume, so
 * it does no I/O, clock reads or randomness outside steps. The 6 h expiry is
 * checked inside the step, through the consumer clock. Step results are tiny
 * ({ state, eventsWritten }) because they are checkpointed (1 MB limit), and a
 * 6 h execution is about 720 operations (limit 30,000).
 */

import { type DurableContext, withDurableExecution } from "@aws/durable-execution-sdk-js";
import {
  CATCH_UP_MAX_AGE_MS,
  type CatchUpResult,
  catchUpDelaySeconds,
  isCatchUpMessage,
} from "./catch-up.ts";
import { consumerConfigFromEnv, LambdaConsumer } from "./lambda-consumer.ts";
import { createLogger, type Logger } from "./logger.ts";

/** What the execution returns: the last round's state and how many rounds ran. */
export interface CatchUpSummary {
  /** `step_failed`: the step kept throwing until the expiry horizon; the turn was not settled. */
  state: CatchUpResult["state"] | "step_failed";
  attempts: number;
}

/** A thrown step error (a DynamoDB blip) is retried this many times in total. */
const STEP_MAX_ATTEMPTS = 3;

/** Backoff between step retries: 2 s, 4 s, ... */
function stepRetryStrategy(
  _error: Error,
  attempt: number,
): { shouldRetry: boolean; delay?: { seconds: number } } {
  return attempt < STEP_MAX_ATTEMPTS
    ? { shouldRetry: true, delay: { seconds: 2 ** attempt } }
    : { shouldRetry: false };
}

/**
 * Build the durable handler. `consumer` supplies the (container-cached)
 * consumer; `env` is read for the wait length.
 */
export function createCatchUpHandler(
  consumer: () => Promise<LambdaConsumer>,
  env: NodeJS.ProcessEnv = process.env,
  logger: Logger = createLogger(),
) {
  return withDurableExecution(
    async (event: unknown, context: DurableContext): Promise<CatchUpSummary> => {
      if (!isCatchUpMessage(event)) {
        throw new Error("catch-up-durable: payload is not a catch-up message");
      }
      const delay = catchUpDelaySeconds(env, logger);
      let attempt = event.attempt;
      for (;;) {
        const current = attempt;
        let result: CatchUpResult;
        try {
          result = await context.step(
            `catch-up-${current}`,
            async (): Promise<CatchUpResult> => {
              const { state, eventsWritten } = await (await consumer()).catchUpOnce({
                ...event,
                attempt: current,
              });
              return { state, eventsWritten };
            },
            { retryStrategy: stepRetryStrategy },
          );
        } catch (err) {
          // The step exhausted its retries (a throttling episode, a short
          // outage). Failing the execution would strand the session in
          // `running` with nothing left to settle it, so treat the round as
          // pending: wait and go again. The in-step 6 h check then fails the
          // turn once the dependency is back. Only a failure lasting past
          // the expiry horizon ends the execution, which is bounded by the
          // round count (no clock reads outside steps).
          const rounds = current - event.attempt + 1;
          logger.warn("catch_up_step_failed", {
            sessionId: event.sessionId,
            turnId: event.turnId,
            attempt: current,
            error: err instanceof Error ? err.message : String(err),
          });
          if (rounds * delay * 1000 > CATCH_UP_MAX_AGE_MS + delay * 1000) {
            return { state: "step_failed", attempts: rounds };
          }
          result = { state: "pending", eventsWritten: 0 };
        }
        if (result.state !== "pending" && result.state !== "load_failed") {
          return { state: result.state, attempts: current - event.attempt + 1 };
        }
        await context.wait(`wait-${current}`, { seconds: delay });
        attempt += 1;
      }
    },
  );
}

let consumerPromise: Promise<LambdaConsumer> | null = null;

/** The consumer is built once per container, without a catch-up scheduler. */
function getConsumer(): Promise<LambdaConsumer> {
  if (!consumerPromise) {
    consumerPromise = LambdaConsumer.create({ config: consumerConfigFromEnv() });
  }
  return consumerPromise;
}

export const handler = createCatchUpHandler(getConsumer);
