/**
 * A thin MCP client over the official SDK (Streamable HTTP) for the tool flow.
 *
 * The bearer comes from the {@link TokenProvider} on every request (so a silent
 * refresh is picked up), is set on a copy of the request headers, and is never
 * logged.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { TokenProvider } from "@nikovirtala/kiro-remote-mcp";

/** The per-request timeout for tool calls (kiro_wait_for_events blocks up to 20 s). */
const CALL_TIMEOUT_MS = 120_000;

export interface ToolCallResult {
  isError: boolean;
  structured: Record<string, unknown> | undefined;
  /** The joined `type: "text"` content items. */
  text: string;
}

export interface McpSession {
  listToolNames(): Promise<string[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
  close(): Promise<void>;
}

/** Connect (initialize) to `<baseUrl>/mcp` with the caller's bearer token. */
export async function connectMcp(
  baseUrl: string,
  tokens: TokenProvider,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<McpSession> {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set("authorization", `Bearer ${await tokens.accessToken()}`);
      return fetchImpl(url, { ...init, headers });
    },
  });
  const client = new Client({ name: "kiro-remote-e2e", version: "0.0.0" });
  await client.connect(transport);
  return {
    async listToolNames() {
      const res = await client.listTools();
      return res.tools.map((t) => t.name);
    },
    async callTool(name, args) {
      const res = await client.callTool({ name, arguments: args }, undefined, {
        timeout: CALL_TIMEOUT_MS,
      });
      const content = Array.isArray(res.content) ? res.content : [];
      const text = content
        .filter((c): c is { type: "text"; text: string } => c?.type === "text")
        .map((c) => c.text)
        .join("\n");
      const structured =
        typeof res.structuredContent === "object" && res.structuredContent !== null
          ? (res.structuredContent as Record<string, unknown>)
          : undefined;
      return { isError: res.isError === true, structured, text };
    },
    async close() {
      await client.close();
    },
  };
}
