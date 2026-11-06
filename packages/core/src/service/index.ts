/**
 * The service layer: pure functions callable from any trigger (API Lambda, MCP
 * server, tests). They are NOT Lambda-handler logic; they take an injected
 * {@link ServiceDeps} and return plain data.
 *
 * Writes ENQUEUE a command onto the SQS FIFO queue (the bridge executes it).
 * Reads derive everything from the event log plus session/turn rows, so no
 * endpoint returns anything not already durable.
 *
 * launchSession enforces:
 *   - MAX_CLOUD_SESSIONS (caller's own active count) -> ConcurrencyLimitError (429)
 *   - ALLOWED_REPOS glob allow-list                  -> RepoNotAllowedError  (403)
 */

import { ulid } from "ulid";
import type { Principal } from "../auth/authenticate.ts";
import { authorize } from "../auth/authorize.ts";
import { MAX_CLOUD_SESSIONS } from "../config.ts";
import { sessionPk } from "../repo/keys.ts";
import type { Repository } from "../repo/repository.ts";
import type { SessionMetaItem } from "../repo/types.ts";
import type { SessionView, TurnView } from "../schemas/index.ts";
import { matchesAllowList } from "./allowlist.ts";
import type { CommandQueue } from "./commands.ts";
import {
  ConcurrencyLimitError,
  InvalidStateError,
  RepoNotAllowedError,
  SessionNotFoundError,
} from "./errors.ts";

export interface ServiceDeps {
  repo: Repository;
  queue: CommandQueue;
  /** Glob allow-list of permitted repos (owner/name patterns). */
  allowedRepos: readonly string[];
  /** Injectable clock. */
  now?: () => number;
  /** Injectable id generator for determinism in tests. */
  newId?: () => string;
}

const ACTIVE_STATUSES = new Set(["provisioning", "running", "idle", "awaiting_permission"]);

function nowIso(deps: ServiceDeps): string {
  return new Date(deps.now?.() ?? Date.now()).toISOString();
}

function genId(deps: ServiceDeps): string {
  return deps.newId?.() ?? ulid();
}

function toSessionView(item: SessionMetaItem): SessionView {
  return {
    id: item.id,
    kiroSessionId: item.kiroSessionId,
    title: item.title,
    repos: item.repos,
    mode: item.mode,
    model: item.model,
    effort: item.effort,
    status: item.status,
    activeTurnId: item.activeTurnId,
    eventSeq: item.eventSeq,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/** Load a session and assert the principal owns it, else 404 (hide existence). */
async function loadOwned(
  deps: ServiceDeps,
  principal: Principal,
  id: string,
): Promise<SessionMetaItem> {
  const item = await deps.repo.getSession(id);
  if (!item || item.status === "deleted" || item.createdBy !== principal.sub) {
    throw new SessionNotFoundError(id);
  }
  return item;
}

export interface LaunchSessionArgs {
  prompt: string;
  repos: string[];
  title?: string;
  mode?: string;
  model?: string;
  effort?: string;
}

export async function launchSession(
  deps: ServiceDeps,
  principal: Principal,
  args: LaunchSessionArgs,
): Promise<SessionView> {
  authorize(principal, "launch");

  // 403: every requested repo must satisfy the allow-list.
  const denied = args.repos.filter((r) => !matchesAllowList(r, deps.allowedRepos));
  if (denied.length > 0) {
    throw new RepoNotAllowedError(denied);
  }

  // 429: the caller's own active cloud-session count must be under the cap.
  const { items } = await deps.repo.listSessionsByUser(principal.sub, { limit: 100 });
  const active = items.filter((s) => ACTIVE_STATUSES.has(s.status)).length;
  if (active >= MAX_CLOUD_SESSIONS) {
    throw new ConcurrencyLimitError(MAX_CLOUD_SESSIONS, active);
  }

  const id = genId(deps);
  const ts = nowIso(deps);
  const meta: SessionMetaItem = {
    PK: sessionPk(id),
    SK: "META",
    id,
    kiroSessionId: null,
    title: args.title ?? null,
    repos: args.repos,
    agent: null,
    mode: args.mode ?? null,
    model: args.model ?? null,
    effort: args.effort ?? null,
    status: "provisioning",
    activeTurnId: null,
    eventSeq: 0,
    createdBy: principal.sub,
    createdAt: ts,
    updatedAt: ts,
    version: 0,
    GSI1PK: `USER#${principal.sub}`,
    GSI1SK: ts,
  };
  await deps.repo.putSession(meta);

  await deps.queue.enqueue({
    kind: "launch",
    sub: principal.sub,
    sessionId: id,
    commandId: genId(deps),
    prompt: args.prompt,
    repos: args.repos,
    ...(args.title ? { title: args.title } : {}),
    ...(args.mode ? { mode: args.mode } : {}),
    ...(args.model ? { model: args.model } : {}),
    ...(args.effort ? { effort: args.effort } : {}),
  });

  return toSessionView(meta);
}

export async function sendPrompt(
  deps: ServiceDeps,
  principal: Principal,
  sessionId: string,
  args: { prompt: string; whenBusy: "steer" | "queue" | "reject" },
): Promise<TurnView> {
  authorize(principal, "prompt", { createdBy: undefined });
  const session = await loadOwned(deps, principal, sessionId);
  authorize(principal, "prompt", { createdBy: session.createdBy });

  // A busy session only accepts a new prompt per the whenBusy policy; "reject"
  // short-circuits here, the bridge enforces steer/queue semantics in order.
  const busy = session.status === "running" || session.status === "awaiting_permission";
  if (busy && args.whenBusy === "reject") {
    throw new InvalidStateError("session is busy and whenBusy=reject");
  }

  const turnId = genId(deps);
  await deps.queue.enqueue({
    kind: "prompt",
    sub: principal.sub,
    sessionId,
    commandId: genId(deps),
    turnId,
    prompt: args.prompt,
    whenBusy: args.whenBusy,
  });

  return {
    id: turnId,
    sessionId,
    status: busy && args.whenBusy === "queue" ? "queued" : "running",
    stopReason: null,
    startedAt: null,
    endedAt: null,
  };
}

export async function steer(
  deps: ServiceDeps,
  principal: Principal,
  sessionId: string,
  content: string,
): Promise<void> {
  const session = await loadOwned(deps, principal, sessionId);
  authorize(principal, "steer", { createdBy: session.createdBy });
  await deps.queue.enqueue({
    kind: "steer",
    sub: principal.sub,
    sessionId,
    commandId: genId(deps),
    content,
  });
}

export async function cancelTurn(
  deps: ServiceDeps,
  principal: Principal,
  sessionId: string,
): Promise<void> {
  const session = await loadOwned(deps, principal, sessionId);
  authorize(principal, "cancel", { createdBy: session.createdBy });
  await deps.queue.enqueue({
    kind: "cancel",
    sub: principal.sub,
    sessionId,
    commandId: genId(deps),
  });
}

export async function answerPermission(
  deps: ServiceDeps,
  principal: Principal,
  sessionId: string,
  requestId: string,
  args: {
    optionId: string;
    consent?: { scope: string; resource: string; workspaceRoot: string };
  },
): Promise<void> {
  const session = await loadOwned(deps, principal, sessionId);
  authorize(principal, "answerPermission", { createdBy: session.createdBy });

  const perm = await deps.repo.getPermission(sessionId, requestId);
  if (perm?.status !== "pending") {
    throw new InvalidStateError("permission request is not pending");
  }
  // Only agent-supplied optionIds are valid; never a synthesized option.
  const offered = perm.options.some(
    (o) =>
      typeof o === "object" &&
      o !== null &&
      (o as { optionId?: string }).optionId === args.optionId,
  );
  if (!offered) {
    throw new InvalidStateError(`optionId not offered: ${args.optionId}`);
  }

  await deps.queue.enqueue({
    kind: "answerPermission",
    sub: principal.sub,
    sessionId,
    commandId: genId(deps),
    requestId,
    optionId: args.optionId,
    ...(args.consent ? { consent: args.consent } : {}),
  });
}

export async function setConfig(
  deps: ServiceDeps,
  principal: Principal,
  sessionId: string,
  args: { model?: string; effort?: string; mode?: string },
): Promise<void> {
  const session = await loadOwned(deps, principal, sessionId);
  authorize(principal, "config", { createdBy: session.createdBy });
  await deps.queue.enqueue({
    kind: "setConfig",
    sub: principal.sub,
    sessionId,
    commandId: genId(deps),
    ...(args.model ? { model: args.model } : {}),
    ...(args.effort ? { effort: args.effort } : {}),
    ...(args.mode ? { mode: args.mode } : {}),
  });
}

export async function deleteSession(
  deps: ServiceDeps,
  principal: Principal,
  sessionId: string,
): Promise<void> {
  const session = await loadOwned(deps, principal, sessionId);
  authorize(principal, "delete", { createdBy: session.createdBy });
  await deps.queue.enqueue({
    kind: "delete",
    sub: principal.sub,
    sessionId,
    commandId: genId(deps),
  });
}

export async function getSession(
  deps: ServiceDeps,
  principal: Principal,
  sessionId: string,
): Promise<SessionView> {
  authorize(principal, "read");
  const session = await loadOwned(deps, principal, sessionId);
  return toSessionView(session);
}

export async function listSessions(
  deps: ServiceDeps,
  principal: Principal,
  args: { limit: number; cursor?: string; status?: string },
): Promise<{ sessions: SessionView[]; cursor?: string }> {
  authorize(principal, "read");
  const { items, cursor } = await deps.repo.listSessionsByUser(principal.sub, {
    limit: args.limit,
    cursor: args.cursor,
  });
  let views = items.map(toSessionView);
  if (args.status) {
    views = views.filter((s) => s.status === args.status);
  }
  return { sessions: views, ...(cursor ? { cursor } : {}) };
}
