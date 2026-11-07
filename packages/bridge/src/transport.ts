/**
 * Newline-delimited JSON-RPC 2.0 stdio transport.
 *
 * CLI V3 speaks newline-delimited JSON-RPC 2.0 over stdin/stdout: one JSON
 * object per line. This transport spawns and supervises the ACP child process,
 * frames outgoing requests/notifications as single lines, parses incoming
 * lines, correlates responses to requests by `id`, and routes agent-to-client
 * requests/notifications to registered handlers.
 *
 * The child command is INJECTABLE ({@link SpawnFn}) so integration tests
 * substitute a fake scripted ACP agent (another Node process) without a real
 * kiro-cli binary.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import {
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_VERSION,
  replyForUnknownRequest,
} from "@nikovirtala/kiro-remote-core";
import type { Logger } from "./logger.ts";

export interface SpawnSpec {
  command: string;
  args: string[];
  /** Extra env merged over process.env for the child. */
  env?: Record<string, string>;
}

/** Injectable spawner so tests substitute a fake ACP agent. */
export type SpawnFn = (spec: SpawnSpec) => ChildProcessWithoutNullStreams;

/** Max bytes of child stderr retained for the on-exit diagnostic tail. */
const STDERR_TAIL_LIMIT = 8 * 1024;

export const defaultSpawn: SpawnFn = (spec) =>
  spawn(spec.command, spec.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...(spec.env ?? {}) },
  }) as ChildProcessWithoutNullStreams;

/** An incoming agent-to-client request that must be answered. */
export interface IncomingRequest {
  id: string | number;
  method: string;
  params: unknown;
}

/** Handler for an agent-to-client request: returns the JSON-RPC `result`. */
export type RequestHandler = (params: unknown) => Promise<unknown> | unknown;
/** Handler for an agent-to-client notification (no `id`, no reply). */
export type NotificationHandler = (params: unknown) => void;

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

/** Raised when a JSON-RPC request comes back as an error object. */
export class JsonRpcResponseError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data: unknown) {
    super(message);
    this.name = "JsonRpcResponseError";
    this.code = code;
    this.data = data;
  }
}

export interface TransportOptions {
  spec: SpawnSpec;
  spawnFn?: SpawnFn;
  logger: Logger;
  /** Called once when the child process exits (for supervision/restart). */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export class StdioJsonRpcTransport {
  private readonly spec: SpawnSpec;
  private readonly spawnFn: SpawnFn;
  private readonly logger: Logger;
  private readonly onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;

  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<string | number, Pending>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private buffer = "";
  private closed = false;
  /**
   * Rolling tail of the child's stderr, bounded to {@link STDERR_TAIL_LIMIT}
   * bytes. kiro-cli writes its own startup diagnostics here; on a non-zero
   * exit we surface this tail at ERROR so the crash is never silent (the tail
   * is redacted by the logger like every other field).
   */
  private stderrTail = "";

  constructor(opts: TransportOptions) {
    this.spec = opts.spec;
    this.spawnFn = opts.spawnFn ?? defaultSpawn;
    this.logger = opts.logger;
    this.onExit = opts.onExit;
  }

  /** Register (or replace) the handler for an agent-to-client request method. */
  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  /** Register (or replace) the handler for an agent-to-client notification. */
  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  /** Spawn the child and start reading its stdout line by line. */
  start(): void {
    this.closed = false;
    this.buffer = "";
    this.stderrTail = "";
    const child = this.spawnFn(this.spec);
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Retain a bounded tail so a crash surfaces kiro-cli's own message even
      // at the default info level, and stream live at debug for verbose mode.
      this.appendStderrTail(chunk);
      // Child diagnostics; redacted by the logger.
      this.logger.debug("acp_stderr", { line: chunk.trimEnd() });
    });
    child.on("exit", (code, signal) => {
      // On a clean (code 0) exit the child's stderr is routine; on a failure
      // (non-zero code or a signal) surface the captured stderr tail at ERROR
      // so the retained logs always contain kiro-cli's own reason for exiting.
      // The tail is redacted by the logger, so a leaked ksk_/token is scrubbed.
      if (code !== 0 || signal) {
        const tail = this.stderrTail.trimEnd();
        this.logger.error("acp_child_exit", {
          code,
          signal,
          ...(tail.length > 0 ? { stderr: tail } : {}),
        });
      } else {
        this.logger.warn("acp_child_exit", { code, signal });
      }
      this.failAllPending(new Error(`acp child exited (code=${code}, signal=${signal})`));
      if (!this.closed) {
        this.onExit?.(code, signal);
      }
    });
    child.on("error", (err) => {
      this.logger.error("acp_child_error", { error: String(err) });
    });
  }

  /** Send a JSON-RPC request and resolve with its `result` (or reject on error). */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const line = JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, method, params });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (r) => resolve(r as T),
        reject,
      });
      this.write(line);
    });
  }

  /** Send a JSON-RPC notification (no id, no response expected). */
  notify(method: string, params?: unknown): void {
    this.write(JSON.stringify({ jsonrpc: JSONRPC_VERSION, method, params }));
  }

  /** Stop supervising and kill the child. */
  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    this.closed = true;
    const child = this.child;
    if (!child || child.exitCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill(signal);
    });
  }

  private write(line: string): void {
    const child = this.child;
    if (!child || child.stdin.destroyed) {
      throw new Error("acp transport is not connected");
    }
    child.stdin.write(`${line}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line.length > 0) {
        this.handleLine(line);
      }
      index = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
      this.logger.warn("acp_parse_error", { error: String(err) });
      return;
    }

    // A response to one of OUR requests: has `id` and `result`/`error` but no `method`.
    if (msg.method === undefined && msg.id !== undefined && msg.id !== null) {
      this.resolvePending(msg);
      return;
    }

    // An agent-to-client message: has a `method`.
    if (typeof msg.method === "string") {
      if (msg.id === undefined || msg.id === null) {
        this.dispatchNotification(msg.method, msg.params);
      } else {
        void this.dispatchRequest(msg.id as string | number, msg.method, msg.params);
      }
    }
  }

  private resolvePending(msg: Record<string, unknown>): void {
    const id = msg.id as string | number;
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    if (msg.error) {
      const e = msg.error as { code?: number; message?: string; data?: unknown };
      pending.reject(
        new JsonRpcResponseError(
          e.code ?? JSONRPC_INTERNAL_ERROR,
          e.message ?? "jsonrpc error",
          e.data,
        ),
      );
      return;
    }
    pending.resolve(msg.result);
  }

  private dispatchNotification(method: string, params: unknown): void {
    const handler = this.notificationHandlers.get(method);
    if (!handler) {
      // Unknown notifications are ignored (never fail the session), but logged.
      this.logger.debug("acp_unknown_notification", { method });
      return;
    }
    try {
      handler(params);
    } catch (err) {
      this.logger.error("acp_notification_handler_error", { method, error: String(err) });
    }
  }

  private async dispatchRequest(
    id: string | number,
    method: string,
    params: unknown,
  ): Promise<void> {
    // Unknown agent-to-client requests get a JSON-RPC error -- NEVER a hang.
    const unknownReply = replyForUnknownRequest(id, method);
    if (unknownReply) {
      this.logger.warn("acp_unknown_request", { method });
      this.write(JSON.stringify(unknownReply));
      return;
    }

    const handler = this.requestHandlers.get(method);
    if (!handler) {
      // Known-but-unregistered (e.g. a handler not installed yet): still answer.
      this.write(JSON.stringify(replyForUnknownRequest(id, `${method}:unregistered`)));
      return;
    }

    try {
      const result = await handler(params);
      this.write(JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, result }));
    } catch (err) {
      this.write(
        JSON.stringify({
          jsonrpc: JSONRPC_VERSION,
          id,
          error: { code: JSONRPC_INTERNAL_ERROR, message: String(err) },
        }),
      );
    }
  }

  /** Append to the bounded stderr tail, discarding the oldest bytes over the cap. */
  private appendStderrTail(chunk: string): void {
    this.stderrTail += chunk;
    if (this.stderrTail.length > STDERR_TAIL_LIMIT) {
      this.stderrTail = this.stderrTail.slice(this.stderrTail.length - STDERR_TAIL_LIMIT);
    }
  }

  private failAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
