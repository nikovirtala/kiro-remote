/**
 * Chunk coalescer.
 *
 * Streamed `message.chunk` and `thought.chunk` events arrive in small pieces.
 * We coalesce them per turn (and per chunk type) to cut down the number of
 * persisted events, flushing when any of these fire:
 *   - FLUSH_MS (750 ms) have elapsed since the first buffered chunk
 *   - the buffered text reaches FLUSH_BYTES (4 KB)
 *   - any non-chunk event arrives (it forces a flush first, preserving order)
 *
 * The coalescer is pure in the sense that it has no timers of its own: the
 * caller feeds it events and a clock, and it returns the events to emit. This
 * keeps it deterministic and trivially testable.
 */

import { FLUSH_BYTES, FLUSH_MS } from "../config.ts";
import type { MessageChunkEvent, NormalizedEvent, ThoughtChunkEvent } from "../domain.ts";

type ChunkEvent = MessageChunkEvent | ThoughtChunkEvent;

function isChunk(ev: NormalizedEvent): ev is ChunkEvent {
  return ev.type === "message.chunk" || ev.type === "thought.chunk";
}

function chunkText(ev: ChunkEvent): string {
  const text = ev.content?.text;
  return typeof text === "string" ? text : "";
}

interface Buffer {
  key: string;
  first: ChunkEvent;
  text: string;
  bytes: number;
  startedAt: number;
}

export class Coalescer {
  private buffers = new Map<string, Buffer>();

  /** Composite key so message and thought streams coalesce independently. */
  private keyFor(ev: ChunkEvent): string {
    return `${ev.turnId ?? "none"}:${ev.type}`;
  }

  /** Merge a buffer into a single coalesced event preserving the first's base. */
  private materialize(buf: Buffer): ChunkEvent {
    return {
      ...buf.first,
      content: { ...buf.first.content, text: buf.text },
    };
  }

  /**
   * Feed one event with the current clock (ms). Returns the ordered list of
   * events to emit now (0+ flushed coalesced chunks, then the event itself for
   * non-chunks). Chunk events are buffered and may emit nothing.
   */
  push(ev: NormalizedEvent, now: number): NormalizedEvent[] {
    if (isChunk(ev)) {
      // Replayed chunks are passed through untouched so dedupe/replay marking
      // is not disturbed by coalescing.
      if (ev.replay) {
        return [ev];
      }
      const key = this.keyFor(ev);
      const existing = this.buffers.get(key);
      const text = chunkText(ev);
      if (existing) {
        existing.text += text;
        existing.bytes = Buffer_byteLength(existing.text);
        if (existing.bytes >= FLUSH_BYTES || now - existing.startedAt >= FLUSH_MS) {
          this.buffers.delete(key);
          return [this.materialize(existing)];
        }
        return [];
      }
      const bytes = Buffer_byteLength(text);
      const buf: Buffer = { key, first: ev, text, bytes, startedAt: now };
      if (bytes >= FLUSH_BYTES) {
        return [this.materialize(buf)];
      }
      this.buffers.set(key, buf);
      return [];
    }

    // A non-chunk event flushes all buffers first (in insertion order), then
    // the event itself is emitted, preserving arrival order.
    const flushed = this.flushAll();
    flushed.push(ev);
    return flushed;
  }

  /**
   * Called by the caller's timer tick: flush any buffer whose age exceeds
   * FLUSH_MS as of `now`.
   */
  tick(now: number): NormalizedEvent[] {
    const out: NormalizedEvent[] = [];
    for (const [key, buf] of this.buffers) {
      if (now - buf.startedAt >= FLUSH_MS) {
        out.push(this.materialize(buf));
        this.buffers.delete(key);
      }
    }
    return out;
  }

  /** Flush everything (e.g. on turn end or shutdown), in insertion order. */
  flushAll(): NormalizedEvent[] {
    const out: NormalizedEvent[] = [];
    for (const buf of this.buffers.values()) {
      out.push(this.materialize(buf));
    }
    this.buffers.clear();
    return out;
  }

  /** True when there is nothing buffered. */
  isEmpty(): boolean {
    return this.buffers.size === 0;
  }
}

/** Byte length of a UTF-8 string without pulling in Node's Buffer type here. */
function Buffer_byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}
