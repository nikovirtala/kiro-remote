/**
 * The MCP extensions every server of this package carries, in the one place
 * they are listed. The server factory (server.ts) attaches them to each server it
 * builds, for stdio and for /mcp alike, so a new extension (Events, Apps) is one
 * more entry here and nothing in either transport.
 */

import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { Principal } from "@nikovirtala/kiro-remote-core";
import type { ToolClient } from "./client.ts";
import type { Logger } from "./logger.ts";
import type { CallToolOutcome } from "./server.ts";
import { loadSkillCatalog } from "./skills.ts";
import { TasksExtension, type TasksExtensionOptions, TurnTaskStore } from "./tasks/index.ts";

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

/** What the extensions that act for one caller need: they are built per server, not once per process. */
export interface CallerExtensionDeps {
  client: ToolClient;
  principal: () => Principal;
  logger?: Logger;
  /** Replaces the Tasks defaults (tests poll in milliseconds, not seconds). */
  tasks?: TasksExtensionOptions;
}

/**
 * The extensions that read as the caller (the store behind Tasks reads the
 * caller's own turns), so each server gets its own. Listed here with the shared
 * ones so a new extension is one more entry in this file.
 */
export function callerExtensions(deps: CallerExtensionDeps): readonly McpExtension[] {
  return [
    new TasksExtension(
      new TurnTaskStore({
        client: deps.client,
        principal: deps.principal,
        ...(deps.tasks?.defaultPollIntervalMs !== undefined
          ? { pollIntervalMs: deps.tasks.defaultPollIntervalMs }
          : {}),
      }),
      { ...(deps.logger ? { logger: deps.logger } : {}), ...deps.tasks },
    ),
  ];
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
