import { describe, expect, it } from "vitest";
import { JSONRPC_METHOD_NOT_FOUND, methodNotFound, replyForUnknownRequest } from "../src/index.ts";

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
