/**
 * Tool catalog, schema parity, annotations, and scope-mapping tests.
 */

import { requiredScope, toMcpInputSchema } from "@nikovirtala/kiro-remote-core";
import { describe, expect, it } from "vitest";
import { CORE_SCHEMA_FOR_TOOL, TOOL_DEFS, TOOL_NAMES, toolListEntries } from "../src/tools.ts";

const EXPECTED_TOOLS = [
  "kiro_capabilities",
  "kiro_list_models",
  "kiro_launch_session",
  "kiro_list_sessions",
  "kiro_adopt_session",
  "kiro_get_session",
  "kiro_send_prompt",
  "kiro_wait_for_events",
  "kiro_get_transcript",
  "kiro_list_permissions",
  "kiro_answer_permission",
  "kiro_set_config",
  "kiro_link_pull_request",
  "kiro_unlink_pull_request",
  "kiro_cancel_turn",
  "kiro_delete_session",
];

const READ_TOOLS = new Set([
  "kiro_capabilities",
  "kiro_list_models",
  "kiro_list_sessions",
  "kiro_get_session",
  "kiro_wait_for_events",
  "kiro_get_transcript",
  "kiro_list_permissions",
]);

describe("tool catalog", () => {
  it("exposes exactly the 16 named tools in a stable order", () => {
    expect(TOOL_NAMES).toEqual(EXPECTED_TOOLS);
    expect(TOOL_DEFS).toHaveLength(16);
  });

  it("sets readOnlyHint on read tools and not on write tools", () => {
    for (const def of TOOL_DEFS) {
      if (READ_TOOLS.has(def.name)) {
        expect(def.annotations.readOnlyHint, def.name).toBe(true);
      } else {
        expect(def.annotations.readOnlyHint ?? false, def.name).toBe(false);
      }
    }
  });

  it("sets destructiveHint ONLY on kiro_delete_session and kiro_cancel_turn", () => {
    const destructive = TOOL_DEFS.filter((t) => t.annotations.destructiveHint === true).map(
      (t) => t.name,
    );
    expect(destructive.sort()).toEqual(["kiro_cancel_turn", "kiro_delete_session"]);
  });

  it("maps each tool to the expected core action", () => {
    const byName = Object.fromEntries(TOOL_DEFS.map((t) => [t.name, t.action]));
    expect(byName.kiro_capabilities).toBe("read");
    expect(byName.kiro_list_models).toBe("read");
    expect(byName.kiro_launch_session).toBe("launch");
    expect(byName.kiro_list_sessions).toBe("read");
    expect(byName.kiro_adopt_session).toBe("launch");
    expect(byName.kiro_get_session).toBe("read");
    expect(byName.kiro_send_prompt).toBe("prompt");
    expect(byName.kiro_wait_for_events).toBe("read");
    expect(byName.kiro_get_transcript).toBe("read");
    expect(byName.kiro_list_permissions).toBe("read");
    expect(byName.kiro_answer_permission).toBe("answerPermission");
    expect(byName.kiro_set_config).toBe("config");
    expect(byName.kiro_link_pull_request).toBe("link");
    expect(byName.kiro_unlink_pull_request).toBe("link");
    expect(requiredScope("link")).toBe("sessions:write");
    expect(byName.kiro_cancel_turn).toBe("cancel");
    expect(byName.kiro_delete_session).toBe("delete");
  });
});

describe("schema parity with the core zod objects", () => {
  it("directly-mapped tools advertise exactly the core object's generated schema", () => {
    const direct = ["kiro_launch_session", "kiro_list_sessions", "kiro_adopt_session"];
    const entries = Object.fromEntries(toolListEntries().map((e) => [e.name, e.inputSchema]));
    for (const name of direct) {
      const core = CORE_SCHEMA_FOR_TOOL[name];
      expect(entries[name], name).toEqual(toMcpInputSchema(core));
    }
  });

  it("augmented tools never diverge from core on the core fields", () => {
    const entries = Object.fromEntries(toolListEntries().map((e) => [e.name, e.inputSchema]));
    for (const [toolName, coreSchema] of Object.entries(CORE_SCHEMA_FOR_TOOL)) {
      const coreProps = (toMcpInputSchema(coreSchema).properties ?? {}) as Record<string, unknown>;
      const toolProps = (entries[toolName].properties ?? {}) as Record<string, unknown>;
      for (const [field, schema] of Object.entries(coreProps)) {
        // wait_for_events intentionally drops the server-fixed `wait` field.
        if (toolName === "kiro_wait_for_events" && field === "wait") {
          continue;
        }
        expect(toolProps[field], `${toolName}.${field}`).toEqual(schema);
      }
    }
  });

  it("every tool advertises an object JSON Schema", () => {
    for (const entry of toolListEntries()) {
      expect(entry.inputSchema.type, entry.name).toBe("object");
    }
  });
});

describe("scope mapping matches core requiredScope", () => {
  it("each tool's action resolves to the expected scope", () => {
    const scopeFor = Object.fromEntries(TOOL_DEFS.map((t) => [t.name, requiredScope(t.action)]));
    expect(scopeFor.kiro_get_session).toBe("sessions:read");
    expect(scopeFor.kiro_launch_session).toBe("sessions:write");
    expect(scopeFor.kiro_send_prompt).toBe("sessions:write");
    expect(scopeFor.kiro_set_config).toBe("sessions:write");
    expect(scopeFor.kiro_answer_permission).toBe("sessions:write");
    expect(scopeFor.kiro_cancel_turn).toBe("sessions:write");
    expect(scopeFor.kiro_delete_session).toBe("sessions:delete");
  });
});

describe("link tools", () => {
  const calls: Array<[string, unknown[]]> = [];
  const client = {
    async linkPullRequest(_p: unknown, sessionId: string, args: { pr: string }) {
      calls.push(["link", [sessionId, args]]);
      return { pr: "octo/repo#7", linkedBy: "manual" };
    },
    async unlinkPullRequest(_p: unknown, sessionId: string, args: { pr: string }) {
      calls.push(["unlink", [sessionId, args]]);
    },
  } as never;
  const principal = { sub: "u", clientId: "c", scopes: ["sessions:write"] } as never;

  it("kiro_link_pull_request links through the client and returns the link", async () => {
    const tool = TOOL_DEFS.find((t) => t.name === "kiro_link_pull_request");
    const out = await tool?.run(client, principal, { sessionId: "S1", pr: "octo/repo#7" });
    expect(out).toEqual({ sessionId: "S1", link: { pr: "octo/repo#7", linkedBy: "manual" } });
    expect(calls).toContainEqual(["link", ["S1", { pr: "octo/repo#7" }]]);
  });

  it("kiro_unlink_pull_request unlinks through the client", async () => {
    const tool = TOOL_DEFS.find((t) => t.name === "kiro_unlink_pull_request");
    const out = await tool?.run(client, principal, { sessionId: "S1", pr: "octo/repo#7" });
    expect(out).toMatchObject({ sessionId: "S1", status: "unlinked" });
    expect(calls).toContainEqual(["unlink", ["S1", { pr: "octo/repo#7" }]]);
  });

  it("rejects something that is not a pull request reference", async () => {
    const tool = TOOL_DEFS.find((t) => t.name === "kiro_link_pull_request");
    await expect(tool?.run(client, principal, { sessionId: "S1", pr: "nope" })).rejects.toThrow();
  });
});
