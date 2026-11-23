/**
 * The 19 MCP tools.
 *
 * Each tool is defined ONCE here with its name, description, required core
 * {@link Action} (which authorize() turns into a scope), MCP annotations
 * (readOnlyHint on reads, destructiveHint on delete/cancel), the zod object its
 * input is validated with, and a handler that calls ONLY the
 * {@link ToolClient} interface -- never any transport-specific logic.
 *
 * Schema parity: the `inputSchema` advertised to MCP clients is generated from
 * the tool's zod object via {@link toMcpInputSchema}, the identical generator
 * the OpenAPI document uses. Tools whose input is exactly a core request body
 * (launch, list_sessions, adopt) use the core zod object verbatim. Tools that
 * additionally need a path identifier (sessionId / requestId) build their zod
 * object by {@link z.ZodObject.extend}-ing the core object, which preserves the
 * core fields' generated schemas byte-for-byte. {@link CORE_SCHEMA_FOR_TOOL}
 * records the core object each tool's body derives from so a parity test can
 * assert no field ever diverges from core.
 */

import type { WriteOptions } from "@nikovirtala/kiro-remote-api";
import {
  type Action,
  AdoptSessionSchema,
  AnswerPermissionSchema,
  authorize,
  ConfigPatchSchema,
  CreateTurnSchema,
  EventsQuerySchema,
  FeedQuerySchema,
  IdempotencyKeyFieldSchema,
  type JsonSchema,
  LaunchSessionSchema,
  LinkPullRequestSchema,
  ListSessionsQuerySchema,
  type Principal,
  toMcpInputSchema,
  WaitForPullRequestSchema,
  z,
} from "@nikovirtala/kiro-remote-core";
import type { ToolClient } from "./client.ts";
import { collectEvents, finalTranscript } from "./events.ts";

/** A JSON value returned as the tool's structured result. */
export type ToolResult = Record<string, unknown>;

/** The MCP annotations we set (display-only hints). */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** A single MCP tool definition. */
export interface ToolDef {
  name: string;
  description: string;
  /** The core action whose scope authorize() checks for this tool. */
  action: Action;
  /** The zod object the tool input is validated with (parity source). */
  inputZod: z.ZodType;
  /** MCP annotations advertised with the tool. */
  annotations: ToolAnnotations;
  /** Run the tool. `args` is the raw (unvalidated) input object. */
  run(client: ToolClient, principal: Principal, args: Record<string, unknown>): Promise<ToolResult>;
}

/* -------------------------------------------------------------------------- */
/* Tool input zod objects (built from the core objects, never diverging)      */
/* -------------------------------------------------------------------------- */

/** A session id, shared by the session-targeting tools. */
const SessionIdField = { sessionId: z.string().min(1) };

/** The optional key every state-changing tool accepts. */
const IdempotencyField = { idempotencyKey: IdempotencyKeyFieldSchema.optional() };

/**
 * Appended to every state-changing tool's description so agents know to use the
 * key. One sentence; the field's own description says the same.
 */
const IDEMPOTENCY_SENTENCE =
  " Pass idempotencyKey (the same value on every retry of this call) so a retry runs at most once within 24 hours; reusing a key with different input is refused.";

/** Tools that take no arguments share this empty-object schema. */
const EmptyInputSchema = z.object({});

/** kiro_get_session. */
const SessionIdSchema = z.object({ ...SessionIdField });

/** kiro_cancel_turn / kiro_delete_session. */
const SessionIdWriteSchema = SessionIdSchema.extend(IdempotencyField);

/** kiro_launch_session / kiro_adopt_session: the core body plus the key. */
const LaunchToolSchema = LaunchSessionSchema.extend(IdempotencyField);
const AdoptToolSchema = AdoptSessionSchema.extend(IdempotencyField);

/** kiro_get_transcript. */
const GetTranscriptSchema = z.object({ ...SessionIdField });

/** kiro_wait_for_events: the events query (minus wait, fixed server-side) plus the session. */
const WaitForEventsSchema = EventsQuerySchema.omit({ wait: true }).extend(SessionIdField);

/** kiro_send_prompt: the CreateTurn body plus the session. */
const SendPromptSchema = CreateTurnSchema.extend({ ...SessionIdField, ...IdempotencyField });

/** kiro_answer_permission: the AnswerPermission body plus the session + requestId. */
const AnswerPermissionToolSchema = AnswerPermissionSchema.extend({
  ...SessionIdField,
  requestId: z.string().min(1),
  ...IdempotencyField,
});

/** kiro_set_config: the ConfigPatch body plus the session. The core refine is kept. */
const SetConfigToolSchema = ConfigPatchSchema.safeExtend({
  ...SessionIdField,
  ...IdempotencyField,
});

/** kiro_link_pull_request / kiro_unlink_pull_request: the link body plus the session. */
const LinkToolSchema = LinkPullRequestSchema.extend({ ...SessionIdField, ...IdempotencyField });

/** kiro_wait_for_pull_request / kiro_stop_waiting_for_pull_request: the PR body plus the session. */
const WaitToolSchema = WaitForPullRequestSchema.extend({ ...SessionIdField, ...IdempotencyField });

/** kiro_list_permissions. */
const ListPermissionsSchema = z.object({
  ...SessionIdField,
  status: z.string().min(1).optional(),
});

/** The client's write options for a tool's optional key (none when absent). */
function writeOptions(idempotencyKey: string | undefined): WriteOptions {
  return idempotencyKey !== undefined ? { idempotencyKey } : {};
}

/**
 * The core zod object each tool's body derives from, for the parity test.
 * Tools absent from this map take an empty object or only identifiers.
 */
export const CORE_SCHEMA_FOR_TOOL: Readonly<Record<string, z.ZodType>> = {
  kiro_launch_session: LaunchSessionSchema,
  kiro_list_sessions: ListSessionsQuerySchema,
  kiro_adopt_session: AdoptSessionSchema,
  kiro_send_prompt: CreateTurnSchema,
  kiro_wait_for_events: EventsQuerySchema,
  kiro_answer_permission: AnswerPermissionSchema,
  kiro_set_config: ConfigPatchSchema,
  kiro_link_pull_request: LinkPullRequestSchema,
  kiro_unlink_pull_request: LinkPullRequestSchema,
  kiro_list_events: FeedQuerySchema,
  kiro_wait_for_pull_request: WaitForPullRequestSchema,
  kiro_stop_waiting_for_pull_request: WaitForPullRequestSchema,
};

/**
 * The canonical list of the 19 tools, in a stable order. Each handler calls
 * only the client interface, so the SAME definitions serve both transports.
 */
export const TOOL_DEFS: readonly ToolDef[] = [
  {
    name: "kiro_capabilities",
    description:
      "Report the control plane's advertised capabilities, the kiro-cli version, and the caller's active cloud-session count.",
    action: "read",
    inputZod: EmptyInputSchema,
    annotations: { title: "Capabilities", readOnlyHint: true, openWorldHint: false },
    async run(client, principal) {
      const caps = await client.capabilities(principal);
      return {
        capabilities: caps.capabilities,
        kiroCliVersion: caps.kiroCliVersion,
        activeSessionCount: caps.activeSessionCount,
      };
    },
  },
  {
    name: "kiro_list_models",
    description: "List the model ids the running agent advertises.",
    action: "read",
    inputZod: EmptyInputSchema,
    annotations: { title: "List Models", readOnlyHint: true, openWorldHint: false },
    async run(client, principal) {
      return await client.listModels(principal);
    },
  },
  {
    name: "kiro_launch_session",
    description: `Launch a new Kiro cloud session against one or more repos with an initial prompt.${IDEMPOTENCY_SENTENCE}`,
    action: "launch",
    inputZod: LaunchToolSchema,
    annotations: { title: "Launch Session", readOnlyHint: false, openWorldHint: true },
    async run(client, principal, args) {
      const { idempotencyKey, ...input } = LaunchToolSchema.parse(args);
      return await client.launchSession(principal, input, writeOptions(idempotencyKey));
    },
  },
  {
    name: "kiro_list_sessions",
    description:
      "List the caller's sessions, newest first, with an optional status filter and pagination cursor.",
    action: "read",
    inputZod: ListSessionsQuerySchema,
    annotations: { title: "List Sessions", readOnlyHint: true, openWorldHint: false },
    async run(client, principal, args) {
      const q = ListSessionsQuerySchema.parse(args);
      return await client.listSessions(principal, {
        limit: q.limit,
        ...(q.cursor ? { cursor: q.cursor } : {}),
        ...(q.status ? { status: q.status } : {}),
      });
    },
  },
  {
    name: "kiro_adopt_session",
    description: `Adopt an existing Kiro cloud session (started elsewhere) into the control plane.${IDEMPOTENCY_SENTENCE}`,
    action: "launch",
    inputZod: AdoptToolSchema,
    annotations: { title: "Adopt Session", readOnlyHint: false, openWorldHint: true },
    async run(client, principal, args) {
      const { idempotencyKey, ...input } = AdoptToolSchema.parse(args);
      return await client.adoptSession(principal, input, writeOptions(idempotencyKey));
    },
  },
  {
    name: "kiro_get_session",
    description:
      "Fetch a single session the caller owns, with its linked pull requests (links), the pull requests it waits for (waits) and its prompt queue (queue: each prompt sent with whenBusy queue, with its turn id and status queued, delivered, started or failed, and the reason it failed).",
    action: "read",
    inputZod: SessionIdSchema,
    annotations: { title: "Get Session", readOnlyHint: true, openWorldHint: false },
    async run(client, principal, args) {
      const { sessionId } = SessionIdSchema.parse(args);
      return { session: await client.getSession(principal, sessionId) };
    },
  },
  {
    name: "kiro_send_prompt",
    description: `Send a prompt to a session. A session is busy while a turn runs and while prompts are queued. whenBusy "queue" keeps the prompt on the session's queue and runs it as its own turn, in order, after the turn in front of it; it ends as a turn or as a visible failure (turn.failed on the event log, shown in kiro_get_session's queue), never silently. "reject" refuses a busy session in the call. "steer" (the default) cannot be applied to a running cloud turn: for a busy session it fails in the call (steer_unsupported, use "queue" instead), stores nothing and leaves the queue as it is. The result's turn id is the id the turn runs under.${IDEMPOTENCY_SENTENCE}`,
    action: "prompt",
    inputZod: SendPromptSchema,
    annotations: { title: "Send Prompt", readOnlyHint: false, openWorldHint: true },
    async run(client, principal, args) {
      const input = SendPromptSchema.parse(args);
      const turn = await client.createTurn(
        principal,
        input.sessionId,
        { prompt: input.prompt, whenBusy: input.whenBusy },
        writeOptions(input.idempotencyKey),
      );
      return { turn };
    },
  },
  {
    name: "kiro_wait_for_events",
    description:
      "Long-poll a session's event log (at most 20s). Returns at most 30 events and 8000 chars of text, reports truncation, and includes nextCursor, turnStatus, and the pending-permission count so an agent can poll cheaply.",
    action: "read",
    inputZod: WaitForEventsSchema,
    annotations: { title: "Wait For Events", readOnlyHint: true, openWorldHint: false },
    async run(client, principal, args) {
      const input = WaitForEventsSchema.parse(args);
      const result = await collectEvents(client, principal, {
        sessionId: input.sessionId,
        after: input.after,
        ...(input.types ? { types: input.types } : {}),
      });
      return { ...result };
    },
  },
  {
    name: "kiro_get_transcript",
    description:
      "Return the assistant's FINAL text for each completed turn in a session (not raw events).",
    action: "read",
    inputZod: GetTranscriptSchema,
    annotations: { title: "Get Transcript", readOnlyHint: true, openWorldHint: false },
    async run(client, principal, args) {
      const { sessionId } = GetTranscriptSchema.parse(args);
      const result = await finalTranscript(client, principal, sessionId);
      return { ...result };
    },
  },
  {
    name: "kiro_list_permissions",
    description:
      "List a session's permission requests, optionally filtered by status (e.g. pending).",
    action: "read",
    inputZod: ListPermissionsSchema,
    annotations: { title: "List Permissions", readOnlyHint: true, openWorldHint: false },
    async run(client, principal, args) {
      const input = ListPermissionsSchema.parse(args);
      return await client.listPermissions(principal, input.sessionId, {
        ...(input.status ? { status: input.status } : {}),
      });
    },
  },
  {
    name: "kiro_answer_permission",
    description: `Answer a pending permission request by returning one of the agent-supplied optionIds (plus optional persistent consent).${IDEMPOTENCY_SENTENCE}`,
    action: "answerPermission",
    inputZod: AnswerPermissionToolSchema,
    annotations: { title: "Answer Permission", readOnlyHint: false, openWorldHint: true },
    async run(client, principal, args) {
      const input = AnswerPermissionToolSchema.parse(args);
      await client.answerPermission(
        principal,
        input.sessionId,
        input.requestId,
        {
          optionId: input.optionId,
          ...(input.consent ? { consent: input.consent } : {}),
        },
        writeOptions(input.idempotencyKey),
      );
      return { requestId: input.requestId, status: "answered" };
    },
  },
  {
    name: "kiro_set_config",
    description: `Change a session's model, effort level, and/or mode.${IDEMPOTENCY_SENTENCE}`,
    action: "config",
    inputZod: SetConfigToolSchema,
    annotations: { title: "Set Config", readOnlyHint: false, openWorldHint: true },
    async run(client, principal, args) {
      const input = SetConfigToolSchema.parse(args);
      await client.setConfig(
        principal,
        input.sessionId,
        {
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
          ...(input.mode ? { mode: input.mode } : {}),
        },
        writeOptions(input.idempotencyKey),
      );
      return { sessionId: input.sessionId, status: "configuring" };
    },
  },
  {
    name: "kiro_link_pull_request",
    description: `Link a pull request (owner/repo#n or a github.com URL) to a session so GitHub activity on it wakes the session. The PR's repo must be one of the session's repos; a PR links to at most one session.${IDEMPOTENCY_SENTENCE}`,
    action: "link",
    inputZod: LinkToolSchema,
    annotations: { title: "Link Pull Request", readOnlyHint: false, openWorldHint: true },
    async run(client, principal, args) {
      const input = LinkToolSchema.parse(args);
      const link = await client.linkPullRequest(
        principal,
        input.sessionId,
        { pr: input.pr },
        writeOptions(input.idempotencyKey),
      );
      return { sessionId: input.sessionId, link };
    },
  },
  {
    name: "kiro_unlink_pull_request",
    description: `Remove a pull request link from a session.${IDEMPOTENCY_SENTENCE}`,
    action: "link",
    inputZod: LinkToolSchema,
    // Not destructive: a link is reversible (link it again).
    annotations: { title: "Unlink Pull Request", readOnlyHint: false, openWorldHint: true },
    async run(client, principal, args) {
      const input = LinkToolSchema.parse(args);
      await client.unlinkPullRequest(
        principal,
        input.sessionId,
        { pr: input.pr },
        writeOptions(input.idempotencyKey),
      );
      return { sessionId: input.sessionId, pr: input.pr, status: "unlinked" };
    },
  },
  {
    name: "kiro_wait_for_pull_request",
    description: `Wake a session once when a pull request it depends on, but does not own, is merged or closed (owner/repo#n or a github.com URL). The PR's repo must be allowed but need not be one of the session's repos. A PR already merged or closed wakes the session at once. Any number of sessions can wait for one PR. kiro_get_session lists a session's waits.${IDEMPOTENCY_SENTENCE}`,
    action: "link",
    inputZod: WaitToolSchema,
    annotations: { title: "Wait For Pull Request", readOnlyHint: false, openWorldHint: true },
    async run(client, principal, args) {
      const input = WaitToolSchema.parse(args);
      const wait = await client.waitForPullRequest(
        principal,
        input.sessionId,
        { pr: input.pr },
        writeOptions(input.idempotencyKey),
      );
      return { sessionId: input.sessionId, wait };
    },
  },
  {
    name: "kiro_stop_waiting_for_pull_request",
    description: `Remove a session's wait for a pull request.${IDEMPOTENCY_SENTENCE}`,
    action: "link",
    inputZod: WaitToolSchema,
    // Not destructive: a wait is reversible (wait again).
    annotations: {
      title: "Stop Waiting For Pull Request",
      readOnlyHint: false,
      openWorldHint: true,
    },
    async run(client, principal, args) {
      const input = WaitToolSchema.parse(args);
      await client.stopWaitingForPullRequest(
        principal,
        input.sessionId,
        { pr: input.pr },
        writeOptions(input.idempotencyKey),
      );
      return { sessionId: input.sessionId, pr: input.pr, status: "stopped" };
    },
  },
  {
    name: "kiro_list_events",
    description:
      "Read the account's change feed: links and waits added, removed or changed, and every wake with its cause, in order. Pass after (the nextCursor of the last page, 0 to start) and limit (default 50, at most 200). Each event has id, seq (no gaps), ts, type, effect (state: moves state a reader follows; annotation: may be skipped if the type is unknown), sessionId, pr, source and a small typed payload. Events are kept 35 days.",
    action: "read",
    inputZod: FeedQuerySchema,
    annotations: { title: "List Events", readOnlyHint: true, openWorldHint: false },
    async run(client, principal, args) {
      const q = FeedQuerySchema.parse(args);
      return { ...(await client.listFeedEvents(principal, q)) };
    },
  },
  {
    name: "kiro_cancel_turn",
    description: `Cancel the active turn on a session.${IDEMPOTENCY_SENTENCE}`,
    action: "cancel",
    inputZod: SessionIdWriteSchema,
    annotations: {
      title: "Cancel Turn",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    async run(client, principal, args) {
      const { sessionId, idempotencyKey } = SessionIdWriteSchema.parse(args);
      await client.cancelTurn(principal, sessionId, writeOptions(idempotencyKey));
      return { sessionId, status: "cancelling" };
    },
  },
  {
    name: "kiro_delete_session",
    description: `Permanently delete a session and its cloud sandbox.${IDEMPOTENCY_SENTENCE}`,
    action: "delete",
    inputZod: SessionIdWriteSchema,
    annotations: {
      title: "Delete Session",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
    async run(client, principal, args) {
      const { sessionId, idempotencyKey } = SessionIdWriteSchema.parse(args);
      await client.deleteSession(principal, sessionId, writeOptions(idempotencyKey));
      return { sessionId, status: "deleting" };
    },
  },
];

/** The 19 tool names, in order. */
export const TOOL_NAMES: readonly string[] = TOOL_DEFS.map((t) => t.name);

/** Look up a tool definition by name. */
export function findTool(name: string): ToolDef | undefined {
  return TOOL_DEFS.find((t) => t.name === name);
}

/**
 * The MCP `tools/list` entries. Each `inputSchema` is generated from the tool's
 * zod object with {@link toMcpInputSchema} (the OpenAPI generator's twin).
 */
export interface ToolListEntry {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: ToolAnnotations;
}

export function toolListEntries(): ToolListEntry[] {
  return TOOL_DEFS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: toMcpInputSchema(t.inputZod),
    annotations: t.annotations,
  }));
}

/** Authorize a tool for a principal; throws the ForbiddenError the API uses. */
export function authorizeTool(def: ToolDef, principal: Principal): void {
  authorize(principal, def.action);
}
