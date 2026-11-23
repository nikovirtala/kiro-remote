/**
 * The HTTP {@link KiroRemoteClient} variant used by the stdio `kiro-remote mcp`
 * CLI. It calls the REST API (packages/api, base path /v1) with the user's
 * bearer token. The token is supplied by an injected {@link TokenProvider} that
 * refreshes silently when needed; this module never reads the keychain or the
 * network for tokens itself, so it stays offline-testable against a fake fetch.
 *
 * The bearer token is attached only as the Authorization header and is NEVER
 * logged (all logging in the package routes through core's redact).
 */

import type {
  ClientCapabilities,
  ClientEventsPage,
  ClientLink,
  ClientPermission,
  ClientSession,
  ClientTurn,
  ClientWait,
  KiroRemoteClient,
  WriteOptions,
} from "@nikovirtala/kiro-remote-api";
import { type FeedPage, type Principal, parsePrRef } from "@nikovirtala/kiro-remote-core";

/** A minimal fetch signature so tests inject a fake without a real network. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

/** Supplies a fresh access token, refreshing silently when needed. */
export interface TokenProvider {
  /** Return a currently-valid access token (refreshing if required). */
  accessToken(): Promise<string>;
}

export interface HttpClientDeps {
  /** REST API base origin WITHOUT a trailing slash, e.g. https://host (no /v1). */
  baseUrl: string;
  tokens: TokenProvider;
  fetch: FetchLike;
  /** Generate an Idempotency-Key for writes (POST). Defaults to crypto UUID. */
  newIdempotencyKey?: () => string;
}

/** `: <detail>` from an RFC 9457 problem body, so a tool error says why (else empty). */
function problemDetail(body: string): string {
  try {
    const detail = (JSON.parse(body) as { detail?: unknown }).detail;
    return typeof detail === "string" && detail !== "" ? `: ${detail}` : "";
  } catch {
    return "";
  }
}

/** Raised when the REST API returns a non-2xx response. */
export class HttpClientError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`REST API error ${status}${problemDetail(body)}`);
    this.name = "HttpClientError";
    this.status = status;
    this.body = body;
  }
}

/** The caller's idempotency key as a request option (none when unset). */
function key(write: WriteOptions | undefined): { idempotencyKey?: string } {
  return write?.idempotencyKey !== undefined ? { idempotencyKey: write.idempotencyKey } : {};
}

function randomId(): string {
  return globalThis.crypto.randomUUID();
}

/** Calls the REST API over HTTP with the user's bearer token. */
export class HttpClient implements KiroRemoteClient {
  private readonly base: string;
  private readonly tokens: TokenProvider;
  private readonly fetchFn: FetchLike;
  private readonly newKey: () => string;

  constructor(deps: HttpClientDeps) {
    this.base = `${deps.baseUrl.replace(/\/+$/, "")}/v1`;
    this.tokens = deps.tokens;
    this.fetchFn = deps.fetch;
    this.newKey = deps.newIdempotencyKey ?? randomId;
  }

  private async request(
    method: string,
    path: string,
    opts: { body?: unknown; idempotent?: boolean; idempotencyKey?: string } = {},
  ): Promise<unknown> {
    const token = await this.tokens.accessToken();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    };
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    // A caller-supplied key is sent as is, so a retry is deduplicated by the
    // server. Otherwise writes that always carried a key keep a fresh one.
    if (opts.idempotencyKey !== undefined) {
      headers["idempotency-key"] = opts.idempotencyKey;
    } else if (opts.idempotent) {
      headers["idempotency-key"] = this.newKey();
    }
    const res = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      throw new HttpClientError(res.status, text);
    }
    return text.length > 0 ? JSON.parse(text) : {};
  }

  private query(params: Record<string, string | number | string[] | undefined>): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) {
        continue;
      }
      const v = Array.isArray(value) ? value.join(",") : String(value);
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
    }
    return parts.length > 0 ? `?${parts.join("&")}` : "";
  }

  async capabilities(_principal: Principal): Promise<ClientCapabilities> {
    return (await this.request("GET", "/capabilities")) as ClientCapabilities;
  }

  async listModels(_principal: Principal): Promise<{ models: string[]; source: string | null }> {
    return (await this.request("GET", "/models")) as { models: string[]; source: string | null };
  }

  async launchSession(
    _principal: Principal,
    args: {
      prompt: string;
      repos: string[];
      title?: string;
      mode?: string;
      model?: string;
      effort?: string;
    },
    write?: WriteOptions,
  ): Promise<{ sessionId: string; turnId: string | null }> {
    return (await this.request("POST", "/sessions", {
      body: args,
      idempotent: true,
      ...key(write),
    })) as {
      sessionId: string;
      turnId: string | null;
    };
  }

  async adoptSession(
    _principal: Principal,
    args: { kiroSessionId: string },
    write?: WriteOptions,
  ): Promise<{ sessionId: string }> {
    const res = (await this.request("POST", "/sessions/adopt", {
      body: args,
      idempotent: true,
      ...key(write),
    })) as { id?: string; sessionId?: string };
    return { sessionId: res.sessionId ?? res.id ?? "" };
  }

  async listSessions(
    _principal: Principal,
    args: { limit: number; cursor?: string; status?: string },
  ): Promise<{ sessions: ClientSession[]; cursor?: string }> {
    const q = this.query({
      limit: args.limit,
      ...(args.cursor ? { cursor: args.cursor } : {}),
      ...(args.status ? { status: args.status } : {}),
    });
    return (await this.request("GET", `/sessions${q}`)) as {
      sessions: ClientSession[];
      cursor?: string;
    };
  }

  async getSession(_principal: Principal, sessionId: string): Promise<ClientSession> {
    return (await this.request(
      "GET",
      `/sessions/${encodeURIComponent(sessionId)}`,
    )) as ClientSession;
  }

  async deleteSession(
    _principal: Principal,
    sessionId: string,
    write?: WriteOptions,
  ): Promise<void> {
    await this.request("DELETE", `/sessions/${encodeURIComponent(sessionId)}`, {
      idempotent: true,
      ...key(write),
    });
  }

  async createTurn(
    _principal: Principal,
    sessionId: string,
    args: { prompt: string; whenBusy: "steer" | "queue" | "reject" },
    write?: WriteOptions,
  ): Promise<ClientTurn> {
    return (await this.request("POST", `/sessions/${encodeURIComponent(sessionId)}/turns`, {
      body: args,
      idempotent: true,
      ...key(write),
    })) as ClientTurn;
  }

  async getEvents(
    _principal: Principal,
    sessionId: string,
    args: { after: number; wait: number; types?: string[] },
  ): Promise<ClientEventsPage> {
    const q = this.query({
      after: args.after,
      wait: args.wait,
      ...(args.types && args.types.length > 0 ? { types: args.types } : {}),
    });
    return (await this.request(
      "GET",
      `/sessions/${encodeURIComponent(sessionId)}/events${q}`,
    )) as ClientEventsPage;
  }

  async listPermissions(
    _principal: Principal,
    sessionId: string,
    args: { status?: string },
  ): Promise<{ permissions: ClientPermission[] }> {
    const q = this.query({ ...(args.status ? { status: args.status } : {}) });
    return (await this.request(
      "GET",
      `/sessions/${encodeURIComponent(sessionId)}/permissions${q}`,
    )) as { permissions: ClientPermission[] };
  }

  async cancelTurn(_principal: Principal, sessionId: string, write?: WriteOptions): Promise<void> {
    await this.request("POST", `/sessions/${encodeURIComponent(sessionId)}/cancel`, {
      body: {},
      idempotent: true,
      ...key(write),
    });
  }

  async answerPermission(
    _principal: Principal,
    sessionId: string,
    requestId: string,
    args: { optionId: string; consent?: Record<string, unknown> },
    write?: WriteOptions,
  ): Promise<void> {
    await this.request(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}`,
      { body: args, idempotent: true, ...key(write) },
    );
  }

  async setConfig(
    _principal: Principal,
    sessionId: string,
    args: { model?: string; effort?: string; mode?: string },
    write?: WriteOptions,
  ): Promise<void> {
    // No fresh key: PATCH config never carried one, only a caller's key does.
    await this.request("PATCH", `/sessions/${encodeURIComponent(sessionId)}/config`, {
      body: args,
      ...key(write),
    });
  }

  async linkPullRequest(
    _principal: Principal,
    sessionId: string,
    args: { pr: string },
    write?: WriteOptions,
  ): Promise<ClientLink> {
    return (await this.request("POST", `/sessions/${encodeURIComponent(sessionId)}/links`, {
      body: args,
      idempotent: true,
      ...key(write),
    })) as ClientLink;
  }

  async unlinkPullRequest(
    _principal: Principal,
    sessionId: string,
    args: { pr: string },
    write?: WriteOptions,
  ): Promise<void> {
    const ref = parsePrRef(args.pr);
    if (!ref) {
      throw new Error("pr must be owner/repo#number or a GitHub pull request URL");
    }
    await this.request(
      "DELETE",
      `/sessions/${encodeURIComponent(sessionId)}/links/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/${ref.number}`,
      key(write),
    );
  }

  async listFeedEvents(
    _principal: Principal,
    args: { after: number; limit: number },
  ): Promise<FeedPage> {
    const q = this.query({ after: args.after, limit: args.limit });
    return (await this.request("GET", `/events${q}`)) as FeedPage;
  }

  async waitForPullRequest(
    _principal: Principal,
    sessionId: string,
    args: { pr: string },
    write?: WriteOptions,
  ): Promise<ClientWait> {
    return (await this.request("POST", `/sessions/${encodeURIComponent(sessionId)}/waits`, {
      body: args,
      idempotent: true,
      ...key(write),
    })) as ClientWait;
  }

  async stopWaitingForPullRequest(
    _principal: Principal,
    sessionId: string,
    args: { pr: string },
    write?: WriteOptions,
  ): Promise<void> {
    const ref = parsePrRef(args.pr);
    if (!ref) {
      throw new Error("pr must be owner/repo#number or a GitHub pull request URL");
    }
    await this.request(
      "DELETE",
      `/sessions/${encodeURIComponent(sessionId)}/waits/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/${ref.number}`,
      key(write),
    );
  }
}
