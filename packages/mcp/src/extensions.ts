/**
 * The MCP extensions every server of this package carries, in the one place
 * they are listed. The server factory (server.ts) attaches them to each server it
 * builds, for stdio and for /mcp alike, so a new extension (Events, Apps) is one
 * more entry here and nothing in either transport.
 */

import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { CallToolOutcome } from "./server.ts";
import { loadSkillCatalog } from "./skills.ts";

/** What the factory needs of an extension: attach it to a server before it connects. */
export interface McpExtension {
  attach(mcp: McpServer): void;
  /**
   * Called with every `tools/call` result before it is sent. Returns the result
   * to send in its place, or `undefined` to leave it. This stands in for the
   * SDK's `tools/call` middleware (`ctx.use`), which 2.4.0 does not have, and is
   * how the Tasks extension answers with a task handle.
   */
  afterToolCall?(
    call: { name: string; args: Record<string, unknown> },
    outcome: CallToolOutcome,
    ctx: ServerContext,
  ): Promise<Record<string, unknown> | undefined>;
}

let loaded: Promise<readonly McpExtension[]> | undefined;

/**
 * The extensions, loaded once per process. A failed load is not kept, so the
 * next request tries again.
 */
export function loadExtensions(): Promise<readonly McpExtension[]> {
  loaded ??= Promise.all([loadSkillCatalog()]).catch((err: unknown) => {
    loaded = undefined;
    throw err;
  });
  return loaded;
}
