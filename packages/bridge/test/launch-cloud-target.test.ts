/**
 * Integration tests for the FEAT-002 cloud-target launch behavior, driven
 * through the FAKE scripted ACP agent (a real child process).
 *
 * (1) A cloud-capable advertisement (executionTargets:['local','cloud-sandbox'],
 *     sessionSources:['local','remote']) must make SessionManager.launch issue
 *     session/new carrying the selected cloud-sandbox/remote target -- so the
 *     agent provisions a real Space in app.kiro.dev instead of a local
 *     in-container session. We assert the shape from the params the fake agent
 *     echoes on stderr (`fakeAgentNewSessionParams`).
 * (2) A purely-local advertisement (executionTargets:['local'],
 *     sessionSources:['local'] -> cloudExecution false) must fail LOUDLY: the
 *     session ends `failed`, the CloudTargetUnavailable metric + error log fire,
 *     and NO local session is created or prompted (no session/new, no prompt).
 */

import type { Command } from "@nikovirtala/kiro-remote-core";
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

interface NewSessionParams {
  cwd?: string;
  executionTarget?: string;
  sessionSource?: string;
  _meta?: { kiro?: { executionTarget?: string; sessionSource?: string; repos?: string[] } };
}

/**
 * The fake agent writes `{"fakeAgentNewSessionParams": <session/new params>}`
 * to stderr; the transport surfaces each stderr chunk under an `acp_stderr` log
 * record whose `line` field carries the raw text. Dig the params back out.
 */
function findNewSessionParams(logLines: string[]): NewSessionParams | null {
  for (const raw of logLines) {
    let outer: { msg?: string; line?: string };
    try {
      outer = JSON.parse(raw) as { msg?: string; line?: string };
    } catch {
      continue;
    }
    if (outer.msg !== "acp_stderr" || typeof outer.line !== "string") {
      continue;
    }
    for (const chunk of outer.line.split("\n")) {
      const trimmed = chunk.trim();
      if (!trimmed.includes("fakeAgentNewSessionParams")) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as {
          fakeAgentNewSessionParams?: NewSessionParams;
        };
        if (parsed.fakeAgentNewSessionParams) {
          return parsed.fakeAgentNewSessionParams;
        }
      } catch {
        // partial chunk; keep scanning.
      }
    }
  }
  return null;
}

describe("cloud-target launch (FEAT-002)", () => {
  test("a cloud-capable advertisement sends session/new with cloud-sandbox/remote selected", async () => {
    harness = await createHarness({
      newSessionId: "sess_cloud-1",
      // The live-shaped advertisement: both local and cloud-sandbox/remote.
      initialize: initResult({
        executionTargets: ["local", "cloud-sandbox"],
        sessionSources: ["local", "remote"],
      }),
      onPrompt: { response: { stopReason: "end_turn" } },
    });
    await harness.server.start();
    await harness.seedSession("sc");

    await harness.server.intake.dispatch(launchCmd("sc"));
    await waitFor(
      async () => (await requireHarness(harness).repo.getSession("sc"))?.status === "idle",
    );

    // ACP cloud path was taken.
    const launchPath = harness.metrics.data.find((d) => d.name === "LaunchPath");
    expect(launchPath?.dimensions?.path).toBe("acp");

    // session/new carried the cloud-sandbox/remote selection, both top-level and
    // under _meta.kiro, with repos still riding alongside.
    const params = findNewSessionParams(harness.logLines);
    expect(params).not.toBeNull();
    const p = params as NewSessionParams;
    expect(p.executionTarget).toBe("cloud-sandbox");
    expect(p.sessionSource).toBe("remote");
    expect(p._meta?.kiro?.executionTarget).toBe("cloud-sandbox");
    expect(p._meta?.kiro?.sessionSource).toBe("remote");
    expect(p._meta?.kiro?.repos).toEqual(["octo/repo"]);

    // No loud failure fired on the cloud-capable path.
    expect(harness.metrics.sum("CloudTargetUnavailable")).toBe(0);
  });

  test("a purely-local advertisement fails LOUDLY: no session/new, no prompt, status failed", async () => {
    harness = await createHarness({
      newSessionId: "unused",
      initialize: initResult({
        executionTargets: ["local"],
        sessionSources: ["local"],
        listScopes: ["local"],
        extensionMethods: [],
      }),
      onPrompt: { response: { stopReason: "end_turn" } },
    });
    await harness.server.start();
    await harness.seedSession("sfail");

    await harness.server.intake.dispatch(launchCmd("sfail"));
    await waitFor(
      async () => (await requireHarness(harness).repo.getSession("sfail"))?.status === "failed",
    );

    const session = await harness.repo.getSession("sfail");
    expect(session?.status).toBe("failed");
    expect(session?.kiroSessionId).toBeNull();

    // Loud failure: metric + error log fired.
    expect(harness.metrics.sum("CloudTargetUnavailable")).toBe(1);
    expect(harness.logLines.some((l) => l.includes("cloud_target_unavailable"))).toBe(true);

    // NO local session was created and NO prompt was dispatched: the fake agent
    // never saw session/new or session/prompt.
    expect(findNewSessionParams(harness.logLines)).toBeNull();
    expect(harness.logLines.some((l) => l.includes("fakeAgentPromptCalled"))).toBe(false);
    expect(harness.metrics.sum("SessionsLaunched")).toBe(0);
    // No launch-path metric is emitted on the loud-failure path.
    expect(harness.metrics.data.find((d) => d.name === "LaunchPath")).toBeUndefined();
  });

  test("an env override forces the execution target/session source on session/new", async () => {
    harness = await createHarness({
      newSessionId: "sess_cloud-override",
      initialize: initResult({
        executionTargets: ["local", "cloud-sandbox"],
        sessionSources: ["local", "remote"],
      }),
      onPrompt: { response: { stopReason: "end_turn" } },
    });
    // Apply the override the way ServeConfig threads it into the manager.
    // biome-ignore lint/suspicious/noExplicitAny: set the private override for the test.
    (harness.server.manager as any).cloudTargetOverride = {
      executionTarget: "cloud-vm",
      sessionSource: "cloud",
    };
    await harness.server.start();
    await harness.seedSession("sov");

    await harness.server.intake.dispatch(launchCmd("sov"));
    await waitFor(
      async () => (await requireHarness(harness).repo.getSession("sov"))?.status === "idle",
    );

    const params = findNewSessionParams(harness.logLines);
    expect(params).not.toBeNull();
    const p = params as NewSessionParams;
    expect(p.executionTarget).toBe("cloud-vm");
    expect(p.sessionSource).toBe("cloud");
  });
});
