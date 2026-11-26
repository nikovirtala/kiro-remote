/**
 * The task id: an opaque string that carries the session id, the turn id and
 * the creation time, so `tasks/get` needs no lookup table (the Lambda holds no
 * state between requests).
 *
 * Form: base64url of the JSON array `[1, sessionId, turnId, createdAtMs, ttlMs]`.
 * Decoding is strict: anything that is not exactly that shape is not a task id
 * and the caller answers "Task not found". Nothing here is a credential: every
 * read behind a task id still checks that the caller owns the session.
 */

const VERSION = 1;
/** Session and turn ids are ULIDs in production and short slugs in tests; both fit. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** A decoded id longer than this is not one we minted. */
const MAX_ENCODED_LENGTH = 512;

/** What a task id names. */
export interface TaskRef {
  sessionId: string;
  turnId: string;
  /** Epoch milliseconds the task was created. */
  createdAtMs: number;
  /** How long the task stays readable from creation, in milliseconds; null: without limit. */
  ttlMs: number | null;
}

export function encodeTaskId(ref: TaskRef): string {
  const json = JSON.stringify([VERSION, ref.sessionId, ref.turnId, ref.createdAtMs, ref.ttlMs]);
  return Buffer.from(json, "utf8").toString("base64url");
}

/** The task a string names, or undefined when it is not a task id this server minted. */
export function decodeTaskId(taskId: string): TaskRef | undefined {
  if (
    taskId.length === 0 ||
    taskId.length > MAX_ENCODED_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(taskId)
  ) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(taskId, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length !== 5) {
    return undefined;
  }
  const [version, sessionId, turnId, createdAtMs, ttlMs] = parsed as unknown[];
  if (
    version !== VERSION ||
    typeof sessionId !== "string" ||
    typeof turnId !== "string" ||
    !ID_PATTERN.test(sessionId) ||
    !ID_PATTERN.test(turnId) ||
    typeof createdAtMs !== "number" ||
    !Number.isSafeInteger(createdAtMs) ||
    createdAtMs < 0 ||
    !(ttlMs === null || (typeof ttlMs === "number" && Number.isSafeInteger(ttlMs) && ttlMs > 0))
  ) {
    return undefined;
  }
  // Re-encoding must give the same string, so one task has one id.
  const ref = { sessionId, turnId, createdAtMs, ttlMs: ttlMs as number | null };
  return encodeTaskId(ref) === taskId ? ref : undefined;
}
