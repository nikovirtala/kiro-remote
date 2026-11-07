/**
 * kiro_wait_for_events and kiro_get_transcript logic.
 *
 * Both read through the {@link ToolClient} interface only, so they work
 * identically over the in-process and HTTP transports.
 *
 * kiro_wait_for_events contract (enforced here, not by the caller):
 *   - waits at most {@link MAX_WAIT_SECONDS} seconds for the underlying read
 *     (the client's long-poll `wait`),
 *   - returns at most {@link MAX_EVENTS} events,
 *   - returns at most {@link MAX_TEXT_CHARS} characters of extracted text,
 *   - states how much was truncated (eventsTruncated / textTruncated + counts),
 *   - includes nextCursor, turnStatus, and the pending-permission count so a
 *     calling agent can poll cheaply.
 *
 * kiro_get_transcript returns the assistant's FINAL text per turn (the
 * concatenation of that turn's assistant message chunks), never raw events.
 */

import type { ClientEvent, ClientPermission } from "@kiro-remote/api";
import type { Principal } from "@kiro-remote/core";
import type { ToolClient } from "./client.ts";

/** Hard cap on how long kiro_wait_for_events blocks. */
export const MAX_WAIT_SECONDS = 25;
/** Hard cap on events returned by kiro_wait_for_events. */
export const MAX_EVENTS = 30;
/** Hard cap on characters of extracted text returned by kiro_wait_for_events. */
export const MAX_TEXT_CHARS = 8000;

/** The normalized event types that carry assistant-visible text content. */
const ASSISTANT_TEXT_TYPES = new Set(["message.chunk"]);

/** Pull the plain text out of a content block, if any. */
function contentText(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    return "";
  }
  const content = (payload as { content?: unknown }).content;
  const block = content ?? payload;
  if (typeof block === "object" && block !== null) {
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string") {
      return text;
    }
  }
  return "";
}

/** The shape kiro_wait_for_events returns. */
export interface WaitForEventsResult {
  events: ClientEvent[];
  /** Concatenated assistant text across the returned events, capped. */
  text: string;
  nextCursor: number;
  turnStatus: string | null;
  pendingPermissionCount: number;
  eventsTruncated: boolean;
  /** Count of events dropped because of the {@link MAX_EVENTS} cap. */
  droppedEvents: number;
  textTruncated: boolean;
  /** Count of text characters dropped because of the {@link MAX_TEXT_CHARS} cap. */
  droppedTextChars: number;
}

/**
 * Long-poll a session's events and apply the wait/limit/truncation contract.
 * The underlying `wait` is clamped to {@link MAX_WAIT_SECONDS}.
 */
export async function collectEvents(
  client: ToolClient,
  principal: Principal,
  args: { sessionId: string; after: number; types?: string[] },
): Promise<WaitForEventsResult> {
  const page = await client.getEvents(principal, args.sessionId, {
    after: args.after,
    wait: MAX_WAIT_SECONDS,
    ...(args.types ? { types: args.types } : {}),
  });

  const all = page.events;
  const totalReturned = all.length;
  const events = all.slice(0, MAX_EVENTS);
  const eventsTruncated = totalReturned > MAX_EVENTS;
  const droppedEvents = eventsTruncated ? totalReturned - MAX_EVENTS : 0;

  // nextCursor is the seq of the last event WE RETURN, so a follow-up poll that
  // was truncated continues from the cut and does not skip dropped events.
  const nextCursor = events.length > 0 ? events[events.length - 1].seq : page.nextCursor;

  // Extract assistant text from the returned (already event-capped) events.
  let text = "";
  for (const ev of events) {
    if (ASSISTANT_TEXT_TYPES.has(ev.type)) {
      text += contentText(ev.payload);
    }
  }
  const fullTextLength = text.length;
  const textTruncated = fullTextLength > MAX_TEXT_CHARS;
  const droppedTextChars = textTruncated ? fullTextLength - MAX_TEXT_CHARS : 0;
  if (textTruncated) {
    text = text.slice(0, MAX_TEXT_CHARS);
  }

  const { permissions } = await client.listPermissions(principal, args.sessionId, {
    status: "pending",
  });
  const pendingPermissionCount = permissions.filter(
    (p: ClientPermission) => p.status === "pending",
  ).length;

  return {
    events,
    text,
    nextCursor,
    turnStatus: page.turnStatus,
    pendingPermissionCount,
    eventsTruncated,
    droppedEvents,
    textTruncated,
    droppedTextChars,
  };
}

/** One turn's final assistant text. */
export interface TranscriptTurn {
  turnId: string | null;
  text: string;
}

/** The shape kiro_get_transcript returns. */
export interface TranscriptResult {
  sessionId: string;
  turns: TranscriptTurn[];
}

/**
 * Build the assistant's FINAL text per turn by reading the whole event log and
 * concatenating each turn's assistant message chunks in sequence order. Raw
 * events are never returned; only the resolved per-turn text.
 */
export async function finalTranscript(
  client: ToolClient,
  principal: Principal,
  sessionId: string,
): Promise<TranscriptResult> {
  // Read the full log from the start without blocking.
  const page = await client.getEvents(principal, sessionId, { after: 0, wait: 0 });
  const byTurn = new Map<string | null, string>();
  const order: Array<string | null> = [];

  for (const ev of page.events) {
    if (!ASSISTANT_TEXT_TYPES.has(ev.type)) {
      continue;
    }
    const text = contentText(ev.payload);
    if (text === "") {
      continue;
    }
    const key = ev.turnId;
    if (!byTurn.has(key)) {
      byTurn.set(key, "");
      order.push(key);
    }
    byTurn.set(key, (byTurn.get(key) ?? "") + text);
  }

  return {
    sessionId,
    turns: order.map((turnId) => ({ turnId, text: byTurn.get(turnId) ?? "" })),
  };
}
