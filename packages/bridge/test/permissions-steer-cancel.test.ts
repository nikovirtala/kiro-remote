/**
 * Permission + follow-up-turn behavior under the chat-only cloud path
 * (FEAT-002).
 *
 * The interactive ACP permission flow (session/request_permission ->
 * answerPermission) does NOT apply to `kiro-cli chat --cloud`: `--no-interactive`
 * governs tool-permission behavior inside the subprocess (it auto-proceeds or
 * refuses rather than prompting). So the cloud path never parks a turn on an
 * ACP permission. These tests cover what remains valid:
 *  - the gateway's pending-permission hold/resolve/expire primitives (used by
 *    any future non-cloud ACP concern, e.g. an adopted session);
 *  - a follow-up turn on an idle cloud session routes to a NEW chat --cloud
 *    --resume-id subprocess (NOT the ACP gateway.prompt path).
 */

import type { Command, PermissionAnswer } from "@nikovirtala/kiro-remote-core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AcpGateway } from "../src/gateway.ts";
import { createLogger } from "../src/logger.ts";
import type { StdioJsonRpcTransport } from "../src/transport.ts";
import { cloudStdout, createHarness, type Harness, requireHarness, waitFor } from "./harness.ts";
import { initResult, SHELL_PERMISSION_PARAMS } from "./scenarios.ts";

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) {
    await harness.stop();
    harness = null;
  }
});

const CLOUD_ID = "08047063-f7b4-4ce5-b79a-2aea9a7a1d29";

/** A stub transport that captures handlers + outgoing requests. */
function stubTransport(): {
  transport: StdioJsonRpcTransport;
  requestHandlers: Map<string, (params: unknown) => unknown>;
} {
  const requestHandlers = new Map<string, (params: unknown) => unknown>();
  const t = {
    onNotification: () => {},
    onRequest: (method: string, handler: (params: unknown) => unknown) => {
      requestHandlers.set(method, handler);
    },
    request: async () => ({}),
  };
  return { transport: t as unknown as StdioJsonRpcTransport, requestHandlers };
}

function makeGateway(): {
  gw: AcpGateway;
  requestHandlers: Map<string, (params: unknown) => unknown>;
  permissionRequested: { sessionId: string; requestId: string }[];
} {
  const { transport, requestHandlers } = stubTransport();
  const permissionRequested: { sessionId: string; requestId: string }[] = [];
  const gw = new AcpGateway({
    transport,
    logger: createLogger({ sink: () => {}, level: "debug" }),
    hooks: {
      onSessionUpdate: () => {},
      onPermissionRequested: (sessionId, requestId) =>
        permissionRequested.push({ sessionId, requestId }),
      onAgentNotification: () => {},
    },
  });
  gw.registerHandlers();
  return { gw, requestHandlers, permissionRequested };
}

describe("gateway permission primitives", () => {
  test("a held-open request is resolved by optionId with canonical consent", async () => {
    const { gw, requestHandlers, permissionRequested } = makeGateway();
    const handler = requestHandlers.get("session/request_permission");
    expect(handler).toBeDefined();

    // The agent asks for permission; the gateway holds the reply open.
    const replyPromise = handler?.(SHELL_PERMISSION_PARAMS) as Promise<{
      outcome: unknown;
      _meta?: unknown;
    }>;
    expect(permissionRequested).toEqual([{ sessionId: "", requestId: "perm-1" }]);
    expect(gw.pendingPermissions.has("perm-1")).toBe(true);

    const answer: PermissionAnswer = {
      optionId: "always-accept",
      consent: { scope: "workspace", resource: "npm run *", workspaceRoot: "/workspace/project" },
    };
    expect(gw.resolvePermission("perm-1", answer)).toBe(true);

    const reply = await replyPromise;
    expect(reply.outcome).toEqual({ outcome: "selected", optionId: "always-accept" });
    expect(reply._meta).toEqual({ kiro: { consent: answer.consent } });
    expect(gw.pendingPermissions.has("perm-1")).toBe(false);
  });

  test("a pending permission can be expired, leaving it to Kiro", () => {
    const { gw, requestHandlers } = makeGateway();
    const handler = requestHandlers.get("session/request_permission");
    void (handler?.(SHELL_PERMISSION_PARAMS) as Promise<unknown>);
    expect(gw.pendingPermissions.has("perm-1")).toBe(true);
    expect(gw.expirePermission("perm-1")).toBe(true);
    expect(gw.pendingPermissions.has("perm-1")).toBe(false);
  });

  test("answerPermission for an unknown requestId soft-fails (no throw/hang)", async () => {
    const { gw } = makeGateway();
    const resolved = await gw.answerPermission("s", "nope", { optionId: "accept" });
    expect(resolved).toBe(false);
  });
});

describe("follow-up turn routing (chat-only cloud)", () => {
  test("a prompt on an idle cloud session resumes via chat --cloud --resume-id", async () => {
    const runner = vi.fn(async () => ({
      code: 0,
      stdout: cloudStdout({ cloudSessionId: CLOUD_ID, assistant: "ok" }),
      stderr: "",
    }));
    harness = await createHarness(
      { initialize: initResult(), onPrompt: { response: { stopReason: "end_turn" } } },
      runner,
    );
    await harness.server.start();
    await harness.seedSession("st");

    await harness.server.intake.dispatch({
      kind: "launch",
      sub: "user-sub-1",
      sessionId: "st",
      commandId: "cmd-launch",
      prompt: "first",
      repos: ["octo/repo"],
    } as Command);
    await waitFor(
      async () => (await requireHarness(harness).repo.getSession("st"))?.status === "idle",
    );

    await harness.server.intake.dispatch({
      kind: "prompt",
      sub: "user-sub-1",
      sessionId: "st",
      commandId: "cmd-turn-2",
      turnId: "t-2",
      prompt: "second",
      whenBusy: "steer",
    } as Command);
    await harness.server.manager.awaitTurnSettled("st");

    expect(runner).toHaveBeenCalledTimes(2);
    const spec = runner.mock.calls[1][0] as { args: string[] };
    expect(spec.args).toContain("--resume-id");
    expect(spec.args).toContain(CLOUD_ID);
    expect((await harness.repo.getSession("st"))?.status).toBe("idle");
  });
});
