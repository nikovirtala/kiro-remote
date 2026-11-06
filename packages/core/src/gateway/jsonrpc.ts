/**
 * JSON-RPC 2.0 helpers shared by the bridge transport.
 *
 * The migration guide requires that any agent-to-client request with an `id`
 * receives a response or an explicit JSON-RPC error, never a hang. When a
 * requested method is not one the client handles, respond with
 * {@link methodNotFound}.
 */

export const JSONRPC_VERSION = "2.0";

/** Standard JSON-RPC error codes we use. */
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export interface JsonRpcResult {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

/** Build a `method not found` error reply for an unknown agent-to-client request. */
export function methodNotFound(id: string | number | null, method: string): JsonRpcError {
  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: { code: JSONRPC_METHOD_NOT_FOUND, message: `method not found: ${method}` },
  };
}

/** Build a successful JSON-RPC result reply. */
export function result(id: string | number | null, value: unknown): JsonRpcResult {
  return { jsonrpc: JSONRPC_VERSION, id, result: value };
}

/** The set of agent-to-client request methods this client answers. */
export const HANDLED_CLIENT_METHODS: ReadonlySet<string> = new Set([
  "session/update",
  "session/request_permission",
  "_kiro/openExternalUrl",
  "_kiro/auth/getAccessToken",
]);

/**
 * Decide the reply for an incoming agent-to-client request. Known methods
 * return null (meaning: route to the real handler); unknown methods return a
 * ready-to-send JSON-RPC error so the request never hangs.
 */
export function replyForUnknownRequest(
  id: string | number | null,
  method: string,
): JsonRpcError | null {
  if (HANDLED_CLIENT_METHODS.has(method)) {
    return null;
  }
  return methodNotFound(id, method);
}
