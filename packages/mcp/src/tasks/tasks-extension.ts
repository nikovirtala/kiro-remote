/**
 * `TasksExtension`: the server side of the MCP Tasks extension
 * (`io.modelcontextprotocol/tasks`, SEP-2663), hand-written to the design of
 * modelcontextprotocol/typescript-sdk PR #2782 (`packages/server/src/ext/tasks/
 * tasksExtension.ts`, head 91bacde) because @modelcontextprotocol/server 2.4.0
 * ships no ext/tasks. REPLACEABLE: when the SDK publishes
 * `@modelcontextprotocol/server/ext/tasks`, swap this folder for it. The names
 * (TasksExtension, TaskStore, create) and the store's four methods match, so
 * the swap is the import, the store's wiring in extensions.ts, and dropping
 * {@link TasksExtension.afterToolCall} for the SDK's `tools/call` middleware.
 *
 * It owns the wire: the capability in `server/discover`, the per-request check
 * that the client declared the extension, `tasks/get`, `tasks/update` and
 * `tasks/cancel` (2026-07-28 only), and the `tools/call` result that is a task
 * handle. What a task is lives behind the {@link TaskStore}.
 *
 * Differences from the PR, each forced by 2.4.0 or by this server:
 *  - There is no `ServerExtension` / `ctx.use('tools/call')` in 2.4.0. An
 *    extension here is a {@link McpExtension}: `attach(mcp)` registers the
 *    methods, and the optional `afterToolCall` hook (server.ts) is where a
 *    tool result becomes a task handle.
 *  - No `principal` option: the store reads as the caller (see TurnTaskStore).
 *  - `create` takes the tool's own context, not a handler `ctx` argument, and
 *    the store may refuse (TaskNotDurableError), in which case the tool answers
 *    as it does without Tasks.
 *  - Whether a request is 2026-07-28 is read from the envelope's protocol
 *    version, not from the envelope's presence: 2.4.0 lifts the `_meta` of a
 *    2025-era request into `ctx.mcpReq.envelope` too.
 *  - `tasks/update` takes a hand-written params schema that reads only `taskId`:
 *    a Kiro task issues no input requests, so every key a client sends is
 *    unknown and is ignored whatever its shape (ext-tasks/core/v2's
 *    UpdateTaskRequestV2Schema would reject a malformed value instead).
 */

import {
  type CancelTaskResultV2,
  type CreateTaskResultV2,
  GetTaskRequestV2Schema,
  type GetTaskResultV2,
  TASKS_EXTENSION_ID_V2,
  type UpdateTaskResultV2,
} from "@modelcontextprotocol/ext-tasks/core/v2";
import {
  CLIENT_CAPABILITIES_META_KEY,
  type McpServer,
  MissingRequiredClientCapabilityError,
  PROTOCOL_VERSION_META_KEY,
  ProtocolError,
  ProtocolErrorCode,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { ForbiddenError } from "@nikovirtala/kiro-remote-core";
import { InsufficientScopeError } from "../errors.ts";
import type { McpExtension } from "../extensions.ts";
import { type Logger, silentLogger } from "../logger.ts";
import type { CallToolOutcome } from "../server.ts";
import { TASK_POLL_INTERVAL_MS, TASK_TTL_MS } from "./constants.ts";
import { type CreateTaskParams, TaskNotDurableError, type TaskStore } from "./store.ts";

export const TASKS_EXTENSION_ID = TASKS_EXTENSION_ID_V2;

/** The first protocol revision with the per-request envelope; the extension is served from it on. */
const FIRST_MODERN_REVISION = "2026-07-28";

/** The tools whose call starts a Kiro turn, and so may answer with a task. */
export const TASK_TOOLS: ReadonlySet<string> = new Set(["kiro_send_prompt"]);

export interface TasksExtensionOptions {
  /** Default retention for `create`, ms; `null` = unlimited. Default {@link TASK_TTL_MS}. */
  defaultTtlMs?: number | null;
  /** Default polling hint for `create`, ms. Default {@link TASK_POLL_INTERVAL_MS}. */
  defaultPollIntervalMs?: number;
  logger?: Logger;
}

/** What a tool passes to {@link TasksExtension.create}. */
export type CreateTaskOptions = Partial<CreateTaskParams>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The client capabilities the request's `_meta` envelope declared; none on the 2025 era. */
function declaredCapabilities(ctx: ServerContext): Record<string, unknown> {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const capabilities = envelope?.[CLIENT_CAPABILITIES_META_KEY];
  return isRecord(capabilities) ? capabilities : {};
}

/**
 * Whether this is a 2026-07-28 request. The `_meta` of a 2025-era request is
 * lifted into `ctx.mcpReq.envelope` too, whatever it holds, so the envelope's
 * presence is not the test: its protocol version is.
 */
function isModernRequest(ctx: ServerContext): boolean {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const version = envelope?.[PROTOCOL_VERSION_META_KEY];
  // Revisions are dates, so they compare as strings.
  return (
    typeof version === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(version) &&
    version >= FIRST_MODERN_REVISION
  );
}

/** Whether this request declared the tasks extension in its per-request client capabilities (2026-07-28 only). */
export function declaresTasksExtension(ctx: ServerContext): boolean {
  if (!isModernRequest(ctx)) {
    return false;
  }
  const extensions = declaredCapabilities(ctx).extensions;
  return isRecord(extensions) && Object.hasOwn(extensions, TASKS_EXTENSION_ID);
}

/** -32021 for a request that did not declare the extension. */
function requireTasksExtension(ctx: ServerContext, what: string): void {
  if (declaresTasksExtension(ctx)) {
    return;
  }
  throw new MissingRequiredClientCapabilityError(
    { requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } } },
    `${what} requires the request to declare the "${TASKS_EXTENSION_ID}" extension capability`,
  );
}

/** The methods exist on 2026-07-28 only; on 2025-11-25 they are other, core methods. */
function requireModernRequest(ctx: ServerContext): void {
  if (!isModernRequest(ctx)) {
    throw new ProtocolError(ProtocolErrorCode.MethodNotFound, "Method not found");
  }
}

/**
 * Run a store call as the caller. The store reads with the caller's own scopes, so a
 * caller without `sessions:read` gets the OAuth insufficient_scope error a tool
 * call gives, before any record is looked at (nothing about the task is revealed).
 */
async function asCaller<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof ForbiddenError) {
      throw new InsufficientScopeError(err.neededScope);
    }
    throw err;
  }
}

/** The answer for an unknown, expired or foreign task. One message for all, so existence never leaks. */
function notFound(): never {
  throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Task not found");
}

/**
 * `tasks/update` params. The wire schema requires `inputResponses`, but the
 * SDK lifts that field out of the params before the handler runs, and a Kiro
 * task never asks for input, so only `taskId` is read here. A hand-written
 * Standard Schema, because every key the client sends is one we never issued and
 * is ignored, whatever its shape.
 */
const updateParams = {
  "~standard": {
    version: 1 as const,
    vendor: "kiro-remote",
    validate(value: unknown) {
      const taskId = isRecord(value) ? value.taskId : undefined;
      return typeof taskId === "string" && taskId !== ""
        ? { value: { taskId } }
        : { issues: [{ message: "taskId must be a non-empty string" }] };
    },
  },
};

export class TasksExtension implements McpExtension {
  readonly id = TASKS_EXTENSION_ID;
  readonly store: TaskStore;
  readonly #defaultTtlMs: number | null;
  readonly #defaultPollIntervalMs: number;
  readonly #logger: Logger;

  constructor(store: TaskStore, options: TasksExtensionOptions = {}) {
    this.store = store;
    this.#defaultTtlMs = options.defaultTtlMs === undefined ? TASK_TTL_MS : options.defaultTtlMs;
    this.#defaultPollIntervalMs = options.defaultPollIntervalMs ?? TASK_POLL_INTERVAL_MS;
    this.#logger = options.logger ?? silentLogger;
  }

  /**
   * Create the task for the current `tools/call` and return the handle the tool
   * answers with. Refuses with -32021 when the request did not declare the
   * extension. The store creates the task durably before this resolves.
   */
  async create(ctx: ServerContext, options: CreateTaskOptions = {}): Promise<CreateTaskResultV2> {
    requireTasksExtension(ctx, "This tool call executes as a task and");
    const task = await this.store.create({
      ttlMs: options.ttlMs === undefined ? this.#defaultTtlMs : options.ttlMs,
      pollIntervalMs: options.pollIntervalMs ?? this.#defaultPollIntervalMs,
      ...(options.context !== undefined ? { context: options.context } : {}),
    });
    return { resultType: "task", ...task };
  }

  /**
   * The `tools/call` hook (server.ts calls it with every result): when a task
   * tool succeeded for a client that declared the extension, answer with the
   * task handle instead of the plain result. `undefined` leaves the result as it
   * is, which is what every other client and every other tool gets.
   *
   * The tool has already acted (the prompt is sent), so a task that cannot be
   * made never turns that into an error: the plain result is returned and the
   * model drives kiro_wait_for_events as it does without Tasks.
   */
  async afterToolCall(
    call: { name: string; args: Record<string, unknown> },
    outcome: CallToolOutcome,
    ctx: ServerContext,
  ): Promise<Record<string, unknown> | undefined> {
    if (!TASK_TOOLS.has(call.name) || outcome.isError || !declaresTasksExtension(ctx)) {
      return undefined;
    }
    const turnId = (outcome.structuredContent as { turn?: { id?: unknown } } | undefined)?.turn?.id;
    const sessionId = call.args.sessionId;
    if (typeof turnId !== "string" || typeof sessionId !== "string") {
      return undefined;
    }
    try {
      const handle = await this.create(ctx, { context: { sessionId, turnId } });
      // A tool result carries `content`; the handle has none to give.
      return { content: [], ...handle };
    } catch (err) {
      this.#logger.info("task not created, answering the tool call without one", {
        tool: call.name,
        durable: !(err instanceof TaskNotDurableError),
        message: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  /** Register `tasks/get`, `tasks/update` and `tasks/cancel`, and advertise the capability. */
  attach(mcp: McpServer): void {
    const server = mcp.server;
    const idParams = GetTaskRequestV2Schema.shape.params;

    server.setRequestHandler(
      "tasks/get" as never,
      { params: idParams } as never,
      (async (params: { taskId: string }, ctx: ServerContext): Promise<GetTaskResultV2> => {
        requireModernRequest(ctx);
        requireTasksExtension(ctx, "tasks/get");
        const task = await asCaller(() => this.store.get(params.taskId));
        if (task === undefined) {
          return notFound();
        }
        return { resultType: "complete", ...task } as GetTaskResultV2;
      }) as never,
    );

    server.setRequestHandler(
      "tasks/update" as never,
      { params: updateParams } as never,
      (async (params: { taskId: string }, ctx: ServerContext): Promise<UpdateTaskResultV2> => {
        requireModernRequest(ctx);
        requireTasksExtension(ctx, "tasks/update");
        if (!(await asCaller(() => this.store.update(params.taskId, {})))) {
          return notFound();
        }
        return { resultType: "complete" };
      }) as never,
    );

    server.setRequestHandler(
      "tasks/cancel" as never,
      { params: idParams } as never,
      (async (params: { taskId: string }, ctx: ServerContext): Promise<CancelTaskResultV2> => {
        requireModernRequest(ctx);
        requireTasksExtension(ctx, "tasks/cancel");
        if (!(await asCaller(() => this.store.cancel(params.taskId)))) {
          return notFound();
        }
        return { resultType: "complete" };
      }) as never,
    );

    server.registerCapabilities({ extensions: { [TASKS_EXTENSION_ID]: {} } } as never);
  }
}
