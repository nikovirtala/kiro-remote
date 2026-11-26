/**
 * {@link TaskStore} backed by the Kiro turn records, not by a table of its own.
 *
 * A task stands for one turn of one session. Its id names the session and the
 * turn ({@link encodeTaskId}), and every read goes to the same records
 * `GET /sessions/{id}/turns/{turnId}` reads: the turn row, or the prompt row
 * while the prompt still waits on the session's queue. That is what makes the
 * store stateless (the Lambda keeps nothing between requests) and what makes a
 * task durable: the row exists before kiro_send_prompt answers when the prompt
 * was sent with whenBusy "queue" (see {@link TurnTaskStore.create}).
 *
 * Ownership is the access check. Reads go through the caller's own
 * {@link Principal}, and an unknown session, someone else's session and a
 * missing turn all answer `undefined`, so a task id never reveals whether it
 * exists. A caller that lacks the `sessions:read` scope gets the usual
 * insufficient_scope error, before any record is looked at.
 */

import type {
  DetailedTaskV2,
  ErrorV2,
  InputResponsesV2,
  TaskV2,
} from "@modelcontextprotocol/ext-tasks/core/v2";
import type { ClientTurn } from "@nikovirtala/kiro-remote-api";
import { type Principal, SessionNotFoundError } from "@nikovirtala/kiro-remote-core";
import type { ToolClient } from "../client.ts";
import { finalTranscript } from "../events.ts";
import { TASK_POLL_INTERVAL_MS } from "./constants.ts";
import { type CreateTaskParams, TaskNotDurableError, type TaskStore } from "./store.ts";
import { decodeTaskId, encodeTaskId, type TaskRef } from "./task-id.ts";

/** JSON-RPC internal error: the code a failed task carries. */
const INTERNAL_ERROR = -32603;

/** Why a prompt that failed on the queue did not run, in words. */
const QUEUE_FAILURES: Readonly<Record<string, string>> = {
  session_deleted: "The session was deleted before the prompt ran.",
  session_failed: "The session failed before the prompt ran.",
  not_sent: "The prompt could not be sent to the session.",
};

export interface TurnTaskStoreDeps {
  client: ToolClient;
  /** The caller of this request; every read runs as them. */
  principal: () => Principal;
  now?: () => number;
  /** The hint on every task (defaults to {@link TASK_POLL_INTERVAL_MS}). */
  pollIntervalMs?: number;
}

/** The task for a turn in the state it is in, without its result (a completed task adds it). */
interface Snapshot {
  task: DetailedTaskV2 | (TaskV2 & { status: "completed" });
  turn: ClientTurn;
}

export class TurnTaskStore implements TaskStore {
  readonly #client: ToolClient;
  readonly #principal: () => Principal;
  readonly #now: () => number;
  readonly #pollIntervalMs: number;

  constructor(deps: TurnTaskStoreDeps) {
    this.#client = deps.client;
    this.#principal = deps.principal;
    this.#now = deps.now ?? Date.now;
    this.#pollIntervalMs = deps.pollIntervalMs ?? TASK_POLL_INTERVAL_MS;
  }

  /**
   * Make the task for `context.sessionId` / `context.turnId`. The turn must be
   * readable before this resolves (the extension's rule that a `tasks/get` for
   * the returned id succeeds); when it is not, this throws
   * {@link TaskNotDurableError} and the caller answers the tool call without a
   * task. A prompt sent with whenBusy "queue" is always readable (its queue row
   * is written before the call answers); one sent with "steer" or "reject" to
   * an idle session is a command on the bridge's queue until the bridge writes
   * the turn row, so it is not.
   */
  async create(params: CreateTaskParams): Promise<TaskV2> {
    const sessionId = params.context?.sessionId;
    const turnId = params.context?.turnId;
    if (typeof sessionId !== "string" || typeof turnId !== "string") {
      throw new TaskNotDurableError("a task needs the session id and the turn id");
    }
    const taskId = encodeTaskId({
      sessionId,
      turnId,
      createdAtMs: this.#now(),
      ttlMs: params.ttlMs,
    });
    const ref = decodeTaskId(taskId);
    const snapshot = ref ? await this.#snapshot(ref) : undefined;
    if (!snapshot) {
      throw new TaskNotDurableError("the turn cannot be read yet, so it cannot back a task");
    }
    const { task } = snapshot;
    return {
      taskId: task.taskId,
      status: task.status,
      ...(task.statusMessage !== undefined ? { statusMessage: task.statusMessage } : {}),
      createdAt: task.createdAt,
      lastUpdatedAt: task.lastUpdatedAt,
      ttlMs: task.ttlMs,
      pollIntervalMs: params.pollIntervalMs ?? this.#pollIntervalMs,
    };
  }

  async get(taskId: string): Promise<DetailedTaskV2 | undefined> {
    const ref = this.#resolve(taskId);
    const snapshot = ref ? await this.#snapshot(ref) : undefined;
    if (!ref || !snapshot) {
      return undefined;
    }
    if (snapshot.task.status !== "completed") {
      return snapshot.task as DetailedTaskV2;
    }
    // The answer is the turn's final text, from the same code kiro_get_transcript uses.
    let transcript: Awaited<ReturnType<typeof finalTranscript>>;
    try {
      transcript = await finalTranscript(this.#client, this.#principal(), ref.sessionId);
    } catch (err) {
      if (!(err instanceof SessionNotFoundError)) {
        throw err;
      }
      // Deleted between the two reads: the answer went with the session.
      return taskForTurn(ref, {
        ...snapshot.turn,
        status: "failed",
        stopReason: "session_deleted",
      }) as DetailedTaskV2;
    }
    const text = transcript.turns.find((t) => t.turnId === ref.turnId)?.text ?? "";
    return { ...snapshot.task, status: "completed", result: completedResult(ref, text) };
  }

  /**
   * Acknowledge an update. A Kiro turn never asks the client for input
   * (`input_required` is not used), so there is no outstanding request an answer
   * could belong to and every key is one the task never issued: the spec says
   * to ignore those, so only the task's existence is checked.
   */
  async update(taskId: string, _inputResponses: InputResponsesV2): Promise<boolean> {
    const ref = this.#resolve(taskId);
    return ref !== undefined && (await this.#snapshot(ref)) !== undefined;
  }

  /**
   * Ask the session to cancel the task's turn: the same call as kiro_cancel_turn.
   * It is cooperative. A cloud session rejects a cancel while its turn runs, and
   * the turn then ends as it would have, so the task reaches `completed` or
   * `failed` on its own. Nothing is sent for a settled turn (the answer is the
   * same), nor for a prompt still waiting on the queue: cancel acts on the
   * session's running turn, which is another turn, and must not stop that one.
   */
  async cancel(taskId: string): Promise<boolean> {
    const ref = this.#resolve(taskId);
    const snapshot = ref ? await this.#snapshot(ref) : undefined;
    if (!ref || !snapshot) {
      return false;
    }
    if (snapshot.turn.status === "running") {
      await this.#client.cancelTurn(this.#principal(), ref.sessionId);
    }
    return true;
  }

  /** The task a string names, unless it is not one of ours or its TTL has passed. */
  #resolve(taskId: string): TaskRef | undefined {
    const ref = decodeTaskId(taskId);
    if (!ref) {
      return undefined;
    }
    return ref.ttlMs !== null && this.#now() - ref.createdAtMs > ref.ttlMs ? undefined : ref;
  }

  async #snapshot(ref: TaskRef): Promise<Snapshot | undefined> {
    const turn = await this.#client.getTurn(this.#principal(), ref.sessionId, ref.turnId);
    if (!turn) {
      return undefined;
    }
    return { task: taskForTurn(ref, turn), turn };
  }
}

/**
 * The result of a completed task. The answer is in `structuredContent` as well
 * as in the text block: the spec treats the text block as a copy of
 * `structuredContent` for older clients, and hosts such as claude.ai show the
 * model only `structuredContent`. Both read the one `text`, so they cannot drift.
 */
export function completedResult(ref: TaskRef, text: string) {
  return {
    resultType: "complete" as const,
    content: [{ type: "text" as const, text }],
    structuredContent: {
      sessionId: ref.sessionId,
      turnId: ref.turnId,
      status: "completed" as const,
      text,
    },
  };
}

/** The ISO time of the later of two ISO times. */
function later(a: string, b: string | null): string {
  return b !== null && b > a ? b : a;
}

/** What went wrong with a failed or refused turn, as the task's JSON-RPC error. */
function failureOf(ref: TaskRef, turn: ClientTurn): ErrorV2 {
  const reason = turn.stopReason;
  const known = reason !== null ? QUEUE_FAILURES[reason] : undefined;
  const message =
    known ??
    `The Kiro turn ${turn.status === "refused" ? "was refused" : "failed"}${reason ? `: ${reason}` : ""}.`;
  return {
    code: INTERNAL_ERROR,
    message,
    data: {
      sessionId: ref.sessionId,
      turnId: ref.turnId,
      status: turn.status,
      ...(reason !== null ? { reason } : {}),
    },
  };
}

/**
 * The task a turn is in its current state (the whole mapping, one place):
 * queued and running are working; completed, cancelled and failed are the
 * same; refused is failed. A completed task here has no result yet.
 */
export function taskForTurn(
  ref: TaskRef,
  turn: ClientTurn,
): DetailedTaskV2 | (TaskV2 & { status: "completed" }) {
  const createdAt = new Date(ref.createdAtMs).toISOString();
  const base = {
    taskId: encodeTaskId(ref),
    createdAt,
    lastUpdatedAt: later(createdAt, turn.endedAt ?? turn.startedAt),
    ttlMs: ref.ttlMs,
  };
  switch (turn.status) {
    case "completed":
      return { ...base, status: "completed" };
    case "cancelled":
      return { ...base, status: "cancelled" };
    case "failed":
    case "refused": {
      const error = failureOf(ref, turn);
      return { ...base, status: "failed", statusMessage: error.message, error };
    }
    default:
      return {
        ...base,
        status: "working",
        statusMessage:
          turn.status === "queued"
            ? "The prompt waits for the turns in front of it."
            : "The turn is running.",
      };
  }
}
