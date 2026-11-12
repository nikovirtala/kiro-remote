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
import { type CatchUpResult, catchUpDelaySeconds, isCatchUpMessage } from "./catch-up.ts";
import { consumerConfigFromEnv, LambdaConsumer } from "./lambda-consumer.ts";

/** What the execution returns: the last round's state and how many rounds ran. */
export interface CatchUpSummary {
  state: CatchUpResult["state"];
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
) {
  return withDurableExecution(
    async (event: unknown, context: DurableContext): Promise<CatchUpSummary> => {
      if (!isCatchUpMessage(event)) {
        throw new Error("catch-up-durable: payload is not a catch-up message");
      }
      const delay = catchUpDelaySeconds(env);
      let attempt = event.attempt;
      for (;;) {
        const current = attempt;
        const result = await context.step(
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
