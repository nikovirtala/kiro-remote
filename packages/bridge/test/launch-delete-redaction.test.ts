import type { Command } from "@kiro-remote/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { parseCloudSessionId } from "../src/headless.ts";
import { createLogger } from "../src/logger.ts";
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
    prompt: "go",
    repos: ["octo/repo"],
  };
}

describe("headless launch fallback", () => {
  test("falls back to stream-json when no cloud execution target is advertised", async () => {
    const runner = vi.fn(async () => ({
      code: 0,
      stdout:
        '{"type":"sessionUpdate","sessionId":"cloud-headless-7"}\n{"type":"runFinished","sessionId":"cloud-headless-7"}\n',
      stderr: "",
    }));
    harness = await createHarness({
      newSessionId: "unused",
      // No "cloud" execution target -> headless path.
      initialize: initResult({ executionTargets: ["local"] }),
      onPrompt: { response: { stopReason: "end_turn" } },
    });
    // Swap in a capturing headless runner.
    // biome-ignore lint/suspicious/noExplicitAny: reach into the manager's runner.
    (harness.server.manager as any).headlessRunner = runner;
    await harness.server.start();
    await harness.seedSession("sh");

    await harness.server.intake.dispatch(launchCmd("sh"));
    await waitFor(
      async () => (await requireHarness(harness).repo.getSession("sh"))?.status === "idle",
    );

    const session = await harness.repo.getSession("sh");
    expect(session?.kiroSessionId).toBe("cloud-headless-7");
    expect(runner).toHaveBeenCalled();
    const launchPath = harness.metrics.data.find((d) => d.name === "LaunchPath");
    expect(launchPath?.dimensions?.path).toBe("headless");
  });

  test("parseCloudSessionId reads the id from stream-json records", () => {
    expect(parseCloudSessionId('{"type":"runFinished","session_id":"abc-123"}')).toBe("abc-123");
    expect(parseCloudSessionId("not json\n")).toBeNull();
  });
});

describe("delete", () => {
  test("marks the session deleted", async () => {
    harness = await createHarness({
      newSessionId: "cloud-del",
      initialize: initResult(),
      onPrompt: { response: { stopReason: "end_turn" } },
    });
    await harness.server.start();
    await harness.seedSession("sd", { status: "idle", kiroSessionId: "cloud-del" });

    await harness.server.intake.dispatch({
      kind: "delete",
      sub: "user-sub-1",
      sessionId: "sd",
      commandId: "cmd-del",
    });
    const session = await harness.repo.getSession("sd");
    expect(session?.status).toBe("deleted");
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
});

describe("redaction", () => {
  test("a ksk_ Kiro API key never appears in log lines", () => {
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

  test("the openExternalUrl value is never logged", async () => {
    harness = await createHarness({
      newSessionId: "cloud-url",
      initialize: initResult(),
      onPrompt: {
        messages: [],
        response: { stopReason: "end_turn" },
      },
    });
    await harness.server.start();
    // Drive an _kiro/openExternalUrl request straight through the registered
    // handler and assert the URL is stored, not logged.
    const secretUrl = "https://provider.example.com/oauth/authorize?code=supersecretvalue";
    await Promise.resolve(
      // biome-ignore lint/suspicious/noExplicitAny: invoke the gateway handler directly.
      (harness.server.gateway as any).registerHandlers(),
    );
    // Simulate the agent-to-client request via the transport dispatch path.
    harness.server.transport.onRequest("_kiro/openExternalUrl", (params) => {
      const p = params as { url: string; sessionId?: string };
      requireHarness(harness).server.gateway.pendingExternalUrls.push({
        sessionId: p.sessionId ?? null,
        url: p.url,
        createdAt: Date.now(),
      });
      return {};
    });

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
