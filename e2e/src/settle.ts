/**
 * Wait for one turn to settle by reading a session's event log.
 *
 * Shared by the MCP flow (kiro_wait_for_events) and the REST flow (GET
 * .../events). The caller supplies `read(after)`, which returns one page; this
 * module owns the settle rule:
 *
 *   - an event matches the turn when no `turnId` is given (the launch turn) or
 *     its `turnId` equals the given one (a follow-up);
 *   - a matching `turn.failed` throws;
 *   - `turnStatus === null` throws (the session is failed or deleted);
 *   - the turn is settled once a matching event (or a `running` status) was
 *     seen and a page reports `idle` without truncation. The Lambda consumer
 *     flushes every event before it persists `idle`, so nothing is missed.
 */

/** The event fields the settle rule reads. */
export interface EventLike {
  seq: number;
  turnId: string | null;
  type: string;
  payload: unknown;
}

/** One page of events plus the session's turn status. */
export interface EventPage {
  events: EventLike[];
  nextCursor: number;
  turnStatus: string | null;
  /** The MCP `eventsTruncated` flag; always false for REST. */
  truncated: boolean;
}

/** What a settled turn produced. */
export interface TurnResult {
  /** The highest event seq read; the next read continues from here. */
  cursor: number;
  /** The concatenated `message.chunk` text of the matching events. */
  text: string;
  /** How many matching events were read. */
  eventCount: number;
  /** Milliseconds from the first read to the first matching event, or null. */
  firstEventMs: number | null;
  durationMs: number;
  polls: number;
}

export interface WaitForTurnOptions {
  after: number;
  turnId?: string;
  read(after: number): Promise<EventPage>;
  now(): number;
  sleep(ms: number): Promise<void>;
  signal?: AbortSignal;
  timeoutMs: number;
  emptyPageDelayMs?: number;
}

/** Pull the text out of a `message.chunk` payload (`content.text` or `text`). */
export function contentText(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    return "";
  }
  const content = (payload as { content?: unknown }).content;
  if (typeof content === "object" && content !== null) {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string") {
      return text;
    }
  }
  const text = (payload as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

/**
 * The stored payload is the whole normalized event, so a bridge failure sits at
 * `payload.payload.error` with the category in `payload.failureReason`.
 */
function failureReason(payload: unknown): string {
  if (typeof payload === "object" && payload !== null) {
    const p = payload as {
      error?: unknown;
      reason?: unknown;
      failureReason?: unknown;
      payload?: { error?: unknown };
    };
    const inner = typeof p.payload === "object" && p.payload !== null ? p.payload.error : undefined;
    const value = inner ?? p.error ?? p.reason ?? p.failureReason;
    if (typeof value === "string") {
      return value;
    }
    if (value !== undefined) {
      return JSON.stringify(value);
    }
  }
  return "no reason given";
}

/** Read pages until the turn settles; throw on failure, timeout, or abort. */
export async function waitForTurn(opts: WaitForTurnOptions): Promise<TurnResult> {
  const emptyPageDelayMs = opts.emptyPageDelayMs ?? 1000;
  const start = opts.now();
  let cursor = opts.after;
  let text = "";
  let eventCount = 0;
  let firstEventMs: number | null = null;
  let sawTurn = false;
  let polls = 0;
  for (;;) {
    if (opts.signal?.aborted) {
      throw new Error("aborted");
    }
    if (opts.now() - start > opts.timeoutMs) {
      throw new Error(`turn did not settle within ${Math.round(opts.timeoutMs / 1000)} s`);
    }
    const page = await opts.read(cursor);
    polls++;
    for (const ev of page.events) {
      if (ev.seq <= cursor) {
        continue;
      }
      cursor = ev.seq;
      if (opts.turnId !== undefined && ev.turnId !== opts.turnId) {
        continue;
      }
      sawTurn = true;
      eventCount++;
      if (firstEventMs === null) {
        firstEventMs = opts.now() - start;
      }
      if (ev.type === "turn.failed") {
        throw new Error(`turn failed: ${failureReason(ev.payload)}`);
      }
      if (ev.type === "message.chunk") {
        text += contentText(ev.payload);
      }
    }
    if (page.turnStatus === null) {
      throw new Error("session left the active states (turnStatus is null: failed or deleted)");
    }
    if (page.turnStatus === "running") {
      sawTurn = true;
    }
    if (sawTurn && page.turnStatus === "idle" && !page.truncated) {
      return { cursor, text, eventCount, firstEventMs, durationMs: opts.now() - start, polls };
    }
    if (page.events.length === 0) {
      await opts.sleep(emptyPageDelayMs);
    }
  }
}
