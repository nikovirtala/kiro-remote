/**
 * The direct KAS engine client used by the Lambda bridge.
 *
 * kiro-cli 3.1.0 runs its ACP agent as a bundled Node server (KAS). kiro-cli
 * itself cannot start that server inside Lambda (its `prctl(PR_SET_PDEATHSIG)`
 * call fails with EPERM there), so the Lambda image carries the unpacked engine
 * under `/opt/kiro` and this module starts it directly, with the same command
 * line and env kiro-cli uses:
 *
 *   /opt/kiro/node --experimental-wasm-modules \
 *     /opt/kiro/kas/current/node_modules/@kiro/agent/dist/server/acp-server.js \
 *     --transport=stdio
 *
 * {@link KasEngine} speaks ACP to it over the existing
 * {@link StdioJsonRpcTransport}: `initialize`, a cloud-sandbox `session/new`,
 * a remote `session/load` (replays the cloud session's history as
 * `session/update` notifications), `session/prompt`, and a remote
 * `session/delete`. The turn itself runs in Kiro's cloud sandbox; the engine
 * only relays its updates, so a short-lived engine per command is enough.
 *
 * The API key travels only in the child env; nothing here logs the env.
 */

import type { Logger } from "./logger.ts";
import { type SpawnFn, type SpawnSpec, StdioJsonRpcTransport } from "./transport.ts";

/** Our client identity sent on initialize. */
export const CLIENT_INFO = { name: "kiro-remote-bridge", version: "0.0.0" } as const;

/** Root of the engine unpacked into the Lambda image. */
export const KAS_ROOT = "/opt/kiro";
/** The Node binary kiro-cli bundles for its engine. */
export const KAS_NODE_PATH = "/opt/kiro/node";
/** The engine's ACP server entry point (`kas/current` is a symlink). */
export const KAS_SERVER_PATH =
  "/opt/kiro/kas/current/node_modules/@kiro/agent/dist/server/acp-server.js";
/** Kiro app endpoint the engine uses for cloud config and remote sessions. */
export const KIRO_APP_ENDPOINT = "https://app.kiro.dev";
/** `_meta` that addresses a remote (cloud) session on load/delete. */
export const REMOTE_SOURCE_META = { kiro: { sessionSource: "remote" } } as const;

/** Default bound on initialize/new/load/delete requests. */
const DEFAULT_RPC_TIMEOUT_MS = 60_000;

/**
 * Build the spawn spec for the engine. `KAS_NODE` / `KAS_SERVER` in `env`
 * override the image paths (for local runs); `KIRO_API_KEY` is set only when
 * a key was resolved.
 */
export function kasSpawnSpec(args: { env: NodeJS.ProcessEnv; apiKey: string | null }): SpawnSpec {
  const { env, apiKey } = args;
  const home = env.HOME ?? "/tmp";
  const childEnv: Record<string, string> = {
    HOME: home,
    KIRO_HOME: env.KIRO_HOME ?? `${home}/.kiro`,
    CLOUD_CONFIG_ENDPOINT: KIRO_APP_ENDPOINT,
    KIRO_REMOTE_SESSIONS_ENDPOINT: KIRO_APP_ENDPOINT,
    NODE_USE_SYSTEM_CA: "1",
    KIRO_LOG_LEVEL: env.KIRO_LOG_LEVEL ?? "debug",
  };
  if (apiKey !== null) {
    childEnv.KIRO_API_KEY = apiKey;
  }
  return {
    command: env.KAS_NODE ?? KAS_NODE_PATH,
    args: ["--experimental-wasm-modules", env.KAS_SERVER ?? KAS_SERVER_PATH, "--transport=stdio"],
    env: childEnv,
  };
}

/** Receives every `session/update` notification: the cloud id and the update. */
export type UpdateListener = (sessionId: string, update: unknown) => void;

export interface KasEngineOptions {
  spec: SpawnSpec;
  spawnFn?: SpawnFn;
  logger: Logger;
  /** Bound on initialize/new/load/delete (session/prompt is unbounded). */
  rpcTimeoutMs?: number;
}

/** A short-lived ACP client for one engine child process. */
export class KasEngine {
  private readonly transport: StdioJsonRpcTransport;
  private readonly rpcTimeoutMs: number;
  private readonly listeners = new Set<UpdateListener>();

  constructor(opts: KasEngineOptions) {
    this.rpcTimeoutMs = opts.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    this.transport = new StdioJsonRpcTransport({
      spec: opts.spec,
      ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
      logger: opts.logger,
    });
    this.transport.onNotification("session/update", (params) => {
      const p = (params ?? {}) as { sessionId?: unknown; update?: unknown };
      const sessionId = typeof p.sessionId === "string" ? p.sessionId : "";
      for (const listener of this.listeners) {
        listener(sessionId, p.update);
      }
    });
  }

  /** Spawn the engine child. */
  start(): void {
    this.transport.start();
  }

  /** Subscribe to `session/update` notifications; returns the unsubscribe. */
  onUpdate(listener: UpdateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Negotiate with the engine. The consumer advertises no client capabilities;
   * the caps publisher passes the ones it wants reflected in CONFIG#CAPS.
   */
  async initialize(clientCapabilities: Record<string, unknown> = {}): Promise<unknown> {
    return this.bounded("initialize", {
      protocolVersion: 1,
      clientInfo: CLIENT_INFO,
      clientCapabilities,
    });
  }

  /** Create a cloud-sandbox session for `repos`; returns its cloud id. */
  async newCloudSession(args: { cwd: string; repos: string[] }): Promise<string> {
    const result = (await this.bounded("session/new", {
      cwd: args.cwd,
      mcpServers: [],
      _meta: {
        kiro: {
          executionTarget: { kind: "cloud-sandbox" },
          sessionSource: "remote",
          repositories: args.repos,
        },
      },
    })) as { sessionId?: unknown } | null;
    const sessionId = result?.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new Error("session/new returned no sessionId");
    }
    return sessionId;
  }

  /**
   * Load a remote session. The engine replays its history as `session/update`
   * notifications before the response, so listeners see the replay before
   * this resolves.
   */
  async loadRemote(sessionId: string, cwd: string): Promise<void> {
    await this.bounded("session/load", {
      sessionId,
      cwd,
      mcpServers: [],
      _meta: REMOTE_SOURCE_META,
    });
  }

  /** Send a text prompt; resolves when the turn ends (no timeout). */
  async prompt(sessionId: string, text: string): Promise<{ stopReason?: string }> {
    const result = (await this.transport.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text }],
    })) as { stopReason?: unknown } | null;
    const stopReason = result?.stopReason;
    return typeof stopReason === "string" ? { stopReason } : {};
  }

  /** Delete a remote session. */
  async deleteRemote(sessionId: string): Promise<void> {
    await this.bounded("session/delete", { sessionId, _meta: REMOTE_SOURCE_META });
  }

  /** Kill the engine child. */
  async stop(): Promise<void> {
    this.listeners.clear();
    await this.transport.stop("SIGTERM");
  }

  private bounded(method: string, params: unknown): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${method} timed out after ${this.rpcTimeoutMs} ms`));
      }, this.rpcTimeoutMs);
      this.transport.request(method, params).then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }
}
