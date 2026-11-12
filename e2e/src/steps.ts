/**
 * The live harness steps: MCP first (discovery, the MCP Inspector, the tool
 * flow over the SDK client), then the same flow over REST.
 *
 * Every step makes real requests through injected dependencies and throws on
 * the first assertion that does not hold. Captured values are non-secret
 * scalars only (ids, statuses, counts, durations); session objects, which
 * carry the repo, are never captured.
 *
 * Not covered because the Lambda bridge path does not support them: cancel
 * (rejected on a running cloud turn), set_config (a logged no-op), permissions
 * (cloud turns never ask), adopt (rejected), and steer/queue mid-turn
 * (rejected). See docs/testing.md.
 */
import type { KiroRemoteClient } from "@nikovirtala/kiro-remote-api";
import type { Principal } from "@nikovirtala/kiro-remote-core";
import { HttpClientError, TOOL_NAMES, type TokenProvider } from "@nikovirtala/kiro-remote-mcp";
import type { ObtainedToken } from "./auth.ts";
import type { McpSession } from "./mcp-client.ts";
import type { Report } from "./report.ts";
import type { Step } from "./runner.ts";
import { type EventLike, type EventPage, waitForTurn } from "./settle.ts";

/** Everything the steps reach the outside world through (faked in unit tests). */
export interface HarnessDeps {
  fetch: typeof fetch;
  /** Run the MCP Inspector `tools/list` (with its own browser sign-in); return the tool names. */
  inspector(baseUrl: string): Promise<string[]>;
  obtainToken(baseUrl: string): Promise<ObtainedToken>;
  connectMcp(baseUrl: string, tokens: TokenProvider): Promise<McpSession>;
  rest(baseUrl: string, tokens: TokenProvider): KiroRemoteClient;
  /** Milliseconds. */
  now(): number;
  sleep(ms: number): Promise<void>;
  /** 8 uppercase hex characters, unique per run; goes into the prompt markers and titles. */
  runId: string;
  /** Write a progress line to stderr (the caller scrubs it). */
  progress(line: string): void;
  turnTimeoutMs: number;
  deleteTimeoutMs: number;
  deletePollMs: number;
  /**
   * Run the GitHub CLI (`gh api ...`, REST only) as the TRUSTED login and return
   * stdout. Only the opt-in GitHub scenario uses it.
   */
  gh?(args: string[]): Promise<string>;
}

export interface SessionCursor {
  id: string;
  cursor: number;
}

/** Mutable state the steps hand to each other. */
export interface HarnessState {
  tokens?: TokenProvider;
  mcp?: McpSession;
  rest?: KiroRemoteClient;
  mcpSession?: SessionCursor;
  restSession?: SessionCursor;
  /** The GitHub scenario's session, and the PR its agent opened. */
  ghSession?: SessionCursor;
  ghPr?: { repo: string; number: number; headRef: string | null; linkedBy: string };
  /** The chain scenario's session (two dependent PRs) and the PRs it opened, in order. */
  ghChain?: {
    session: SessionCursor;
    launchedAt: number;
    prs: Array<{ repo: string; number: number; headRef: string }>;
  };
  /** The failing-check scenario's session and the PR whose checks fail. */
  ghChecks?: {
    session: SessionCursor;
    pr?: { repo: string; number: number; headRef: string };
  };
  /** GitHub delivery ids of the wake turns the GitHub steps have seen so far. */
  ghWakeDeliveries?: string[];
  /** Session ids created and not yet confirmed deleted. */
  created: Set<string>;
}

export interface HarnessContext {
  baseUrl: string | null;
  repo(): string | null;
  deps: HarnessDeps;
  state: HarnessState;
  signal?: AbortSignal;
}

export const TURN_TIMEOUT_MS = 20 * 60_000;
export const DELETE_TIMEOUT_MS = 5 * 60_000;
export const DELETE_POLL_MS = 5_000;
/** The REST long-poll wait, in seconds (the API maximum). */
const REST_WAIT_SECONDS = 20;
/** HttpClient ignores the principal argument; the bearer identifies the caller. */
const REST_PRINCIPAL: Principal = { sub: "e2e", clientId: "e2e", scopes: [] };

/* -------------------------------------------------------------------------- */
/* Prompts                                                                    */
/* -------------------------------------------------------------------------- */

export type MarkerKind = "MCP_LAUNCH" | "MCP_FOLLOWUP" | "REST_LAUNCH" | "REST_FOLLOWUP";

export function markerFor(runId: string, kind: MarkerKind): string {
  return `KIRO_E2E_${runId}_${kind}`;
}

export function promptFor(marker: string): string {
  return `This is an automated kiro-remote end-to-end check. Do not change any files, do not open a pull request, and do not run any commands. Reply with exactly this line and nothing else: ${marker}`;
}

export function titleFor(runId: string, via: "mcp" | "rest"): string {
  return `kiro-remote e2e ${runId} (${via})`;
}

/* -------------------------------------------------------------------------- */
/* Field readers: throw on a missing or mistyped field                        */
/* -------------------------------------------------------------------------- */

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(o: Obj, key: string, what: string): string {
  const v = o[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${what}: ${key} is not a non-empty string`);
  }
  return v;
}

function num(o: Obj, key: string, what: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`${what}: ${key} is not a number`);
  }
  return v;
}

function obj(o: Obj, key: string, what: string): Obj {
  const v = o[key];
  if (!isObj(v)) {
    throw new Error(`${what}: ${key} is not an object`);
  }
  return v;
}

function list(o: Obj, key: string, what: string): unknown[] {
  const v = o[key];
  if (!Array.isArray(v)) {
    throw new Error(`${what}: ${key} is not an array`);
  }
  return v;
}

function statusOrNull(o: Obj, key: string, what: string): string | null {
  const v = o[key];
  if (v !== null && typeof v !== "string") {
    throw new Error(`${what}: ${key} is neither a string nor null`);
  }
  return v;
}

function events(raw: unknown[], what: string): EventLike[] {
  return raw.map((e) => {
    if (!isObj(e) || typeof e.seq !== "number" || typeof e.type !== "string") {
      throw new Error(`${what}: an event has no numeric seq or string type`);
    }
    const turnId = typeof e.turnId === "string" ? e.turnId : null;
    return { seq: e.seq, type: e.type, turnId, payload: e.payload };
  });
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

function baseOf(ctx: HarnessContext): string {
  if (!ctx.baseUrl) {
    throw new Error("KIRO_REMOTE_URL is unset");
  }
  return ctx.baseUrl;
}

function repoOf(ctx: HarnessContext): string {
  const repo = ctx.repo();
  if (!repo) {
    throw new Error("KIRO_API_E2E_REPO is unset");
  }
  return repo;
}

function tokensOf(ctx: HarnessContext): TokenProvider {
  if (!ctx.state.tokens) {
    throw new Error("no login token");
  }
  return ctx.state.tokens;
}

function mcpOf(ctx: HarnessContext): McpSession {
  if (!ctx.state.mcp) {
    throw new Error("no MCP connection");
  }
  return ctx.state.mcp;
}

function restOf(ctx: HarnessContext): KiroRemoteClient {
  ctx.state.rest ??= ctx.deps.rest(baseOf(ctx), tokensOf(ctx));
  return ctx.state.rest;
}

function sessionOf(s: SessionCursor | undefined): SessionCursor {
  if (!s) {
    throw new Error("no session from the launch step");
  }
  return s;
}

/** Assert the names are exactly the 16 registered tools. */
export function assertToolSet(names: string[], what: string): void {
  const expected = new Set<string>(TOOL_NAMES);
  const got = new Set(names);
  const missing = [...expected].filter((n) => !got.has(n));
  const extra = [...got].filter((n) => !expected.has(n));
  if (missing.length > 0 || extra.length > 0 || names.length !== expected.size) {
    throw new Error(
      `${what}: expected the ${expected.size} registered tools, got ${names.length}` +
        (missing.length > 0 ? `; missing ${missing.join(", ")}` : "") +
        (extra.length > 0 ? `; unexpected ${extra.join(", ")}` : ""),
    );
  }
}

/** Call a tool and return its structured result; a tool error throws. */
async function callOk(mcp: McpSession, name: string, args: Obj): Promise<Obj> {
  const res = await mcp.callTool(name, args);
  if (res.isError) {
    throw new Error(`${name} returned an error: ${res.text}`);
  }
  if (!res.structured) {
    throw new Error(`${name} returned no structured content`);
  }
  return res.structured;
}

function checkCapabilities(caps: Obj, what: string): number {
  obj(caps, "capabilities", what);
  return num(caps, "activeSessionCount", what);
}

function abortableSleep(ctx: HarnessContext, ms: number): Promise<void> {
  if (ctx.signal?.aborted) {
    return Promise.reject(new Error("aborted"));
  }
  return ctx.deps.sleep(ms);
}

/**
 * Poll `isGone` every deletePollMs until it returns true or the delete timeout
 * passes. `isGone` returns a string describing the current state otherwise.
 */
async function waitUntilGone(
  ctx: HarnessContext,
  id: string,
  isGone: () => Promise<true | string>,
  opts: { honorAbort: boolean },
): Promise<number> {
  const start = ctx.deps.now();
  let last = "";
  for (;;) {
    const res = await isGone();
    if (res === true) {
      return ctx.deps.now() - start;
    }
    last = res;
    if (ctx.deps.now() - start >= ctx.deps.deleteTimeoutMs) {
      throw new Error(
        `session ${id} still readable ${Math.round(ctx.deps.deleteTimeoutMs / 1000)} s after delete (last: ${last})`,
      );
    }
    if (opts.honorAbort) {
      await abortableSleep(ctx, ctx.deps.deletePollMs);
    } else {
      await ctx.deps.sleep(ctx.deps.deletePollMs);
    }
  }
}

async function restGone(client: KiroRemoteClient, id: string): Promise<true | string> {
  try {
    const s = await client.getSession(REST_PRINCIPAL, id);
    return `status ${s.status}`;
  } catch (err) {
    if (err instanceof HttpClientError && err.status === 404) {
      return true;
    }
    return err instanceof Error ? err.message : String(err);
  }
}

function mcpPage(r: Obj): EventPage {
  const what = "kiro_wait_for_events";
  return {
    events: events(list(r, "events", what), what),
    nextCursor: num(r, "nextCursor", what),
    turnStatus: statusOrNull(r, "turnStatus", what),
    truncated: r.eventsTruncated === true,
  };
}

async function mcpTranscriptTurns(mcp: McpSession, sessionId: string): Promise<Obj[]> {
  const t = await callOk(mcp, "kiro_get_transcript", { sessionId });
  return list(t, "turns", "kiro_get_transcript").filter(isObj);
}

function turnCaptured(r: Awaited<ReturnType<typeof waitForTurn>>): Obj {
  return {
    eventCount: r.eventCount,
    polls: r.polls,
    firstEventMs: r.firstEventMs,
    turnMs: r.durationMs,
  };
}

/* -------------------------------------------------------------------------- */
/* Steps                                                                      */
/* -------------------------------------------------------------------------- */

const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "kiro-remote-e2e", version: "0.0.0" },
  },
});

async function getJson(ctx: HarnessContext, url: string, what: string): Promise<Obj> {
  const res = await ctx.deps.fetch(url, { headers: { accept: "application/json" } });
  if (res.status !== 200) {
    throw new Error(`${what} returned HTTP ${res.status}`);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!isObj(body)) {
    throw new Error(`${what} is not a JSON object`);
  }
  return body;
}

const discovery: Step<HarnessContext> = {
  id: "discovery",
  name: "MCP discovery: 401 challenge, protected-resource and authorization-server metadata",
  requires: ["baseUrl"],
  needs: [],
  async run(ctx) {
    const base = baseOf(ctx);
    const res = await ctx.deps.fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: INITIALIZE_BODY,
    });
    if (res.status !== 401) {
      throw new Error(`unauthenticated POST /mcp returned HTTP ${res.status}, expected 401`);
    }
    const challenge = res.headers.get("www-authenticate") ?? "";
    const match = /resource_metadata="([^"]+)"/.exec(challenge);
    if (!match) {
      throw new Error("the 401 has no WWW-Authenticate resource_metadata parameter");
    }
    const prm = await getJson(ctx, match[1], "protected-resource metadata");
    if (prm.resource !== `${base}/mcp`) {
      throw new Error("protected-resource metadata: resource is not <KIRO_REMOTE_URL>/mcp");
    }
    const servers = list(prm, "authorization_servers", "protected-resource metadata");
    if (servers[0] !== base) {
      throw new Error(
        "protected-resource metadata: authorization_servers[0] is not <KIRO_REMOTE_URL>",
      );
    }
    const as = await getJson(
      ctx,
      `${base}/.well-known/oauth-authorization-server`,
      "authorization-server metadata",
    );
    if (as.issuer !== base) {
      throw new Error("authorization-server metadata: issuer is not <KIRO_REMOTE_URL>");
    }
    const methods = list(as, "code_challenge_methods_supported", "authorization-server metadata");
    if (!methods.includes("S256")) {
      throw new Error("authorization-server metadata: S256 PKCE is not supported");
    }
    for (const key of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
      str(as, key, "authorization-server metadata");
    }
    return {
      challengeStatus: res.status,
      scopesSupported: Array.isArray(prm.scopes_supported) ? prm.scopes_supported.length : 0,
    };
  },
};

const mcpInspector: Step<HarnessContext> = {
  id: "mcp-inspector",
  name: "MCP Inspector CLI: OAuth sign-in (browser) and tools/list",
  requires: ["baseUrl"],
  needs: ["discovery"],
  async run(ctx) {
    const names = await ctx.deps.inspector(baseOf(ctx));
    assertToolSet(names, "Inspector tools/list");
    return { toolCount: names.length };
  },
};

const login: Step<HarnessContext> = {
  id: "login",
  name: "kiro-remote login token (keychain, or browser sign-in)",
  requires: ["baseUrl"],
  needs: [],
  async run(ctx) {
    const got = await ctx.deps.obtainToken(baseOf(ctx));
    ctx.state.tokens = got.tokens;
    return { source: got.source, scopeCount: got.scopes.length };
  },
};

const mcpTools: Step<HarnessContext> = {
  id: "mcp-tools",
  name: "MCP SDK client: tools/list, kiro_capabilities, kiro_list_models",
  requires: ["baseUrl"],
  needs: ["login"],
  async run(ctx) {
    ctx.state.mcp = await ctx.deps.connectMcp(baseOf(ctx), tokensOf(ctx));
    const mcp = ctx.state.mcp;
    const names = await mcp.listToolNames();
    assertToolSet(names, "tools/list");
    const caps = await callOk(mcp, "kiro_capabilities", {});
    const activeSessionCount = checkCapabilities(caps, "kiro_capabilities");
    const models = await callOk(mcp, "kiro_list_models", {});
    const modelCount = list(models, "models", "kiro_list_models").length;
    return { toolCount: names.length, activeSessionCount, modelCount };
  },
};

const mcpLaunch: Step<HarnessContext> = {
  id: "mcp-launch",
  name: "MCP kiro_launch_session, kiro_get_session, kiro_list_sessions",
  requires: ["baseUrl", "repo"],
  needs: ["mcp-tools"],
  async run(ctx) {
    const mcp = mcpOf(ctx);
    const marker = markerFor(ctx.deps.runId, "MCP_LAUNCH");
    const launched = await callOk(mcp, "kiro_launch_session", {
      prompt: promptFor(marker),
      repos: [repoOf(ctx)],
      title: titleFor(ctx.deps.runId, "mcp"),
    });
    const sessionId = str(launched, "sessionId", "kiro_launch_session");
    ctx.state.created.add(sessionId);
    ctx.state.mcpSession = { id: sessionId, cursor: 0 };
    const got = await callOk(mcp, "kiro_get_session", { sessionId });
    const session = obj(got, "session", "kiro_get_session");
    if (session.id !== sessionId) {
      throw new Error("kiro_get_session returned a different session id");
    }
    const listed = await callOk(mcp, "kiro_list_sessions", { limit: 20 });
    const ids = list(listed, "sessions", "kiro_list_sessions").map((s) => (isObj(s) ? s.id : null));
    if (!ids.includes(sessionId)) {
      throw new Error("kiro_list_sessions (limit 20) does not contain the new session");
    }
    return {
      sessionId,
      turnId: typeof launched.turnId === "string" ? launched.turnId : null,
      sessionStatus: typeof session.status === "string" ? session.status : null,
    };
  },
};

const mcpLaunchTurn: Step<HarnessContext> = {
  id: "mcp-launch-turn",
  name: "MCP kiro_wait_for_events until the launch turn settles, then kiro_get_transcript",
  requires: ["baseUrl", "repo"],
  needs: ["mcp-launch"],
  async run(ctx) {
    const mcp = mcpOf(ctx);
    const s = sessionOf(ctx.state.mcpSession);
    const res = await waitForTurn({
      after: s.cursor,
      read: async (after) =>
        mcpPage(await callOk(mcp, "kiro_wait_for_events", { sessionId: s.id, after })),
      now: ctx.deps.now,
      sleep: ctx.deps.sleep,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      timeoutMs: ctx.deps.turnTimeoutMs,
    });
    s.cursor = res.cursor;
    const marker = markerFor(ctx.deps.runId, "MCP_LAUNCH");
    const turns = await mcpTranscriptTurns(mcp, s.id);
    if (!turns.some((t) => typeof t.text === "string" && t.text.includes(marker))) {
      throw new Error("kiro_get_transcript has no turn containing the launch marker");
    }
    return { ...turnCaptured(res), transcriptTurns: turns.length };
  },
};

const mcpFollowup: Step<HarnessContext> = {
  id: "mcp-followup",
  name: "MCP kiro_send_prompt (whenBusy reject), wait until it settles, kiro_get_transcript",
  requires: ["baseUrl", "repo"],
  needs: ["mcp-launch-turn"],
  async run(ctx) {
    const mcp = mcpOf(ctx);
    const s = sessionOf(ctx.state.mcpSession);
    const marker = markerFor(ctx.deps.runId, "MCP_FOLLOWUP");
    const sent = await callOk(mcp, "kiro_send_prompt", {
      sessionId: s.id,
      prompt: promptFor(marker),
      whenBusy: "reject",
    });
    const turnId = str(obj(sent, "turn", "kiro_send_prompt"), "id", "kiro_send_prompt turn");
    const res = await waitForTurn({
      after: s.cursor,
      turnId,
      read: async (after) =>
        mcpPage(await callOk(mcp, "kiro_wait_for_events", { sessionId: s.id, after })),
      now: ctx.deps.now,
      sleep: ctx.deps.sleep,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      timeoutMs: ctx.deps.turnTimeoutMs,
    });
    s.cursor = res.cursor;
    const turns = await mcpTranscriptTurns(mcp, s.id);
    const turn = turns.find((t) => t.turnId === turnId);
    if (!turn || typeof turn.text !== "string" || !turn.text.includes(marker)) {
      throw new Error("kiro_get_transcript: the follow-up turn does not contain its marker");
    }
    return { turnId, ...turnCaptured(res) };
  },
};

const mcpDelete: Step<HarnessContext> = {
  id: "mcp-delete",
  name: "MCP kiro_delete_session, then kiro_get_session until not found",
  requires: ["baseUrl", "repo"],
  needs: ["mcp-launch"],
  async run(ctx) {
    const mcp = mcpOf(ctx);
    const s = sessionOf(ctx.state.mcpSession);
    const del = await callOk(mcp, "kiro_delete_session", { sessionId: s.id });
    if (del.status !== "deleting") {
      throw new Error("kiro_delete_session: status is not deleting");
    }
    const goneMs = await waitUntilGone(
      ctx,
      s.id,
      async () => {
        const res = await mcp.callTool("kiro_get_session", { sessionId: s.id });
        if (res.isError && /not found/i.test(res.text)) {
          return true;
        }
        if (res.isError) {
          return res.text;
        }
        const session = res.structured?.session;
        return `status ${isObj(session) ? String(session.status) : "unknown"}`;
      },
      { honorAbort: true },
    );
    ctx.state.created.delete(s.id);
    return { sessionId: s.id, goneMs };
  },
};

const restRead: Step<HarnessContext> = {
  id: "rest-read",
  name: "REST GET /v1/capabilities and /v1/models",
  requires: ["baseUrl"],
  needs: ["login"],
  async run(ctx) {
    const client = restOf(ctx);
    const caps = (await client.capabilities(REST_PRINCIPAL)) as unknown;
    if (!isObj(caps)) {
      throw new Error("GET /v1/capabilities is not an object");
    }
    const activeSessionCount = checkCapabilities(caps, "GET /v1/capabilities");
    const models = (await client.listModels(REST_PRINCIPAL)) as unknown;
    if (!isObj(models)) {
      throw new Error("GET /v1/models is not an object");
    }
    const modelCount = list(models, "models", "GET /v1/models").length;
    return { activeSessionCount, modelCount };
  },
};

const restLaunch: Step<HarnessContext> = {
  id: "rest-launch",
  name: "REST POST /v1/sessions, GET /v1/sessions/{id}",
  requires: ["baseUrl", "repo"],
  needs: ["login"],
  async run(ctx) {
    const client = restOf(ctx);
    const marker = markerFor(ctx.deps.runId, "REST_LAUNCH");
    const launched = (await client.launchSession(REST_PRINCIPAL, {
      prompt: promptFor(marker),
      repos: [repoOf(ctx)],
      title: titleFor(ctx.deps.runId, "rest"),
    })) as unknown;
    if (!isObj(launched)) {
      throw new Error("POST /v1/sessions is not an object");
    }
    const sessionId = str(launched, "sessionId", "POST /v1/sessions");
    ctx.state.created.add(sessionId);
    ctx.state.restSession = { id: sessionId, cursor: 0 };
    const session = await client.getSession(REST_PRINCIPAL, sessionId);
    if (session.id !== sessionId) {
      throw new Error("GET /v1/sessions/{id} returned a different session id");
    }
    return {
      sessionId,
      turnId: typeof launched.turnId === "string" ? launched.turnId : null,
      sessionStatus: typeof session.status === "string" ? session.status : null,
    };
  },
};

function restEventReader(ctx: HarnessContext, sessionId: string) {
  const client = restOf(ctx);
  return async (after: number): Promise<EventPage> => {
    const page = (await client.getEvents(REST_PRINCIPAL, sessionId, {
      after,
      wait: REST_WAIT_SECONDS,
    })) as unknown;
    const what = "GET /v1/sessions/{id}/events";
    if (!isObj(page)) {
      throw new Error(`${what} is not an object`);
    }
    return {
      events: events(list(page, "events", what), what),
      nextCursor: num(page, "nextCursor", what),
      turnStatus: statusOrNull(page, "turnStatus", what),
      truncated: false,
    };
  };
}

const restLaunchTurn: Step<HarnessContext> = {
  id: "rest-launch-turn",
  name: "REST GET /v1/sessions/{id}/events until the launch turn settles",
  requires: ["baseUrl", "repo"],
  needs: ["rest-launch"],
  async run(ctx) {
    const s = sessionOf(ctx.state.restSession);
    const res = await waitForTurn({
      after: s.cursor,
      read: restEventReader(ctx, s.id),
      now: ctx.deps.now,
      sleep: ctx.deps.sleep,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      timeoutMs: ctx.deps.turnTimeoutMs,
    });
    s.cursor = res.cursor;
    if (!res.text.includes(markerFor(ctx.deps.runId, "REST_LAUNCH"))) {
      throw new Error("the launch turn's message text does not contain the launch marker");
    }
    return turnCaptured(res);
  },
};

const restFollowup: Step<HarnessContext> = {
  id: "rest-followup",
  name: "REST POST /v1/sessions/{id}/turns (whenBusy reject), events until it settles",
  requires: ["baseUrl", "repo"],
  needs: ["rest-launch-turn"],
  async run(ctx) {
    const s = sessionOf(ctx.state.restSession);
    const marker = markerFor(ctx.deps.runId, "REST_FOLLOWUP");
    const turn = (await restOf(ctx).createTurn(REST_PRINCIPAL, s.id, {
      prompt: promptFor(marker),
      whenBusy: "reject",
    })) as unknown;
    if (!isObj(turn)) {
      throw new Error("POST /v1/sessions/{id}/turns is not an object");
    }
    const turnId = str(turn, "id", "POST /v1/sessions/{id}/turns");
    const res = await waitForTurn({
      after: s.cursor,
      turnId,
      read: restEventReader(ctx, s.id),
      now: ctx.deps.now,
      sleep: ctx.deps.sleep,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      timeoutMs: ctx.deps.turnTimeoutMs,
    });
    s.cursor = res.cursor;
    if (!res.text.includes(marker)) {
      throw new Error("the follow-up turn's message text does not contain its marker");
    }
    return { turnId, ...turnCaptured(res) };
  },
};

const restDelete: Step<HarnessContext> = {
  id: "rest-delete",
  name: "REST DELETE /v1/sessions/{id}, then GET until 404",
  requires: ["baseUrl", "repo"],
  needs: ["rest-launch"],
  async run(ctx) {
    const client = restOf(ctx);
    const s = sessionOf(ctx.state.restSession);
    await client.deleteSession(REST_PRINCIPAL, s.id);
    const goneMs = await waitUntilGone(ctx, s.id, () => restGone(client, s.id), {
      honorAbort: true,
    });
    ctx.state.created.delete(s.id);
    return { sessionId: s.id, goneMs };
  },
};

/* -------------------------------------------------------------------------- */
/* Opt-in GitHub wake scenario (KIRO_API_E2E_GITHUB=1)                         */
/* -------------------------------------------------------------------------- */

/** Wake turns in an events page: `turn_started` session.info events with a github trigger. */
export function githubWakes(
  events: readonly EventLike[],
): Array<{ seq: number; turnId: string; deliveryIds: string[]; ts: string | null }> {
  const out: Array<{ seq: number; turnId: string; deliveryIds: string[]; ts: string | null }> = [];
  for (const e of events) {
    const p = e.payload as {
      payload?: { trigger?: { source?: unknown; deliveryIds?: unknown } };
    } | null;
    const trigger = p?.payload?.trigger;
    if (e.type !== "session.info" || !e.turnId || trigger?.source !== "github") {
      continue;
    }
    const ts = (e as { ts?: unknown }).ts;
    out.push({
      seq: e.seq,
      turnId: e.turnId,
      deliveryIds: Array.isArray(trigger.deliveryIds)
        ? trigger.deliveryIds.filter((d): d is string => typeof d === "string")
        : [],
      ts: typeof ts === "string" ? ts : null,
    });
  }
  return out;
}

/**
 * The stack runs with GITHUB_AUTO_CLOSE_ON_MERGE=after_turn. The harness cannot
 * read the stack's setting, so KIRO_API_E2E_GITHUB_AUTOCLOSE=1 says so.
 */
function autoCloseExpected(): boolean {
  return process.env.KIRO_API_E2E_GITHUB_AUTOCLOSE === "1";
}

const GH_LINK_TIMEOUT_MS = 3 * 60_000;
const GH_WAKE_TIMEOUT_MS = 5 * 60_000;
/**
 * How long a session must then stay without another GitHub wake. Webhook to
 * wake turn took ~5 s live, so this is ample, and it is what makes each wake
 * step attributable: only the harness's own action can wake the session.
 */
export const GH_QUIET_MS = 45_000;

function ghOf(ctx: HarnessContext): (args: string[]) => Promise<string> {
  if (!ctx.deps.gh) {
    throw new Error("no gh runner configured");
  }
  return ctx.deps.gh;
}

function ghSessionOf(ctx: HarnessContext): SessionCursor {
  return sessionOf(ctx.state.ghSession);
}

/** Poll until `pick` returns a value, or time out. */
async function pollUntil<T>(
  ctx: HarnessContext,
  what: string,
  timeoutMs: number,
  pick: () => Promise<T | null>,
): Promise<T> {
  const start = ctx.deps.now();
  for (;;) {
    const got = await pick();
    if (got !== null) {
      return got;
    }
    if (ctx.deps.now() - start > timeoutMs) {
      throw new Error(`${what} did not happen within ${Math.round(timeoutMs / 1000)} s`);
    }
    await abortableSleep(ctx, 5_000);
  }
}

/**
 * Fail if a GitHub wake turn starts on the session within `quietMs`. Called
 * after a wake turn settles: nothing the harness did since can explain another
 * wake, so one means the session woke itself (the agent's own PR comment did
 * this once) or something else is waking it, and the next step could
 * otherwise mistake that wake for its own.
 */
export async function expectNoWake(
  ctx: HarnessContext,
  s: SessionCursor,
  quietMs: number,
  after: string,
): Promise<void> {
  const client = restOf(ctx);
  const start = ctx.deps.now();
  for (;;) {
    let page: Awaited<ReturnType<KiroRemoteClient["getEvents"]>>;
    try {
      page = await client.getEvents(REST_PRINCIPAL, s.id, {
        after: s.cursor,
        wait: 0,
        types: ["session.info"],
      });
    } catch (err) {
      if (err instanceof HttpClientError && err.status === 404) {
        throw new Error(
          `the session was deleted after ${after}; if the stack runs with GITHUB_AUTO_CLOSE_ON_MERGE=after_turn, set KIRO_API_E2E_GITHUB_AUTOCLOSE=1`,
        );
      }
      throw err;
    }
    const extra = githubWakes(page.events as unknown as EventLike[])[0];
    if (extra) {
      throw new Error(
        `unexpected GitHub wake turn ${extra.turnId} (deliveries: ${extra.deliveryIds.join(", ") || "none"}) ` +
          `within ${Math.round(quietMs / 1000)} s after ${after}; the harness did nothing that should wake the session`,
      );
    }
    if (ctx.deps.now() - start >= quietMs) {
      return;
    }
    await abortableSleep(ctx, 5_000);
  }
}

async function waitForWake(
  ctx: HarnessContext,
  s: SessionCursor,
  startedAt: number,
  opts: { timeoutMs?: number; closeExpected?: boolean } = {},
) {
  const client = restOf(ctx);
  const wake = await pollUntil(
    ctx,
    "the GitHub wake turn",
    opts.timeoutMs ?? GH_WAKE_TIMEOUT_MS,
    async () => {
      const page = await client.getEvents(REST_PRINCIPAL, s.id, {
        after: s.cursor,
        wait: 0,
        types: ["session.info"],
      });
      const found = githubWakes(page.events as unknown as EventLike[])[0];
      return found ?? null;
    },
  );
  // A wake that re-uses a delivery an earlier wake step already saw is not
  // caused by this step's action.
  const seen = new Set(ctx.state.ghWakeDeliveries ?? []);
  const reused = wake.deliveryIds.filter((d) => seen.has(d));
  if (wake.deliveryIds.length === 0 || reused.length > 0) {
    throw new Error(
      `wake turn ${wake.turnId} has no new GitHub delivery (deliveries: ${wake.deliveryIds.join(", ") || "none"})`,
    );
  }
  ctx.state.ghWakeDeliveries = [...seen, ...wake.deliveryIds];
  const latencyMs = (wake.ts ? Date.parse(wake.ts) : ctx.deps.now()) - startedAt;
  try {
    const settled = await waitForTurn({
      after: s.cursor,
      turnId: wake.turnId,
      read: restEventReader(ctx, s.id),
      now: ctx.deps.now,
      sleep: ctx.deps.sleep,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      timeoutMs: ctx.deps.turnTimeoutMs,
    });
    s.cursor = settled.cursor;
    return { wake, settled: turnCaptured(settled), latencyMs };
  } catch (err) {
    // autoCloseOnMerge deletes the session within a second of the post-merge
    // turn ending (seen live), which can beat the harness's next event read.
    // The stack only auto-closes after that turn COMPLETED, so a 404 here,
    // with a close expected, means the turn ended and the session was closed;
    // the caller still confirms the session is gone.
    if (opts.closeExpected && err instanceof HttpClientError && err.status === 404) {
      return { wake, settled: { turnEndSeen: false }, latencyMs };
    }
    throw err;
  }
}

const ghLaunch: Step<HarnessContext> = {
  id: "gh-launch",
  name: "GitHub: launch a session whose agent opens a docs-only PR",
  requires: ["baseUrl", "repo", "github"],
  needs: ["login"],
  async run(ctx) {
    const client = restOf(ctx);
    const prompt = [
      "Make a docs-only change: add one new file docs/kiro-remote-e2e-" +
        ctx.deps.runId.toLowerCase() +
        ".md with one line,",
      "on a new branch, and open a pull request for it. Reply with the pull request URL and nothing else.",
    ].join(" ");
    const launched = (await client.launchSession(REST_PRINCIPAL, {
      prompt,
      repos: [repoOf(ctx)],
      title: titleFor(ctx.deps.runId, "rest"),
    })) as unknown;
    if (!isObj(launched)) {
      throw new Error("POST /v1/sessions is not an object");
    }
    const id = str(launched, "sessionId", "POST /v1/sessions");
    ctx.state.created.add(id);
    ctx.state.ghSession = { id, cursor: 0 };
    const s = ghSessionOf(ctx);
    const res = await waitForTurn({
      after: 0,
      read: restEventReader(ctx, id),
      now: ctx.deps.now,
      sleep: ctx.deps.sleep,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      timeoutMs: ctx.deps.turnTimeoutMs,
    });
    s.cursor = res.cursor;
    return { sessionId: id, ...turnCaptured(res) };
  },
};

const ghLink: Step<HarnessContext> = {
  id: "gh-link",
  name: "GitHub: the PR is linked to the session (GET /v1/sessions/{id} links[])",
  requires: ["baseUrl", "repo", "github"],
  needs: ["gh-launch"],
  async run(ctx) {
    const s = ghSessionOf(ctx);
    const client = restOf(ctx);
    const link = await pollUntil(ctx, "the PR link", GH_LINK_TIMEOUT_MS, async () => {
      const session = await client.getSession(REST_PRINCIPAL, s.id);
      return session.links && session.links.length > 0 ? session.links[0] : null;
    });
    const [owner, name, num] = link.pr.replace("#", "/").split("/");
    const number = Number(num);
    const pull = JSON.parse(await ghOf(ctx)(["api", `repos/${owner}/${name}/pulls/${number}`])) as {
      head?: { ref?: string };
    };
    ctx.state.ghPr = {
      repo: link.repo,
      number,
      headRef: pull.head?.ref ?? null,
      linkedBy: link.linkedBy,
    };
    // "linkedBy" says which method worked in this run: harvest, trailer or manual.
    return { linkedBy: link.linkedBy, prState: link.prState };
  },
};

/**
 * The stack treats the harness's GitHub login as UNTRUSTED (its
 * GITHUB_TRUSTED_LOGINS names someone else). The harness cannot read the
 * stack's setting, so KIRO_API_E2E_GITHUB_UNTRUSTED=1 says so; the wake prompt
 * checks then expect the fact only, never the text.
 */
export function untrustedExpected(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KIRO_API_E2E_GITHUB_UNTRUSTED === "1";
}

/** The marker kiro-remote puts around quoted trusted text (packages/github/src/render.ts). */
export const GH_QUOTE_BEGIN = "<<<BEGIN GITHUB QUOTE>>>";

/** GET /v1/sessions/{id}/turns/{turnId}: the prompt the turn ran with. */
async function turnPrompt(ctx: HarnessContext, sessionId: string, turnId: string): Promise<string> {
  const url = `${baseOf(ctx)}/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}`;
  const res = await ctx.deps.fetch(url, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${await tokensOf(ctx).accessToken()}`,
    },
  });
  if (res.status !== 200) {
    throw new Error(`GET /v1/sessions/{id}/turns/{turnId} answered ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  if (!isObj(body) || typeof body.prompt !== "string") {
    throw new Error("GET /v1/sessions/{id}/turns/{turnId} has no prompt");
  }
  return body.prompt;
}

/** The GitHub login the harness's `gh` acts as. */
async function ghLogin(ctx: HarnessContext): Promise<string> {
  const user = JSON.parse(await ghOf(ctx)(["api", "user"])) as { login?: unknown };
  if (typeof user.login !== "string" || user.login === "") {
    throw new Error("gh api user returned no login");
  }
  return user.login;
}

/**
 * Check what a wake prompt forwarded from a person's text. Trusted (the
 * default): the text is quoted between the markers. Untrusted: only `fact`,
 * with no quote block and none of the text.
 */
export function checkWakePrompt(
  prompt: string,
  args: { header: string; fact: string; text: string; untrusted: boolean },
): { quoted: boolean } {
  const first = prompt.split("\n")[0] ?? "";
  if (!first.startsWith("[GitHub webhook]") || !first.includes(args.header)) {
    throw new Error(`the wake prompt's header is not for ${args.header}: ${first.slice(0, 200)}`);
  }
  if (!prompt.includes(args.fact)) {
    throw new Error(`the wake prompt does not state "${args.fact}"`);
  }
  const quoted = prompt.includes(GH_QUOTE_BEGIN);
  const hasText = prompt.includes(args.text);
  if (args.untrusted) {
    if (quoted || hasText) {
      throw new Error(
        `an untrusted login's text reached the wake prompt (quote block: ${quoted}, text: ${hasText})`,
      );
    }
  } else if (!quoted || !hasText) {
    throw new Error(
      `a trusted login's text was not quoted in the wake prompt (quote block: ${quoted}, text: ${hasText})`,
    );
  }
  return { quoted };
}

const ghReviewWake: Step<HarnessContext> = {
  id: "gh-review-wake",
  name: "GitHub: a review comment wakes the session (text quoted only when trusted)",
  requires: ["baseUrl", "repo", "github"],
  needs: ["gh-link"],
  async run(ctx) {
    const s = ghSessionOf(ctx);
    const pr = ctx.state.ghPr;
    if (!pr) {
      throw new Error("no PR from gh-link");
    }
    const login = await ghLogin(ctx);
    const text = `E2E ${ctx.deps.runId} review canary: please reply with the word ACK.`;
    const startedAt = ctx.deps.now();
    await ghOf(ctx)([
      "api",
      "--method",
      "POST",
      `repos/${pr.repo}/pulls/${pr.number}/reviews`,
      "-f",
      "event=COMMENT",
      "-f",
      `body=${text}`,
    ]);
    const { wake, settled, latencyMs } = await waitForWake(ctx, s, startedAt);
    const untrusted = untrustedExpected();
    const { quoted } = checkWakePrompt(await turnPrompt(ctx, s.id, wake.turnId), {
      header: "pull_request_review.submitted (commented)",
      fact: `@${login} submitted a review on PR #${pr.number}: commented.`,
      text,
      untrusted,
    });
    // The prompt asks for a reply, which the agent may post as a PR comment
    // (it did in a live run). That comment must not wake the session again.
    await expectNoWake(ctx, s, GH_QUIET_MS, "the review wake turn settled");
    return {
      wakeTurnId: wake.turnId,
      deliveries: wake.deliveryIds.length,
      reviewToWakeTurnStartMs: latencyMs,
      reviewer: untrusted ? "untrusted" : "trusted",
      quoted,
      quietAfterMs: GH_QUIET_MS,
      ...settled,
    };
  },
};

const ghCommentWake: Step<HarnessContext> = {
  id: "gh-comment-wake",
  name: "GitHub: a PR comment wakes the session (text quoted only when trusted)",
  requires: ["baseUrl", "repo", "github"],
  needs: ["gh-review-wake"],
  async run(ctx) {
    const s = ghSessionOf(ctx);
    const pr = ctx.state.ghPr;
    if (!pr) {
      throw new Error("no PR from gh-link");
    }
    const login = await ghLogin(ctx);
    const text = `E2E ${ctx.deps.runId} comment canary: reply in one sentence, do not change any file.`;
    const startedAt = ctx.deps.now();
    await ghOf(ctx)([
      "api",
      "--method",
      "POST",
      `repos/${pr.repo}/issues/${pr.number}/comments`,
      "-f",
      `body=${text}`,
    ]);
    const { wake, settled, latencyMs } = await waitForWake(ctx, s, startedAt);
    const untrusted = untrustedExpected();
    const { quoted } = checkWakePrompt(await turnPrompt(ctx, s.id, wake.turnId), {
      header: "issue_comment.created",
      fact: `@${login} commented on PR #${pr.number}.`,
      text,
      untrusted,
    });
    await expectNoWake(ctx, s, GH_QUIET_MS, "the comment wake turn settled");
    return {
      wakeTurnId: wake.turnId,
      commentToWakeTurnStartMs: latencyMs,
      commenter: untrusted ? "untrusted" : "trusted",
      quoted,
      quietAfterMs: GH_QUIET_MS,
      ...settled,
    };
  },
};

const ghMergeWake: Step<HarnessContext> = {
  id: "gh-merge-wake",
  name: "GitHub: merging the PR wakes the session (and closes it with autoCloseOnMerge)",
  requires: ["baseUrl", "repo", "github"],
  needs: ["gh-comment-wake"],
  async run(ctx) {
    const s = ghSessionOf(ctx);
    const pr = ctx.state.ghPr;
    if (!pr) {
      throw new Error("no PR from gh-link");
    }
    const startedAt = ctx.deps.now();
    await ghOf(ctx)([
      "api",
      "--method",
      "PUT",
      `repos/${pr.repo}/pulls/${pr.number}/merge`,
      "-f",
      "merge_method=squash",
    ]);
    const { wake, settled, latencyMs } = await waitForWake(ctx, s, startedAt, {
      closeExpected: autoCloseExpected(),
    });
    const out: Obj = {
      wakeTurnId: wake.turnId,
      mergeToWakeTurnStartMs: latencyMs,
      ...settled,
    };
    // With GITHUB_AUTO_CLOSE_ON_MERGE=after_turn the session is deleted once this turn completes.
    if (autoCloseExpected()) {
      await waitUntilGone(ctx, s.id, () => restGone(restOf(ctx), s.id), { honorAbort: true });
      ctx.state.created.delete(s.id);
      out.autoClosed = true;
    } else {
      await expectNoWake(ctx, s, GH_QUIET_MS, "the merge wake turn settled");
      out.quietAfterMs = GH_QUIET_MS;
    }
    return out;
  },
};

const ghCleanup: Step<HarnessContext> = {
  id: "gh-cleanup",
  name: "GitHub: delete the PR's head branch",
  requires: ["baseUrl", "repo", "github"],
  needs: [],
  async run(ctx) {
    const pr = ctx.state.ghPr;
    if (!pr?.headRef) {
      return { branchDeleted: false };
    }
    try {
      await ghOf(ctx)([
        "api",
        "--method",
        "PATCH",
        `repos/${pr.repo}/pulls/${pr.number}`,
        "-f",
        "state=closed",
      ]);
    } catch {
      // Already merged or closed.
    }
    await ghOf(ctx)(["api", "--method", "DELETE", `repos/${pr.repo}/git/refs/heads/${pr.headRef}`]);
    return { branchDeleted: true };
  },
};

/* -------------------------------------------------------------------------- */
/* GitHub chain: two dependent PRs in one session                              */
/* -------------------------------------------------------------------------- */

/** The slice of a GitHub pull request the chain steps read. */
interface GhPull {
  number: number;
  state: string;
  created_at: string;
  merged_at: string | null;
  head: { ref: string; sha: string };
  base: { ref: string };
}

async function ghPull(ctx: HarnessContext, repo: string, number: number): Promise<GhPull> {
  return JSON.parse(await ghOf(ctx)(["api", `repos/${repo}/pulls/${number}`])) as GhPull;
}

/** PRs in `repo` created at or after `sinceMs` (newest first, last 30 only). */
async function ghPullsSince(ctx: HarnessContext, repo: string, sinceMs: number) {
  const all = JSON.parse(
    await ghOf(ctx)([
      "api",
      `repos/${repo}/pulls?state=all&sort=created&direction=desc&per_page=30`,
    ]),
  ) as GhPull[];
  return all.filter((p) => Date.parse(p.created_at) >= sinceMs);
}

/** `owner/repo#n` -> parts. */
function prRef(pr: string): { repo: string; number: number } {
  const hash = pr.lastIndexOf("#");
  return { repo: pr.slice(0, hash), number: Number(pr.slice(hash + 1)) };
}

/** Squash-merge a PR as the trusted login; returns the merge commit sha. */
async function ghMerge(ctx: HarnessContext, repo: string, number: number): Promise<string> {
  const res = JSON.parse(
    await ghOf(ctx)([
      "api",
      "--method",
      "PUT",
      `repos/${repo}/pulls/${number}/merge`,
      "-f",
      "merge_method=squash",
    ]),
  ) as { sha?: string; merged?: boolean };
  if (res.merged !== true || !res.sha) {
    throw new Error(`merging ${repo}#${number} did not report a merge commit`);
  }
  return res.sha;
}

function ghChainOf(ctx: HarnessContext): NonNullable<HarnessState["ghChain"]> {
  if (!ctx.state.ghChain) {
    throw new Error("no chain session from gh-chain-launch");
  }
  return ctx.state.ghChain;
}

/** Allowance for clock skew between this machine and GitHub when comparing creation times. */
const GH_CLOCK_SKEW_MS = 5_000;

const ghChainLaunch: Step<HarnessContext> = {
  id: "gh-chain-launch",
  name: "GitHub chain: launch a session that must deliver two PRs in order",
  requires: ["baseUrl", "repo", "github"],
  needs: ["login"],
  async run(ctx) {
    const client = restOf(ctx);
    const file = `docs/kiro-remote-e2e-${ctx.deps.runId.toLowerCase()}-chain.md`;
    const prompt = [
      "This task needs two pull requests, delivered in order.",
      `Part 1, now: on a new branch, add the file ${file} containing the single line "part 1",`,
      "and open a pull request for it. Then reply with that pull request URL and nothing else.",
      "Do not start part 2 in this turn.",
      "Part 2, only after you are told that the first pull request was merged: update your local copy",
      "of the default branch from the remote, create a new branch from it, append the line",
      `"part 2" to ${file}, and open a second pull request. Part 2 depends on part 1 being merged,`,
      "so it must be based on the updated default branch. Reply with the second pull request URL",
      "and nothing else.",
    ].join(" ");
    const launchedAt = ctx.deps.now();
    const launched = (await client.launchSession(REST_PRINCIPAL, {
      prompt,
      repos: [repoOf(ctx)],
      title: titleFor(ctx.deps.runId, "rest"),
    })) as unknown;
    if (!isObj(launched)) {
      throw new Error("POST /v1/sessions is not an object");
    }
    const id = str(launched, "sessionId", "POST /v1/sessions");
    ctx.state.created.add(id);
    ctx.state.ghChain = { session: { id, cursor: 0 }, launchedAt, prs: [] };
    const s = ghChainOf(ctx).session;
    const res = await waitForTurn({
      after: 0,
      read: restEventReader(ctx, id),
      now: ctx.deps.now,
      sleep: ctx.deps.sleep,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      timeoutMs: ctx.deps.turnTimeoutMs,
    });
    s.cursor = res.cursor;
    return { sessionId: id, ...turnCaptured(res) };
  },
};

const ghChainFirstPr: Step<HarnessContext> = {
  id: "gh-chain-first-pr",
  name: "GitHub chain: exactly one PR exists after the first turn, and it is linked",
  requires: ["baseUrl", "repo", "github"],
  needs: ["gh-chain-launch"],
  async run(ctx) {
    const chain = ghChainOf(ctx);
    const client = restOf(ctx);
    const link = await pollUntil(ctx, "the first PR link", GH_LINK_TIMEOUT_MS, async () => {
      const session = await client.getSession(REST_PRINCIPAL, chain.session.id);
      return session.links && session.links.length > 0 ? session.links : null;
    });
    if (link.length !== 1) {
      throw new Error(`expected 1 linked PR after the first turn, found ${link.length}`);
    }
    const { repo, number } = prRef(link[0].pr);
    // The agent must not have opened the second PR ahead of the merge.
    const opened = await ghPullsSince(ctx, repo, chain.launchedAt - GH_CLOCK_SKEW_MS);
    if (opened.length !== 1 || opened[0].number !== number) {
      throw new Error(
        `expected only the linked PR #${number} to exist after the first turn, found: ${opened.map((p) => `#${p.number}`).join(", ") || "none"}`,
      );
    }
    chain.prs.push({ repo, number, headRef: opened[0].head.ref });
    return { firstPr: number, linkedBy: link[0].linkedBy };
  },
};

const ghChainMergeFirst: Step<HarnessContext> = {
  id: "gh-chain-merge-first",
  name: "GitHub chain: merging the first PR wakes the session, which opens the second PR on top of it",
  requires: ["baseUrl", "repo", "github"],
  needs: ["gh-chain-first-pr"],
  async run(ctx) {
    const chain = ghChainOf(ctx);
    const s = chain.session;
    const first = chain.prs[0];
    const startedAt = ctx.deps.now();
    const firstMergeSha = await ghMerge(ctx, first.repo, first.number);
    const firstMergedAt = Date.parse((await ghPull(ctx, first.repo, first.number)).merged_at ?? "");
    const { wake, settled, latencyMs } = await waitForWake(ctx, s, startedAt);

    // The second PR is linked once the wake turn that opened it settles.
    const client = restOf(ctx);
    const links = await pollUntil(ctx, "the second PR link", GH_LINK_TIMEOUT_MS, async () => {
      const session = await client.getSession(REST_PRINCIPAL, s.id);
      return session.links && session.links.length >= 2 ? session.links : null;
    });
    const second = links.find((l) => prRef(l.pr).number !== first.number);
    if (links.length !== 2 || !second) {
      throw new Error(`expected 2 linked PRs after the merge wake, found ${links.length}`);
    }
    const { repo, number } = prRef(second.pr);
    const pull = await ghPull(ctx, repo, number);
    // The order the task demands: the second PR was opened after the first was merged...
    if (!(Date.parse(pull.created_at) >= firstMergedAt - GH_CLOCK_SKEW_MS)) {
      throw new Error(
        `PR #${number} was created at ${pull.created_at}, before PR #${first.number} was merged`,
      );
    }
    // ...and its head contains the first PR's merge commit.
    const cmp = JSON.parse(
      await ghOf(ctx)(["api", `repos/${repo}/compare/${firstMergeSha}...${pull.head.sha}`]),
    ) as { status?: string; behind_by?: number };
    if (cmp.behind_by !== 0) {
      throw new Error(
        `PR #${number} is not based on PR #${first.number}'s merge commit (compare: ${cmp.status}, behind by ${cmp.behind_by})`,
      );
    }
    chain.prs.push({ repo, number, headRef: pull.head.ref });
    // With autoCloseOnMerge on, this post-merge turn must NOT close the session:
    // PR 2 is open. The quiet check below reads its events, so it also fails if
    // the session is gone; this makes the reason explicit.
    await expectNoWake(ctx, s, GH_QUIET_MS, "the first merge wake turn settled");
    if (autoCloseExpected()) {
      const gone = await restGone(client, s.id);
      if (gone === true) {
        throw new Error(
          `auto-close deleted the session after PR #${first.number} merged although PR #${number} is still open`,
        );
      }
    }
    return {
      firstPr: first.number,
      secondPr: number,
      secondLinkedBy: second.linkedBy,
      ...(autoCloseExpected() ? { keptWithOpenPr: true } : {}),
      wakeTurnId: wake.turnId,
      mergeToWakeTurnStartMs: latencyMs,
      quietAfterMs: GH_QUIET_MS,
      ...settled,
    };
  },
};

const ghChainMergeSecond: Step<HarnessContext> = {
  id: "gh-chain-merge-second",
  name: "GitHub chain: merging the second PR wakes the session",
  requires: ["baseUrl", "repo", "github"],
  needs: ["gh-chain-merge-first"],
  async run(ctx) {
    const chain = ghChainOf(ctx);
    const s = chain.session;
    const second = chain.prs[1];
    const startedAt = ctx.deps.now();
    await ghMerge(ctx, second.repo, second.number);
    const { wake, settled, latencyMs } = await waitForWake(ctx, s, startedAt, {
      closeExpected: autoCloseExpected(),
    });
    const out: Obj = {
      secondPr: second.number,
      wakeTurnId: wake.turnId,
      mergeToWakeTurnStartMs: latencyMs,
      ...settled,
    };
    if (autoCloseExpected()) {
      // Every linked PR is merged now, so this post-merge turn closes the session.
      await waitUntilGone(ctx, s.id, () => restGone(restOf(ctx), s.id), { honorAbort: true });
      ctx.state.created.delete(s.id);
      out.autoClosed = true;
    } else {
      await expectNoWake(ctx, s, GH_QUIET_MS, "the second merge wake turn settled");
      out.quietAfterMs = GH_QUIET_MS;
    }
    return out;
  },
};

const ghChainCleanup: Step<HarnessContext> = {
  id: "gh-chain-cleanup",
  name: "GitHub chain: close any open PR and delete the head branches",
  requires: ["baseUrl", "repo", "github"],
  needs: [],
  async run(ctx) {
    const prs = ctx.state.ghChain?.prs ?? [];
    for (const pr of prs) {
      try {
        await ghOf(ctx)([
          "api",
          "--method",
          "PATCH",
          `repos/${pr.repo}/pulls/${pr.number}`,
          "-f",
          "state=closed",
        ]);
      } catch {
        // Already merged or closed.
      }
      await ghOf(ctx)([
        "api",
        "--method",
        "DELETE",
        `repos/${pr.repo}/git/refs/heads/${pr.headRef}`,
      ]);
    }
    return { branchesDeleted: prs.length };
  },
};

/* -------------------------------------------------------------------------- */
/* GitHub checks: a failing check wakes, then closing the PR unmerged wakes     */
/* -------------------------------------------------------------------------- */

/**
 * The marker the repo's `e2e check` workflow fails on. Split so this file does
 * not match its own grep when the harness repo is the e2e repo.
 */
const FAIL_CHECK_MARKER = `KIRO_E2E${"_FAIL_CHECK"}`;
/** Failing-check wakes are debounced (GITHUB_CHECKS_DEBOUNCE_MS = 2 min), plus slack. */
const GH_CHECKS_WAKE_TIMEOUT_MS = 6 * 60_000;

function ghChecksOf(ctx: HarnessContext): NonNullable<HarnessState["ghChecks"]> {
  if (!ctx.state.ghChecks) {
    throw new Error("no checks session from gh-checks-launch");
  }
  return ctx.state.ghChecks;
}

const ghChecksLaunch: Step<HarnessContext> = {
  id: "gh-checks-launch",
  name: "GitHub checks: launch a session whose PR fails the repo's check",
  requires: ["baseUrl", "repo", "github"],
  needs: ["login"],
  async run(ctx) {
    const client = restOf(ctx);
    const file = `docs/kiro-remote-e2e-${ctx.deps.runId.toLowerCase()}-checks.md`;
    const prompt = [
      `On a new branch, add the file ${file} whose only line is the single word`,
      `${FAIL_CHECK_MARKER}, and open a pull request for it. Reply with the pull request URL and`,
      "nothing else. The repository's CI fails that pull request on purpose. If you are later told",
      "that a check failed, or that the pull request was closed, do NOT change any file, do not push",
      "and do not open another pull request: just reply with what you were told and nothing else.",
    ].join(" ");
    const launched = (await client.launchSession(REST_PRINCIPAL, {
      prompt,
      repos: [repoOf(ctx)],
      title: titleFor(ctx.deps.runId, "rest"),
    })) as unknown;
    if (!isObj(launched)) {
      throw new Error("POST /v1/sessions is not an object");
    }
    const id = str(launched, "sessionId", "POST /v1/sessions");
    ctx.state.created.add(id);
    ctx.state.ghChecks = { session: { id, cursor: 0 } };
    const res = await waitForTurn({
      after: 0,
      read: restEventReader(ctx, id),
      now: ctx.deps.now,
      sleep: ctx.deps.sleep,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      timeoutMs: ctx.deps.turnTimeoutMs,
    });
    ghChecksOf(ctx).session.cursor = res.cursor;
    return { sessionId: id, ...turnCaptured(res) };
  },
};

const ghChecksWake: Step<HarnessContext> = {
  id: "gh-checks-wake",
  name: "GitHub checks: the failing check wakes the session (debounced)",
  requires: ["baseUrl", "repo", "github"],
  needs: ["gh-checks-launch"],
  async run(ctx) {
    const checks = ghChecksOf(ctx);
    const s = checks.session;
    const client = restOf(ctx);
    const link = await pollUntil(ctx, "the PR link", GH_LINK_TIMEOUT_MS, async () => {
      const session = await client.getSession(REST_PRINCIPAL, s.id);
      return session.links && session.links.length > 0 ? session.links[0] : null;
    });
    const { repo, number } = prRef(link.pr);
    const pull = await ghPull(ctx, repo, number);
    checks.pr = { repo, number, headRef: pull.head.ref };

    // The repo's workflow must actually fail on this PR's head commit, else a
    // wake would prove nothing.
    const failedAt = await pollUntil(
      ctx,
      "the check to fail",
      GH_CHECKS_WAKE_TIMEOUT_MS,
      async () => {
        const suites = JSON.parse(
          await ghOf(ctx)(["api", `repos/${repo}/commits/${pull.head.sha}/check-suites`]),
        ) as {
          check_suites?: Array<{
            status: string;
            conclusion: string | null;
            app?: { slug?: string };
          }>;
        };
        // Only the GitHub Actions suite runs the "e2e check" workflow. Other apps
        // installed on the account get suites on the commit too; they may stay
        // queued forever or succeed, and say nothing about the marker.
        const actions = (suites.check_suites ?? []).filter((c) => c.app?.slug === "github-actions");
        const done = actions.filter((c) => c.status === "completed");
        if (done.length === 0 || done.length < actions.length) {
          return null;
        }
        const failed = done.filter(
          (c) => c.conclusion === "failure" || c.conclusion === "timed_out",
        );
        if (failed.length === 0) {
          throw new Error(
            `the PR's GitHub Actions checks completed without failing (${done.map((c) => c.conclusion).join(", ")}); the repo's "e2e check" workflow must fail a PR carrying the marker`,
          );
        }
        return ctx.deps.now();
      },
    );

    const { wake, settled, latencyMs } = await waitForWake(ctx, s, failedAt, {
      timeoutMs: GH_CHECKS_WAKE_TIMEOUT_MS,
    });
    await expectNoWake(ctx, s, GH_QUIET_MS, "the failing-check wake turn settled");
    return {
      pr: number,
      wakeTurnId: wake.turnId,
      deliveries: wake.deliveryIds.length,
      checkFailureToWakeTurnStartMs: latencyMs,
      quietAfterMs: GH_QUIET_MS,
      ...settled,
    };
  },
};

const ghCloseWake: Step<HarnessContext> = {
  id: "gh-close-wake",
  name: "GitHub checks: closing the PR without merging wakes the session",
  requires: ["baseUrl", "repo", "github"],
  needs: ["gh-checks-wake"],
  async run(ctx) {
    const checks = ghChecksOf(ctx);
    const pr = checks.pr;
    if (!pr) {
      throw new Error("no PR from gh-checks-wake");
    }
    const startedAt = ctx.deps.now();
    await ghOf(ctx)([
      "api",
      "--method",
      "PATCH",
      `repos/${pr.repo}/pulls/${pr.number}`,
      "-f",
      "state=closed",
    ]);
    const after = await ghPull(ctx, pr.repo, pr.number);
    if (after.merged_at !== null) {
      throw new Error(`PR #${pr.number} is merged; this step needs a closed-unmerged PR`);
    }
    const { wake, settled, latencyMs } = await waitForWake(ctx, checks.session, startedAt);
    await expectNoWake(ctx, checks.session, GH_QUIET_MS, "the closed-unmerged wake turn settled");
    return {
      pr: pr.number,
      wakeTurnId: wake.turnId,
      closeToWakeTurnStartMs: latencyMs,
      quietAfterMs: GH_QUIET_MS,
      ...settled,
    };
  },
};

const ghChecksCleanup: Step<HarnessContext> = {
  id: "gh-checks-cleanup",
  name: "GitHub checks: delete the PR's head branch",
  requires: ["baseUrl", "repo", "github"],
  needs: [],
  async run(ctx) {
    const pr = ctx.state.ghChecks?.pr;
    if (!pr) {
      return { branchDeleted: false };
    }
    await ghOf(ctx)(["api", "--method", "DELETE", `repos/${pr.repo}/git/refs/heads/${pr.headRef}`]);
    return { branchDeleted: true };
  },
};

/** The opt-in GitHub wake scenario; appended to {@link STEPS} when KIRO_API_E2E_GITHUB=1. */
export const GITHUB_STEPS: readonly Step<HarnessContext>[] = [
  ghLaunch,
  ghLink,
  ghReviewWake,
  ghCommentWake,
  ghMergeWake,
  ghCleanup,
  ghChainLaunch,
  ghChainFirstPr,
  ghChainMergeFirst,
  ghChainMergeSecond,
  ghChainCleanup,
  ghChecksLaunch,
  ghChecksWake,
  ghCloseWake,
  ghChecksCleanup,
];

/** The steps, in run order. */
export const STEPS: readonly Step<HarnessContext>[] = [
  discovery,
  mcpInspector,
  login,
  mcpTools,
  mcpLaunch,
  mcpLaunchTurn,
  mcpFollowup,
  mcpDelete,
  restRead,
  restLaunch,
  restLaunchTurn,
  restFollowup,
  restDelete,
];

export const CLEANUP_ID = "cleanup";
const CLEANUP_NAME = "Delete leftover sessions over REST";

/**
 * Delete every session the run created and did not confirm deleted. Recorded
 * only when there is something to clean up. It ignores the abort signal so an
 * interrupted run still removes what it made.
 */
export async function cleanupSessions(ctx: HarnessContext, report: Report): Promise<void> {
  const ids = [...ctx.state.created];
  if (ids.length === 0) {
    return;
  }
  const start = ctx.deps.now();
  ctx.deps.progress(report.scrub(`▶ ${CLEANUP_ID}: ${ids.length} leftover session(s)`));
  let client: KiroRemoteClient;
  try {
    client = restOf(ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    report.fail(
      CLEANUP_ID,
      CLEANUP_NAME,
      `cannot delete leftover sessions ${ids.join(", ")}: ${message}`,
      ctx.deps.now() - start,
    );
    return;
  }
  const left: string[] = [];
  for (const id of ids) {
    try {
      await client.deleteSession(REST_PRINCIPAL, id);
    } catch {
      // A 404 means it is already gone; any other error is settled by the poll below.
    }
    try {
      await waitUntilGone(ctx, id, () => restGone(client, id), { honorAbort: false });
      ctx.state.created.delete(id);
    } catch {
      left.push(id);
    }
  }
  const ms = ctx.deps.now() - start;
  if (left.length > 0) {
    report.fail(CLEANUP_ID, CLEANUP_NAME, `sessions not confirmed deleted: ${left.join(", ")}`, ms);
    ctx.deps.progress(report.scrub(`✘ ${CLEANUP_ID}: not deleted: ${left.join(", ")}`));
    return;
  }
  report.pass(CLEANUP_ID, CLEANUP_NAME, { deleted: ids.length }, ms);
  ctx.deps.progress(report.scrub(`✔ ${CLEANUP_ID}: deleted ${ids.length}`));
}
