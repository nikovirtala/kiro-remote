/**
 * Unit tests for AcpGateway's session/new (+ session/load) cloud-target shaping
 * (FEAT-002).
 *
 * The control plane must request a REAL cloud Space on session/new rather than
 * letting the agent default source='local' (which runs inside the bridge
 * container and never shows up in app.kiro.dev). The agent STRICTLY validates
 * `_meta.kiro` and rejects unknown keys there (it failed session/new with
 * "Invalid params: invalid _meta.kiro.executionTarget"), so the gateway sends
 * the selected executionTarget/sessionSource as TOP-LEVEL params ONLY and NEVER
 * under `_meta.kiro`. The accepted `_meta.kiro` keys stay (repos/modeId/...).
 * The redacted acp_rpc_request log in transport.ts confirms whether the
 * top-level field is accepted on live redeploy.
 *
 * We drive the gateway with a STUB transport (same capturing approach as
 * gateway-prompt-shape.test.ts) and assert the exact session/new params shape.
 */

import type { SessionInputs } from "@nikovirtala/kiro-remote-core";
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
      if (method === "session/new") {
        return { sessionId: "sess_cloud-1" };
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

function kiroMeta(params: Record<string, unknown>): Record<string, unknown> {
  const meta = params._meta as { kiro?: Record<string, unknown> } | undefined;
  return meta?.kiro ?? {};
}

const BASE: SessionInputs = {
  cwd: "/workspace/project",
  additionalDirectories: ["/workspace/shared"],
  mcpServers: [{ name: "example", command: "x" }],
};

describe("AcpGateway.sessionParams cloud target (FEAT-002)", () => {
  test("includes executionTarget/sessionSource ONLY top-level, NOT under _meta.kiro, on session/new", async () => {
    const calls: Captured[] = [];
    const gw = makeGateway(calls);
    await gw.newSession({
      ...BASE,
      repos: ["octo/repo"],
      executionTarget: "cloud-sandbox",
      sessionSource: "remote",
    });

    const params = paramsOf(calls, "session/new");
    // Top-level placement.
    expect(params.executionTarget).toBe("cloud-sandbox");
    expect(params.sessionSource).toBe("remote");
    // NOT under _meta.kiro (strict schema rejects unknown keys there).
    const kiro = kiroMeta(params);
    expect("executionTarget" in kiro).toBe(false);
    expect("sessionSource" in kiro).toBe(false);
    // repos still rides under _meta.kiro (accepted key).
    expect(kiro.repos).toEqual(["octo/repo"]);
    // Existing fields preserved.
    expect(params.cwd).toBe("/workspace/project");
    expect(params.additionalDirectories).toEqual(["/workspace/shared"]);
    expect(params.mcpServers).toEqual([{ name: "example", command: "x" }]);
  });

  test("repos (and modeId) still ride under _meta.kiro while target/source stay top-level", async () => {
    const calls: Captured[] = [];
    const gw = makeGateway(calls);
    await gw.newSession({
      ...BASE,
      modeId: "vibe",
      repos: ["octo/a", "octo/b"],
      executionTarget: "cloud-sandbox",
      sessionSource: "remote",
    });
    const params = paramsOf(calls, "session/new");
    const kiro = kiroMeta(params);
    expect(kiro.repos).toEqual(["octo/a", "octo/b"]);
    expect(kiro.modeId).toBe("vibe");
    // target/source are NOT under _meta.kiro.
    expect("executionTarget" in kiro).toBe(false);
    expect("sessionSource" in kiro).toBe(false);
    // ...they are top-level.
    expect(params.executionTarget).toBe("cloud-sandbox");
    expect(params.sessionSource).toBe("remote");
  });

  test("omits target/source keys entirely when they are unset (no regression)", async () => {
    const calls: Captured[] = [];
    const gw = makeGateway(calls);
    await gw.newSession({ ...BASE, repos: ["octo/repo"] });

    const params = paramsOf(calls, "session/new");
    expect("executionTarget" in params).toBe(false);
    expect("sessionSource" in params).toBe(false);
    const kiro = kiroMeta(params);
    expect("executionTarget" in kiro).toBe(false);
    expect("sessionSource" in kiro).toBe(false);
    // repos is still present (today's shape is unchanged when no target/source).
    expect(kiro.repos).toEqual(["octo/repo"]);
  });

  test("omits _meta entirely when no _meta.kiro fields are present", async () => {
    const calls: Captured[] = [];
    const gw = makeGateway(calls);
    await gw.newSession({ ...BASE });

    const params = paramsOf(calls, "session/new");
    expect("_meta" in params).toBe(false);
    expect("executionTarget" in params).toBe(false);
    expect("sessionSource" in params).toBe(false);
  });

  test("session/load carries the target/source top-level ONLY (not under _meta.kiro) when present", async () => {
    const calls: Captured[] = [];
    const gw = makeGateway(calls);
    await gw.loadSession("sess_x", {
      ...BASE,
      executionTarget: "cloud-sandbox",
      sessionSource: "remote",
    });

    const params = paramsOf(calls, "session/load");
    expect(params.sessionId).toBe("sess_x");
    expect(params.executionTarget).toBe("cloud-sandbox");
    expect(params.sessionSource).toBe("remote");
    // NOT under _meta.kiro -- in fact session/load sends no _meta.kiro at all.
    expect("_meta" in params).toBe(false);
  });

  test("session/load omits target/source when unset", async () => {
    const calls: Captured[] = [];
    const gw = makeGateway(calls);
    await gw.loadSession("sess_y", { ...BASE });

    const params = paramsOf(calls, "session/load");
    expect("executionTarget" in params).toBe(false);
    expect("sessionSource" in params).toBe(false);
    expect("_meta" in params).toBe(false);
  });
});
