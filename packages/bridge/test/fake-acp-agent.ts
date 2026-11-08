#!/usr/bin/env node
/**
 * A FAKE scripted ACP V3 agent.
 *
 * This is a real child process (spawned by the bridge transport in tests) that
 * speaks newline-delimited JSON-RPC 2.0 over stdin/stdout, exactly like
 * `kiro-cli acp --agent-engine=v3`, but replays a scripted conversation instead
 * of talking to Kiro. No real kiro-cli is involved.
 *
 * The SCENARIO is read from the FAKE_ACP_SCENARIO env var (a JSON document):
 *  - `initialize`: the result to return (extensionMethods, executionTargets,
 *    configOptions, modes, ...).
 *  - `onPrompt`: for each session/prompt, a list of agent-to-client messages to
 *    emit (session/update notifications, session/request_permission requests,
 *    replay-marked updates, rate_limit, unknown update types) BEFORE the prompt
 *    response resolves, plus the prompt `response`.
 *  - `emitTurnEndBeforeResponse`: when true, a session_info_update with
 *    _meta.kiro.kind "turn_end" is emitted before the prompt response (to prove
 *    it does NOT settle the turn).
 *  - `sendUnknownRequest`: when true, the agent issues an unknown agent-to-client
 *    request with an id and asserts it gets a JSON-RPC error (the client must
 *    not hang). The agent writes the received error to stderr for the test.
 *  - `onLoad`: replay updates to emit when session/load is called.
 *
 * The agent is intentionally dumb: it does whatever the scenario says. This
 * keeps every bridge behavior test-driven without Kiro.
 */

import { createInterface } from "node:readline";

interface ScriptedMessage {
  /** "notify" -> a session/update or other notification; "request" -> needs a reply. */
  kind: "notify" | "request";
  method: string;
  params: unknown;
}

interface Scenario {
  initialize: Record<string, unknown>;
  newSessionId?: string;
  /**
   * Bug A reproduction: when true, session/new returns NO sessionId (empty
   * result) and the agent instead routes all session/update + _kiro/sessions/
   * changed under `freshCloudId` (a fresh sess_<uuid>), exactly like the live
   * agent that never echoes the id session/new is keyed on.
   */
  emptyNewSessionId?: boolean;
  /** The fresh cloud id the agent routes updates under when emptyNewSessionId. */
  freshCloudId?: string;
  /** Emit a _kiro/sessions/changed notification (carrying the id) on session/new. */
  emitSessionsChangedOnNew?: boolean;
  onPrompt?: {
    messages?: ScriptedMessage[];
    emitTurnEndBeforeResponse?: boolean;
    response?: { stopReason?: string };
    /** When set, the agent does NOT resolve the prompt until a steer arrives. */
    waitForSteer?: boolean;
  };
  onLoad?: { messages?: ScriptedMessage[] };
  sendUnknownRequest?: boolean;
  /** Delay (ms) before the prompt response resolves (to interleave messages). */
  promptDelayMs?: number;
  /** Hold the prompt response until a permission reply arrives from the client. */
  waitForPermissionReply?: boolean;
}

const scenario: Scenario = JSON.parse(process.env.FAKE_ACP_SCENARIO ?? "{}");

let outRequestId = 10000;
const pendingClientReplies = new Map<number, string>();

function send(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function emitScripted(messages: ScriptedMessage[], sessionId: string): void {
  for (const m of messages) {
    if (m.kind === "notify") {
      const params =
        m.method === "session/update"
          ? { sessionId, update: m.params }
          : { sessionId, ...(m.params as Record<string, unknown>) };
      send({ jsonrpc: "2.0", method: m.method, params });
    } else {
      const id = outRequestId++;
      pendingClientReplies.set(id, m.method);
      const params = { sessionId, ...(m.params as Record<string, unknown>) };
      send({ jsonrpc: "2.0", id, method: m.method, params });
    }
  }
}

const rl = createInterface({ input: process.stdin });

let lastSessionId = scenario.newSessionId ?? "cloud-session-1";
let steerResolver: (() => void) | null = null;
let permissionResolver: (() => void) | null = null;

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  // A reply to one of OUR agent-to-client requests.
  if (msg.method === undefined && msg.id !== undefined) {
    const id = msg.id as number;
    const method = pendingClientReplies.get(id);
    if (method) {
      pendingClientReplies.delete(id);
      // Echo back what we received so the test can assert handling.
      process.stderr.write(`${JSON.stringify({ fakeAgentReplyFor: method, id, body: msg })}\n`);
      // A permission reply can release a held prompt response.
      if (method === "session/request_permission" && permissionResolver) {
        const r = permissionResolver;
        permissionResolver = null;
        setTimeout(r, 0);
      }
    }
    return;
  }

  const method = msg.method as string;
  const id = msg.id;
  const params = (msg.params ?? {}) as Record<string, unknown>;

  switch (method) {
    case "initialize":
      send({ jsonrpc: "2.0", id, result: scenario.initialize });
      return;

    case "session/new": {
      // Echo the received params so a test can assert what the client sent
      // (cwd/additionalDirectories/mcpServers/_meta.kiro incl. repos).
      process.stderr.write(`${JSON.stringify({ fakeAgentNewSessionParams: params })}\n`);
      if (scenario.emptyNewSessionId) {
        // Bug A: the live agent does NOT return a usable id on session/new. It
        // picks a fresh cloud id and routes everything under it. Our control
        // plane must adopt that id from the first update / sessions/changed.
        lastSessionId = scenario.freshCloudId ?? "sess_fresh-cloud-1";
        send({ jsonrpc: "2.0", id, result: {} });
        if (scenario.emitSessionsChangedOnNew) {
          send({
            jsonrpc: "2.0",
            method: "_kiro/sessions/changed",
            params: { sessions: [{ sessionId: lastSessionId }] },
          });
        }
        return;
      }
      send({ jsonrpc: "2.0", id, result: { sessionId: lastSessionId } });
      return;
    }

    case "session/load":
      lastSessionId = String(params.sessionId ?? lastSessionId);
      send({ jsonrpc: "2.0", id, result: { sessionId: lastSessionId } });
      // Emit replay updates on load, if scripted.
      if (scenario.onLoad?.messages) {
        emitScripted(scenario.onLoad.messages, lastSessionId);
      }
      return;

    case "session/prompt": {
      process.stderr.write(`${JSON.stringify({ fakeAgentPromptCalled: true })}\n`);
      // Bug A: the live agent always routes updates under its OWN fresh cloud id,
      // not the id the client prompted with. When reproducing that, ignore the
      // incoming sessionId and use the fresh id so adoption must happen.
      const sid = scenario.emptyNewSessionId
        ? lastSessionId
        : String(params.sessionId ?? lastSessionId);
      const onPrompt = scenario.onPrompt ?? {};
      if (onPrompt.messages) {
        emitScripted(onPrompt.messages, sid);
      }
      // Optionally issue an unknown agent-to-client request mid-turn.
      if (scenario.sendUnknownRequest) {
        const uid = outRequestId++;
        pendingClientReplies.set(uid, "_kiro/totally/unknown");
        send({
          jsonrpc: "2.0",
          id: uid,
          method: "_kiro/totally/unknown",
          params: { sessionId: sid },
        });
      }
      // Optionally emit a turn_end info update BEFORE responding (must not settle).
      if (onPrompt.emitTurnEndBeforeResponse) {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: sid,
            update: {
              sessionUpdate: "session_info_update",
              _meta: { kiro: { kind: "turn_end" } },
            },
          },
        });
      }
      const respond = (): void => {
        send({ jsonrpc: "2.0", id, result: onPrompt.response ?? { stopReason: "end_turn" } });
      };
      if (onPrompt.waitForSteer) {
        steerResolver = respond;
      } else if (scenario.waitForPermissionReply) {
        permissionResolver = respond;
      } else {
        const delay = scenario.promptDelayMs ?? 0;
        if (delay > 0) {
          setTimeout(respond, delay);
        } else {
          respond();
        }
      }
      return;
    }

    case "_session/steer":
      send({ jsonrpc: "2.0", id, result: {} });
      // A steer may release a prompt that was waiting.
      if (steerResolver) {
        const r = steerResolver;
        steerResolver = null;
        setTimeout(r, 0);
      }
      return;

    case "session/cancel":
      send({ jsonrpc: "2.0", id, result: {} });
      // After cancel, resolve the waiting prompt (its response is what settles
      // the turn as cancelled -- the client WAITS for it).
      if (steerResolver) {
        const r = steerResolver;
        steerResolver = null;
        setTimeout(r, 0);
      }
      return;

    case "session/set_config_option":
    case "session/set_mode":
      send({ jsonrpc: "2.0", id, result: {} });
      return;

    case "session/list":
      send({ jsonrpc: "2.0", id, result: { sessions: [{ sessionId: "cloud-adopted-1" }] } });
      return;

    default:
      // Unknown client-to-agent request: respond with method not found.
      if (id !== undefined) {
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `method not found: ${method}` },
        });
      }
      return;
  }
});
