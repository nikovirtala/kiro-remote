import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createHttpTransportHandler,
  TOOL_NAMES,
  type ToolClient,
} from "@nikovirtala/kiro-remote-mcp";
import { afterEach, describe, expect, it } from "vitest";
import { connectMcp } from "./mcp-client.ts";

const TOKEN = "eyJhbGciOiJub25lIn0.e30.sig";

async function serve(client: Partial<ToolClient>) {
  const handler = createHttpTransportHandler({ client: client as ToolClient });
  const auth: string[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }
    auth.push(req.headers.authorization ?? "");
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="x"' });
      res.end();
      return;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") {
        headers[k] = v;
      }
    }
    const out = await handler.handle({
      principal: { sub: "u", clientId: "c", scopes: ["sessions:read"] },
      method: req.method ?? "GET",
      headers,
      body,
    });
    res.writeHead(out.status, out.headers);
    res.end(out.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, auth, baseUrl: `http://127.0.0.1:${port}` };
}

let running: Server | undefined;
afterEach(async () => {
  await new Promise((resolve) => running?.close(resolve));
  running = undefined;
});

describe("connectMcp", () => {
  it("lists tools and calls one with the bearer on every request", async () => {
    const s = await serve({
      async listModels() {
        return { models: ["m1"], source: null };
      },
    });
    running = s.server;
    const mcp = await connectMcp(s.baseUrl, { accessToken: async () => TOKEN });
    const names = await mcp.listToolNames();
    expect(names).toEqual([...TOOL_NAMES]);
    expect(names).toHaveLength(14);
    const res = await mcp.callTool("kiro_list_models", {});
    expect(res.isError).toBe(false);
    expect(res.structured?.models).toEqual(["m1"]);
    await mcp.close();
    expect(s.auth.length).toBeGreaterThan(2);
    expect(s.auth.every((a) => a === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("reports a failing tool as isError with its text", async () => {
    const s = await serve({
      async listModels() {
        throw new Error("models unavailable");
      },
    });
    running = s.server;
    const mcp = await connectMcp(s.baseUrl, { accessToken: async () => TOKEN });
    const res = await mcp.callTool("kiro_list_models", {});
    expect(res.isError).toBe(true);
    expect(res.text).toContain("models unavailable");
    await mcp.close();
  });
});
