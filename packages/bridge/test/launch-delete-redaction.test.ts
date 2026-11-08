/**
 * Chat-only cloud path tests (FEAT-002): parseCloudSessionId unit coverage,
 * launch idempotency, follow-up turns via --resume-id, log redaction, and the
 * unchanged chat --delete-session delete path. Everything is driven through the
 * injectable HeadlessRunner fake emitting PLAIN-TEXT `--cloud` output (no real
 * binary, no stream-json).
 */

import type { Command } from "@nikovirtala/kiro-remote-core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { parseCloudSessionId } from "../src/headless.ts";
import { createLogger } from "../src/logger.ts";
import { cloudStdout, createHarness, type Harness, requireHarness, waitFor } from "./harness.ts";
import { initResult } from "./scenarios.ts";

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) {
    await harness.stop();
    harness = null;
  }
});

function launchCmd(sessionId: string, commandId = "cmd-launch"): Command {
  return {
    kind: "launch",
    sub: "user-sub-1",
    sessionId,
    commandId,
    prompt: "go",
    repos: ["octo/repo"],
  };
}

const CLOUD_ID = "08047063-f7b4-4ce5-b79a-2aea9a7a1d29";

describe("parseCloudSessionId (plain-text [cloud] session line)", () => {
  test("reads the uuid from a `[cloud] session <uuid>` line", () => {
    expect(parseCloudSessionId(`[cloud] session ${CLOUD_ID}`)).toBe(CLOUD_ID);
  });

  test("tolerates a surrounding log prefix and extra whitespace", () => {
    expect(parseCloudSessionId(`2026-11-07T10:00:00Z [cloud]   session   ${CLOUD_ID}  `)).toBe(
      CLOUD_ID,
    );
  });

  test("returns the id from the FIRST matching line when interleaved with logs", () => {
    const out = cloudStdout({
      cloudSessionId: CLOUD_ID,
      tools: [{ title: "fs_read", status: "Completed" }],
      assistant: "hello",
    });
    expect(parseCloudSessionId(out)).toBe(CLOUD_ID);
  });

  test("returns null when there is no `[cloud] session` line", () => {
    expect(parseCloudSessionId("[INFO] nothing here\nassistant text\n")).toBeNull();
    expect(parseCloudSessionId("")).toBeNull();
  });
});

describe("launch idempotency", () => {
  test("a redelivered launch invokes the headless runner exactly once", async () => {
    const runner = vi.fn(async () => ({
      code: 0,
      stdout: cloudStdout({ cloudSessionId: CLOUD_ID, assistant: "done" }),
      stderr: "",
    }));
    harness = await createHarness(
      { initialize: initResult(), onPrompt: { response: { stopReason: "end_turn" } } },
      runner,
    );
    await harness.server.start();
    await harness.seedSession("idem");

    await harness.server.intake.dispatch(launchCmd("idem", "cmd-launch-1"));
    await waitFor(
      async () => (await requireHarness(harness).repo.getSession("idem"))?.status === "idle",
    );
    expect(runner).toHaveBeenCalledTimes(1);
    expect(harness.metrics.sum("SessionsLaunched")).toBe(1);

    // Redeliver the SAME launch (SQS at-least-once / visibility-timeout).
    await harness.server.intake.dispatch(launchCmd("idem", "cmd-launch-1"));
    await harness.server.manager.awaitTurnSettled("idem");

    // No second chat --cloud subprocess, no duplicate Space, no double metric.
    expect(runner).toHaveBeenCalledTimes(1);
    expect(harness.metrics.sum("SessionsLaunched")).toBe(1);
    expect(harness.logLines.some((l) => l.includes("launch_idempotent_skip"))).toBe(true);
  });
});

describe("signal-killed launch (code === null) is a failure, not a truncated success", () => {
  test("a null exit code with a [cloud] line still fails LOUDLY", async () => {
    // A process killed by a signal reports code === null. Even though it printed
    // a `[cloud] session <uuid>` line, the turn is TRUNCATED -- it must fail, not
    // be persisted as a complete turn at idle.
    const runner = vi.fn(async () => ({
      code: null,
      stdout: cloudStdout({ cloudSessionId: CLOUD_ID, assistant: "partial answer" }),
      stderr: "Killed",
    }));
    harness = await createHarness(
      { initialize: initResult(), onPrompt: { response: { stopReason: "end_turn" } } },
      runner,
    );
    await harness.server.start();
    await harness.seedSession("skill");

    await harness.server.intake.dispatch(launchCmd("skill"));
    await waitFor(
      async () => (await requireHarness(harness).repo.getSession("skill"))?.status === "failed",
    );

    const session = await harness.repo.getSession("skill");
    expect(session?.status).toBe("failed");
    expect(harness.metrics.sum("CloudLaunchFailed")).toBe(1);
    expect(harness.metrics.sum("SessionsLaunched")).toBe(0);
    expect(harness.logLines.some((l) => l.includes("cloud_launch_failed"))).toBe(true);
  });
});

describe("follow-up turns via --resume-id", () => {
  test("a prompt on an idle cloud session resumes the SAME cloud id", async () => {
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
    await harness.seedSession("res");

    // Launch (first turn).
    await harness.server.intake.dispatch(launchCmd("res"));
    await waitFor(
      async () => (await requireHarness(harness).repo.getSession("res"))?.status === "idle",
    );
    expect(runner).toHaveBeenCalledTimes(1);

    // Follow-up prompt turn.
    await harness.server.intake.dispatch({
      kind: "prompt",
      sub: "user-sub-1",
      sessionId: "res",
      commandId: "cmd-turn-2",
      turnId: "t-2",
      prompt: "and now this",
      whenBusy: "steer",
    });
    await harness.server.manager.awaitTurnSettled("res");

    // The follow-up invoked chat --cloud --resume-id <same cloud id>.
    expect(runner).toHaveBeenCalledTimes(2);
    const spec = runner.mock.calls[1][0] as { command: string; args: string[] };
    expect(spec.command).toBe("kiro-cli");
    expect(spec.args).toEqual([
      "chat",
      "--cloud",
      "--resume-id",
      CLOUD_ID,
      "--no-interactive",
      "and now this",
    ]);

    // The session returned to idle after the follow-up turn.
    expect((await harness.repo.getSession("res"))?.status).toBe("idle");
  });
});

describe("redaction", () => {
  test("a ksk_ token in the subprocess output never appears in any log line", async () => {
    // A launch that fails (no `[cloud] session` line) logs the raw child output;
    // the redacting logger must scrub the ksk_ token out of it.
    const secret = "ksk_live_abcdef0123456789";
    const runner = vi.fn(async () => ({
      code: 1,
      stdout: `[INFO] token is ${secret} inline\nno cloud session line here\n`,
      stderr: `bearer ${secret}`,
    }));
    harness = await createHarness(
      { initialize: initResult(), onPrompt: { response: { stopReason: "end_turn" } } },
      runner,
    );
    await harness.server.start();
    await harness.seedSession("sred");

    await harness.server.intake.dispatch(launchCmd("sred"));
    await waitFor(
      async () => (await requireHarness(harness).repo.getSession("sred"))?.status === "failed",
    );

    const joined = harness.logLines.join("\n");
    expect(joined).not.toContain(secret);
    expect(joined).toContain("[REDACTED]");
  });

  test("a ksk_ Kiro API key never appears in log lines (logger unit)", () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l), level: "debug" });
    logger.info("child_env", {
      KIRO_API_KEY: "ksk_live_abcdef0123456789",
      note: "token is ksk_live_abcdef0123456789 inline",
    });
    const joined = lines.join("\n");
    expect(joined).not.toContain("ksk_live_abcdef0123456789");
    expect(joined).toContain("[REDACTED]");
  });
});

describe("delete", () => {
  test("runs chat --delete-session and marks the session deleted", async () => {
    const runner = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    harness = await createHarness(
      { initialize: initResult(), onPrompt: { response: { stopReason: "end_turn" } } },
      runner,
    );
    await harness.server.start();
    await harness.seedSession("sd", { status: "idle", kiroSessionId: CLOUD_ID });

    await harness.server.intake.dispatch({
      kind: "delete",
      sub: "user-sub-1",
      sessionId: "sd",
      commandId: "cmd-del",
    });
    const session = await harness.repo.getSession("sd");
    expect(session?.status).toBe("deleted");

    // The delete path invoked `kiro-cli chat --delete-session <cloudId>`.
    expect(runner).toHaveBeenCalledTimes(1);
    const spec = runner.mock.calls[0][0] as { command: string; args: string[] };
    expect(spec.args).toEqual(["chat", "--delete-session", CLOUD_ID]);
  });
});

describe("session discovery", () => {
  test("session/list returns advertised cloud sessions for adoption", async () => {
    harness = await createHarness({
      newSessionId: "cloud-x",
      initialize: initResult(),
      onPrompt: { response: { stopReason: "end_turn" } },
    });
    await harness.server.start();
    const sessions = await harness.server.gateway.listSessions("cloud");
    expect(sessions).toEqual([{ sessionId: "cloud-adopted-1" }]);
  });

  test("the openExternalUrl value is never logged", async () => {
    harness = await createHarness({
      newSessionId: "cloud-url",
      initialize: initResult(),
      onPrompt: { messages: [], response: { stopReason: "end_turn" } },
    });
    await harness.server.start();
    const secretUrl = "https://provider.example.com/oauth/authorize?code=supersecretvalue";
    harness.server.gateway.pendingExternalUrls.push({
      sessionId: "cloud-url",
      url: secretUrl,
      createdAt: Date.now(),
    });
    const joined = harness.logLines.join("\n");
    expect(joined).not.toContain("supersecretvalue");
    expect(harness.server.gateway.pendingExternalUrls.some((p) => p.url === secretUrl)).toBe(true);
  });
});
