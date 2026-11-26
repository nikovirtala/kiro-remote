/**
 * What the Tasks tests share: the records a bridge leaves (a turn row, a queued
 * prompt that failed) and the id of the task for a turn.
 */

import { queuedPromptSk, sessionPk, turnSk } from "@nikovirtala/kiro-remote-core";
import { encodeTaskId, TASK_TTL_MS } from "../src/tasks/index.ts";
import { type InProcHarness, principal } from "./helpers.ts";

export const P = principal();
export const OTHER = principal({ sub: "user-2" });
export const NOW = Date.parse("2026-11-26T12:00:00.000Z");

export type Status = "queued" | "running" | "completed" | "failed" | "refused" | "cancelled";

/** A turn row the way the bridge writes it. */
export async function putTurn(
  h: InProcHarness,
  sessionId: string,
  id: string,
  status: Status,
  over: { stopReason?: string | null; endedAt?: string | null } = {},
) {
  await h.repo.putTurn({
    PK: sessionPk(sessionId),
    SK: turnSk(id),
    id,
    sessionId,
    prompt: "the prompt",
    status,
    stopReason: over.stopReason ?? null,
    startedAt: "2026-11-26T12:00:01.000Z",
    endedAt: over.endedAt ?? null,
    metering: null,
  });
}

/** What Repository.failQueuedPrompt leaves on the row (the fake DynamoDB cannot run its transaction). */
export function failQueued(h: InProcHarness, sessionId: string, id: string, reason: string) {
  const key = `${sessionPk(sessionId)}\u0000${queuedPromptSk(id)}`;
  const row = h.ddb.items.get(key);
  if (!row) throw new Error("no such queued prompt");
  h.ddb.put({ ...row, status: "failed", failReason: reason, failedAt: "2026-11-26T12:00:05.000Z" });
}

/** The task a tool call would create for this turn. */
export const taskIdFor = (sessionId: string, turnId: string, ttlMs: number | null = TASK_TTL_MS) =>
  encodeTaskId({ sessionId, turnId, createdAtMs: NOW, ttlMs });
