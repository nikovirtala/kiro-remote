import { describe, expect, it } from "vitest";
import type { RunReport, StepStatus } from "./report.ts";
import { runHarness } from "./run.ts";
import { discoveryFetch, FAKE_TOKEN, FakeKiro, fakeDeps, throwingDeps } from "./test-fakes.ts";

const BASE = "https://kiro.example.com";
const REPO = "secret-owner/secret-repo";
const ENV = { KIRO_REMOTE_URL: BASE, KIRO_API_E2E_REPO: REPO };

const STEP_IDS = [
  "discovery",
  "mcp-inspector",
  "mcp-skills",
  "mcp-modern-tools",
  "login",
  "mcp-tools",
  "mcp-launch",
  "mcp-launch-turn",
  "mcp-followup",
  "mcp-tasks",
  "mcp-no-tasks",
  "mcp-delete",
  "rest-read",
  "rest-launch",
  "rest-launch-turn",
  "rest-followup",
  "rest-delete",
];

const LAUNCH_STEPS = [
  "mcp-launch",
  "mcp-launch-turn",
  "mcp-followup",
  "mcp-tasks",
  "mcp-no-tasks",
  "mcp-delete",
  "rest-launch",
  "rest-launch-turn",
  "rest-followup",
  "rest-delete",
];

function statuses(report: RunReport): Record<string, StepStatus> {
  return Object.fromEntries(report.steps.map((s) => [s.id, s.status]));
}

function step(report: RunReport, id: string) {
  const found = report.steps.find((s) => s.id === id);
  if (!found) {
    throw new Error(`no step ${id}`);
  }
  return found;
}

describe("runHarness", () => {
  it("(a) skips every step without KIRO_REMOTE_URL, calls nothing, and exits 2", async () => {
    const { report, exitCode } = await runHarness({ env: {}, deps: throwingDeps() });
    expect(report.steps.map((s) => s.id)).toEqual(STEP_IDS);
    for (const s of report.steps) {
      expect(s.status).toBe("skipped");
      expect(s.reason).toContain("KIRO_REMOTE_URL is unset");
    }
    expect(exitCode).toBe(2);
  });

  it("(b) passes every step on the happy path and leaves no session behind", async () => {
    const kiro = new FakeKiro();
    const { report, exitCode } = await runHarness({ env: ENV, deps: fakeDeps(BASE, kiro) });
    expect(report.steps.map((s) => s.id)).toEqual(STEP_IDS);
    expect(report.steps.filter((s) => s.status !== "passed")).toEqual([]);
    expect(exitCode).toBe(0);
    expect(kiro.liveSessions()).toEqual([]);
    expect(report.steps.some((s) => s.id === "cleanup")).toBe(false);
    const json = JSON.stringify(report);
    expect(json).not.toContain(REPO);
    expect(json).not.toContain(FAKE_TOKEN);
    expect(step(report, "mcp-launch").captured?.sessionId).toBe("ses-1");
    expect(step(report, "login").captured?.source).toBe("keychain");
    // Every live step made real calls on the backend.
    expect(kiro.calls).toContain("mcp:kiro_wait_for_events");
    expect(kiro.calls).toContain("mcp:kiro_send_prompt");
    expect(kiro.calls).toContain("rest:getEvents");
    expect(kiro.calls).toContain("rest:createTurn");
  });

  it("(c) a failed launch turn fails, skips the follow-up, still deletes, and exits 1", async () => {
    const kiro = new FakeKiro({ failLaunchTurn: true });
    const { report, exitCode } = await runHarness({ env: ENV, deps: fakeDeps(BASE, kiro) });
    const st = statuses(report);
    expect(st["mcp-launch-turn"]).toBe("failed");
    expect(step(report, "mcp-launch-turn").reason).toContain("turn failed: sandbox crashed");
    expect(st["mcp-followup"]).toBe("skipped");
    expect(step(report, "mcp-followup").reason).toBe(
      "skipped because mcp-launch-turn did not pass.",
    );
    expect(st["mcp-delete"]).toBe("passed");
    expect(st["rest-delete"]).toBe("passed");
    expect(kiro.liveSessions()).toEqual([]);
    expect(exitCode).toBe(1);
  });

  it("(d) a failing Inspector run fails only its step and exits 1", async () => {
    const kiro = new FakeKiro();
    const deps = fakeDeps(BASE, kiro, {
      inspector: async () => {
        throw new Error("MCP Inspector exited 3: auth_required");
      },
    });
    const { report, exitCode } = await runHarness({ env: ENV, deps });
    expect(step(report, "mcp-inspector").status).toBe("failed");
    expect(step(report, "mcp-inspector").reason).toContain("auth_required");
    expect(report.steps.filter((s) => s.status !== "passed").map((s) => s.id)).toEqual([
      "mcp-inspector",
    ]);
    expect(exitCode).toBe(1);
  });

  it("(d2) a skills/list --verify that exits non-zero fails its step, and only that step", async () => {
    const kiro = new FakeKiro();
    const fake = fakeDeps(BASE, kiro);
    const deps = fakeDeps(BASE, kiro, {
      inspectorRun: async (url, call) => {
        if (call.verify) {
          throw new Error("MCP Inspector exited 7: skill digest mismatch");
        }
        return fake.inspectorRun?.(url, call) ?? "";
      },
    });
    const { report, exitCode } = await runHarness({ env: ENV, deps });
    expect(step(report, "mcp-skills").status).toBe("failed");
    expect(step(report, "mcp-skills").reason).toContain("exited 7");
    expect(report.steps.filter((s) => s.status !== "passed").map((s) => s.id)).toEqual([
      "mcp-skills",
    ]);
    expect(exitCode).toBe(1);
  });

  it("(d3) skills that do not verify, or a missing kiro-remote-sessions, fail the step", async () => {
    const kiro = new FakeKiro();
    const report = (name: string, ok: boolean) =>
      `${JSON.stringify({ name, ok, outcome: ok ? "verified" : "failed", files: [] })}\n`;
    for (const [stdout, reason] of [
      [report("kiro-remote-sessions", false), "not verified"],
      [report("another-skill", true), "does not offer kiro-remote-sessions"],
      ["", "does not offer kiro-remote-sessions"],
    ] as const) {
      const deps = fakeDeps(BASE, kiro, { inspectorRun: async () => stdout });
      const { report: run } = await runHarness({ env: ENV, deps });
      expect(step(run, "mcp-skills").status).toBe("failed");
      expect(step(run, "mcp-skills").reason).toContain(reason);
    }
  });

  it("(d4) the modern-era tools/list must list exactly the 19 tools", async () => {
    const kiro = new FakeKiro();
    const deps = fakeDeps(BASE, kiro, {
      inspectorRun: async () =>
        JSON.stringify({ result: { tools: [{ name: "kiro_capabilities" }] } }),
    });
    const { report, exitCode } = await runHarness({ env: ENV, deps });
    expect(step(report, "mcp-modern-tools").status).toBe("failed");
    expect(exitCode).toBe(1);
  });

  it("(d5) the two Inspector steps ask for the era and the check they name", async () => {
    const kiro = new FakeKiro();
    const calls: unknown[] = [];
    const fake = fakeDeps(BASE, kiro);
    const deps = fakeDeps(BASE, kiro, {
      inspectorRun: async (url, call) => {
        calls.push(call);
        return fake.inspectorRun?.(url, call) ?? "";
      },
    });
    await runHarness({ env: ENV, deps });
    expect(calls).toEqual([
      { method: "skills/list", verify: true },
      { method: "tools/list", era: "modern" },
    ]);
  });

  it("(e) without a repo the launch steps are skipped and the rest pass, exit 2", async () => {
    const kiro = new FakeKiro();
    const { report, exitCode } = await runHarness({
      env: { KIRO_REMOTE_URL: BASE },
      deps: fakeDeps(BASE, kiro),
    });
    for (const id of LAUNCH_STEPS) {
      expect(step(report, id).status).toBe("skipped");
      expect(step(report, id).reason).toContain("KIRO_API_E2E_REPO is unset");
    }
    for (const id of STEP_IDS.filter((i) => !LAUNCH_STEPS.includes(i))) {
      expect(step(report, id).status).toBe("passed");
    }
    expect(kiro.sessions.size).toBe(0);
    expect(exitCode).toBe(2);
  });

  it("(f) a delete that never confirms fails, and cleanup fails listing the session", async () => {
    const kiro = new FakeKiro({ deleteNeverConfirms: true });
    const { report, exitCode } = await runHarness({ env: ENV, deps: fakeDeps(BASE, kiro) });
    expect(step(report, "mcp-delete").status).toBe("failed");
    expect(step(report, "mcp-delete").reason).toMatch(/still readable 20 s after delete/);
    const cleanup = step(report, "cleanup");
    expect(cleanup.status).toBe("failed");
    expect(cleanup.reason).toContain("ses-1");
    expect(cleanup.reason).toContain("ses-2");
    expect(exitCode).toBe(1);
  });

  it("(g) an aborted run skips every step as interrupted and exits 2", async () => {
    const ac = new AbortController();
    ac.abort();
    const { report, exitCode } = await runHarness({
      env: ENV,
      deps: throwingDeps(),
      signal: ac.signal,
    });
    expect(report.steps).toHaveLength(STEP_IDS.length);
    for (const s of report.steps) {
      expect(s.status).toBe("skipped");
      expect(s.reason).toBe("run interrupted.");
    }
    expect(exitCode).toBe(2);
  });

  it("(h) a wrong tool list fails mcp-tools", async () => {
    const kiro = new FakeKiro({ wrongToolList: true });
    const { report, exitCode } = await runHarness({ env: ENV, deps: fakeDeps(BASE, kiro) });
    expect(step(report, "mcp-tools").status).toBe("failed");
    expect(step(report, "mcp-tools").reason).toContain("missing kiro_capabilities");
    expect(step(report, "mcp-launch").status).toBe("skipped");
    expect(exitCode).toBe(1);
  });

  it("a launch that throws fails the launch and skips its dependents", async () => {
    const kiro = new FakeKiro({ launchThrows: true });
    const { report, exitCode } = await runHarness({ env: ENV, deps: fakeDeps(BASE, kiro) });
    expect(step(report, "mcp-launch").status).toBe("failed");
    expect(step(report, "mcp-launch").reason).toContain("launch rejected");
    for (const id of [
      "mcp-launch-turn",
      "mcp-followup",
      "mcp-tasks",
      "mcp-no-tasks",
      "mcp-delete",
    ]) {
      expect(step(report, id).status).toBe("skipped");
    }
    expect(step(report, "rest-launch").status).toBe("failed");
    expect(exitCode).toBe(1);
  });

  it("(i) the Tasks steps send a real request each and verify the task against the transcript", async () => {
    const kiro = new FakeKiro();
    const { report } = await runHarness({ env: ENV, deps: fakeDeps(BASE, kiro) });
    expect(step(report, "mcp-tasks").status).toBe("passed");
    expect(step(report, "mcp-no-tasks").status).toBe("passed");
    expect(kiro.calls).toContain("tasks:kiro_send_prompt");
    expect(step(report, "mcp-tasks").captured?.turnId).toEqual(expect.any(String));
  });

  it.each([
    ["a server that returns no task", { noTasks: true }, "did not return a task"],
    ["a task whose text is not the transcript's", { taskTextDiffers: true }, "kiro_get_transcript"],
    [
      "a task whose structuredContent.text is not the transcript's",
      { structuredTextDiffers: true },
      "structuredContent.text",
    ],
    ["a task that fails", { taskFails: true }, "the task ended failed: turn failed"],
  ] as const)(
    "(j) %s fails mcp-tasks, still deletes the session, and exits 1",
    async (_name, options, reason) => {
      const kiro = new FakeKiro(options);
      const { report, exitCode } = await runHarness({ env: ENV, deps: fakeDeps(BASE, kiro) });
      expect(step(report, "mcp-tasks").status).toBe("failed");
      expect(step(report, "mcp-tasks").reason).toContain(reason);
      expect(step(report, "mcp-delete").status).toBe("passed");
      expect(kiro.liveSessions()).toEqual([]);
      expect(exitCode).toBe(1);
    },
  );

  it("(k) an ordinary client that is handed a task fails mcp-no-tasks", async () => {
    const kiro = new FakeKiro({ plainReturnsTask: true });
    const { report, exitCode } = await runHarness({ env: ENV, deps: fakeDeps(BASE, kiro) });
    expect(step(report, "mcp-no-tasks").status).toBe("failed");
    expect(step(report, "mcp-no-tasks").reason).toContain("did not declare Tasks");
    expect(step(report, "mcp-tasks").status).toBe("passed");
    expect(exitCode).toBe(1);
  });

  it("scrubs the repo from a failure reason", async () => {
    const kiro = new FakeKiro();
    const deps = fakeDeps(BASE, kiro, {
      inspector: async () => {
        throw new Error(`repo ${REPO} is not allowed`);
      },
    });
    const { report } = await runHarness({ env: ENV, deps });
    expect(step(report, "mcp-inspector").reason).toBe("repo [REDACTED] is not allowed");
    expect(JSON.stringify(report)).not.toContain(REPO);
  });
});

describe("discovery step", () => {
  it("fails when the protected-resource metadata names the wrong resource", async () => {
    const kiro = new FakeKiro();
    const deps = fakeDeps(BASE, kiro, {
      fetch: discoveryFetch(BASE, { prm: { resource: "https://other.example.com/mcp" } }),
    });
    const { report } = await runHarness({ env: ENV, deps });
    expect(step(report, "discovery").status).toBe("failed");
    expect(step(report, "discovery").reason).toContain("resource is not");
    expect(step(report, "mcp-inspector").reason).toBe("skipped because discovery did not pass.");
  });

  it("fails when the 401 has no WWW-Authenticate challenge", async () => {
    const kiro = new FakeKiro();
    const deps = fakeDeps(BASE, kiro, { fetch: discoveryFetch(BASE, { challenge: null }) });
    const { report } = await runHarness({ env: ENV, deps });
    expect(step(report, "discovery").status).toBe("failed");
    expect(step(report, "discovery").reason).toContain("resource_metadata");
  });

  it("fails when /mcp does not answer 401 unauthenticated", async () => {
    const kiro = new FakeKiro();
    const deps = fakeDeps(BASE, kiro, { fetch: discoveryFetch(BASE, { mcpStatus: 200 }) });
    const { report } = await runHarness({ env: ENV, deps });
    expect(step(report, "discovery").reason).toContain("expected 401");
  });
});
