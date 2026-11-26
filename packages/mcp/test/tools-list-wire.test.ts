/**
 * Pins the `tools/list` wire output of both transports to a fixture, so the
 * set of tools, their input schemas and their annotations cannot change by
 * accident (for example during an SDK migration). The fixture is the output of
 * `listTools()` before the move to the v2 SDK; regenerate it only when a tool
 * is added or changed on purpose (`UPDATE_TOOLS_LIST_FIXTURE=1 pnpm test`).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createHttpTransportHandler } from "../src/http-transport.ts";
import { buildMcpServer, listTools } from "../src/server.ts";
import { buildInProcess, principal } from "./helpers.ts";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tools-list.json");

if (process.env.UPDATE_TOOLS_LIST_FIXTURE === "1") {
  writeFileSync(FIXTURE, `${JSON.stringify(listTools(), null, 2)}\n`); // then: pnpm exec biome format --write test/fixtures
}

const expected = JSON.parse(readFileSync(FIXTURE, "utf8"));

describe("tools/list is unchanged", () => {
  it("the HTTP handler answers the fixture", async () => {
    const { client } = buildInProcess();
    const handler = createHttpTransportHandler({ client });
    const res = await handler.handle({
      principal: principal(),
      method: "POST",
      headers: {},
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(JSON.parse(res.body).result).toEqual(expected);
  });

  it("the stdio server answers the fixture", async () => {
    const { client } = buildInProcess();
    const server = buildMcpServer(client, () => principal());
    const [a, b] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: "t", version: "0" });
    await server.connect(a);
    await mcpClient.connect(b);
    const listed = await mcpClient.listTools();
    expect(JSON.parse(JSON.stringify(listed))).toEqual(expected);
    await mcpClient.close();
  });

  it("the fixture names the 19 tools", () => {
    expect(expected.tools).toHaveLength(19);
  });
});
