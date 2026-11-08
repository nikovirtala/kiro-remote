/**
 * Unit tests for AcpGateway's prompt/steer content-block shaping (Bug B).
 *
 * The live ACP V3 agent rejected session/prompt with "Invalid params" because
 * the bridge sent `prompt` as a single {type:'text',text} object. ACP V3 wants
 * `prompt` to be an ARRAY of content blocks. AcpGateway.prompt and
 * AcpGateway.steer must therefore wrap a single content-block object into a
 * one-element array and pass an already-array through unchanged.
 *
 * We drive the gateway with a STUB transport (same approach as the Bug A
 * session-id test) that CAPTURES the outgoing request method + params so we can
 * assert the exact shape sent over the wire.
 */

import { describe, expect, test } from "vitest";
import { AcpGateway } from "../src/gateway.ts";
import { createLogger } from "../src/logger.ts";
import type { StdioJsonRpcTransport } from "../src/transport.ts";

interface Captured {
  method: string;
  params: unknown;
}

/** A transport that records every outgoing request and returns a canned result. */
function capturingTransport(calls: Captured[]): StdioJsonRpcTransport {
  const t = {
    onNotification: () => {},
    onRequest: () => {},
    request: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      if (method === "session/prompt") {
        return { stopReason: "end_turn" };
      }
      return {};
    },
  };
  return t as unknown as StdioJsonRpcTransport;
}

function makeGateway(calls: Captured[]): AcpGateway {
  return new AcpGateway({
    transport: capturingTransport(calls),
    logger: createLogger({ sink: () => {}, level: "debug" }),
    hooks: {
      onSessionUpdate: () => {},
      onPermissionRequested: () => {},
      onAgentNotification: () => {},
    },
  });
}

function paramsOf(calls: Captured[], method: string): Record<string, unknown> {
  const call = calls.find((c) => c.method === method);
  if (!call) {
    throw new Error(`no ${method} call captured`);
  }
  return call.params as Record<string, unknown>;
}

describe("AcpGateway.prompt content-block shaping (Bug B)", () => {
  test("wraps a single content-block object into a one-element array", async () => {
    const calls: Captured[] = [];
    const gw = makeGateway(calls);
    await gw.prompt("sess_1", { type: "text", text: "hello" });

    const params = paramsOf(calls, "session/prompt");
    expect(params.sessionId).toBe("sess_1");
    expect(Array.isArray(params.prompt)).toBe(true);
    expect(params.prompt).toEqual([{ type: "text", text: "hello" }]);
  });

  test("passes an already-array prompt through unchanged", async () => {
    const calls: Captured[] = [];
    const gw = makeGateway(calls);
    const blocks = [
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ];
    await gw.prompt("sess_2", blocks);

    const params = paramsOf(calls, "session/prompt");
    expect(Array.isArray(params.prompt)).toBe(true);
    expect(params.prompt).toEqual(blocks);
  });

  test("returns the stopReason from the session/prompt response", async () => {
    const calls: Captured[] = [];
    const gw = makeGateway(calls);
    const res = await gw.prompt("sess_3", { type: "text", text: "x" });
    expect(res.stopReason).toBe("end_turn");
  });
});

describe("AcpGateway.steer content-block shaping (Bug B)", () => {
  test("sends _session/steer with prompt as a one-element array", async () => {
    const calls: Captured[] = [];
    const gw = makeGateway(calls);
    await gw.steer("sess_4", { type: "text", text: "steer me" });

    const params = paramsOf(calls, "_session/steer");
    expect(params.sessionId).toBe("sess_4");
    expect(Array.isArray(params.prompt)).toBe(true);
    expect(params.prompt).toEqual([{ type: "text", text: "steer me" }]);
  });

  test("passes an already-array steer prompt through unchanged", async () => {
    const calls: Captured[] = [];
    const gw = makeGateway(calls);
    const blocks = [{ type: "text", text: "one" }];
    await gw.steer("sess_5", blocks);

    const params = paramsOf(calls, "_session/steer");
    expect(params.prompt).toEqual(blocks);
  });
});
