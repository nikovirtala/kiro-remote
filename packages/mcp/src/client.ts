/**
 * The ONE {@link KiroRemoteClient} interface the MCP tools are written against,
 * re-exported here as {@link ToolClient} with its two implementations.
 *
 * The interface is defined once, canonically, in @nikovirtala/kiro-remote-api's mcp-seam;
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
  ClientLink,
  ClientPermission,
  ClientSession,
  ClientTurn,
  ClientWait,
  KiroRemoteClient,
  WriteOptions,
} from "@nikovirtala/kiro-remote-api";
import { fingerprintRequest, withIdempotentResult } from "@nikovirtala/kiro-remote-api";
import {
  capabilities as deriveCapabilities,
  type FeedPage,
  type Principal,
  type Repository,
  readEvents,
  type ServiceDeps,
  adoptSession as svcAdopt,
  answerPermission as svcAnswer,
  cancelTurn as svcCancel,
  deleteSession as svcDelete,
  listFeedEvents as svcFeed,
  getSession as svcGetSession,
  launchSession as svcLaunch,
  linkPullRequest as svcLink,
  listSessions as svcListSessions,
  sendPrompt as svcSendPrompt,
  setConfig as svcSetConfig,
  stopWaitingForPullRequest as svcStopWaiting,
  unlinkPullRequest as svcUnlink,
  waitForPullRequest as svcWait,
} from "@nikovirtala/kiro-remote-core";

/** The single client interface the tools depend on (canonical in @nikovirtala/kiro-remote-api). */
export type ToolClient = KiroRemoteClient;

const ACTIVE_STATUSES = ["provisioning", "running", "idle", "awaiting_permission"];

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

  /**
   * Run a state-changing call. Without a key it just runs; with one it goes
   * through the same withIdempotency the REST routes use, scoped to the
   * caller's sub and fingerprinted by (in-process, operation, input).
   */
  private async write<T>(
    principal: Principal,
    opts: WriteOptions | undefined,
    operation: string,
    input: unknown,
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = opts?.idempotencyKey;
    if (key === undefined) {
      return fn();
    }
    return withIdempotentResult(
      this.repo,
      principal.sub,
      key,
      fingerprintRequest("MCP", operation, input),
      fn,
    );
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
    opts?: WriteOptions,
  ): Promise<{ sessionId: string; turnId: string | null }> {
    return this.write(principal, opts, "launchSession", args, async () => {
      const view = await svcLaunch(this.service, principal, args);
      return { sessionId: view.id, turnId: view.activeTurnId };
    });
  }

  async adoptSession(
    principal: Principal,
    args: { kiroSessionId: string },
    opts?: WriteOptions,
  ): Promise<{ sessionId: string }> {
    return this.write(principal, opts, "adoptSession", args, async () => {
      const view = await svcAdopt(this.service, principal, args);
      return { sessionId: view.id };
    });
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

  async deleteSession(principal: Principal, sessionId: string, opts?: WriteOptions): Promise<void> {
    await this.write(principal, opts, "deleteSession", { sessionId }, () =>
      svcDelete(this.service, principal, sessionId, { source: "mcp" }),
    );
  }

  async createTurn(
    principal: Principal,
    sessionId: string,
    args: { prompt: string; whenBusy: "steer" | "queue" | "reject" },
    opts?: WriteOptions,
  ): Promise<ClientTurn> {
    return this.write(
      principal,
      opts,
      "createTurn",
      { sessionId, ...args },
      async () => (await svcSendPrompt(this.service, principal, sessionId, args)) as ClientTurn,
    );
  }

  async getEvents(
    principal: Principal,
    sessionId: string,
    args: { after: number; wait: number; types?: string[] },
  ): Promise<ClientEventsPage> {
    // Same long-poll as GET /v1/sessions/{id}/events; ownership is enforced on
    // every read (hides existence on 404).
    return readEvents(this.service, principal, sessionId, args);
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

  async cancelTurn(principal: Principal, sessionId: string, opts?: WriteOptions): Promise<void> {
    await this.write(principal, opts, "cancelTurn", { sessionId }, () =>
      svcCancel(this.service, principal, sessionId),
    );
  }

  async answerPermission(
    principal: Principal,
    sessionId: string,
    requestId: string,
    args: { optionId: string; consent?: Record<string, unknown> },
    opts?: WriteOptions,
  ): Promise<void> {
    await this.write(principal, opts, "answerPermission", { sessionId, requestId, ...args }, () =>
      svcAnswer(this.service, principal, sessionId, requestId, {
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
      }),
    );
  }

  async setConfig(
    principal: Principal,
    sessionId: string,
    args: { model?: string; effort?: string; mode?: string },
    opts?: WriteOptions,
  ): Promise<void> {
    await this.write(principal, opts, "setConfig", { sessionId, ...args }, () =>
      svcSetConfig(this.service, principal, sessionId, args),
    );
  }

  async linkPullRequest(
    principal: Principal,
    sessionId: string,
    args: { pr: string },
    opts?: WriteOptions,
  ): Promise<ClientLink> {
    return this.write(
      principal,
      opts,
      "linkPullRequest",
      { sessionId, ...args },
      async () => (await svcLink(this.service, principal, sessionId, args.pr, "mcp")).link,
    );
  }

  async unlinkPullRequest(
    principal: Principal,
    sessionId: string,
    args: { pr: string },
    opts?: WriteOptions,
  ): Promise<void> {
    await this.write(principal, opts, "unlinkPullRequest", { sessionId, ...args }, () =>
      svcUnlink(this.service, principal, sessionId, args.pr, "mcp"),
    );
  }

  async listFeedEvents(
    principal: Principal,
    args: { after: number; limit: number },
  ): Promise<FeedPage> {
    return svcFeed(this.service, principal, args);
  }

  async waitForPullRequest(
    principal: Principal,
    sessionId: string,
    args: { pr: string },
    opts?: WriteOptions,
  ): Promise<ClientWait> {
    return this.write(
      principal,
      opts,
      "waitForPullRequest",
      { sessionId, ...args },
      async () => (await svcWait(this.service, principal, sessionId, args.pr, "mcp")).wait,
    );
  }

  async stopWaitingForPullRequest(
    principal: Principal,
    sessionId: string,
    args: { pr: string },
    opts?: WriteOptions,
  ): Promise<void> {
    await this.write(principal, opts, "stopWaitingForPullRequest", { sessionId, ...args }, () =>
      svcStopWaiting(this.service, principal, sessionId, args.pr, "mcp"),
    );
  }
}
