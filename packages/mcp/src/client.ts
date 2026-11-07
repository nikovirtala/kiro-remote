/**
 * The ONE {@link KiroRemoteClient} interface the MCP tools are written against,
 * re-exported here as {@link ToolClient} with its two implementations.
 *
 * The interface is defined once, canonically, in @kiro-remote/api's mcp-seam;
 * both this package and the API import that single definition so there is no
 * divergence. The tools call ONLY {@link ToolClient}; neither implementation
 * leaks transport details into them.
 *
 *   - {@link InProcessClient}: used by the Streamable HTTP transport mounted at
 *     /mcp on the API. It calls the core service functions and the repository
 *     DIRECTLY with the authenticated Principal (no self-HTTP), exactly as the
 *     REST routes do, so authorize() runs with the caller's own scopes.
 *   - {@link HttpClient}: used by the stdio `kiro-remote mcp` CLI. It calls the
 *     REST API over HTTP with the user's bearer token.
 */

import type {
  ClientCapabilities,
  ClientEventsPage,
  ClientPermission,
  ClientSession,
  ClientTurn,
  KiroRemoteClient,
} from "@kiro-remote/api";
import {
  capabilities as deriveCapabilities,
  type Principal,
  type Repository,
  type ServiceDeps,
  adoptSession as svcAdopt,
  answerPermission as svcAnswer,
  cancelTurn as svcCancel,
  deleteSession as svcDelete,
  getSession as svcGetSession,
  launchSession as svcLaunch,
  listSessions as svcListSessions,
  sendPrompt as svcSendPrompt,
  setConfig as svcSetConfig,
} from "@kiro-remote/core";

/** The single client interface the tools depend on (canonical in @kiro-remote/api). */
export type ToolClient = KiroRemoteClient;

const ACTIVE_STATUSES = ["provisioning", "running", "idle", "awaiting_permission"];

function deriveTurnStatus(sessionStatus: string): string | null {
  switch (sessionStatus) {
    case "running":
      return "running";
    case "awaiting_permission":
      return "awaiting_permission";
    case "idle":
      return "idle";
    case "provisioning":
      return "provisioning";
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* In-process client (Streamable HTTP transport mounted in the API)           */
/* -------------------------------------------------------------------------- */

export interface InProcessClientDeps {
  service: ServiceDeps;
  repo: Repository;
  /** Resolve the server's kiro-cli version string (for kiro_capabilities). */
  kiroCliVersion: () => Promise<string | null>;
}

/**
 * Calls the core service + repository directly. This is the variant the API
 * wires into {@link ApiContext.mcp} so an in-process tool call costs no HTTP
 * round trip. Every method forwards the authenticated Principal straight into
 * the core service, which runs authorize() itself.
 */
export class InProcessClient implements KiroRemoteClient {
  private readonly service: ServiceDeps;
  private readonly repo: Repository;
  private readonly kiroCliVersionFn: () => Promise<string | null>;

  constructor(deps: InProcessClientDeps) {
    this.service = deps.service;
    this.repo = deps.repo;
    this.kiroCliVersionFn = deps.kiroCliVersion;
  }

  async capabilities(principal: Principal): Promise<ClientCapabilities> {
    const caps = await this.repo.getCaps();
    const normalized = caps ? deriveCapabilities(caps.initializeResult) : null;
    const kiroCliVersion = await this.kiroCliVersionFn();
    const { items } = await this.repo.listSessionsByUser(principal.sub, { limit: 100 });
    const activeSessionCount = items.filter((s) => ACTIVE_STATUSES.includes(s.status)).length;
    return {
      capabilities: (normalized ?? {
        extensionMethods: [],
        sessionSources: [],
        listScopes: [],
        executionTargets: [],
        configOptions: [],
        modes: [],
        models: [],
        replayMarking: false,
      }) as unknown as Record<string, unknown>,
      kiroCliVersion,
      activeSessionCount,
    };
  }

  async listModels(): Promise<{ models: string[]; source: string | null }> {
    const models = await this.repo.getModels();
    return { models: models?.models ?? [], source: models?.source ?? null };
  }

  async launchSession(
    principal: Principal,
    args: {
      prompt: string;
      repos: string[];
      title?: string;
      mode?: string;
      model?: string;
      effort?: string;
    },
  ): Promise<{ sessionId: string; turnId: string | null }> {
    const view = await svcLaunch(this.service, principal, args);
    return { sessionId: view.id, turnId: view.activeTurnId };
  }

  async adoptSession(
    principal: Principal,
    args: { kiroSessionId: string },
  ): Promise<{ sessionId: string }> {
    const view = await svcAdopt(this.service, principal, args);
    return { sessionId: view.id };
  }

  async listSessions(
    principal: Principal,
    args: { limit: number; cursor?: string; status?: string },
  ): Promise<{ sessions: ClientSession[]; cursor?: string }> {
    const result = await svcListSessions(this.service, principal, args);
    return {
      sessions: result.sessions as ClientSession[],
      ...(result.cursor ? { cursor: result.cursor } : {}),
    };
  }

  async getSession(principal: Principal, sessionId: string): Promise<ClientSession> {
    return (await svcGetSession(this.service, principal, sessionId)) as ClientSession;
  }

  async deleteSession(principal: Principal, sessionId: string): Promise<void> {
    await svcDelete(this.service, principal, sessionId);
  }

  async createTurn(
    principal: Principal,
    sessionId: string,
    args: { prompt: string; whenBusy: "steer" | "queue" | "reject" },
  ): Promise<ClientTurn> {
    return (await svcSendPrompt(this.service, principal, sessionId, args)) as ClientTurn;
  }

  async getEvents(
    principal: Principal,
    sessionId: string,
    args: { after: number; wait: number; types?: string[] },
  ): Promise<ClientEventsPage> {
    // Ownership is enforced by reading the session first (hides existence on 404).
    const session = await svcGetSession(this.service, principal, sessionId);
    const events = await this.repo.queryEvents(sessionId, args.after, {
      ...(args.types && args.types.length > 0 ? { types: args.types } : {}),
    });
    const rows = events.map((e) => ({
      seq: e.seq,
      sessionId,
      turnId: e.turnId,
      type: e.type,
      rawType: e.rawType,
      replay: e.replay,
      ts: e.ts,
      payload: e.payload,
    }));
    const nextCursor = rows.length > 0 ? rows[rows.length - 1].seq : args.after;
    return { events: rows, nextCursor, turnStatus: deriveTurnStatus(session.status) };
  }

  async listPermissions(
    principal: Principal,
    sessionId: string,
    args: { status?: string },
  ): Promise<{ permissions: ClientPermission[] }> {
    await svcGetSession(this.service, principal, sessionId);
    const status = args.status === "pending" ? "pending" : undefined;
    const perms = await this.repo.queryPermissions(sessionId, status ? { status } : {});
    return {
      permissions: perms.map((p) => ({
        requestId: p.requestId,
        toolCallId: p.toolCallId,
        toolCall: p.toolCall,
        options: p.options,
        consent: p.consent,
        status: p.status,
        answer: p.answer,
      })),
    };
  }

  async cancelTurn(principal: Principal, sessionId: string): Promise<void> {
    await svcCancel(this.service, principal, sessionId);
  }

  async answerPermission(
    principal: Principal,
    sessionId: string,
    requestId: string,
    args: { optionId: string; consent?: Record<string, unknown> },
  ): Promise<void> {
    await svcAnswer(this.service, principal, sessionId, requestId, {
      optionId: args.optionId,
      ...(args.consent
        ? {
            consent: args.consent as {
              scope: string;
              resource: string;
              workspaceRoot: string;
            },
          }
        : {}),
    });
  }

  async setConfig(
    principal: Principal,
    sessionId: string,
    args: { model?: string; effort?: string; mode?: string },
  ): Promise<void> {
    await svcSetConfig(this.service, principal, sessionId, args);
  }
}
