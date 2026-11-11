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
import { EVENTS_MAX_WAIT_SECONDS, EVENTS_POLL_INTERVAL_MS, MAX_CLOUD_SESSIONS } from "../config.ts";
import { trailerInstruction } from "../github/pr-ref.ts";
import { sessionPk } from "../repo/keys.ts";
import { ConcurrentModificationError, type Repository } from "../repo/repository.ts";
import type { SessionMetaItem } from "../repo/types.ts";
import type { EventView, SessionView, TurnView } from "../schemas/index.ts";
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
  /** Injectable sleep used by the events long-poll, so tests need not wait. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Ask the agent to put a `Kiro-Remote-Session: <id>` trailer in any PR body
   * it writes (the launch prompt gains one line). Absent means off; the
   * construct only sets it when the GitHub feature is deployed.
   */
  prTrailer?: "on" | "off";
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
export async function loadOwned(
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
    prompt: deps.prTrailer === "on" ? `${args.prompt}\n\n${trailerInstruction(id)}` : args.prompt,
    repos: args.repos,
    ...(args.title ? { title: args.title } : {}),
    ...(args.mode ? { mode: args.mode } : {}),
    ...(args.model ? { model: args.model } : {}),
    ...(args.effort ? { effort: args.effort } : {}),
  });

  return toSessionView(meta);
}

export async function adoptSession(
  deps: ServiceDeps,
  principal: Principal,
  args: { kiroSessionId: string },
): Promise<SessionView> {
  authorize(principal, "launch");

  // 429: adopting still consumes a cloud-session slot, so the cap applies.
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
    kiroSessionId: args.kiroSessionId,
    title: null,
    repos: [],
    agent: null,
    mode: null,
    model: null,
    effort: null,
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
    kind: "adopt",
    sub: principal.sub,
    sessionId: id,
    commandId: genId(deps),
    kiroSessionId: args.kiroSessionId,
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

  // A manual prompt wins over a GitHub wake: bumping META's version makes a
  // drainInbox that read the session before this point lose its optimistic
  // lock (it then retries after this turn settles). Losing this CAS to another
  // writer is fine, since that writer bumped the version too.
  try {
    await deps.repo.updateSession(sessionId, session.version, {});
  } catch (err) {
    if (!(err instanceof ConcurrentModificationError)) {
      throw err;
    }
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
  const links = await deps.repo.queryLinks(sessionId);
  return {
    ...toSessionView(session),
    links: links.map((l) => ({
      pr: l.pr,
      repo: l.repo,
      number: l.number,
      linkedBy: l.linkedBy,
      linkedAt: l.linkedAt,
      prState: l.prState,
      headSha: l.headSha,
    })),
  };
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

/* -------------------------------------------------------------------------- */
/* Events long-poll                                                           */
/* -------------------------------------------------------------------------- */

/** Map a session status to the turnStatus reported alongside an events page. */
export function deriveTurnStatus(sessionStatus: string): string | null {
  switch (sessionStatus) {
    case "running":
    case "awaiting_permission":
    case "idle":
    case "provisioning":
      return sessionStatus;
    default:
      return null;
  }
}

/** One page of the event log plus the long-poll cursor state. */
export interface EventsPage {
  events: EventView[];
  nextCursor: number;
  turnStatus: string | null;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read a session's events with seq > `after`, long-polling up to `wait`
 * seconds (clamped to {@link EVENTS_MAX_WAIT_SECONDS}) for the first one.
 *
 * Returns as soon as at least one event is available. Otherwise it re-reads
 * every {@link EVENTS_POLL_INTERVAL_MS} until the deadline and then returns an
 * empty page with `nextCursor` unchanged. `wait` = 0 is a single read.
 *
 * The session row is re-read on every iteration, so `turnStatus` is current
 * and a session deleted mid-wait surfaces as {@link SessionNotFoundError}.
 * The poll keeps waiting whatever the session status is (an idle session can
 * still receive events from a prompt the bridge has not picked up yet).
 */
export async function readEvents(
  deps: ServiceDeps,
  principal: Principal,
  sessionId: string,
  args: { after: number; wait: number; types?: string[] },
): Promise<EventsPage> {
  authorize(principal, "read");
  const now = (): number => deps.now?.() ?? Date.now();
  const sleep = deps.sleep ?? defaultSleep;
  const waitMs = Math.min(Math.max(args.wait, 0), EVENTS_MAX_WAIT_SECONDS) * 1000;
  const deadline = now() + waitMs;
  // Bound the iterations too, so a clock that does not advance cannot spin forever.
  const maxSleeps = Math.ceil(waitMs / EVENTS_POLL_INTERVAL_MS);
  const types = args.types && args.types.length > 0 ? { types: args.types } : {};

  for (let sleeps = 0; ; sleeps++) {
    const session = await loadOwned(deps, principal, sessionId);
    const items = await deps.repo.queryEvents(sessionId, args.after, types);
    const remaining = deadline - now();
    if (items.length > 0 || remaining <= 0 || sleeps >= maxSleeps) {
      const events: EventView[] = items.map((e) => ({
        seq: e.seq,
        sessionId,
        turnId: e.turnId,
        type: e.type,
        rawType: e.rawType,
        replay: e.replay,
        ts: e.ts,
        payload: e.payload,
      }));
      const nextCursor = events.length > 0 ? events[events.length - 1].seq : args.after;
      return { events, nextCursor, turnStatus: deriveTurnStatus(session.status) };
    }
    await sleep(Math.min(EVENTS_POLL_INTERVAL_MS, remaining));
  }
}
