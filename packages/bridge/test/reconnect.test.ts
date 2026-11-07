import type { SessionInputs, SessionMetaItem } from "@kiro-remote/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Supervisor, TRANSPORT_LOST_REASON } from "../src/supervisor.ts";
import { createHarness, type Harness, requireHarness } from "./harness.ts";
import { initResult } from "./scenarios.ts";

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) {
    await harness.stop();
    harness = null;
  }
});

function inputsFor(session: SessionMetaItem): SessionInputs {
  return {
    cwd: "/workspace/project",
    additionalDirectories: ["/workspace/shared"],
    mcpServers: [{ name: "example", command: "x" }],
    ...(session.mode ? { modeId: session.mode } : {}),
  };
}

describe("reconnect / supervision", () => {
  test("re-registers handlers before load, re-sends inputs, dedupes replay, never resends a prompt, marks in-flight turn transport_lost", async () => {
    // Replay on load: two identical tool_call updates (replay-marked) to prove
    // dedupe by toolCallId+content; a chunk; NO turn_completion (so the in-flight
    // turn is NOT shown complete and must be marked transport_lost).
    const replayToolCall = {
      sessionUpdate: "tool_call",
      toolCallId: "call-42",
      title: "edit",
      status: "completed",
      _meta: { kiro: { replay: true } },
    };
    harness = await createHarness({
      newSessionId: "cloud-rc",
      initialize: initResult(),
      onLoad: {
        messages: [
          { kind: "notify", method: "session/update", params: replayToolCall },
          { kind: "notify", method: "session/update", params: replayToolCall },
        ],
      },
      onPrompt: { response: { stopReason: "end_turn" } },
    });
    await harness.server.start();

    // Seed a RUNNING session with an in-flight turn and a turn row.
    const session = await harness.seedSession("src", {
      status: "running",
      kiroSessionId: "cloud-rc",
      activeTurnId: "turn-live",
    });
    await harness.repo.putTurn({
      PK: session.PK,
      SK: "TURN#turn-live",
      id: "turn-live",
      sessionId: "src",
      prompt: "the original prompt",
      status: "running",
      stopReason: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      metering: null,
    });

    // Spy on handler registration ordering: registerHandlers must be called
    // before loadSession.
    const order: string[] = [];
    const registerSpy = vi
      .spyOn(harness.server.gateway, "registerHandlers")
      .mockImplementation(() => {
        order.push("registerHandlers");
      });
    const loadSpy = vi.spyOn(harness.server.gateway, "loadSession");
    loadSpy.mockImplementation(async (sid: string, _inputs: SessionInputs) => {
      order.push("loadSession");
      return { sessionId: sid };
    });

    // Inject a clock that advances past the replay-settle window on the first
    // read so the no-completion branch does not block for the full window; the
    // replay tool_calls still drain (deterministically) before the decision.
    let clock = 0;
    const supervisor = new Supervisor({
      gateway: harness.server.gateway,
      manager: harness.server.manager,
      repo: harness.repo,
      logger: harness.server.logger,
      metrics: harness.server.metrics,
      inputsFor,
      now: () => {
        clock += 5000;
        return clock;
      },
      listSessions: async () => [
        (await requireHarness(harness).repo.getSession("src")) as SessionMetaItem,
      ],
    });

    const reconnected = await supervisor.reconnect();
    expect(reconnected).toEqual(["src"]);

    // Handlers re-registered BEFORE load.
    expect(registerSpy).toHaveBeenCalled();
    expect(order.indexOf("registerHandlers")).toBeLessThan(order.indexOf("loadSession"));

    // Re-sent inputs include cwd + additionalDirectories + mcpServers.
    const loadInputs = loadSpy.mock.calls[0]?.[1] as SessionInputs;
    expect(loadInputs.cwd).toBe("/workspace/project");
    expect(loadInputs.additionalDirectories).toEqual(["/workspace/shared"]);
    expect(loadInputs.mcpServers).toEqual([{ name: "example", command: "x" }]);

    // AcpRestarts metric emitted on reconnect.
    expect(harness.metrics.sum("AcpRestarts")).toBe(1);

    // The in-flight turn was marked failed with reason transport_lost (replay
    // did NOT show completion) and the prompt was NEVER resent.
    const turn = await harness.repo.getTurn("src", "turn-live");
    expect(turn?.status).toBe("failed");
    expect(turn?.stopReason).toBe(TRANSPORT_LOST_REASON);
    const promptResent = harness.logLines.some((l) => l.includes("fakeAgentPromptCalled"));
    expect(promptResent).toBe(false);
  });

  test("an in-flight turn that replay shows completed is NOT marked transport_lost", async () => {
    harness = await createHarness({
      newSessionId: "cloud-rc2",
      initialize: initResult(),
      onPrompt: { response: { stopReason: "end_turn" } },
    });
    await harness.server.start();

    const session = await harness.seedSession("src2", {
      status: "running",
      kiroSessionId: "cloud-rc2",
      activeTurnId: "turn-done",
    });
    await harness.repo.putTurn({
      PK: session.PK,
      SK: "TURN#turn-done",
      id: "turn-done",
      sessionId: "src2",
      prompt: "p",
      status: "running",
      stopReason: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      metering: null,
    });
    // Pre-seed a replayed turn.completed event for this turn.
    await harness.repo.appendEvent("src2", {
      turnId: "turn-done",
      ts: new Date().toISOString(),
      type: "turn.completed",
      rawType: "session_info_update",
      replay: true,
      payload: { type: "turn.completed" },
    });

    vi.spyOn(harness.server.gateway, "loadSession").mockResolvedValue({ sessionId: "cloud-rc2" });

    const supervisor = new Supervisor({
      gateway: harness.server.gateway,
      manager: harness.server.manager,
      repo: harness.repo,
      logger: harness.server.logger,
      metrics: harness.server.metrics,
      inputsFor,
      listSessions: async () => [
        (await requireHarness(harness).repo.getSession("src2")) as SessionMetaItem,
      ],
    });
    await supervisor.reconnect();

    const turn = await harness.repo.getTurn("src2", "turn-done");
    // Replay showed completion -> NOT marked transport_lost.
    expect(turn?.stopReason).not.toBe(TRANSPORT_LOST_REASON);
    expect(turn?.status).toBe("running");
  });

  test("replay completion delivered live on load (not pre-seeded) settles without transport_lost", async () => {
    // The completion arrives ONLY as an async session/update emitted by the
    // agent on session/load -- it is NOT pre-seeded and loadSession is NOT
    // mocked. The supervisor must await replay draining before reading the log;
    // a synchronous read would race the un-landed completion and misclassify the
    // turn as transport_lost.
    const replayCompletion = {
      sessionUpdate: "session_info_update",
      status: "end_turn",
      _meta: { kiro: { kind: "turn_completion", replay: true } },
    };
    harness = await createHarness({
      newSessionId: "cloud-rc3",
      initialize: initResult(),
      onLoad: {
        messages: [{ kind: "notify", method: "session/update", params: replayCompletion }],
      },
      onPrompt: { response: { stopReason: "end_turn" } },
    });
    await harness.server.start();

    const session = await harness.seedSession("src3", {
      status: "running",
      kiroSessionId: "cloud-rc3",
      activeTurnId: "turn-live-3",
    });
    await harness.repo.putTurn({
      PK: session.PK,
      SK: "TURN#turn-live-3",
      id: "turn-live-3",
      sessionId: "src3",
      prompt: "the original prompt",
      status: "running",
      stopReason: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      metering: null,
    });

    const supervisor = new Supervisor({
      gateway: harness.server.gateway,
      manager: harness.server.manager,
      repo: harness.repo,
      logger: harness.server.logger,
      metrics: harness.server.metrics,
      inputsFor,
      listSessions: async () => [
        (await requireHarness(harness).repo.getSession("src3")) as SessionMetaItem,
      ],
    });
    await supervisor.reconnect();

    // Replay (drained before the decision) showed completion -> NOT transport_lost.
    const turn = await harness.repo.getTurn("src3", "turn-live-3");
    expect(turn?.stopReason).not.toBe(TRANSPORT_LOST_REASON);
    expect(turn?.status).toBe("running");
    const promptResent = harness.logLines.some((l) => l.includes("fakeAgentPromptCalled"));
    expect(promptResent).toBe(false);
  });

  test("duplicate replay updates are deduped by toolCallId+content", async () => {
    harness = await createHarness({
      newSessionId: "cloud-dd",
      initialize: initResult(),
      onPrompt: { response: { stopReason: "end_turn" } },
    });
    await harness.server.start();
    await harness.seedSession("sdd", { status: "running", kiroSessionId: "cloud-dd" });
    // Register the runtime so the deduper is active for this session.
    harness.server.manager.registerLoaded("sdd", "cloud-dd", { cwd: "/workspace/project" });

    const replay = {
      sessionUpdate: "tool_call",
      toolCallId: "call-99",
      title: "edit",
      status: "completed",
      _meta: { kiro: { replay: true } },
    };
    await harness.server.manager.handleUpdate("cloud-dd", replay);
    await harness.server.manager.handleUpdate("cloud-dd", replay);

    const events = await harness.repo.queryEvents("sdd", 0, { limit: 100 });
    const toolEvents = events.filter((e) => e.type === "tool.call");
    // Two identical replayed updates -> only ONE persisted.
    expect(toolEvents.length).toBe(1);
  });
});
