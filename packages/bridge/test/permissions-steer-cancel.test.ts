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
import { cloudStreams, createHarness, type Harness, requireHarness, waitFor } from "./harness.ts";
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
      ...cloudStreams({ cloudSessionId: CLOUD_ID, assistant: "ok" }),
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

  test("a failed follow-up resume surfaces a metric + turn.failed event (not a quiet drop)", async () => {
    // First call (launch) succeeds; the second call (resume) exits non-zero.
    let call = 0;
    const runner = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        return {
          code: 0,
          ...cloudStreams({ cloudSessionId: CLOUD_ID, assistant: "ok" }),
        };
      }
      const streams = cloudStreams({ cloudSessionId: CLOUD_ID });
      return { code: 1, stdout: streams.stdout, stderr: `${streams.stderr}resume boom\n` };
    });
    harness = await createHarness(
      { initialize: initResult(), onPrompt: { response: { stopReason: "end_turn" } } },
      runner,
    );
    await harness.server.start();
    await harness.seedSession("sf");

    await harness.server.intake.dispatch({
      kind: "launch",
      sub: "user-sub-1",
      sessionId: "sf",
      commandId: "cmd-launch",
      prompt: "first",
      repos: ["octo/repo"],
    } as Command);
    await waitFor(
      async () => (await requireHarness(harness).repo.getSession("sf"))?.status === "idle",
    );

    await harness.server.intake.dispatch({
      kind: "prompt",
      sub: "user-sub-1",
      sessionId: "sf",
      commandId: "cmd-turn-2",
      turnId: "t-2",
      prompt: "second",
      whenBusy: "steer",
    } as Command);
    await harness.server.manager.awaitTurnSettled("sf");

    // LOUD: a turn-failure metric fired AND an error log line appeared.
    expect(harness.metrics.sum("CloudTurnFailed")).toBe(1);
    expect(harness.logLines.some((l) => l.includes("cloud_turn_failed"))).toBe(true);

    // A client-visible turn.failed event was persisted (not just a status flip).
    const events = await harness.repo.queryEvents("sf", 0, { limit: 100 });
    expect(events.map((e) => e.type)).toContain("turn.failed");

    // The session returns to idle (recoverable) rather than hanging in running.
    expect((await harness.repo.getSession("sf"))?.status).toBe("idle");
  });

  test("a redelivered follow-up prompt (same turnId) does NOT run a second resume", async () => {
    const runner = vi.fn(async () => ({
      code: 0,
      ...cloudStreams({ cloudSessionId: CLOUD_ID, assistant: "ok" }),
    }));
    harness = await createHarness(
      { initialize: initResult(), onPrompt: { response: { stopReason: "end_turn" } } },
      runner,
    );
    await harness.server.start();
    await harness.seedSession("sr");

    await harness.server.intake.dispatch({
      kind: "launch",
      sub: "user-sub-1",
      sessionId: "sr",
      commandId: "cmd-launch",
      prompt: "first",
      repos: ["octo/repo"],
    } as Command);
    await waitFor(
      async () => (await requireHarness(harness).repo.getSession("sr"))?.status === "idle",
    );

    const promptCmd = {
      kind: "prompt",
      sub: "user-sub-1",
      sessionId: "sr",
      commandId: "cmd-turn-2",
      turnId: "t-2",
      prompt: "second",
      whenBusy: "steer",
    } as Command;

    await harness.server.intake.dispatch(promptCmd);
    await harness.server.manager.awaitTurnSettled("sr");
    // Redeliver the IDENTICAL prompt command (SQS at-least-once).
    await harness.server.intake.dispatch(promptCmd);
    await harness.server.manager.awaitTurnSettled("sr");

    // Runner fired exactly twice: once for launch, once for the single resume
    // turn -- the redelivery was a logged no-op, not a second resume.
    expect(runner).toHaveBeenCalledTimes(2);
    expect(harness.logLines.some((l) => l.includes("prompt_idempotent_skip"))).toBe(true);
  });

  test("mid-turn steer and cancel on a cloud session reject loudly (no doomed ACP call)", async () => {
    // A gated runner keeps the follow-up resume turn RUNNING so we can steer/
    // cancel mid-turn before it settles.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let call = 0;
    const runner = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        // Launch completes immediately so the session reaches idle.
        return {
          code: 0,
          ...cloudStreams({ cloudSessionId: CLOUD_ID, assistant: "ok" }),
        };
      }
      // The resume turn parks on the gate -> the turn stays running.
      await gate;
      return {
        code: 0,
        ...cloudStreams({ cloudSessionId: CLOUD_ID, assistant: "late" }),
      };
    });
    harness = await createHarness(
      { initialize: initResult(), onPrompt: { response: { stopReason: "end_turn" } } },
      runner,
    );
    await harness.server.start();
    await harness.seedSession("sm");

    await harness.server.intake.dispatch({
      kind: "launch",
      sub: "user-sub-1",
      sessionId: "sm",
      commandId: "cmd-launch",
      prompt: "first",
      repos: ["octo/repo"],
    } as Command);
    await waitFor(
      async () => (await requireHarness(harness).repo.getSession("sm"))?.status === "idle",
    );

    // Start a follow-up turn that parks on the gate -> the turn is RUNNING.
    await requireHarness(harness).server.manager.prompt("sm", "mid", "t-mid");
    expect(requireHarness(harness).server.manager.machineState("sm")?.turn).toBe("running");

    // Mid-turn steer rejects loudly rather than issuing a doomed ACP steer.
    await expect(
      requireHarness(harness).server.manager.steer("sm", "interrupt", "steer"),
    ).rejects.toThrow(/not supported for cloud/);
    // Mid-turn cancel rejects loudly rather than issuing a doomed ACP cancel.
    await expect(requireHarness(harness).server.manager.cancel("sm")).rejects.toThrow(
      /not supported for cloud/,
    );

    // The turn is still running (a swallowed cancel must not fake a state change).
    expect(requireHarness(harness).server.manager.machineState("sm")?.turn).toBe("running");

    // Let the background resume turn settle so shutdown is clean.
    release?.();
    await requireHarness(harness).server.manager.awaitTurnSettled("sm");
  });
});
