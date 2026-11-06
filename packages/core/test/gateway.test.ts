import { describe, expect, it } from "vitest";
import {
  JSONRPC_METHOD_NOT_FOUND,
  methodNotFound,
  planReconnect,
  replyForUnknownRequest,
} from "../src/index.ts";

describe("unknown agent-to-client requests get a JSON-RPC error", () => {
  it("returns a method-not-found error for an unknown method", () => {
    const reply = replyForUnknownRequest(7, "_kiro/some/future/method");
    expect(reply).not.toBeNull();
    expect(reply?.error.code).toBe(JSONRPC_METHOD_NOT_FOUND);
    expect(reply?.id).toBe(7);
  });

  it("returns null (route to handler) for a known method", () => {
    expect(replyForUnknownRequest(7, "session/request_permission")).toBeNull();
    expect(replyForUnknownRequest(7, "session/update")).toBeNull();
    expect(replyForUnknownRequest(7, "_kiro/openExternalUrl")).toBeNull();
  });

  it("methodNotFound builds a well-formed error object", () => {
    const err = methodNotFound(null, "x");
    expect(err).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: JSONRPC_METHOD_NOT_FOUND, message: "method not found: x" },
    });
  });
});

describe("reconnect plan never resends a prompt", () => {
  const inputs = { cwd: "/w", additionalDirectories: ["/s"], mcpServers: [] };

  it("registers the update handler first and resendPrompt is always false", () => {
    const plan = planReconnect({ inputs, source: "remote" });
    expect(plan.registerUpdateHandlerFirst).toBe(true);
    expect(plan.resendPrompt).toBe(false);
  });

  it("never uses noReplay for a remote session", () => {
    expect(planReconnect({ inputs, source: "remote" }).noReplay).toBe(false);
  });

  it("re-sends client-owned inputs (mcpServers not persisted by V3)", () => {
    const plan = planReconnect({ inputs, source: "local" });
    expect(plan.loadInputs).toEqual(inputs);
    expect(plan.resendPrompt).toBe(false);
  });
});
