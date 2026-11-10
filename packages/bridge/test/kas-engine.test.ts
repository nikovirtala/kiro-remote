/**
 * Tests for the direct KAS engine client: the spawn spec it builds and the
 * ACP shapes it sends, driven against the fake ACP agent as a real child.
 */

import { describe, expect, test } from "vitest";
import {
  CLIENT_INFO,
  KAS_NODE_PATH,
  KAS_SERVER_PATH,
  KasEngine,
  KIRO_APP_ENDPOINT,
  kasSpawnSpec,
} from "../src/kas-engine.ts";
import { createLogger } from "../src/logger.ts";
import { defaultSpawn, type SpawnFn } from "../src/transport.ts";
import { echoed, exited, fakeAgentSpawner } from "./fake-agent-spawn.ts";
import { initResult } from "./scenarios.ts";

function engineFor(scenario: unknown, rpcTimeoutMs?: number) {
  const logLines: string[] = [];
  const logger = createLogger({ level: "debug", sink: (l) => logLines.push(l) });
  const spawner = fakeAgentSpawner([scenario]);
  const engine = new KasEngine({
    spec: kasSpawnSpec({ env: {}, apiKey: "ksk_test_key" }),
    spawnFn: spawner.spawnFn,
    logger,
    ...(rpcTimeoutMs !== undefined ? { rpcTimeoutMs } : {}),
  });
  return { engine, logLines, spawner };
}

function update(sessionUpdate: string, extra: Record<string, unknown> = {}) {
  return { kind: "notify", method: "session/update", params: { sessionUpdate, ...extra } };
}

describe("kasSpawnSpec", () => {
  test("defaults to the image paths and the app endpoint", () => {
    const spec = kasSpawnSpec({ env: {}, apiKey: "ksk_test_key" });
    expect(spec.command).toBe(KAS_NODE_PATH);
    expect(spec.args).toEqual([
      "--experimental-wasm-modules",
      KAS_SERVER_PATH,
      "--transport=stdio",
    ]);
    expect(spec.env).toMatchObject({
      HOME: "/tmp",
      KIRO_HOME: "/tmp/.kiro",
      CLOUD_CONFIG_ENDPOINT: KIRO_APP_ENDPOINT,
      KIRO_REMOTE_SESSIONS_ENDPOINT: KIRO_APP_ENDPOINT,
      NODE_USE_SYSTEM_CA: "1",
      KIRO_LOG_LEVEL: "debug",
    });
    expect(spec.env?.KIRO_API_KEY === "ksk_test_key").toBe(true);
  });

  test("reads overrides from env", () => {
    const spec = kasSpawnSpec({
      env: {
        KAS_NODE: "/usr/local/bin/node",
        KAS_SERVER: "/srv/acp-server.js",
        HOME: "/home/u",
        KIRO_LOG_LEVEL: "info",
      },
      apiKey: "ksk_test_key",
    });
    expect(spec.command).toBe("/usr/local/bin/node");
    expect(spec.args[1]).toBe("/srv/acp-server.js");
    expect(spec.env?.HOME).toBe("/home/u");
    expect(spec.env?.KIRO_HOME).toBe("/home/u/.kiro");
    expect(spec.env?.KIRO_LOG_LEVEL).toBe("info");

    const explicitHome = kasSpawnSpec({ env: { KIRO_HOME: "/k" }, apiKey: null });
    expect(explicitHome.env?.KIRO_HOME).toBe("/k");
  });

  test("omits KIRO_API_KEY when no key was resolved", () => {
    const spec = kasSpawnSpec({ env: {}, apiKey: null });
    expect(spec.env).not.toHaveProperty("KIRO_API_KEY");
  });
});

describe("KasEngine", () => {
  test("initialize sends protocolVersion 1, CLIENT_INFO and empty clientCapabilities by default", async () => {
    const { engine, logLines } = engineFor({ initialize: initResult() });
    engine.start();
    try {
      await engine.initialize();
    } finally {
      await engine.stop();
    }
    expect(echoed(logLines, "fakeAgentInitializeParams")).toEqual([
      {
        protocolVersion: 1,
        clientInfo: { name: "kiro-remote-bridge", version: "0.0.0" },
        clientCapabilities: {},
      },
    ]);
    expect(CLIENT_INFO).toEqual({ name: "kiro-remote-bridge", version: "0.0.0" });
  });

  test("initialize forwards the passed clientCapabilities", async () => {
    const { engine, logLines } = engineFor({ initialize: initResult() });
    const clientCapabilities = { _meta: { kiro: { openExternalUrl: true } } };
    engine.start();
    try {
      await engine.initialize(clientCapabilities);
    } finally {
      await engine.stop();
    }
    expect(echoed(logLines, "fakeAgentInitializeParams")).toEqual([
      { protocolVersion: 1, clientInfo: CLIENT_INFO, clientCapabilities },
    ]);
  });

  test("newCloudSession sends the cloud-sandbox _meta and returns the id", async () => {
    const { engine, logLines } = engineFor({
      initialize: initResult(),
      newSessionId: "sess_cloud-1",
    });
    engine.start();
    try {
      await engine.initialize();
      const id = await engine.newCloudSession({ cwd: "/tmp/ws", repos: ["octo/repo"] });
      expect(id).toBe("sess_cloud-1");
    } finally {
      await engine.stop();
    }
    expect(echoed(logLines, "fakeAgentNewSessionParams")).toEqual([
      {
        cwd: "/tmp/ws",
        mcpServers: [],
        _meta: {
          kiro: {
            executionTarget: { kind: "cloud-sandbox" },
            sessionSource: "remote",
            repositories: ["octo/repo"],
          },
        },
      },
    ]);
    expect(logLines.join("\n")).not.toContain("ksk_");
  });

  test("newCloudSession throws when session/new returns no id", async () => {
    const { engine } = engineFor({ initialize: initResult(), emptyNewSessionId: true });
    engine.start();
    try {
      await engine.initialize();
      await expect(engine.newCloudSession({ cwd: "/tmp", repos: [] })).rejects.toThrow(
        /no sessionId/,
      );
    } finally {
      await engine.stop();
    }
  });

  test("loadRemote sends sessionSource remote and delivers the replay before resolving", async () => {
    const { engine, logLines } = engineFor({
      initialize: initResult(),
      onLoad: {
        replayBeforeResponse: true,
        messages: [
          update("agent_message_chunk", { content: { type: "text", text: "earlier" } }),
          update("agent_message_chunk", { content: { type: "text", text: " answer" } }),
        ],
      },
    });
    const seen: [string, unknown][] = [];
    engine.onUpdate((sid, u) => seen.push([sid, u]));
    engine.start();
    try {
      await engine.initialize();
      await engine.loadRemote("sess_cloud-9", "/tmp/ws");
      // Captured synchronously at resolve time: the replay already arrived.
      expect(seen.map(([sid]) => sid)).toEqual(["sess_cloud-9", "sess_cloud-9"]);
    } finally {
      await engine.stop();
    }
    expect(echoed(logLines, "fakeAgentLoadParams")).toEqual([
      {
        sessionId: "sess_cloud-9",
        cwd: "/tmp/ws",
        mcpServers: [],
        _meta: { kiro: { sessionSource: "remote" } },
      },
    ]);
  });

  test("prompt streams updates and returns the stopReason", async () => {
    const { engine, logLines } = engineFor({
      initialize: initResult(),
      onPrompt: {
        messages: [update("agent_message_chunk", { content: { type: "text", text: "hi" } })],
        response: { stopReason: "end_turn" },
      },
    });
    const seen: unknown[] = [];
    const unsubscribe = engine.onUpdate((_sid, u) => seen.push(u));
    engine.start();
    try {
      await engine.initialize();
      const res = await engine.prompt("sess_cloud-1", "do it");
      expect(res).toEqual({ stopReason: "end_turn" });
      expect(seen).toEqual([
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
      ]);
      unsubscribe();
    } finally {
      await engine.stop();
    }
    expect(echoed(logLines, "fakeAgentPromptParams")).toEqual([
      { sessionId: "sess_cloud-1", prompt: [{ type: "text", text: "do it" }] },
    ]);
  });

  test("deleteRemote sends the remote _meta", async () => {
    const { engine, logLines, spawner } = engineFor({ initialize: initResult() });
    engine.start();
    try {
      await engine.initialize();
      await engine.deleteRemote("sess_cloud-1");
    } finally {
      await engine.stop();
    }
    expect(echoed(logLines, "fakeAgentDeleteParams")).toEqual([
      { sessionId: "sess_cloud-1", _meta: { kiro: { sessionSource: "remote" } } },
    ]);
    const child = spawner.children[0];
    if (!child) {
      throw new Error("no child spawned");
    }
    await exited(child);
    expect(child.killed).toBe(true);
  });

  test("an RPC that never answers rejects after rpcTimeoutMs", async () => {
    const logger = createLogger({ level: "error", sink: () => {} });
    // A child that reads stdin and never writes a reply.
    const silent: SpawnFn = () =>
      defaultSpawn({
        command: process.execPath,
        args: ["-e", "process.stdin.resume(); setInterval(() => {}, 1000);"],
      });
    const engine = new KasEngine({
      spec: kasSpawnSpec({ env: {}, apiKey: null }),
      spawnFn: silent,
      logger,
      rpcTimeoutMs: 200,
    });
    engine.start();
    try {
      await expect(engine.initialize()).rejects.toThrow(/initialize timed out after 200 ms/);
    } finally {
      await engine.stop();
    }
  });
});
