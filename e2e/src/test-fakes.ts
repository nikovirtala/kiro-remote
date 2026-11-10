/**
 * Offline fakes for the harness unit tests: a discovery fetch, and a fake
 * kiro-remote backend that serves both an MCP session and a REST client over
 * the same in-memory sessions. Nothing here touches the network or a browser.
 */
import type {
  ClientEvent,
  ClientSession,
  ClientTurn,
  KiroRemoteClient,
} from "@nikovirtala/kiro-remote-api";
import { HttpClientError, TOOL_NAMES } from "@nikovirtala/kiro-remote-mcp";
import type { McpSession, ToolCallResult } from "./mcp-client.ts";
import type { HarnessDeps } from "./steps.ts";

export const FAKE_TOKEN = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1MSJ9.fake-signature";

export interface DiscoveryOverrides {
  /** The WWW-Authenticate value on the 401; null drops the header. */
  challenge?: string | null;
  /** Fields merged into the protected-resource metadata. */
  prm?: Record<string, unknown>;
  /** Fields merged into the authorization-server metadata. */
  as?: Record<string, unknown>;
  /** Status of the unauthenticated POST /mcp. */
  mcpStatus?: number;
}

/** A fetch that answers the three discovery requests like the deployed facade. */
export function discoveryFetch(base: string, over: DiscoveryOverrides = {}): typeof fetch {
  const prmUrl = `${base}/.well-known/oauth-protected-resource/mcp`;
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    if (url === `${base}/mcp` && method === "POST") {
      const challenge =
        over.challenge === undefined ? `Bearer resource_metadata="${prmUrl}"` : over.challenge;
      return new Response(null, {
        status: over.mcpStatus ?? 401,
        headers: challenge === null ? {} : { "www-authenticate": challenge },
      });
    }
    if (url === prmUrl) {
      return json({
        resource: `${base}/mcp`,
        authorization_servers: [base],
        scopes_supported: ["sessions:read", "sessions:write", "sessions:delete"],
        bearer_methods_supported: ["header"],
        ...over.prm,
      });
    }
    if (url === `${base}/.well-known/oauth-authorization-server`) {
      return json({
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        code_challenge_methods_supported: ["S256"],
        ...over.as,
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

export interface FakeKiroOptions {
  /** The launch turn ends in turn.failed instead of a message. */
  failLaunchTurn?: boolean;
  /** tools/list omits one tool. */
  wrongToolList?: boolean;
  /** A deleted session stays readable as `deleting` forever. */
  deleteNeverConfirms?: boolean;
  /** Launching a session throws. */
  launchThrows?: boolean;
}

interface ScriptStep {
  add: Array<Pick<ClientEvent, "type" | "turnId" | "payload">>;
  status: string;
}

interface FakeSession {
  row: ClientSession;
  log: ClientEvent[];
  script: ScriptStep[];
  deleted: boolean;
}

const MARKER = /KIRO_E2E_\w+/;

/** An in-memory backend behind both a fake McpSession and a fake KiroRemoteClient. */
export class FakeKiro {
  readonly sessions = new Map<string, FakeSession>();
  readonly calls: string[] = [];
  private seq = 0;
  private readonly opts: FakeKiroOptions;

  constructor(opts: FakeKiroOptions = {}) {
    this.opts = opts;
  }

  /** Sessions created and not deleted. */
  liveSessions(): string[] {
    return [...this.sessions.values()].filter((s) => !s.deleted).map((s) => s.row.id);
  }

  private find(id: string): FakeSession {
    const s = this.sessions.get(id);
    if (!s || (s.deleted && !this.opts.deleteNeverConfirms)) {
      throw new Error(`session not found: ${id}`);
    }
    return s;
  }

  private scriptTurn(s: FakeSession, turnId: string, prompt: string, launch: boolean): void {
    const marker = MARKER.exec(prompt)?.[0] ?? "";
    const middle: ScriptStep =
      launch && this.opts.failLaunchTurn
        ? {
            add: [
              {
                type: "turn.failed",
                turnId,
                payload: { failureReason: "error", payload: { error: "sandbox crashed" } },
              },
            ],
            status: "idle",
          }
        : {
            add: [
              {
                type: "message.chunk",
                turnId,
                payload: { type: "message.chunk", content: { type: "text", text: marker } },
              },
            ],
            status: "running",
          };
    s.script.push({ add: [], status: "running" }, middle, {
      add: [{ type: "turn.completed", turnId, payload: {} }],
      status: "idle",
    });
    s.row.status = "running";
  }

  launch(args: { prompt: string; repos: string[]; title?: string }) {
    if (this.opts.launchThrows) {
      throw new Error("launch rejected");
    }
    const id = `ses-${this.sessions.size + 1}`;
    const turnId = `turn-${id}-1`;
    const now = new Date(0).toISOString();
    const s: FakeSession = {
      row: {
        id,
        kiroSessionId: null,
        title: args.title ?? null,
        repos: args.repos,
        mode: null,
        model: null,
        effort: null,
        status: "provisioning",
        activeTurnId: turnId,
        eventSeq: 0,
        createdAt: now,
        updatedAt: now,
      },
      log: [],
      script: [],
      deleted: false,
    };
    this.sessions.set(id, s);
    this.scriptTurn(s, turnId, args.prompt, true);
    return { sessionId: id, turnId };
  }

  createTurn(id: string, prompt: string): ClientTurn {
    const s = this.find(id);
    if (s.row.status !== "idle") {
      throw new Error("session busy");
    }
    const turnId = `turn-${id}-${s.log.length + 2}`;
    this.scriptTurn(s, turnId, prompt, false);
    return {
      id: turnId,
      sessionId: id,
      status: "running",
      stopReason: null,
      startedAt: null,
      endedAt: null,
    };
  }

  read(id: string, after: number) {
    const s = this.find(id);
    const step = s.script.shift();
    if (step) {
      for (const e of step.add) {
        this.seq++;
        s.log.push({
          seq: this.seq,
          sessionId: id,
          turnId: e.turnId,
          type: e.type,
          rawType: e.type,
          replay: false,
          ts: new Date(0).toISOString(),
          payload: e.payload,
        });
      }
      s.row.status = step.status;
    }
    const events = s.log.filter((e) => e.seq > after);
    const turnStatus = s.deleted ? null : s.row.status;
    return { events, nextCursor: events.at(-1)?.seq ?? after, turnStatus };
  }

  transcript(id: string) {
    const s = this.find(id);
    const byTurn = new Map<string | null, string>();
    for (const e of s.log) {
      if (e.type === "message.chunk") {
        const text = (e.payload as { content: { text: string } }).content.text;
        byTurn.set(e.turnId, (byTurn.get(e.turnId) ?? "") + text);
      }
    }
    return { sessionId: id, turns: [...byTurn].map(([turnId, text]) => ({ turnId, text })) };
  }

  remove(id: string): void {
    const s = this.find(id);
    s.deleted = true;
    s.row.status = "deleting";
  }

  /** A fake MCP session over this backend (the tools the harness uses). */
  mcp(): McpSession {
    const tools: Record<string, (a: Record<string, unknown>) => Record<string, unknown>> = {
      kiro_capabilities: () => ({
        capabilities: {},
        kiroCliVersion: "3.1.0",
        activeSessionCount: 0,
      }),
      kiro_list_models: () => ({ models: ["auto"], source: null }),
      kiro_launch_session: (a) =>
        this.launch(a as { prompt: string; repos: string[]; title?: string }),
      kiro_get_session: (a) => ({ session: this.find(String(a.sessionId)).row }),
      kiro_list_sessions: () => ({
        sessions: [...this.sessions.values()].filter((s) => !s.deleted).map((s) => s.row),
      }),
      kiro_wait_for_events: (a) => ({
        ...this.read(String(a.sessionId), Number(a.after)),
        text: "",
        pendingPermissionCount: 0,
        eventsTruncated: false,
      }),
      kiro_get_transcript: (a) => this.transcript(String(a.sessionId)),
      kiro_send_prompt: (a) => ({ turn: this.createTurn(String(a.sessionId), String(a.prompt)) }),
      kiro_delete_session: (a) => {
        this.remove(String(a.sessionId));
        return { sessionId: a.sessionId, status: "deleting" };
      },
    };
    return {
      listToolNames: async () => {
        this.calls.push("mcp:tools/list");
        return this.opts.wrongToolList ? TOOL_NAMES.slice(1) : [...TOOL_NAMES];
      },
      callTool: async (name, args): Promise<ToolCallResult> => {
        this.calls.push(`mcp:${name}`);
        const tool = tools[name];
        if (!tool) {
          return { isError: true, structured: undefined, text: `unknown tool: ${name}` };
        }
        try {
          const structured = tool(args);
          return { isError: false, structured, text: JSON.stringify(structured) };
        } catch (err) {
          return { isError: true, structured: undefined, text: (err as Error).message };
        }
      },
      close: async () => {},
    };
  }

  /** A fake REST client over this backend. */
  rest(): KiroRemoteClient {
    const wrap = <T>(name: string, fn: () => T): Promise<T> => {
      this.calls.push(`rest:${name}`);
      try {
        return Promise.resolve(fn());
      } catch (err) {
        const message = (err as Error).message;
        const status = message.startsWith("session not found") ? 404 : 409;
        return Promise.reject(new HttpClientError(status, JSON.stringify({ detail: message })));
      }
    };
    const unsupported = () => Promise.reject(new Error("not used by the harness"));
    return {
      capabilities: () =>
        wrap("capabilities", () => ({
          capabilities: {},
          kiroCliVersion: "3.1.0",
          activeSessionCount: 0,
        })),
      listModels: () => wrap("listModels", () => ({ models: ["auto"], source: null })),
      launchSession: (_p, args) => wrap("launchSession", () => this.launch(args)),
      getSession: (_p, id) => wrap("getSession", () => this.find(id).row),
      listSessions: unsupported,
      adoptSession: unsupported,
      deleteSession: (_p, id) => wrap("deleteSession", () => this.remove(id)),
      createTurn: (_p, id, args) => wrap("createTurn", () => this.createTurn(id, args.prompt)),
      getEvents: (_p, id, args) => wrap("getEvents", () => this.read(id, args.after)),
      listPermissions: unsupported,
      cancelTurn: unsupported,
      answerPermission: unsupported,
      setConfig: unsupported,
    };
  }
}

/** Deps that throw if any of them is touched. */
export function throwingDeps(): Partial<HarnessDeps> {
  const boom = (name: string) => () => {
    throw new Error(`${name} must not be called`);
  };
  return {
    fetch: boom("fetch") as unknown as typeof fetch,
    inspector: boom("inspector"),
    obtainToken: boom("obtainToken"),
    connectMcp: boom("connectMcp"),
    rest: boom("rest"),
    sleep: boom("sleep"),
    progress: () => {},
  };
}

/** Fake deps over a FakeKiro with a fake clock. */
export function fakeDeps(
  base: string,
  kiro: FakeKiro,
  over: Partial<HarnessDeps> = {},
): Partial<HarnessDeps> {
  let t = 0;
  return {
    fetch: discoveryFetch(base),
    inspector: async () => [...TOOL_NAMES],
    obtainToken: async () => ({
      tokens: { accessToken: async () => FAKE_TOKEN },
      source: "keychain",
      scopes: ["sessions:read", "sessions:write", "sessions:delete"],
    }),
    connectMcp: async () => kiro.mcp(),
    rest: () => kiro.rest(),
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    runId: "ABCDEF12",
    progress: () => {},
    turnTimeoutMs: 60_000,
    deleteTimeoutMs: 20_000,
    deletePollMs: 5_000,
    ...over,
  };
}
