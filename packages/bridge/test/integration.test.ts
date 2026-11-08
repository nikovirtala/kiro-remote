import { type Command, hasExtensionMethod } from "@nikovirtala/kiro-remote-core";
import { afterEach, describe, expect, test } from "vitest";
import { createHarness, type Harness, requireHarness, waitFor } from "./harness.ts";
import { initResult } from "./scenarios.ts";

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) {
    await harness.stop();
    harness = null;
  }
});

function launchCmd(sessionId: string, overrides: Partial<Command> = {}): Command {
  return {
    kind: "launch",
    sub: "user-sub-1",
    sessionId,
    commandId: `cmd-${Math.random().toString(36).slice(2)}`,
    prompt: "do the thing",
    repos: ["octo/repo"],
    ...overrides,
  } as Command;
}

describe("launch -> prompt -> turn settle", () => {
  test("turn settles ONLY on the prompt response and writes events", async () => {
    harness = await createHarness({
      newSessionId: "cloud-1",
      initialize: initResult(),
      onPrompt: {
        messages: [
          {
            kind: "notify",
            method: "session/update",
            params: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "hello" },
            },
          },
          {
            kind: "notify",
            method: "session/update",
            params: {
              sessionUpdate: "tool_call",
              toolCallId: "call-7",
              title: "read",
              status: "pending",
            },
          },
        ],
        response: { stopReason: "end_turn" },
      },
    });
    await harness.server.start();
    await harness.seedSession("s1");

    await harness.server.intake.dispatch(launchCmd("s1"));

    await waitFor(
      async () => (await requireHarness(harness).repo.getSession("s1"))?.status === "idle",
    );
    const session = await harness.repo.getSession("s1");
    expect(session?.status).toBe("idle");
    expect(session?.kiroSessionId).toBe("cloud-1");

    const machine = harness.server.manager.machineState("s1");
    expect(machine?.turn).toBe("completed");

    // Events were written to the DynamoDB log.
    const events = await harness.repo.queryEvents("s1", 0, { limit: 100 });
    expect(events.length).toBeGreaterThan(0);
    expect(harness.metrics.sum("SessionsLaunched")).toBe(1);
    expect(harness.metrics.sum("EventsWritten")).toBeGreaterThan(0);
    // LaunchPath acp (cloud target advertised).
    const launchPath = harness.metrics.data.find((d) => d.name === "LaunchPath");
    expect(launchPath?.dimensions?.path).toBe("acp");
  });

  test("adopts a fresh cloud id when session/new returns no id (Bug A)", async () => {
    const freshCloudId = "sess_f0140707-5ace-4779-a290-fc9fc3773dca";
    harness = await createHarness({
      // session/new returns NO id; the agent routes under this fresh sess_ id and
      // announces it via _kiro/sessions/changed, exactly like the live agent.
      emptyNewSessionId: true,
      freshCloudId,
      emitSessionsChangedOnNew: true,
      initialize: initResult(),
      onPrompt: {
        messages: [
          {
            kind: "notify",
            method: "session/update",
            params: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "hi" },
            },
          },
        ],
        response: { stopReason: "end_turn" },
      },
    });
    await harness.server.start();
    await harness.seedSession("sfresh");

    await harness.server.intake.dispatch(launchCmd("sfresh"));

    await waitFor(
      async () => (await requireHarness(harness).repo.getSession("sfresh"))?.status === "idle",
    );
    const session = await harness.repo.getSession("sfresh");
    expect(session?.status).toBe("idle");
    // kiroToLocal adopted the fresh sess_ id and it was persisted.
    expect(session?.kiroSessionId).toBe(freshCloudId);

    // Events reached the DynamoDB log (routing worked after adoption).
    const events = await harness.repo.queryEvents("sfresh", 0, { limit: 100 });
    expect(events.length).toBeGreaterThan(0);
    expect(harness.metrics.sum("EventsWritten")).toBeGreaterThan(0);

    // No unknown-session complaint remains for the adopted id.
    const unknown = harness.logLines.filter(
      (l) => l.includes("update_for_unknown_session") && l.includes(freshCloudId),
    );
    expect(unknown).toEqual([]);
  });

  test("adopts a fresh cloud id from the first session/update alone (Bug A)", async () => {
    const freshCloudId = "sess_update-only-cloud-id";
    harness = await createHarness({
      // No _kiro/sessions/changed: adoption must happen off the first update.
      emptyNewSessionId: true,
      freshCloudId,
      initialize: initResult(),
      onPrompt: {
        messages: [
          {
            kind: "notify",
            method: "session/update",
            params: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "hi" },
            },
          },
        ],
        response: { stopReason: "end_turn" },
      },
    });
    await harness.server.start();
    await harness.seedSession("supd");

    await harness.server.intake.dispatch(launchCmd("supd"));

    await waitFor(
      async () => (await requireHarness(harness).repo.getSession("supd"))?.status === "idle",
    );
    const session = await harness.repo.getSession("supd");
    expect(session?.kiroSessionId).toBe(freshCloudId);
    const events = await harness.repo.queryEvents("supd", 0, { limit: 100 });
    expect(events.length).toBeGreaterThan(0);
  });

  test("first turn runs when the agent REQUIRES an array-shaped prompt (Bug B)", async () => {
    harness = await createHarness({
      newSessionId: "cloud-arr",
      initialize: initResult(),
      // The agent rejects session/prompt with "Invalid params" unless `prompt`
      // is an array of content blocks -- exactly what the live agent did.
      requireArrayPrompt: true,
      onPrompt: {
        messages: [
          {
            kind: "notify",
            method: "session/update",
            params: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "hello" },
            },
          },
        ],
        response: { stopReason: "end_turn" },
      },
    });
    await harness.server.start();
    await harness.seedSession("sarr");

    await harness.server.intake.dispatch(launchCmd("sarr"));

    await waitFor(
      async () => (await requireHarness(harness).repo.getSession("sarr"))?.status === "idle",
    );
    const session = await harness.repo.getSession("sarr");
    expect(session?.status).toBe("idle");

    // The turn completed (the prompt was accepted, i.e. sent as an array).
    const machine = harness.server.manager.machineState("sarr");
    expect(machine?.turn).toBe("completed");

    // Events reached the DynamoDB log, so the turn actually progressed.
    const events = await harness.repo.queryEvents("sarr", 0, { limit: 100 });
    expect(events.length).toBeGreaterThan(0);
    expect(harness.metrics.sum("EventsWritten")).toBeGreaterThan(0);

    // No prompt_error complaint (the array-shaped prompt was NOT rejected).
    const promptErrors = harness.logLines.filter((l) => l.includes("prompt_error"));
    expect(promptErrors).toEqual([]);
  });

  test("a turn_end session_info_update does NOT settle the turn", async () => {
    harness = await createHarness({
      newSessionId: "cloud-2",
      initialize: initResult(),
      promptDelayMs: 80,
      onPrompt: {
        emitTurnEndBeforeResponse: true,
        response: { stopReason: "end_turn" },
      },
    });
    await harness.server.start();
    await harness.seedSession("s2");

    await harness.server.intake.dispatch(launchCmd("s2"));

    // While the prompt response is delayed, after the turn_end update lands the
    // machine MUST still be running (turn not settled by turn_end).
    await waitFor(
      () => requireHarness(harness).server.manager.machineState("s2")?.session === "running",
    );
    const midState = harness.server.manager.machineState("s2");
    expect(midState?.turn).toBe("running");
    expect(midState?.session).toBe("running");

    // The turn now settles off the dispatch path; await the background settle.
    await harness.server.manager.awaitTurnSettled("s2");
    // Now the prompt response has arrived and settled the turn.
    const finalState = harness.server.manager.machineState("s2");
    expect(finalState?.turn).toBe("completed");
  });

  test("stopReason refusal marks the turn refused", async () => {
    harness = await createHarness({
      newSessionId: "cloud-3",
      initialize: initResult(),
      onPrompt: { response: { stopReason: "refusal" } },
    });
    await harness.server.start();
    await harness.seedSession("s3");
    await harness.server.intake.dispatch(launchCmd("s3"));
    await waitFor(
      () => requireHarness(harness).server.manager.machineState("s3")?.turn === "refused",
    );
    expect(harness.server.manager.machineState("s3")?.turn).toBe("refused");
  });
});

describe("capability gating", () => {
  test("a _kiro/* method is NOT called unless advertised", async () => {
    harness = await createHarness({
      // Reduced extensionMethods: openExternalUrl only; no _kiro/session/context.
      initialize: initResult({ extensionMethods: ["_kiro/openExternalUrl"] }),
      onPrompt: { response: { stopReason: "end_turn" } },
    });
    await harness.server.start();
    // Any future _kiro/* call must gate on the advertised extensionMethods via
    // core's hasExtensionMethod (the real, shared gate used by the API too).
    const caps = harness.server.gateway.capabilities();
    expect(hasExtensionMethod(caps, "_kiro/session/context")).toBe(false);
    expect(hasExtensionMethod(caps, "_kiro/openExternalUrl")).toBe(true);
    expect(caps.extensionMethods).toEqual(["_kiro/openExternalUrl"]);
  });
});

describe("config", () => {
  test("rejects a config value that is not advertised", async () => {
    harness = await createHarness({
      newSessionId: "cloud-cfg",
      initialize: initResult(),
      onPrompt: { response: { stopReason: "end_turn" } },
    });
    await harness.server.start();
    await harness.seedSession("sc");
    await harness.server.intake.dispatch(launchCmd("sc"));
    await waitFor(
      async () => (await requireHarness(harness).repo.getSession("sc"))?.status === "idle",
    );

    // Unadvertised model -> rejected.
    await expect(harness.server.manager.setConfig("sc", { model: "gpt-nope" })).rejects.toThrow(
      /not advertised/,
    );
    // Advertised model -> accepted.
    await expect(
      harness.server.manager.setConfig("sc", { model: "claude-haiku" }),
    ).resolves.toBeUndefined();
    // Unadvertised mode -> rejected.
    await expect(harness.server.manager.setConfig("sc", { mode: "wizard" })).rejects.toThrow(
      /not advertised/,
    );
  });
});
