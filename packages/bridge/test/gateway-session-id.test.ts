/**
 * Unit tests for AcpGateway's tolerant session-id extraction (Bug A).
 *
 * The real ACP V3 session/new response shape is NOT observable in-sandbox
 * (Docker + kiro-cli unavailable), so AcpGateway.newSession must read the cloud
 * session id from every plausible location and return '' when none is present
 * (so SessionManager's late adoption can recover it from the first update).
 *
 * We drive the gateway with a STUB transport implementing just the surface the
 * gateway uses (request / onNotification / onRequest) whose request() resolves a
 * crafted session/new result, then assert the extracted id for each shape.
 */

import { describe, expect, test } from "vitest";
import { AcpGateway } from "../src/gateway.ts";
import { createLogger } from "../src/logger.ts";
import type { StdioJsonRpcTransport } from "../src/transport.ts";

/** A minimal transport whose request() returns a fixed result for session/new. */
function stubTransport(newSessionResult: unknown): StdioJsonRpcTransport {
  const t = {
    onNotification: () => {},
    onRequest: () => {},
    request: async (method: string) => {
      if (method === "session/new") {
        return newSessionResult;
      }
      return {};
    },
  };
  return t as unknown as StdioJsonRpcTransport;
}

function makeGateway(newSessionResult: unknown): AcpGateway {
  return new AcpGateway({
    transport: stubTransport(newSessionResult),
    logger: createLogger({ sink: () => {}, level: "debug" }),
    hooks: {
      onSessionUpdate: () => {},
      onPermissionRequested: () => {},
      onAgentNotification: () => {},
    },
  });
}

const INPUTS = { cwd: "/workspace", mcpServers: [] };

describe("AcpGateway.newSession extractSessionId", () => {
  test("reads a top-level result.sessionId", async () => {
    const gw = makeGateway({ sessionId: "sess_top-level" });
    const { sessionId } = await gw.newSession(INPUTS);
    expect(sessionId).toBe("sess_top-level");
  });

  test("reads a nested result.session.sessionId", async () => {
    const gw = makeGateway({ session: { sessionId: "sess_nested-session" } });
    const { sessionId } = await gw.newSession(INPUTS);
    expect(sessionId).toBe("sess_nested-session");
  });

  test("reads a nested result.session.id", async () => {
    const gw = makeGateway({ session: { id: "sess_nested-id" } });
    const { sessionId } = await gw.newSession(INPUTS);
    expect(sessionId).toBe("sess_nested-id");
  });

  test("reads result._meta.kiro.sessionId", async () => {
    const gw = makeGateway({ _meta: { kiro: { sessionId: "sess_meta-kiro" } } });
    const { sessionId } = await gw.newSession(INPUTS);
    expect(sessionId).toBe("sess_meta-kiro");
  });

  test("reads result._meta.kiro.id", async () => {
    const gw = makeGateway({ _meta: { kiro: { id: "sess_meta-kiro-id" } } });
    const { sessionId } = await gw.newSession(INPUTS);
    expect(sessionId).toBe("sess_meta-kiro-id");
  });

  test("reads a top-level result.id", async () => {
    const gw = makeGateway({ id: "sess_top-id" });
    const { sessionId } = await gw.newSession(INPUTS);
    expect(sessionId).toBe("sess_top-id");
  });

  test("returns '' when no id is present (does NOT throw)", async () => {
    const gw = makeGateway({ somethingElse: true });
    const { sessionId } = await gw.newSession(INPUTS);
    expect(sessionId).toBe("");
  });

  test("returns '' for a non-object result", async () => {
    const gw = makeGateway(null);
    const { sessionId } = await gw.newSession(INPUTS);
    expect(sessionId).toBe("");
  });

  test("prefers the top-level sessionId over nested locations", async () => {
    const gw = makeGateway({
      sessionId: "sess_primary",
      session: { sessionId: "sess_secondary" },
      _meta: { kiro: { sessionId: "sess_tertiary" } },
      id: "sess_quaternary",
    });
    const { sessionId } = await gw.newSession(INPUTS);
    expect(sessionId).toBe("sess_primary");
  });

  test("skips empty strings and falls through to the next location", async () => {
    const gw = makeGateway({ sessionId: "", session: { sessionId: "sess_fallthrough" } });
    const { sessionId } = await gw.newSession(INPUTS);
    expect(sessionId).toBe("sess_fallthrough");
  });
});
