/**
 * Replay dedupe.
 *
 * On reconnect, remote replay may re-deliver updates (and is not guaranteed to
 * mark every replayed update). The client dedupes replayed tool/content events
 * by `toolCallId` + a content hash so a replayed update is not persisted twice.
 */

import type { NormalizedEvent } from "../domain.ts";

/** Stable dedupe key for an event: toolCallId (when present) + content shape. */
export function dedupeKey(ev: NormalizedEvent): string {
  switch (ev.type) {
    case "tool.call":
    case "tool.update":
      return `${ev.type}:${ev.toolCallId}:${stableStringify(ev.payload)}`;
    case "permission.requested":
    case "permission.resolved":
      return `${ev.type}:${ev.toolCallId}:${ev.requestId}`;
    case "message.chunk":
    case "thought.chunk":
    case "user.message":
      return `${ev.type}:${ev.turnId ?? ""}:${stableStringify(ev.content)}`;
    default:
      return `${ev.type}:${stableStringify(ev)}`;
  }
}

/** A deduper tracking seen keys across a replay window. */
export class ReplayDeduper {
  private seen = new Set<string>();

  /** Returns true if this event is new (and records it), false if a duplicate. */
  accept(ev: NormalizedEvent): boolean {
    const key = dedupeKey(ev);
    if (this.seen.has(key)) {
      return false;
    }
    this.seen.add(key);
    return true;
  }

  reset(): void {
    this.seen.clear();
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}
