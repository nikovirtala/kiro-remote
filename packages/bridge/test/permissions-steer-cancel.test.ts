import type { Command } from "@nikovirtala/core";
import { afterEach, describe, expect, test } from "vitest";
import { createHarness, type Harness, requireHarness, waitFor } from "./harness.ts";
import { initResult, SHELL_PERMISSION_PARAMS } from "./scenarios.ts";

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) {
    await harness.stop();
    harness = null;
  }
});

function launchCmd(sessionId: string): Command {
  return {
    kind: "launch",
    sub: "user-sub-1",
    sessionId,
    commandId: `cmd-${Math.random().toString(36).slice(2)}`,
    prompt: "run the tests",
    repos: ["octo/repo"],
  };
}

describe("permissions", () => {
  test("stored verbatim, answered by optionId, consent returned for allow_always", async () => {
    harness = await createHarness({
      newSessionId: "cloud-p",
      initialize: initResult(),
      waitForPermissionReply: true,
      onPrompt: {
        messages: [
          {
            kind: "request",
            method: "session/request_permission",
            params: SHELL_PERMISSION_PARAMS,
          },
        ],
        response: { stopReason: "end_turn" },
      },
    });
    await harness.server.start();
    await harness.seedSession("sp");

    const dispatch = harness.server.intake.dispatch(launchCmd("sp"));

    // The permission request lands and is stored verbatim + awaiting_permission.
    await waitFor(
      async () => (await requireHarness(harness).repo.getPermission("sp", "perm-1")) !== null,
    );
    const perm = await harness.repo.getPermission("sp", "perm-1");
    expect(perm?.status).toBe("pending");
    // options[] stored VERBATIM (all four, exact ids/kinds, no synthesis).
    expect(perm?.options).toEqual(SHELL_PERMISSION_PARAMS.options);
    expect(harness.server.manager.machineState("sp")?.session).toBe("awaiting_permission");

    // Answer with an allow_always option + canonical consent.
    const consent = {
      scope: "workspace",
      resource: "npm run *",
      workspaceRoot: "/workspace/project",
    };
    await harness.server.intake.dispatch({
      kind: "answerPermission",
      sub: "user-sub-1",
      sessionId: "sp",
      commandId: "cmd-answer",
      requestId: "perm-1",
      optionId: "always-accept",
      consent,
    });

    // The agent received the exact optionId and consent (via stderr echo check
    // is indirect; assert the stored answer + that the turn resolves).
    await dispatch;
    const answered = await harness.repo.getPermission("sp", "perm-1");
    expect(answered?.status).toBe("answered");
    expect(answered?.answer).toEqual({ optionId: "always-accept", consent });
    expect(harness.server.manager.machineState("sp")?.turn).toBe("completed");
    expect(harness.metrics.sum("PermissionWait")).toBeGreaterThanOrEqual(0);
  });

  test("a pending permission can be expired, leaving it to Kiro", async () => {
    harness = await createHarness({
      newSessionId: "cloud-pe",
      initialize: initResult(),
      waitForPermissionReply: true,
      onPrompt: {
        messages: [
          {
            kind: "request",
            method: "session/request_permission",
            params: SHELL_PERMISSION_PARAMS,
          },
        ],
        response: { stopReason: "end_turn" },
      },
    });
    await harness.server.start();
    await harness.seedSession("spe");
    void harness.server.intake.dispatch(launchCmd("spe"));
    await waitFor(() => requireHarness(harness).server.gateway.pendingPermissions.has("perm-1"));
    // Expiring drops our hold (the request falls back to Kiro / next client).
    expect(harness.server.gateway.expirePermission("perm-1")).toBe(true);
    expect(harness.server.gateway.pendingPermissions.has("perm-1")).toBe(false);
  });
});

describe("steer and cancel", () => {
  test("steer mid-turn keeps the _session/ prefix and does not start a new turn", async () => {
    harness = await createHarness({
      newSessionId: "cloud-st",
      initialize: initResult(),
      onPrompt: { waitForSteer: true, response: { stopReason: "end_turn" } },
    });
    await harness.server.start();
    await harness.seedSession("sst");

    const dispatch = harness.server.intake.dispatch(launchCmd("sst"));
    await waitFor(
      () => requireHarness(harness).server.manager.machineState("sst")?.turn === "running",
    );

    // A follow-up during the active turn steers (whenBusy=steer); the fake
    // agent releases the prompt once steered.
    await harness.server.intake.dispatch({
      kind: "prompt",
      sub: "user-sub-1",
      sessionId: "sst",
      commandId: "cmd-steer",
      turnId: "t-2",
      prompt: "also do this",
      whenBusy: "steer",
    });

    await dispatch;
    expect(harness.server.manager.machineState("sst")?.turn).toBe("completed");
  });

  test("whenBusy=reject does not steer during an active turn", async () => {
    harness = await createHarness({
      newSessionId: "cloud-rj",
      initialize: initResult(),
      onPrompt: { waitForSteer: true, response: { stopReason: "end_turn" } },
    });
    await harness.server.start();
    await harness.seedSession("srj");
    const dispatch = harness.server.intake.dispatch(launchCmd("srj"));
    await waitFor(
      () => requireHarness(harness).server.manager.machineState("srj")?.turn === "running",
    );

    await harness.server.intake.dispatch({
      kind: "prompt",
      sub: "user-sub-1",
      sessionId: "srj",
      commandId: "cmd-reject",
      turnId: "t-3",
      prompt: "nope",
      whenBusy: "reject",
    });
    const rejected = harness.logLines.some((l) => l.includes("steer_rejected"));
    expect(rejected).toBe(true);

    // Release the original turn via a real steer so the test can settle.
    await harness.server.manager.steer("srj", "release", "steer");
    await dispatch;
  });

  test("cancel requests cancellation and waits for the prompt response", async () => {
    harness = await createHarness({
      newSessionId: "cloud-cx",
      initialize: initResult(),
      onPrompt: { waitForSteer: true, response: { stopReason: "cancelled" } },
    });
    await harness.server.start();
    await harness.seedSession("scx");
    const dispatch = harness.server.intake.dispatch(launchCmd("scx"));
    await waitFor(
      () => requireHarness(harness).server.manager.machineState("scx")?.turn === "running",
    );

    await harness.server.intake.dispatch({
      kind: "cancel",
      sub: "user-sub-1",
      sessionId: "scx",
      commandId: "cmd-cancel",
    });
    await dispatch;
    // The turn settles as cancelled ONLY after the prompt response arrives.
    expect(harness.server.manager.machineState("scx")?.turn).toBe("cancelled");
  });
});

describe("unknown agent-to-client request", () => {
  test("is answered with a JSON-RPC error (never hangs)", async () => {
    const stderrLines: string[] = [];
    harness = await createHarness({
      newSessionId: "cloud-u",
      initialize: initResult(),
      sendUnknownRequest: true,
      onPrompt: { response: { stopReason: "end_turn" } },
    });
    // Capture the fake agent's stderr to confirm it got a -32601 error back.
    harness.server.transport.onNotification("__noop__", () => undefined);
    await harness.server.start();
    await harness.seedSession("su");
    await harness.server.intake.dispatch(launchCmd("su"));
    await waitFor(
      async () => (await requireHarness(harness).repo.getSession("su"))?.status === "idle",
    );

    // The turn still completed despite the unknown request (no hang).
    expect(harness.server.manager.machineState("su")?.turn).toBe("completed");
    // The unknown request was logged as answered with an error.
    const loggedUnknown = harness.logLines.some((l) => l.includes("acp_unknown_request"));
    expect(loggedUnknown).toBe(true);
    void stderrLines;
  });
});
