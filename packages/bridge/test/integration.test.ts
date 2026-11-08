import type { Command } from "@nikovirtala/kiro-remote-core";
import { hasExtensionMethod } from "@nikovirtala/kiro-remote-core";
import { afterEach, describe, expect, test } from "vitest";
import { cloudRunner, createHarness, type Harness, requireHarness, waitFor } from "./harness.ts";
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

const CLOUD_ID = "08047063-f7b4-4ce5-b79a-2aea9a7a1d29";

describe("launch via chat --cloud -> idle + events", () => {
  test("provisions a cloud session and writes assistant + tool events", async () => {
    harness = await createHarness(
      { initialize: initResult(), onPrompt: { response: { stopReason: "end_turn" } } },
      cloudRunner({
        cloudSessionId: CLOUD_ID,
        tools: [{ title: "fs_read /workspace", status: "Completed" }],
        assistant: "hello",
      }),
    );
    await harness.server.start();
    await harness.seedSession("s1");

    await harness.server.intake.dispatch(launchCmd("s1"));

    await waitFor(
      async () => (await requireHarness(harness).repo.getSession("s1"))?.status === "idle",
    );
    const session = await harness.repo.getSession("s1");
    expect(session?.status).toBe("idle");
    expect(session?.kiroSessionId).toBe(CLOUD_ID);

    // The first turn is complete (provisioning -> idle): no running turn.
    const machine = harness.server.manager.machineState("s1");
    expect(machine?.session).toBe("idle");
    expect(machine?.turn).toBeNull();

    // Events were written to the DynamoDB log.
    const events = await harness.repo.queryEvents("s1", 0, { limit: 100 });
    expect(events.length).toBeGreaterThan(0);
    expect(harness.metrics.sum("SessionsLaunched")).toBe(1);
    expect(harness.metrics.sum("EventsWritten")).toBeGreaterThan(0);
    // LaunchPath records the chat --cloud subprocess path.
    const launchPath = harness.metrics.data.find((d) => d.name === "LaunchPath");
    expect(launchPath?.dimensions?.path).toBe("headless");
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
