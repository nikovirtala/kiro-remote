/**
 * The Tasks extension's two tunables, in one place.
 *
 * Header: see index.ts. Both values are carried on every task handle and
 * every `tasks/get` answer, so a client sees the same numbers throughout.
 */

/**
 * How often a client should poll `tasks/get`, in milliseconds. A follow-up
 * turn on a warm cloud session takes about 9 s, and a first turn minutes, so
 * polling faster than every 5 s only multiplies Lambda invocations (each poll
 * of a running turn is one DynamoDB read, and a settled turn also reads the
 * event log). Clients may poll less often.
 */
export const TASK_POLL_INTERVAL_MS = 5_000;

/**
 * How long a task handle stays readable after it was created, in
 * milliseconds. Turn rows carry no TTL of their own (they live as long as the
 * session), and a queued prompt's row lives 7 days, so the limit is ours to
 * set: a task is "Task not found" once this has passed, even though the turn
 * can still be read with kiro_get_transcript. 24 hours covers a long
 * unattended turn plus a client that polls after being offline overnight.
 */
export const TASK_TTL_MS = 24 * 60 * 60 * 1000;
