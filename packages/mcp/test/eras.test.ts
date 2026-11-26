/**
 * The /mcp seam serves both protocol eras from one server factory: a
 * 2025-06-18 client (the v1 SDK client, as the e2e harness and the Inspector's
 * `--protocol-era legacy` use) and a 2026-07-28 request with the `_meta`
 * envelope. The contract is the same in both: the same 19 tools, the same
 * `insufficient_scope` JSON-RPC error for a missing scope, `isError: true` for
 * a tool that fails.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { describe, expect, it, vi } from "vitest";
import { createHttpTransportHandler } from "../src/http-transport.ts";
import { createMcpServerFactory } from "../src/server.ts";
import {
  buildInProcess,
  MODERN_META,
  modernCall,
  principal,
  type RpcAnswer,
  seamFetch,
} from "./helpers.ts";

const expected = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "fixtures", "tools-list.json"),
    "utf8",
  ),
);

async function legacyClient(scopes?: string[]) {
  const h = buildInProcess({ ids: ["sess-1", "cmd-1"] });
  const handler = createHttpTransportHandler({ client: h.client });
  const who = principal(scopes ? { scopes } : {});
  const client = new Client({ name: "legacy-client", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("https://seam.test/mcp"), {
      fetch: seamFetch(handler, who),
    }),
  );
  return { client, handler, who, h };
}

describe("2025-06-18 client (v1 SDK) over the seam", () => {
  it("negotiates 2025-06-18, lists the 19 tools unchanged and calls one", async () => {
    const { client } = await legacyClient();
    expect(client.getServerVersion()?.name).toBe("kiro-remote");
    expect(JSON.parse(JSON.stringify(await client.listTools()))).toEqual(expected);

    const out = await client.callTool({
      name: "kiro_launch_session",
      arguments: { prompt: "x", repos: ["acme/app"] },
    });
    expect(out.structuredContent).toMatchObject({ sessionId: "sess-1" });
    await client.close();
  });

  it("a missing scope is a JSON-RPC insufficient_scope error", async () => {
    const { client } = await legacyClient(["sessions:read"]);
    await expect(
      client.callTool({ name: "kiro_delete_session", arguments: { sessionId: "x" } }),
    ).rejects.toMatchObject({
      code: -32600,
      message: expect.stringContaining("insufficient_scope"),
      data: { error: "insufficient_scope", scope: "sessions:delete" },
    });
    await client.close();
  });

  it("a failing tool is an isError result", async () => {
    const { client } = await legacyClient();
    const out = await client.callTool({
      name: "kiro_get_session",
      arguments: { sessionId: "nope" },
    });
    expect(out.isError).toBe(true);
    await client.close();
  });
});

describe("2026-07-28 request over the seam", () => {
  it("server/discover names the era and the tools capability", async () => {
    const { handler } = await legacyClient();
    const { status, json } = await modernCall(handler, principal(), "server/discover");
    expect(status).toBe(200);
    expect(json.result.supportedVersions).toContain("2026-07-28");
    expect(json.result.capabilities.tools).toBeDefined();
    expect(json.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("kiro-remote");
  });

  it("tools/list is the same 19 tools as the 2025 era", async () => {
    const { handler } = await legacyClient();
    const { json } = await modernCall(handler, principal(), "tools/list");
    expect(json.result.tools).toEqual(expected.tools);
  });

  it("tools/call runs a tool", async () => {
    const { handler } = await legacyClient();
    const { json } = await modernCall(handler, principal(), "tools/call", {
      name: "kiro_launch_session",
      arguments: { prompt: "x", repos: ["acme/app"] },
    });
    expect(json.result.structuredContent).toMatchObject({ sessionId: "sess-1" });
  });

  it("a missing scope is the same insufficient_scope JSON-RPC error", async () => {
    const { handler } = await legacyClient();
    const { json } = await modernCall(
      handler,
      principal({ scopes: ["sessions:read"] }),
      "tools/call",
      { name: "kiro_delete_session", arguments: { sessionId: "x" } },
    );
    expect(json.result).toBeUndefined();
    expect(json.error).toMatchObject({
      code: -32600,
      message: expect.stringContaining("insufficient_scope"),
      data: { error: "insufficient_scope", scope: "sessions:delete" },
    });
  });

  it("a failing tool is an isError result", async () => {
    const { handler } = await legacyClient();
    const { json } = await modernCall(handler, principal(), "tools/call", {
      name: "kiro_get_session",
      arguments: { sessionId: "nope" },
    });
    expect(json.result.isError).toBe(true);
  });

  it("subscriptions/listen is refused: the seam cannot hold a stream", async () => {
    const { handler } = await legacyClient();
    const { json } = await modernCall(handler, principal(), "subscriptions/listen", {
      notifications: { toolsListChanged: true },
    });
    expect(json.error.code).toBe(-32601);
  });
});

describe("stdio serves both eras from the same factory", () => {
  /** Drive serveStdio over an in-memory pair with raw JSON-RPC messages. */
  async function stdioPeer(scopes?: string[]) {
    const h = buildInProcess({ ids: ["sess-1", "cmd-1"] });
    const [server, peer] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(
      createMcpServerFactory({
        client: h.client,
        principal: () => principal(scopes ? { scopes } : {}),
      }),
      { transport: server },
    );
    const inbox: RpcAnswer[] = [];
    peer.onmessage = (m) => {
      inbox.push(m as RpcAnswer);
    };
    await peer.start();
    const ask = async (msg: Record<string, unknown>) => {
      const before = inbox.length;
      await peer.send({ jsonrpc: "2.0", ...msg } as never);
      await vi.waitFor(() => expect(inbox.length).toBeGreaterThan(before));
      return inbox[inbox.length - 1] as RpcAnswer;
    };
    return { ask, close: () => handle.close() };
  }

  it("a 2025 opening (initialize) is served: tools/list unchanged, insufficient_scope kept", async () => {
    const { ask, close } = await stdioPeer(["sessions:read"]);
    const init = await ask({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    expect(init.result.protocolVersion).toBe("2025-06-18");
    const list = await ask({ id: 2, method: "tools/list" });
    expect(list.result.tools).toEqual(expected.tools);
    const denied = await ask({
      id: 3,
      method: "tools/call",
      params: { name: "kiro_delete_session", arguments: { sessionId: "x" } },
    });
    expect(denied.error).toMatchObject({
      code: -32600,
      data: { error: "insufficient_scope", scope: "sessions:delete" },
    });
    await close();
  });

  it("a 2026 opening (envelope, no initialize) is served the same tools", async () => {
    const { ask, close } = await stdioPeer();
    const list = await ask({ id: 1, method: "tools/list", params: { _meta: MODERN_META } });
    expect(list.result.tools).toEqual(expected.tools);
    await close();
  });
});
