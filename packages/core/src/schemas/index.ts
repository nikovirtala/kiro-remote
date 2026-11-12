/**
 * Zod schemas: the single source of truth for REST request/response
 * validation, OpenAPI 3.1 component schemas, and MCP tool input schemas.
 *
 * The same zod objects power all three consumers. {@link toOpenApiSchema} and
 * {@link toMcpInputSchema} both call zod's native JSON-Schema emitter, so a
 * parity test can assert the two outputs are byte-for-byte identical for a
 * given zod object.
 */

import { z } from "zod";
import { EVENTS_MAX_WAIT_SECONDS } from "../config.ts";
import { parsePrRef } from "../github/pr-ref.ts";

/* -------------------------------------------------------------------------- */
/* Shared primitives                                                          */
/* -------------------------------------------------------------------------- */

export const RepoRefSchema = z
  .string()
  .regex(/^[^/\s]+\/[^/\s]+$/, "repo must be in owner/name form");

export const SessionModeSchema = z.string().min(1);
export const ModelIdSchema = z.string().min(1);
export const EffortLevelSchema = z.string().min(1);

export const SessionStatusSchema = z.union([
  z.literal("provisioning"),
  z.literal("running"),
  z.literal("idle"),
  z.literal("awaiting_permission"),
  z.literal("failed"),
  z.literal("deleted"),
]);

export const TurnStatusSchema = z.union([
  z.literal("queued"),
  z.literal("running"),
  z.literal("completed"),
  z.literal("failed"),
  z.literal("refused"),
  z.literal("cancelled"),
]);

/* -------------------------------------------------------------------------- */
/* Request bodies / query params                                              */
/* -------------------------------------------------------------------------- */

/** POST /v1/sessions */
export const LaunchSessionSchema = z.object({
  prompt: z.string().min(1),
  repos: z.array(RepoRefSchema).min(1),
  title: z.string().min(1).optional(),
  mode: SessionModeSchema.optional(),
  model: ModelIdSchema.optional(),
  effort: EffortLevelSchema.optional(),
});
export type LaunchSessionInput = z.infer<typeof LaunchSessionSchema>;

/** POST /v1/sessions/{id}/links: `owner/repo#n` or a github.com pull request URL. */
export const LinkPullRequestSchema = z.object({
  pr: z
    .string()
    .min(1)
    .refine(
      (v) => parsePrRef(v) !== null,
      "pr must be owner/repo#number or a GitHub pull request URL",
    ),
});
export type LinkPullRequestInput = z.infer<typeof LinkPullRequestSchema>;

/** GET /v1/github/unmatched (query) */
export const UnmatchedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type UnmatchedQuery = z.infer<typeof UnmatchedQuerySchema>;

/** GET /v1/sessions (query) */
export const ListSessionsQuerySchema = z.object({
  status: SessionStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).optional(),
});
export type ListSessionsQuery = z.infer<typeof ListSessionsQuerySchema>;

/** POST /v1/sessions/adopt */
export const AdoptSessionSchema = z.object({
  kiroSessionId: z.string().min(1),
});
export type AdoptSessionInput = z.infer<typeof AdoptSessionSchema>;

/** POST /v1/sessions/{id}/turns */
export const CreateTurnSchema = z.object({
  prompt: z.string().min(1),
  whenBusy: z.union([z.literal("steer"), z.literal("queue"), z.literal("reject")]).default("steer"),
});
export type CreateTurnInput = z.infer<typeof CreateTurnSchema>;

/** GET /v1/sessions/{id}/events (query) */
export const EventsQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  wait: z.coerce.number().int().min(0).max(EVENTS_MAX_WAIT_SECONDS).default(0),
  types: z.array(z.string().min(1)).optional(),
});
export type EventsQuery = z.infer<typeof EventsQuerySchema>;

/** POST /v1/sessions/{id}/permissions/{requestId} */
export const AnswerPermissionSchema = z.object({
  optionId: z.string().min(1),
  consent: z
    .object({
      scope: z.string().min(1),
      resource: z.string().min(1),
      workspaceRoot: z.string().min(1),
    })
    .optional(),
});
export type AnswerPermissionInput = z.infer<typeof AnswerPermissionSchema>;

/** PATCH /v1/sessions/{id}/config */
export const ConfigPatchSchema = z
  .object({
    model: ModelIdSchema.optional(),
    effort: EffortLevelSchema.optional(),
    mode: SessionModeSchema.optional(),
  })
  .refine((v) => v.model !== undefined || v.effort !== undefined || v.mode !== undefined, {
    message: "at least one of model, effort, or mode is required",
  });
export type ConfigPatchInput = z.infer<typeof ConfigPatchSchema>;

/* -------------------------------------------------------------------------- */
/* Response bodies                                                            */
/* -------------------------------------------------------------------------- */

export const LinkSchema = z.object({
  pr: z.string(),
  repo: z.string(),
  number: z.number().int(),
  linkedBy: z.union([z.literal("harvest"), z.literal("trailer"), z.literal("manual")]),
  linkedAt: z.string(),
  prState: z.union([
    z.literal("open"),
    z.literal("closed"),
    z.literal("merged"),
    z.literal("unknown"),
  ]),
  headSha: z.string().nullable(),
});
export type LinkView = z.infer<typeof LinkSchema>;

export const TurnTriggerSchema = z.object({
  source: z.union([z.literal("user"), z.literal("github")]),
  deliveryIds: z.array(z.string()),
});
export type TurnTriggerView = z.infer<typeof TurnTriggerSchema>;

export const UnmatchedDeliverySchema = z.object({
  deliveryId: z.string(),
  event: z.string(),
  action: z.string().nullable(),
  repo: z.string(),
  number: z.number().int().nullable(),
  sender: z.string().nullable(),
  receivedAt: z.string(),
  url: z.string().nullable(),
});
export type UnmatchedDeliveryView = z.infer<typeof UnmatchedDeliverySchema>;

export const SessionSchema = z.object({
  id: z.string(),
  kiroSessionId: z.string().nullable(),
  title: z.string().nullable(),
  repos: z.array(RepoRefSchema),
  mode: z.string().nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  status: SessionStatusSchema,
  activeTurnId: z.string().nullable(),
  eventSeq: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Linked pull requests. Present on GET /v1/sessions/{id} only. */
  links: z.array(LinkSchema).optional(),
});
export type SessionView = z.infer<typeof SessionSchema>;

export const TurnSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  status: TurnStatusSchema,
  stopReason: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  /** Why the turn started. Absent for turns recorded before triggers existed. */
  trigger: TurnTriggerSchema.optional(),
  /**
   * The prompt the turn ran with (GET only): what the user sent, or for a
   * GitHub wake the prompt kiro-remote rendered from the events.
   */
  prompt: z.string().optional(),
});
export type TurnView = z.infer<typeof TurnSchema>;

export const EventSchema = z.object({
  seq: z.number().int(),
  sessionId: z.string(),
  turnId: z.string().nullable(),
  type: z.string(),
  rawType: z.string(),
  replay: z.boolean(),
  ts: z.string(),
  payload: z.unknown(),
});
export type EventView = z.infer<typeof EventSchema>;

/**
 * Registry of the schemas that map to an MCP tool input. The MCP server and
 * the OpenAPI generator both read from this single object so there is one
 * source of truth and the parity test can iterate it.
 */
export const TOOL_INPUT_SCHEMAS = {
  launchSession: LaunchSessionSchema,
  listSessions: ListSessionsQuerySchema,
  adoptSession: AdoptSessionSchema,
  createTurn: CreateTurnSchema,
  getEvents: EventsQuerySchema,
  answerPermission: AnswerPermissionSchema,
  setConfig: ConfigPatchSchema,
} as const;

export type ToolName = keyof typeof TOOL_INPUT_SCHEMAS;

export { z };
