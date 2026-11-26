/**
 * The MCP extensions every server of this package carries, in the one place
 * they are listed. The server factory (server.ts) attaches them to each server it
 * builds, for stdio and for /mcp alike, so a new extension (Events, Apps) is one
 * more entry here and nothing in either transport.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { loadSkillCatalog } from "./skills.ts";

/** What the factory needs of an extension: attach it to a server before it connects. */
export interface McpExtension {
  attach(mcp: McpServer): void;
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
