/**
 * The change feed's contract (version 1).
 *
 * kiro-remote decides from its own state (which PR belongs to which session, what a session waits
 * for, which session to wake), and publishes every one of those decisions as an event others can
 * read (ark ADR 9t6n5jc6). One append-only feed per account: the owner of the session the event is
 * about. Events are ordered by `seq`, which has no gaps, so a reader that holds a cursor never
 * misses an event, and a jump in `seq` means the events in between have expired.
 *
 * These zod objects are the source of truth. `packages/core/schemas/feed/*.json` are generated from
 * them (`pnpm --filter @nikovirtala/kiro-remote-core gen:feed-schemas`) and checked in; a test fails
 * when they drift and when an emitted event does not validate against them.
 *
 * Enum values. A payload's enum (such as the `reason` of `wait.removed`) and the envelope's
 * `source` may gain values within `v: 1`: a reader treats a value it does not know as opaque (shows
 * it, groups by it, never fails on it), exactly as it already does for `source`. Adding a type or an
 * optional field is also `v: 1`. `v: 2` is for removing or renaming a value, changing what one
 * means, or adding a required field. The checked-in JSON Schemas list the values known at the
 * commit they were generated from, so a reader that validates against its own copy must not
 * reject an event because of an enum value its copy lacks.
 *
 * Never in an event: prompt text, transcript content, PR titles or bodies, tokens. Only ids, PR
 * references, enums and counts.
 */

import { z } from "zod";

export const FEED_VERSION = 1;

/**
 * How long events are kept (DynamoDB TTL). At least 30 days, with 5 days of margin for a reader that
 * comes back about monthly. DynamoDB deletes an expired item late, never early.
 */
export const FEED_TTL_DAYS = 35;

/**
 * Who or what caused the change. A reader must treat an unknown value as opaque.
 *
 * - `mcp`, `rest`: a caller of the API.
 * - `trailer`: a `Kiro-Remote-*` line in a PR body.
 * - `webhook`: a GitHub delivery (and the delayed re-checks it started).
 * - `harvest`: the PR URL the agent printed in a turn.
 * - `sweep`: a read of GitHub kiro-remote made on its own initiative (the check made when a wait is
 *   registered, and a later scheduled sweep).
 * - `bridge`: kiro-remote itself, while it drives a session (a queued prompt that cannot run because
 *   its session failed; added within v: 1, under the rule on enum values above).
 */
export const FeedSourceSchema = z.enum([
  "mcp",
  "rest",
  "trailer",
  "webhook",
  "harvest",
  "sweep",
  "bridge",
]);
export type FeedSource = z.infer<typeof FeedSourceSchema>;

/**
 * `state`: the event moves state a reader follows (a link, a wait). A reader that meets a `state`
 * type it does not know cannot rebuild the state any more and must stop and say so.
 * `annotation`: the event explains or records a decision (why a session woke). A reader may skip
 * an annotation type it does not know.
 */
export const FeedEffectSchema = z.enum(["state", "annotation"]);
export type FeedEffect = z.infer<typeof FeedEffectSchema>;

const PrRefSchema = z.string().regex(/^[^/\s]+\/[^#\s]+#[1-9][0-9]*$/, "owner/repo#n");
const PrStateSchema = z.enum(["open", "closed", "merged", "unknown"]);
const LinkMethodSchema = z.enum(["harvest", "trailer", "manual"]);
const WaitSourceSchema = z.enum(["mcp", "rest", "trailer"]);

/** Why a session is woken: its own PR's event, its PR no longer merging, or a PR it waits for. */
export const WakeCauseSchema = z.enum(["linked_pr_event", "conflict", "wait"]);
export type WakeCause = z.infer<typeof WakeCauseSchema>;

/**
 * Why a prompt that was accepted will not run (the `reason` of `prompt.failed`). A reader treats a
 * value it does not know as opaque.
 *
 * - `session_deleted`: the session was deleted (by the caller, or found deleted) while the prompt
 *   waited.
 * - `session_failed`: the session failed (it never provisioned), so nothing can run.
 * - `not_sent`: the prompt was stored but could not be sent to the bridge; the caller got an error.
 */
export const PromptFailReasonSchema = z.enum(["session_deleted", "session_failed", "not_sent"]);
export type PromptFailReason = z.infer<typeof PromptFailReasonSchema>;

const wakeItem = {
  /** The inbox item the wake is, so queued, delivered and dropped can be followed together. */
  itemId: z.string().min(1),
  /** pr_merged, pr_closed, review, comment, checks_failed, pr_conflict, pr_behind, pr_wait_*. */
  kind: z.string().min(1).max(40),
  cause: WakeCauseSchema,
};

/** The payload of each event type, and whether it moves state. */
export const FEED_TYPES = {
  "link.added": {
    effect: "state",
    payload: z.strictObject({ method: LinkMethodSchema, prState: PrStateSchema }),
  },
  "link.removed": {
    effect: "state",
    payload: z.strictObject({ reason: z.enum(["unlinked"]) }),
  },
  "link.state_changed": {
    effect: "state",
    payload: z.strictObject({ from: PrStateSchema, to: PrStateSchema }),
  },
  "wait.registered": {
    effect: "state",
    payload: z.strictObject({ waitSource: WaitSourceSchema }),
  },
  "wait.removed": {
    effect: "state",
    payload: z.strictObject({
      /**
       * merged, closed, unreadable: the wait fired. stopped: the caller removed it.
       * registration_failed: it was stored but its first check could not be requested.
       * session_deleted: the session was deleted, so nothing is left to wake (added within v: 1,
       * under the rule on enum values in the header).
       */
      reason: z.enum([
        "merged",
        "closed",
        "unreadable",
        "stopped",
        "registration_failed",
        "session_deleted",
      ]),
    }),
  },
  "prompt.failed": {
    effect: "annotation",
    payload: z.strictObject({
      /** The turn id the caller was given for the prompt. */
      turnId: z.string().min(1),
      whenBusy: z.literal("queue"),
      reason: PromptFailReasonSchema,
    }),
  },
  "wake.queued": {
    effect: "annotation",
    payload: z.strictObject({
      ...wakeItem,
      /** True when the wake was folded into a pending item instead of becoming a new one. */
      merged: z.boolean(),
    }),
  },
  "wake.delivered": {
    effect: "annotation",
    payload: z.strictObject({ ...wakeItem, turnId: z.string().min(1) }),
  },
  "wake.released": {
    effect: "annotation",
    payload: z.strictObject({ ...wakeItem, turnId: z.string().min(1) }),
  },
  "wake.dropped": {
    effect: "annotation",
    payload: z.strictObject({ ...wakeItem, reason: z.string().min(1).max(60) }),
  },
} as const;

export type FeedType = keyof typeof FEED_TYPES;
export const FEED_TYPE_NAMES = Object.keys(FEED_TYPES) as FeedType[];

const envelopeShape = {
  /** The contract version. */
  v: z.literal(FEED_VERSION),
  /** A ULID, unique across feeds. */
  id: z.string().min(1),
  /** Position in the owner's feed: 1, 2, 3, ... with no gaps. The cursor is the last `seq` read. */
  seq: z.number().int().min(1),
  /** When the change was committed, ISO-8601. */
  ts: z.string().min(1),
  effect: FeedEffectSchema,
  sessionId: z.string().min(1),
  /** The PR the event is about, or null. */
  pr: PrRefSchema.nullable(),
  source: FeedSourceSchema,
};

/** The envelope any reader can parse, whatever the type. `payload` is read by type. */
export const FeedEnvelopeSchema = z.strictObject({
  ...envelopeShape,
  type: z.string().min(1).max(60),
  payload: z.record(z.string(), z.unknown()),
});
export type FeedEnvelope = z.infer<typeof FeedEnvelopeSchema>;

/** One schema per type: the envelope with the type and effect fixed and the payload typed. */
export const FEED_EVENT_SCHEMAS = Object.fromEntries(
  FEED_TYPE_NAMES.map((type) => [
    type,
    z.strictObject({
      ...envelopeShape,
      type: z.literal(type),
      effect: z.literal(FEED_TYPES[type].effect),
      payload: FEED_TYPES[type].payload,
    }),
  ]),
) as unknown as Record<FeedType, z.ZodType>;

export type FeedEvent = z.infer<typeof FeedEnvelopeSchema>;

/** A page of the feed: GET /v1/events and kiro_list_events. */
export const FeedPageSchema = z.strictObject({
  events: z.array(FeedEnvelopeSchema),
  /** Pass this as `after` to continue. Equals the `after` that was sent when there was nothing new. */
  nextCursor: z.number().int().min(0),
  /** True when more events are waiting beyond `limit`. */
  hasMore: z.boolean(),
});
export type FeedPage = z.infer<typeof FeedPageSchema>;

/** GET /v1/events (query), and the arguments of kiro_list_events. */
export const FeedQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type FeedQuery = z.infer<typeof FeedQuerySchema>;

/** The JSON Schemas checked in under packages/core/schemas/feed, by file name. */
export function feedJsonSchemas(): Record<string, Record<string, unknown>> {
  const gen = (s: z.ZodType) =>
    z.toJSONSchema(s, { target: "draft-2020-12", io: "output", unrepresentable: "any" }) as Record<
      string,
      unknown
    >;
  const out: Record<string, Record<string, unknown>> = {
    "envelope.json": gen(FeedEnvelopeSchema),
    "page.json": gen(FeedPageSchema),
  };
  for (const type of FEED_TYPE_NAMES) {
    out[`${type}.json`] = gen(FEED_EVENT_SCHEMAS[type]);
  }
  return out;
}

/**
 * What a reader does with an event, by what it knows. `handle`: a type it knows. `skip`: an
 * annotation of a type it does not know, which loses it nothing it follows. `stop`: a state change
 * of a type it does not know, after which the state it rebuilds would be wrong.
 */
export function feedEventDisposition(
  event: Pick<FeedEnvelope, "type" | "effect">,
  knownTypes: ReadonlySet<string>,
): "handle" | "skip" | "stop" {
  if (knownTypes.has(event.type)) {
    return "handle";
  }
  return event.effect === "annotation" ? "skip" : "stop";
}
