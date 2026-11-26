/**
 * An MCP client for the Tasks extension over `/mcp`, built on the extension's
 * own requester (@modelcontextprotocol/ext-tasks/client) rather than on
 * requests written here: the requester declares the extension, reads the task
 * handle, polls `tasks/get` at the server's interval and decodes the result.
 *
 * Only the transport is ours. A 2026-07-28 request is self-contained, so there
 * is no connection to open: each request is one POST carrying the `_meta`
 * envelope, the `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` headers and
 * the caller's bearer (read from the {@link TokenProvider} on every request, so a
 * silent refresh is picked up). The bearer is never logged.
 */
import type {
  ConnectedMcpSessionPort,
  JsonRpcResponse,
} from "@modelcontextprotocol/ext-tasks/client";
import { resultFromTaskOutcome, withTasks } from "@modelcontextprotocol/ext-tasks/client";
import type { TokenProvider } from "@nikovirtala/kiro-remote-mcp";

const PROTOCOL = "2026-07-28";
/** The timeout of one request (a `tasks/get` or the call that starts the task). */
const REQUEST_TIMEOUT_MS = 60_000;

/** How a call ended: what the tool (or the task) finally answered. */
export interface TasksOutcome {
  status: "completed" | "failed" | "cancelled";
  /** The joined text content of the result; empty when there is none. */
  text: string;
  structured: Record<string, unknown> | undefined;
  /** A failed task's error message. */
  error?: string;
}

/** One tool call: a task to poll, or an ordinary result that is already here. */
export interface TasksCall {
  kind: "task" | "immediate";
  /** The task id, for a task. */
  taskId?: string;
  /** Poll a task until it settles (or return the immediate result). */
  settle(options: { timeoutMs: number; signal?: AbortSignal }): Promise<TasksOutcome>;
}

export interface TasksSession {
  /** Call a tool, declaring the Tasks extension. */
  callTool(name: string, args: Record<string, unknown>): Promise<TasksCall>;
  close(): Promise<void>;
}

type Json = Record<string, unknown>;

const idle = (): (() => void) => () => {};

/** The result of a tool call as `text` and `structured`. */
function readResult(result: unknown): Pick<TasksOutcome, "text" | "structured"> {
  const r = (typeof result === "object" && result !== null ? result : {}) as Json;
  const content = Array.isArray(r.content) ? r.content : [];
  const text = content
    .filter((c): c is { type: "text"; text: string } => (c as Json | null)?.type === "text")
    .map((c) => c.text)
    .join("\n");
  const structured =
    typeof r.structuredContent === "object" && r.structuredContent !== null
      ? (r.structuredContent as Record<string, unknown>)
      : undefined;
  return { text, structured };
}

/** The JSON-RPC answer in a response body: plain JSON, or the one `data:` event of an SSE stream. */
function parseBody(body: string, contentType: string): Json {
  if (contentType.startsWith("text/event-stream")) {
    const data = body
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("");
    return JSON.parse(data) as Json;
  }
  return JSON.parse(body) as Json;
}

/** A session port that POSTs each 2026-07-28 request to `<baseUrl>/mcp`. */
function httpPort(
  baseUrl: string,
  tokens: TokenProvider,
  fetchImpl: typeof fetch,
): ConnectedMcpSessionPort {
  let nextId = 0;
  return {
    endpointId: "kiro-remote-e2e",
    taskCapabilities: { generation: "v2", capabilities: {} },
    async dispatch(request, options): Promise<JsonRpcResponse> {
      const base = request as Json;
      const params = (base.params ?? {}) as Json;
      const meta = (params._meta ?? {}) as Json;
      const message: Json = {
        jsonrpc: "2.0",
        id: ++nextId,
        ...base,
        params: {
          ...params,
          _meta: {
            ...meta,
            "io.modelcontextprotocol/protocolVersion": PROTOCOL,
            "io.modelcontextprotocol/clientInfo": { name: "kiro-remote-e2e", version: "0.0.0" },
            // The requester puts the Tasks extension in here; nothing is added for it.
            "io.modelcontextprotocol/clientCapabilities":
              meta["io.modelcontextprotocol/clientCapabilities"] ?? {},
          },
        },
      };
      // `Headers` so a header the requester names itself (Mcp-Name on a task request) replaces ours.
      const headers = new Headers({
        authorization: `Bearer ${await tokens.accessToken()}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL,
        "mcp-method": String(message.method),
        ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
        ...(typeof params.taskId === "string" ? { "mcp-name": params.taskId } : {}),
      });
      for (const [key, value] of Object.entries(options?.context?.headers ?? {})) {
        headers.set(key, value);
      }
      const res = await fetchImpl(`${baseUrl}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        signal: options?.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
          : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      let json: Json;
      try {
        json = parseBody(text, res.headers.get("content-type") ?? "");
      } catch {
        throw new Error(
          `POST /mcp ${String(message.method)} returned HTTP ${res.status}, not JSON-RPC`,
        );
      }
      return json.error
        ? { kind: "error", error: json.error as never }
        : { kind: "result", result: json.result as never };
    },
    onServerRequest: idle,
    onNotification: idle,
    onInvalidated: idle,
    invalidated: false,
  };
}

/** Open a Tasks-aware session on `<baseUrl>/mcp` with the caller's bearer token. */
export function connectTasks(
  baseUrl: string,
  tokens: TokenProvider,
  fetchImpl: typeof fetch = globalThis.fetch,
): TasksSession {
  const session = withTasks(httpPort(baseUrl, tokens, fetchImpl));
  return {
    async callTool(name, args) {
      const execution = await session.callTool(
        name,
        args as Parameters<typeof session.callTool>[1],
      );
      return {
        kind: execution.kind,
        ...(execution.kind === "task" ? { taskId: String(execution.handle.taskId) } : {}),
        async settle({ timeoutMs, signal }) {
          const stop = signal
            ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
            : AbortSignal.timeout(timeoutMs);
          const { outcome } = await execution.settle({ signal: stop });
          if (outcome.status === "completed") {
            return { status: "completed", ...readResult(resultFromTaskOutcome(outcome)) };
          }
          if (outcome.status === "failed") {
            return {
              status: "failed",
              text: "",
              structured: undefined,
              error: outcome.error.message,
            };
          }
          return { status: "cancelled", text: "", structured: undefined };
        },
      };
    },
    close: () => session.close(),
  };
}
