/**
 * The stdio MCP transport for `kiro-remote mcp`.
 *
 * It serves the shared MCP server factory wired to the HTTP {@link ToolClient}
 * (which calls the REST API with the user's silently-refreshed token) over
 * stdio. The Principal passed to the
 * tools is derived LOCALLY from the stored access token for scope gating; the
 * REST API still enforces authorization authoritatively server-side.
 */

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { Principal } from "@nikovirtala/kiro-remote-core";
import type { ToolClient } from "./client.ts";
import type { Keychain } from "./keychain.ts";
import { createMcpServerFactory, type Logger, silentLogger } from "./server.ts";
import { decodeTokenForDisplay } from "./token-provider.ts";

export interface RunStdioDeps {
  client: ToolClient;
  keychain: Keychain;
  logger?: Logger;
}

/**
 * Build the local {@link Principal} for scope gating from the stored token's
 * (unverified) claims. Returns an empty-scope principal when no token is
 * stored; tool calls then fail with insufficient_scope as expected.
 */
export async function localPrincipal(keychain: Keychain): Promise<Principal> {
  const stored = await keychain.get();
  if (!stored) {
    return { sub: "", clientId: "", scopes: [] };
  }
  const who = decodeTokenForDisplay(stored.accessToken);
  const scopes =
    who.scopes.length > 0
      ? who.scopes
      : stored.scope
        ? stored.scope.split(/\s+/).filter(Boolean)
        : [];
  // Normalize scopes to their short form (strip any resource prefix) so
  // authorize() sees `sessions:read` etc., matching the API's authenticate().
  const normalized = scopes.map((s) => {
    const slash = s.lastIndexOf("/");
    return slash >= 0 ? s.slice(slash + 1) : s;
  });
  return { sub: who.sub ?? "", clientId: stored.clientId, scopes: normalized };
}

/** Serve the MCP server over stdio until the transport closes. */
export async function runStdio(deps: RunStdioDeps): Promise<void> {
  const logger = deps.logger ?? silentLogger;
  const principal = await localPrincipal(deps.keychain);
  serveStdio(
    createMcpServerFactory({
      client: deps.client,
      logger,
      principal: () => principal,
    }),
    { onerror: (err) => logger.error("stdio transport error", { message: err.message }) },
  );
}
