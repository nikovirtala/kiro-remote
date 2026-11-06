import { describe, expect, it } from "vitest";
import {
  normalizeRequest,
  normalizeUpdate,
  type PermissionRequestedEvent,
  type RawEvent,
  type ToolUpdateEvent,
} from "../src/index.ts";
import { loadFixture } from "./helpers.ts";

describe("normalizer: migration-guide fixtures", () => {
  it("maps the replay agent_message_chunk fixture and marks replay", () => {
    const fixture = loadFixture<{ params: { sessionId: string; update: unknown } }>(
      "session-update-replay.json",
    );
    const ev = normalizeUpdate(fixture.params.sessionId, fixture.params.update);
    expect(ev.type).toBe("message.chunk");
    expect(ev.replay).toBe(true);
    if (ev.type === "message.chunk") {
      expect(ev.content).toEqual({ type: "text", text: "Previously streamed response" });
    }
    expect(ev.rawType).toBe("agent_message_chunk");
  });

  it("maps the request_permission consent fixture with options verbatim", () => {
    const fx = loadFixture<{ params: Record<string, unknown> }>("request-permission-consent.json");
    const ev = normalizeRequest(
      "session-1",
      "session/request_permission",
      fx.params,
    ) as PermissionRequestedEvent;
    expect(ev.type).toBe("permission.requested");
    expect(ev.toolCallId).toBe("call-1");
    // All four agent-supplied options preserved in order.
    expect(ev.options.map((o) => o.optionId)).toEqual([
      "accept",
      "always-accept",
      "reject",
      "always-reject",
    ]);
    expect(ev.options[1].kind).toBe("allow_always");
    // Consent context carried through.
    expect(ev.consent).toMatchObject({
      capability: "shell",
      resource: "npm run test",
      workspaceRoot: "/workspace/project",
      persistableConsent: true,
    });
  });

  it("maps the request_permission mcpTool fixture preserving omitted-vs-false", () => {
    const fx = loadFixture<{ params: Record<string, unknown> }>("request-permission-mcptool.json");
    const ev = normalizeRequest(
      "session-1",
      "session/request_permission",
      fx.params,
    ) as PermissionRequestedEvent;
    expect(ev.mcpTool?.version).toBe(1);
    expect(ev.mcpTool?.identity).toEqual({ serverName: "example-server", toolName: "search" });
    // Only the two hints present in the fixture exist; the others are omitted.
    expect(ev.mcpTool?.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });
    expect("destructiveHint" in (ev.mcpTool?.annotations ?? {})).toBe(false);
    expect("idempotentHint" in (ev.mcpTool?.annotations ?? {})).toBe(false);
  });
});

describe("normalizer: mcpTool omitted-vs-false", () => {
  it("records explicit false distinctly from omission", () => {
    const ev = normalizeRequest("s", "session/request_permission", {
      toolCall: { toolCallId: "c9" },
      options: [],
      _meta: {
        kiro: {
          mcpTool: {
            version: 1,
            identity: { serverName: "srv", toolName: "t" },
            annotations: { readOnlyHint: false, destructiveHint: true },
          },
        },
      },
    }) as PermissionRequestedEvent;
    expect(ev.mcpTool?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true });
    expect("openWorldHint" in (ev.mcpTool?.annotations ?? {})).toBe(false);
  });
});

describe("normalizer: session_info_update dispatch by kind", () => {
  it("maps context_usage to session.info with the kind", () => {
    const ev = normalizeUpdate("s", {
      sessionUpdate: "session_info_update",
      usagePercentage: 42,
      _meta: { kiro: { kind: "context_usage" } },
    });
    expect(ev.type).toBe("session.info");
    if (ev.type === "session.info") {
      expect(ev.kind).toBe("context_usage");
      expect(ev.payload.usagePercentage).toBe(42);
    }
  });

  it("maps turn_completion to turn.completed carrying status as stopReason", () => {
    const ev = normalizeUpdate("s", {
      sessionUpdate: "session_info_update",
      status: "completed",
      promptTurnSummaries: [{ tokens: 10 }],
      _meta: { kiro: { kind: "turn_completion" } },
    });
    expect(ev.type).toBe("turn.completed");
    if (ev.type === "turn.completed") {
      expect(ev.stopReason).toBe("completed");
    }
  });

  it("maps steering_queued to session.info", () => {
    const ev = normalizeUpdate("s", {
      sessionUpdate: "session_info_update",
      _meta: { kiro: { kind: "steering_queued" } },
    });
    expect(ev.type).toBe("session.info");
  });

  it("falls back to raw when session_info_update has no kind", () => {
    const ev = normalizeUpdate("s", { sessionUpdate: "session_info_update" });
    expect(ev.type).toBe("raw");
  });
});

describe("normalizer: tool events keyed by toolCallId", () => {
  it("keys tool_call by toolCallId not title", () => {
    const ev = normalizeUpdate("s", {
      sessionUpdate: "tool_call",
      toolCallId: "tc-1",
      title: "Deceptive Title",
      status: "pending",
    });
    expect(ev.type).toBe("tool.call");
    if (ev.type === "tool.call") {
      expect(ev.toolCallId).toBe("tc-1");
    }
  });

  it("maps _meta.kiro.failureReason on tool_call_update", () => {
    const ev = normalizeUpdate("s", {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-1",
      status: "failed",
      _meta: { kiro: { failureReason: "denied" } },
    }) as ToolUpdateEvent;
    expect(ev.failureReason).toBe("denied");
  });

  it("maps an unknown failureReason to generic", () => {
    const ev = normalizeUpdate("s", {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-1",
      status: "failed",
      _meta: { kiro: { failureReason: "weird" } },
    }) as ToolUpdateEvent;
    expect(ev.failureReason).toBe("generic");
  });
});

describe("normalizer: unknown inputs become raw with payload preserved", () => {
  it("maps an unknown update type to raw and counts it", () => {
    let count = 0;
    const original = { sessionUpdate: "totally_new_thing", data: { a: 1 } };
    const ev = normalizeUpdate("s", original, {
      hooks: { onUnmapped: () => count++ },
    }) as RawEvent;
    expect(ev.type).toBe("raw");
    expect(ev.rawType).toBe("totally_new_thing");
    expect(ev.payload).toEqual(original);
    expect(count).toBe(1);
  });

  it("maps an unknown agent-to-client request to raw and counts it", () => {
    let count = 0;
    const ev = normalizeRequest(
      "s",
      "_kiro/brand_new/method",
      { x: 1 },
      {
        hooks: { onUnmapped: () => count++ },
      },
    ) as RawEvent;
    expect(ev.type).toBe("raw");
    expect(ev.rawType).toBe("_kiro/brand_new/method");
    expect(ev.payload).toEqual({ x: 1 });
    expect(count).toBe(1);
  });

  it("maps _kiro/mcp/status to a full-snapshot mcp.status event", () => {
    const ev = normalizeRequest("s", "_kiro/mcp/status", {
      servers: [{ name: "a", state: "connected" }],
    });
    expect(ev.type).toBe("mcp.status");
  });
});
