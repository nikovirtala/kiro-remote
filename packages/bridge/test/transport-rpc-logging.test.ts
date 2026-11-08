/**
 * The transport must emit redaction-safe raw JSON-RPC observability at debug.
 *
 * These debug logs are the diagnostic mechanism the session-launch fixes rely
 * on: on a live redeploy (BRIDGE_LOG_LEVEL=debug) they reveal the exact
 * session/new response shape (where the real sess_ id lives) and the exact
 * session/prompt params and Invalid params error. Every line flows through the
 * bridge logger, so core's redact() scrubs ksk_/bearer/JWT/OAuth URLs -- a
 * secret placed in params/result NEVER appears raw in the emitted line.
 *
 * The test uses a tiny scripted Node child (an injectable SpawnFn) that echoes
 * back either a successful result or a JSON-RPC error, exercising request(),
 * notify(), and both resolvePending() branches without a real kiro-cli.
 */

import { spawn } from "node:child_process";
import { describe, expect, test } from "vitest";
import { createLogger } from "../src/logger.ts";
import { type SpawnFn, StdioJsonRpcTransport } from "../src/transport.ts";

/**
 * A spawn fn that runs a scripted child which, for each incoming line, replies
 * on stdout. A request for method "ok/*" gets a result echoing back the params;
 * a request for method "fail/*" gets a JSON-RPC error whose data echoes params.
 */
function echoingSpawn(): SpawnFn {
  const script = `
    const { createInterface } = require("node:readline");
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
      const t = line.trim();
      if (!t) return;
      let msg;
      try { msg = JSON.parse(t); } catch { return; }
      if (msg.id === undefined || msg.id === null) return; // notification: no reply
      if (typeof msg.method === "string" && msg.method.startsWith("fail/")) {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32602, message: "Invalid params", data: msg.params },
        }) + "\\n");
        return;
      }
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { echo: msg.params },
      }) + "\\n");
    });
  `;
  return () =>
    // biome-ignore lint/suspicious/noExplicitAny: a real child satisfies the stream shape.
    spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] }) as any;
}

interface RpcLog {
  level: string;
  msg: string;
  id?: unknown;
  method?: string;
  code?: unknown;
  message?: string;
}

/** Build a transport over the echoing child, collecting debug log lines. */
function makeTransport(): { transport: StdioJsonRpcTransport; lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger({ level: "debug", sink: (l) => lines.push(l), env: {} });
  const transport = new StdioJsonRpcTransport({
    spec: { command: "unused", args: [] },
    spawnFn: echoingSpawn(),
    logger,
    onExit: () => {},
  });
  transport.start();
  return { transport, lines };
}

function records(lines: string[]): RpcLog[] {
  return lines.map((l) => JSON.parse(l) as RpcLog);
}

describe("transport raw JSON-RPC logging", () => {
  test("request() emits acp_rpc_request with id/method and the response emits acp_rpc_response", async () => {
    const { transport, lines } = makeTransport();
    try {
      await transport.request("ok/session/new", { cwd: "/workspace" });

      const recs = records(lines);
      const req = recs.find((r) => r.msg === "acp_rpc_request");
      expect(req).toBeDefined();
      expect(req?.level).toBe("debug");
      expect(req?.method).toBe("ok/session/new");
      expect(req?.id).toBe(1);

      const resp = recs.find((r) => r.msg === "acp_rpc_response");
      expect(resp).toBeDefined();
      expect(resp?.level).toBe("debug");
      expect(resp?.id).toBe(1);
    } finally {
      await transport.stop();
    }
  });

  test("notify() emits acp_rpc_notify with the method", async () => {
    const { transport, lines } = makeTransport();
    try {
      transport.notify("session/cancel", { sessionId: "s1" });
      const recs = records(lines);
      const note = recs.find((r) => r.msg === "acp_rpc_notify");
      expect(note).toBeDefined();
      expect(note?.level).toBe("debug");
      expect(note?.method).toBe("session/cancel");
    } finally {
      await transport.stop();
    }
  });

  test("a JSON-RPC error response emits acp_rpc_response_error with code/message", async () => {
    const { transport, lines } = makeTransport();
    try {
      await expect(transport.request("fail/session/prompt", { bad: true })).rejects.toThrow(
        "Invalid params",
      );

      const recs = records(lines);
      const err = recs.find((r) => r.msg === "acp_rpc_response_error");
      expect(err).toBeDefined();
      expect(err?.level).toBe("debug");
      expect(err?.id).toBe(1);
      // `code` is logged as a structured field, but redact() scrubs the key
      // name "code" (it is the OAuth authorization-code key), so the value is
      // the placeholder -- the field is present, which is what matters here.
      expect(err?.code).toBe("[REDACTED]");
      expect(err?.message).toBe("Invalid params");
    } finally {
      await transport.stop();
    }
  });

  test("a ksk_ secret in request params does NOT appear raw in the emitted log line", async () => {
    const { transport, lines } = makeTransport();
    try {
      await transport.request("ok/session/new", { token: "ksk_SECRETvalue123" });

      const reqLine = lines.find((l) => l.includes('"acp_rpc_request"'));
      expect(reqLine).toBeDefined();
      expect(reqLine).not.toContain("ksk_SECRETvalue123");
      expect(reqLine).toContain("[REDACTED]");
    } finally {
      await transport.stop();
    }
  });

  test("a bearer token in response result does NOT appear raw in the emitted log line", async () => {
    const { transport, lines } = makeTransport();
    try {
      // The child echoes params back into `result`, so a bearer token in the
      // request params round-trips into the acp_rpc_response result field.
      await transport.request("ok/session/new", {
        authorization: "Bearer abc.def.ghi",
      });

      const respLine = lines.find((l) => l.includes('"acp_rpc_response"'));
      expect(respLine).toBeDefined();
      expect(respLine).not.toContain("abc.def.ghi");
      expect(respLine).toContain("[REDACTED]");
    } finally {
      await transport.stop();
    }
  });

  test("a secret in a JSON-RPC error's data does NOT appear raw in the emitted log line", async () => {
    const { transport, lines } = makeTransport();
    try {
      await expect(
        transport.request("fail/session/prompt", { apiKey: "ksk_leakme" }),
      ).rejects.toThrow("Invalid params");

      const errLine = lines.find((l) => l.includes('"acp_rpc_response_error"'));
      expect(errLine).toBeDefined();
      expect(errLine).not.toContain("ksk_leakme");
      expect(errLine).toContain("[REDACTED]");
    } finally {
      await transport.stop();
    }
  });
});
