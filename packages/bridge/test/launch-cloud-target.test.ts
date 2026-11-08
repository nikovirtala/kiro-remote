/**
 * Integration tests for the chat-only cloud LAUNCH path (FEAT-002), driven
 * through the injectable HeadlessRunner fake (NO real binary).
 *
 * Cloud sessions are provisioned AND driven entirely by `kiro-cli chat --cloud`
 * subprocesses (chat-only == cloud-only, for now). A launch runs
 * `chat --cloud --repo ... --no-interactive "<prompt>"`; the real cloud session
 * id is parsed from the plain-text `[cloud] session <uuid>` line; the assistant
 * text + tool activity are persisted as events; the session reaches `idle`.
 *
 * A launch that emits NO `[cloud] session` line (or exits non-zero) fails
 * LOUDLY: status `failed`, the CloudLaunchFailed metric, and an error log.
 */

import type { Command } from "@nikovirtala/kiro-remote-core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cloudStreams, createHarness, type Harness, requireHarness, waitFor } from "./harness.ts";
import { initResult } from "./scenarios.ts";

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
    prompt: "do the thing",
    repos: ["octo/repo"],
  };
}

const CLOUD_ID = "08047063-f7b4-4ce5-b79a-2aea9a7a1d29";

describe("chat-only cloud launch (FEAT-002)", () => {
  test("provisions via chat --cloud, parses the cloud id, persists events, reaches idle", async () => {
    const runner = vi.fn(async () => ({
      code: 0,
      ...cloudStreams({
        cloudSessionId: CLOUD_ID,
        tools: [{ title: "fs_read /workspace/README.md", status: "Completed" }],
        assistant: "Here is the answer.",
      }),
    }));
    harness = await createHarness(
      { initialize: initResult(), onPrompt: { response: { stopReason: "end_turn" } } },
      runner,
    );
    await harness.server.start();
    await harness.seedSession("sc");

    await harness.server.intake.dispatch(launchCmd("sc"));
    await waitFor(
      async () => (await requireHarness(harness).repo.getSession("sc"))?.status === "idle",
    );

    // The runner was invoked with the chat --cloud launch argv.
    expect(runner).toHaveBeenCalledTimes(1);
    const spec = runner.mock.calls[0][0] as { command: string; args: string[] };
    expect(spec.command).toBe("kiro-cli");
    expect(spec.args).toEqual([
      "chat",
      "--cloud",
      "--repo",
      "octo/repo",
      "--no-interactive",
      "do the thing",
    ]);

    // The real cloud id (from the `[cloud] session <uuid>` line) was persisted.
    const session = await harness.repo.getSession("sc");
    expect(session?.status).toBe("idle");
    expect(session?.kiroSessionId).toBe(CLOUD_ID);

    // The launch path metric records "headless" (the chat --cloud subprocess).
    const launchPath = harness.metrics.data.find((d) => d.name === "LaunchPath");
    expect(launchPath?.dimensions?.path).toBe("headless");
    expect(harness.metrics.sum("SessionsLaunched")).toBe(1);

    // The assistant text + tool activity were persisted as events.
    const events = await harness.repo.queryEvents("sc", 0, { limit: 100 });
    const types = events.map((e) => e.type);
    expect(types).toContain("message.chunk");
    expect(types).toContain("tool.call");
    expect(types).toContain("tool.update");
  });

  test("fails LOUDLY when no `[cloud] session` line appears", async () => {
    const runner = vi.fn(async () => ({
      code: 0,
      // STDERR has log lines but NO `[cloud] session` marker; STDOUT has prose.
      stdout: "no session was created\n",
      stderr: "[INFO] starting\n[sandbox] done\n",
    }));
    harness = await createHarness(
      { initialize: initResult(), onPrompt: { response: { stopReason: "end_turn" } } },
      runner,
    );
    await harness.server.start();
    await harness.seedSession("sfail");

    await harness.server.intake.dispatch(launchCmd("sfail"));
    await waitFor(
      async () => (await requireHarness(harness).repo.getSession("sfail"))?.status === "failed",
    );

    const session = await harness.repo.getSession("sfail");
    expect(session?.status).toBe("failed");
    expect(session?.kiroSessionId).toBeNull();

    // Loud failure: metric + error log fired; no SessionsLaunched / LaunchPath.
    expect(harness.metrics.sum("CloudLaunchFailed")).toBe(1);
    expect(harness.logLines.some((l) => l.includes("cloud_launch_failed"))).toBe(true);
    expect(harness.metrics.sum("SessionsLaunched")).toBe(0);
    expect(harness.metrics.data.find((d) => d.name === "LaunchPath")).toBeUndefined();
  });

  test("fails LOUDLY when the chat --cloud subprocess exits non-zero", async () => {
    const runner = vi.fn(async () => ({
      code: 1,
      ...cloudStreams({ cloudSessionId: CLOUD_ID }),
    }));
    harness = await createHarness(
      { initialize: initResult(), onPrompt: { response: { stopReason: "end_turn" } } },
      runner,
    );
    await harness.server.start();
    await harness.seedSession("snz");

    await harness.server.intake.dispatch(launchCmd("snz"));
    await waitFor(
      async () => (await requireHarness(harness).repo.getSession("snz"))?.status === "failed",
    );

    expect(harness.metrics.sum("CloudLaunchFailed")).toBe(1);
    expect(harness.logLines.some((l) => l.includes("cloud_launch_failed"))).toBe(true);
  });
});
