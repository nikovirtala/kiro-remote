/**
 * Catch-up for a cloud turn that outlived its Lambda invocation.
 *
 * When the consumer nears its deadline it detaches from a running turn (the
 * turn keeps running in Kiro's cloud sandbox) and schedules a
 * {@link CatchUpMessage} on the standard catch-up queue with a delivery delay.
 * Each catch-up run loads the remote session, which replays its whole history,
 * and {@link planCatchUp} works out which of the replayed events for the
 * detached turn the DynamoDB event log does not hold yet.
 *
 * The replay segment of the detached turn is found by its ordinal: the
 * message carries {@link CatchUpMessage.turnOrdinal} (1 for a launch, the
 * number of `turn_start` markers in the pre-prompt load replay + 1 for a
 * follow-up), and a replay with fewer turns does not hold the turn yet. Without
 * an ordinal (a redelivered command recovering a hard-killed turn) the segment
 * from the LAST `turn_start` is used, and a segment whose text diverges from
 * the recorded text is treated as an earlier turn: nothing is written.
 *
 * Deduplication uses the event log as the ledger. The segment is compared
 * against the events already recorded under the turn's id:
 *  - message/thought/user chunks: per-type text-prefix matching on the
 *    concatenated text (live streaming and the replay split text differently);
 *  - tool.call / tool.update: key `(type, toolCallId, status)`;
 *  - anything else: key `(type, rawType, kind)`, skipping as many replay
 *    occurrences as the log already holds.
 */

import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { type NormalizedEvent, normalizeUpdate } from "@nikovirtala/kiro-remote-core";

/** Delivery delay for each catch-up message. */
export const CATCH_UP_DELAY_SECONDS = 60;
/** A detached turn with no `turn_end` after this long is failed. */
export const CATCH_UP_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** The catch-up queue message body. */
export interface CatchUpMessage {
  kind: "catchUp";
  /** Our session id. */
  sessionId: string;
  /** The cloud (Kiro) session id to load. */
  kiroSessionId: string;
  /** The detached turn. */
  turnId: string;
  /** META eventSeq when the turn began; the turn's events have seq > afterSeq. */
  afterSeq: number;
  /** 1 for the first catch-up after detaching. */
  attempt: number;
  /** Epoch ms when the turn was detached. */
  detachedAt: number;
  /**
   * 1-based position of the detached turn among the replay's `turn_start`
   * markers. Absent when unknown (a hard-kill recovery).
   */
  turnOrdinal?: number;
}

export function isCatchUpMessage(value: unknown): value is CatchUpMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    v.kind === "catchUp" &&
    typeof v.sessionId === "string" &&
    typeof v.kiroSessionId === "string" &&
    typeof v.turnId === "string" &&
    typeof v.afterSeq === "number" &&
    typeof v.attempt === "number" &&
    typeof v.detachedAt === "number" &&
    (v.turnOrdinal === undefined ||
      (typeof v.turnOrdinal === "number" && Number.isInteger(v.turnOrdinal) && v.turnOrdinal >= 1))
  );
}

export interface CatchUpScheduler {
  schedule(msg: CatchUpMessage, delaySeconds: number): Promise<void>;
}

/** Schedules catch-up messages on a standard SQS queue with a delivery delay. */
export class SqsCatchUpScheduler implements CatchUpScheduler {
  private readonly sqs: SQSClient;
  private readonly queueUrl: string;

  constructor(args: { sqs: SQSClient; queueUrl: string }) {
    this.sqs = args.sqs;
    this.queueUrl = args.queueUrl;
  }

  async schedule(msg: CatchUpMessage, delaySeconds: number): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(msg),
        DelaySeconds: delaySeconds,
      }),
    );
  }
}

export interface CatchUpPlan {
  /** The replay holds the detached turn's `turn_start` marker. */
  turnFound: boolean;
  /** The turn's segment holds a `turn_end` marker. */
  ended: boolean;
  /**
   * Set when no ordinal was given and the last turn's text diverges from the
   * recorded text: the segment is probably an earlier turn, so nothing is
   * written.
   */
  mismatch?: true;
  /** The last `turn.completed` stopReason in the segment. */
  stopReason?: string;
  /** Events to append, in replay order, under `turnId` with `replay: false`. */
  events: NormalizedEvent[];
}

type TextType = "message.chunk" | "thought.chunk" | "user.message";

function isTextEvent(ev: NormalizedEvent): ev is Extract<NormalizedEvent, { type: TextType }> {
  return ev.type === "message.chunk" || ev.type === "thought.chunk" || ev.type === "user.message";
}

function textOf(ev: Extract<NormalizedEvent, { type: TextType }>): string {
  const text = ev.content?.text;
  return typeof text === "string" ? text : "";
}

function isTurnMarker(ev: NormalizedEvent, kind: "turn_start" | "turn_end"): boolean {
  return ev.type === "session.info" && ev.kind === kind;
}

function toolKey(ev: NormalizedEvent): string | null {
  if (ev.type === "tool.call" || ev.type === "tool.update") {
    return `${ev.type}|${ev.toolCallId}|${ev.status}`;
  }
  return null;
}

function otherKey(ev: NormalizedEvent): string {
  const kind = ev.type === "session.info" ? ev.kind : "";
  return `${ev.type}|${ev.rawType}|${kind}`;
}

/** Count the `turn_start` markers in raw `session/update` objects (a load replay). */
export function countTurnStarts(updates: unknown[]): number {
  return updates.filter((u) => isTurnMarker(normalizeUpdate("", u), "turn_start")).length;
}

/**
 * Work out which replayed events of the detached turn are missing from the
 * event log. Pure: `updates` are raw ACP `session/update` objects from the
 * load replay, `recorded` the normalized payloads already logged for `turnId`,
 * `turnOrdinal` the turn's 1-based position among the replay's turns.
 */
export function planCatchUp(args: {
  sessionId: string;
  turnId: string;
  updates: unknown[];
  recorded: NormalizedEvent[];
  turnOrdinal?: number;
  onUnmapped?: (rawType: string) => void;
}): CatchUpPlan {
  const { sessionId, turnId, turnOrdinal } = args;
  const notFound: CatchUpPlan = { turnFound: false, ended: false, events: [] };
  const normalized = args.updates.map((u) =>
    normalizeUpdate(sessionId, u, {
      turnId,
      ...(args.onUnmapped ? { hooks: { onUnmapped: args.onUnmapped } } : {}),
    }),
  );

  const starts: number[] = [];
  normalized.forEach((ev, i) => {
    if (isTurnMarker(ev, "turn_start")) {
      starts.push(i);
    }
  });
  // With an ordinal the segment runs from that turn's start to the next
  // turn's start; a replay with fewer turns does not hold the turn yet.
  const index = turnOrdinal !== undefined ? turnOrdinal - 1 : starts.length - 1;
  const start = starts[index];
  if (start === undefined) {
    return notFound;
  }
  const segment = normalized.slice(start, starts[index + 1] ?? normalized.length);

  // What the log already holds for the turn.
  const remainingText = new Map<TextType, string>();
  const recordedTools = new Set<string>();
  const recordedOther = new Map<string, number>();
  for (const ev of args.recorded) {
    if (isTextEvent(ev)) {
      remainingText.set(ev.type, (remainingText.get(ev.type) ?? "") + textOf(ev));
      continue;
    }
    const tk = toolKey(ev);
    if (tk !== null) {
      recordedTools.add(tk);
      continue;
    }
    const ok = otherKey(ev);
    recordedOther.set(ok, (recordedOther.get(ok) ?? 0) + 1);
  }

  const events: NormalizedEvent[] = [];
  const emit = (ev: NormalizedEvent): void => {
    events.push({ ...ev, turnId, replay: false });
  };
  let ended = false;
  let stopReason: string | undefined;

  for (const ev of segment) {
    if (isTurnMarker(ev, "turn_end")) {
      ended = true;
    }
    if (ev.type === "turn.completed" && ev.stopReason !== undefined) {
      stopReason = ev.stopReason;
    }

    if (isTextEvent(ev)) {
      const t = textOf(ev);
      const r = remainingText.get(ev.type) ?? "";
      if (r.length === 0) {
        emit(ev);
      } else if (r.startsWith(t)) {
        remainingText.set(ev.type, r.slice(t.length));
      } else if (t.startsWith(r)) {
        emit({ ...ev, content: { ...ev.content, text: t.slice(r.length) } });
        remainingText.set(ev.type, "");
      } else if (turnOrdinal === undefined) {
        // Without an ordinal, diverging text means the last turn in the
        // replay is not the detached one (the replay lacks it): write nothing.
        return { ...notFound, mismatch: true };
      } else {
        emit(ev);
        remainingText.set(ev.type, "");
      }
      continue;
    }

    const tk = toolKey(ev);
    if (tk !== null) {
      if (!recordedTools.has(tk)) {
        recordedTools.add(tk);
        emit(ev);
      }
      continue;
    }

    const ok = otherKey(ev);
    const left = recordedOther.get(ok) ?? 0;
    if (left > 0) {
      recordedOther.set(ok, left - 1);
    } else {
      emit(ev);
    }
  }

  return { turnFound: true, ended, ...(stopReason !== undefined ? { stopReason } : {}), events };
}
