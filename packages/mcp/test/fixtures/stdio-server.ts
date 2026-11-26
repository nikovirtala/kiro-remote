/**
 * A stdio MCP server for the Inspector test: the shared server factory over
 * serveStdio, with the in-memory fakes behind its tools and a caller that holds
 * every scope. Run it with `node test/fixtures/stdio-server.ts`.
 */

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMcpServerFactory } from "../../src/server.ts";
import { buildInProcess, principal } from "../helpers.ts";

serveStdio(
  createMcpServerFactory({
    client: buildInProcess().client,
    principal: () => principal(),
  }),
);
