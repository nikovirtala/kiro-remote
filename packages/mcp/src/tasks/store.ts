/**
 * The store interface of the Tasks extension: what the `tasks/*` request
 * handlers and {@link TasksExtension.create} call. It has the four methods of
 * the SDK's TaskStore (modelcontextprotocol/typescript-sdk PR #2782,
 * packages/server/src/ext/tasks/store.ts), so a store written against one
 * works with the other.
 *
 * What differs is where the state lives: the SDK's InMemoryTaskStore keeps
 * tasks in the process, ours ({@link TurnTaskStore}) keeps none and reads the
 * Kiro turn the task stands for.
 */

import type {
  DetailedTaskV2,
  InputResponsesV2,
  TaskV2,
} from "@modelcontextprotocol/ext-tasks/core/v2";

/** What {@link TaskStore.create} is asked to create. */
export interface CreateTaskParams {
  /** Retention from creation, ms; `null` = unlimited. */
  ttlMs: number | null;
  /** Suggested client polling interval, ms. */
  pollIntervalMs?: number;
  /**
   * Auth binding in the SDK: the creating request's principal. Ours binds a
   * task to the owner of its session through the caller's own reads, so this is
   * accepted and not needed.
   */
  principal?: string;
  /** Store-defined. {@link TurnTaskStore} reads `sessionId` and `turnId`. */
  context?: Record<string, unknown>;
}

/** The caller identity presented on a `tasks/*` request (unused by {@link TurnTaskStore}, see {@link CreateTaskParams.principal}). */
export interface TaskAccess {
  principal?: string;
}

/**
 * - `create` MUST NOT resolve before a subsequent `get(taskId)` would succeed.
 * - `get`, `update`, `cancel` resolve `undefined` / `false` for an unknown,
 *   expired or foreign task; the extension answers -32602 "Task not found".
 * - `cancel` is cooperative: it resolves on acknowledgement and the task may
 *   still settle `completed` or `failed`. Idempotent on settled tasks.
 */
export interface TaskStore {
  create(params: CreateTaskParams): Promise<TaskV2>;
  get(taskId: string, access?: TaskAccess): Promise<DetailedTaskV2 | undefined>;
  update(taskId: string, inputResponses: InputResponsesV2, access?: TaskAccess): Promise<boolean>;
  cancel(taskId: string, access?: TaskAccess): Promise<boolean>;
}

/** Thrown by `create` when the record the task stands for cannot be read back yet. */
export class TaskNotDurableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskNotDurableError";
  }
}
