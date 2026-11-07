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
  ClientPermission,
  ClientSession,
  ClientTurn,
  KiroRemoteClient,
} from "@nikovirtala/kiro-remote-api";
import type { Principal } from "@nikovirtala/kiro-remote-core";

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

/** Raised when the REST API returns a non-2xx response. */
export class HttpClientError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`REST API error ${status}`);
    this.name = "HttpClientError";
    this.status = status;
    this.body = body;
  }
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
    opts: { body?: unknown; idempotent?: boolean } = {},
  ): Promise<unknown> {
    const token = await this.tokens.accessToken();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    };
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (opts.idempotent) {
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
  ): Promise<{ sessionId: string; turnId: string | null }> {
    return (await this.request("POST", "/sessions", { body: args, idempotent: true })) as {
      sessionId: string;
      turnId: string | null;
    };
  }

  async adoptSession(
    _principal: Principal,
    args: { kiroSessionId: string },
  ): Promise<{ sessionId: string }> {
    const res = (await this.request("POST", "/sessions/adopt", {
      body: args,
      idempotent: true,
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

  async deleteSession(_principal: Principal, sessionId: string): Promise<void> {
    await this.request("DELETE", `/sessions/${encodeURIComponent(sessionId)}`, {
      idempotent: true,
    });
  }

  async createTurn(
    _principal: Principal,
    sessionId: string,
    args: { prompt: string; whenBusy: "steer" | "queue" | "reject" },
  ): Promise<ClientTurn> {
    return (await this.request("POST", `/sessions/${encodeURIComponent(sessionId)}/turns`, {
      body: args,
      idempotent: true,
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

  async cancelTurn(_principal: Principal, sessionId: string): Promise<void> {
    await this.request("POST", `/sessions/${encodeURIComponent(sessionId)}/cancel`, {
      body: {},
      idempotent: true,
    });
  }

  async answerPermission(
    _principal: Principal,
    sessionId: string,
    requestId: string,
    args: { optionId: string; consent?: Record<string, unknown> },
  ): Promise<void> {
    await this.request(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}`,
      { body: args, idempotent: true },
    );
  }

  async setConfig(
    _principal: Principal,
    sessionId: string,
    args: { model?: string; effort?: string; mode?: string },
  ): Promise<void> {
    await this.request("PATCH", `/sessions/${encodeURIComponent(sessionId)}/config`, {
      body: args,
    });
  }
}
