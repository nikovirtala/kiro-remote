import type { Command } from "@nikovirtala/kiro-remote-core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { parseCloudSessionId } from "../src/headless.ts";
import { createLogger } from "../src/logger.ts";
import { createHarness, type Harness, requireHarness, waitFor } from "./harness.ts";
import { initResult } from "./scenarios.ts";

let harness: Harness | null = null;

interface NewSessionParams {
  cwd?: string;
  additionalDirectories?: string[];
  mcpServers?: unknown[];
  _meta?: { kiro?: { repos?: string[]; modeId?: string } };
}

/**
 * The fake agent writes `{"fakeAgentNewSessionParams": <session/new params>}`
 * to its stderr. The bridge transport logs each stderr chunk under an
 * `acp_stderr` record whose `line` field carries that raw text. Dig the
 * session/new params back out of the captured log lines.
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
      // Purely-local advertisement (no cloud/remote signal) -> headless path.
      initialize: initResult({
        executionTargets: ["local"],
        sessionSources: ["local"],
        listScopes: ["local"],
        extensionMethods: [],
      }),
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

  test("chooses the ACP path from a non-literal cloud signal (sessionSources)", async () => {
    harness = await createHarness({
      newSessionId: "cloud-acp-signal",
      // No "cloud" execution target at all, but a remote sessionSource -> ACP.
      initialize: initResult({
        executionTargets: [],
        sessionSources: ["remote"],
        listScopes: ["local"],
        extensionMethods: [],
      }),
      onPrompt: { response: { stopReason: "end_turn" } },
    });
    await harness.server.start();
    await harness.seedSession("ss");

    await harness.server.intake.dispatch(launchCmd("ss"));
    await waitFor(
      async () => (await requireHarness(harness).repo.getSession("ss"))?.status === "idle",
    );

    const launchPath = harness.metrics.data.find((d) => d.name === "LaunchPath");
    expect(launchPath?.dimensions?.path).toBe("acp");
    const session = await harness.repo.getSession("ss");
    expect(session?.kiroSessionId).toBe("cloud-acp-signal");
  });

  test("routes headless for a purely-local advertisement", async () => {
    const runner = vi.fn(async () => ({
      code: 0,
      stdout: '{"type":"runFinished","sessionId":"cloud-local-9"}\n',
      stderr: "",
    }));
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
    // biome-ignore lint/suspicious/noExplicitAny: reach into the manager's runner.
    (harness.server.manager as any).headlessRunner = runner;
    await harness.server.start();
    await harness.seedSession("sl");

    await harness.server.intake.dispatch(launchCmd("sl"));
    await waitFor(
      async () => (await requireHarness(harness).repo.getSession("sl"))?.status === "idle",
    );

    const launchPath = harness.metrics.data.find((d) => d.name === "LaunchPath");
    expect(launchPath?.dimensions?.path).toBe("headless");
    expect(runner).toHaveBeenCalled();
  });

  test("logs exitCode and scrubbed stdout/stderr on a headless failure", async () => {
    // Runner returns output that carries no parseable session id AND a ksk_
    // token: the failure must log exitCode + the raw (redacted) stdout/stderr,
    // and the ksk_ token must never appear in the logs.
    const runner = vi.fn(async () => ({
      code: 3,
      stdout: "no session here; leaked ksk_live_shouldnotappear token\n",
      stderr: "boom",
    }));
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
    // biome-ignore lint/suspicious/noExplicitAny: reach into the manager's runner.
    (harness.server.manager as any).headlessRunner = runner;
    await harness.server.start();
    await harness.seedSession("sf");

    // The launch throws (no parseable session id); swallow it and assert on logs.
    await expect(harness.server.intake.dispatch(launchCmd("sf"))).rejects.toThrow(
      "headless launch produced no cloud session id",
    );
    await waitFor(() =>
      requireHarness(harness).logLines.some((l) => l.includes("headless_launch_failed")),
    );

    const failLine = harness.logLines.find((l) => l.includes("headless_launch_failed"));
    expect(failLine).toBeDefined();
    const record = JSON.parse(failLine as string) as Record<string, unknown>;
    // exitCode survives redaction (it is NOT the sensitive `code` field).
    expect(record.exitCode).toBe(3);
    expect(record.code).toBeUndefined();
    expect(typeof record.stderr).toBe("string");
    // The ksk_ token never appears anywhere in the logs.
    const joined = harness.logLines.join("\n");
    expect(joined).not.toContain("ksk_live_shouldnotappear");
    expect(joined).toContain("[REDACTED]");
  });

  test("the ACP cloud path conveys repos to session/new under _meta.kiro", async () => {
    harness = await createHarness({
      newSessionId: "cloud-acp-1",
      // "cloud" execution target advertised -> ACP session/new path.
      initialize: initResult({ executionTargets: ["cloud", "local"] }),
      onPrompt: { response: { stopReason: "end_turn" } },
    });
    await harness.server.start();
    await harness.seedSession("sa");

    await harness.server.intake.dispatch(launchCmd("sa"));
    await waitFor(
      async () => (await requireHarness(harness).repo.getSession("sa"))?.status === "idle",
    );

    const session = await harness.repo.getSession("sa");
    expect(session?.kiroSessionId).toBe("cloud-acp-1");
    const launchPath = harness.metrics.data.find((d) => d.name === "LaunchPath");
    expect(launchPath?.dimensions?.path).toBe("acp");

    // The fake agent echoes the session/new params over stderr, which the
    // transport surfaces as an `acp_stderr` log record whose `line` field holds
    // the (newline-delimited) agent stderr. Parse that out and assert repos
    // rode along under _meta.kiro.repos. This FAILS if the ACP path drops repos.
    const params = findNewSessionParams(harness.logLines);
    expect(params).not.toBeNull();
    expect((params as NewSessionParams)._meta?.kiro?.repos).toEqual(["octo/repo"]);
  });

  test("parseCloudSessionId reads the id from stream-json records", () => {
    expect(parseCloudSessionId('{"type":"runFinished","session_id":"abc-123"}')).toBe("abc-123");
    expect(parseCloudSessionId("not json\n")).toBeNull();
    // Backwards-compatible nested id locations are also accepted.
    expect(parseCloudSessionId('{"type":"runFinished","session":{"sessionId":"nested-1"}}')).toBe(
      "nested-1",
    );
    expect(parseCloudSessionId('{"result":{"sessionId":"nested-2"}}')).toBe("nested-2");
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
