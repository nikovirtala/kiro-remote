import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHttpTransportHandler, type ToolClient } from "@nikovirtala/kiro-remote-mcp";
import { afterEach, describe, expect, it } from "vitest";
import { connectTasks } from "./tasks-client.ts";

const TOKEN = "eyJhbGciOiJub25lIn0.e30.sig";
const SESSION = "ses-1";
const TURN = "turn-1";

/** A tool client whose turn is queued, then running, then completed with some text. */
function scriptedClient(): Partial<ToolClient> {
  let reads = 0;
  const turn = (status: string) => ({
    id: TURN,
    sessionId: SESSION,
    status,
    stopReason: null,
    startedAt: null,
    endedAt: null,
  });
  return {
    async createTurn() {
      return turn("queued");
    },
    async getTurn() {
      reads++;
      return turn(reads === 1 ? "queued" : reads === 2 ? "running" : "completed");
    },
    async getEvents() {
      return {
        events: [
          {
            seq: 1,
            sessionId: SESSION,
            turnId: TURN,
            type: "message.chunk",
            rawType: "agent_message_chunk",
            replay: false,
            ts: "2026-11-26T12:00:00.000Z",
            payload: { content: { type: "text", text: "All done." } },
          },
        ],
        nextCursor: 1,
        turnStatus: "idle",
      };
    },
  };
}

async function serve(client: Partial<ToolClient>) {
  const handler = createHttpTransportHandler({
    client: client as ToolClient,
    tasks: { defaultPollIntervalMs: 10 },
  });
  const seen: Array<{ method: string; name: string | undefined; auth: string | undefined }> = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") {
        headers[k] = v;
      }
    }
    seen.push({
      method: String(headers["mcp-method"]),
      name: headers["mcp-name"],
      auth: headers.authorization,
    });
    const out = await handler.handle({
      principal: { sub: "u", clientId: "c", scopes: ["sessions:read", "sessions:write"] },
      method: req.method ?? "POST",
      headers,
      body,
    });
    res.writeHead(out.status, out.headers);
    res.end(out.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, seen, baseUrl: `http://127.0.0.1:${port}` };
}

let running: Server | undefined;
afterEach(async () => {
  await new Promise((resolve) => running?.close(resolve));
  running = undefined;
});

describe("connectTasks", () => {
  it("gets a task for kiro_send_prompt, polls it to completed and reads the turn's text", async () => {
    const s = await serve(scriptedClient());
    running = s.server;
    const tasks = connectTasks(s.baseUrl, { accessToken: async () => TOKEN });
    const call = await tasks.callTool("kiro_send_prompt", {
      sessionId: SESSION,
      prompt: "go",
      whenBusy: "queue",
    });
    expect(call.kind).toBe("task");
    expect(call.taskId).toEqual(expect.any(String));
    const outcome = await call.settle({ timeoutMs: 10_000 });
    expect(outcome).toMatchObject({
      status: "completed",
      text: "All done.",
      structured: { sessionId: SESSION, turnId: TURN, status: "completed", text: "All done." },
    });
    await tasks.close();
    // The call, then tasks/get named by the task id, every one with the bearer.
    expect(s.seen.map((r) => r.method)).toContain("tasks/get");
    expect(s.seen.find((r) => r.method === "tasks/get")?.name).toBe(call.taskId);
    expect(s.seen.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("reports a failed task with its message", async () => {
    const client = scriptedClient();
    client.getTurn = async () => ({
      id: TURN,
      sessionId: SESSION,
      status: "failed",
      stopReason: "sandbox_crashed",
      startedAt: null,
      endedAt: null,
    });
    const s = await serve(client);
    running = s.server;
    const tasks = connectTasks(s.baseUrl, { accessToken: async () => TOKEN });
    const call = await tasks.callTool("kiro_send_prompt", {
      sessionId: SESSION,
      prompt: "go",
      whenBusy: "queue",
    });
    const outcome = await call.settle({ timeoutMs: 10_000 });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("sandbox_crashed");
    await tasks.close();
  });
});
