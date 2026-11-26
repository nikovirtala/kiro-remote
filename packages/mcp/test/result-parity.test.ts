/**
 * The rule every result of this server holds: when a result has both
 * `structuredContent` and a text content block, `structuredContent` holds every
 * piece of information the text block has.
 *
 * Why: some hosts (claude.ai) show the model only `structuredContent` and drop
 * the text block, which the MCP spec treats as a copy of `structuredContent` for
 * older clients. A host that does so must lose nothing.
 *
 * "Holds" is checked per block: a text block that is JSON must equal the
 * structured content; a text block that is prose must be the value of one of its
 * string fields. The rule is run over every tool (tools.ts outcomes through
 * callTool) and over every result the Tasks module builds.
 */

import { describe, expect, it } from "vitest";
import { callTool } from "../src/server.ts";
import { completedResult, TurnTaskStore } from "../src/tasks/index.ts";
import { TOOL_NAMES } from "../src/tools.ts";
import { buildInProcess, type InProcHarness } from "./helpers.ts";
import { NOW, P, putTurn, taskIdFor } from "./tasks-fixtures.ts";

interface Result {
  content?: ReadonlyArray<{ type: string; text?: string }>;
  structuredContent?: unknown;
}

/** Every string value anywhere inside a JSON value. */
function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
}

/** Why a text block's information is not all in `structured`, or `undefined` when it is. */
function lostByStructuredOnly(text: string, structured: unknown): string | undefined {
  // A JSON copy of the structured content: nothing may differ.
  try {
    if (JSON.stringify(JSON.parse(text)) === JSON.stringify(structured)) return undefined;
  } catch {
    // Not JSON: prose, which must be a value in structuredContent.
  }
  return stringsIn(structured).includes(text)
    ? undefined
    : `the text block ${JSON.stringify(text)} is not in structuredContent`;
}

/** Check the rule on one result; returns the problems (empty when it holds). */
function ruleProblems(result: Result): string[] {
  const texts = (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "");
  if (result.structuredContent === undefined || texts.length === 0) return [];
  return texts.flatMap((t) => lostByStructuredOnly(t, result.structuredContent) ?? []);
}

/** The results checked, for the summary line at the end. */
const checked: string[] = [];

function expectRule(name: string, result: Result) {
  checked.push(name);
  expect(ruleProblems(result), name).toEqual([]);
}

/* ------------------------------- the checker ------------------------------- */

describe("the rule checker", () => {
  it("fails the result a Tasks client got before the fix: text only in the text block", () => {
    const before = {
      content: [{ type: "text", text: "ok" }],
      structuredContent: { sessionId: "s", turnId: "t", status: "completed" },
    };
    expect(ruleProblems(before)).toHaveLength(1);
  });

  it("passes prose that is a field of structuredContent, and JSON that is a copy of it", () => {
    expect(
      ruleProblems({
        content: [{ type: "text", text: "ok" }],
        structuredContent: { status: "completed", text: "ok" },
      }),
    ).toEqual([]);
    expect(
      ruleProblems({
        content: [{ type: "text", text: '{"a":[1,2]}' }],
        structuredContent: { a: [1, 2] },
      }),
    ).toEqual([]);
  });

  it("fails JSON text that holds more than structuredContent", () => {
    expect(
      ruleProblems({
        content: [{ type: "text", text: '{"a":1,"b":2}' }],
        structuredContent: { a: 1 },
      }),
    ).toHaveLength(1);
  });

  it("has nothing to check on a result without structuredContent or without text", () => {
    expect(ruleProblems({ content: [{ type: "text", text: "boom" }] })).toEqual([]);
    expect(ruleProblems({ content: [], structuredContent: { a: 1 } })).toEqual([]);
  });
});

/* ------------------------------ every tool ------------------------------ */

/** The arguments for each tool, against the state {@link seeded} leaves. */
const TOOL_CALLS: Record<string, Record<string, unknown>> = {
  kiro_capabilities: {},
  kiro_list_models: {},
  kiro_launch_session: { prompt: "go", repos: ["acme/app"] },
  kiro_list_sessions: {},
  kiro_adopt_session: { kiroSessionId: "kiro-sess-1" },
  kiro_get_session: { sessionId: "s1" },
  kiro_send_prompt: { sessionId: "s1", prompt: "go", whenBusy: "queue" },
  kiro_wait_for_events: { sessionId: "s1", after: 0 },
  kiro_get_transcript: { sessionId: "s1" },
  kiro_list_permissions: { sessionId: "s1" },
  kiro_answer_permission: { sessionId: "s1", requestId: "r1", optionId: "allow" },
  kiro_set_config: { sessionId: "s1", model: "m1" },
  kiro_link_pull_request: { sessionId: "s1", pr: "acme/app#7" },
  kiro_unlink_pull_request: { sessionId: "s1", pr: "acme/app#7" },
  kiro_wait_for_pull_request: { sessionId: "s1", pr: "other/repo#43" },
  kiro_stop_waiting_for_pull_request: { sessionId: "s1", pr: "other/repo#43" },
  kiro_list_events: {},
  kiro_cancel_turn: { sessionId: "s1" },
  kiro_delete_session: { sessionId: "s1" },
};

async function seeded(): Promise<InProcHarness> {
  const h = buildInProcess();
  h.seedSession({ id: "s1", status: "running" });
  h.seedEvent("s1", 1, { turnId: "t1", payload: { content: { type: "text", text: "hi" } } });
  h.seedPermission("s1", "r1");
  // So the unlink and stop tools have something to remove.
  await h.client.linkPullRequest(P, "s1", { pr: "acme/app#7" });
  await h.client.waitForPullRequest(P, "s1", { pr: "other/repo#43" });
  return h;
}

describe("every tool outcome (tools.ts, through callTool)", () => {
  it("has a call here for every tool", () => {
    expect(Object.keys(TOOL_CALLS).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it.each(TOOL_NAMES)("%s: structuredContent holds everything the text block has", async (name) => {
    const h = await seeded();
    const outcome = await callTool(h.client, P, name, TOOL_CALLS[name] ?? {});
    // A tool error has text only, which is nothing to lose; every tool here is meant to succeed.
    expect(outcome.isError, `${name}: ${outcome.content[0]?.text}`).toBeUndefined();
    expect(outcome.structuredContent, name).toBeDefined();
    expectRule(name, outcome);
  });

  it("a tool that fails has a text block and no structuredContent", async () => {
    const h = await seeded();
    const outcome = await callTool(h.client, P, "kiro_get_session", { sessionId: "nope" });
    expect(outcome.isError).toBe(true);
    expect(outcome.structuredContent).toBeUndefined();
    expectRule("kiro_get_session (error)", outcome);
  });
});

/* ------------------------------ every task result ------------------------------ */

describe("every result the Tasks module builds", () => {
  const store = (h: InProcHarness) =>
    new TurnTaskStore({ client: h.client, principal: () => P, now: () => NOW });

  it("a completed task: the answer is in both places, equal", async () => {
    const h = buildInProcess();
    const s = h.seedSession({ id: "s1", status: "idle" });
    await putTurn(h, s, "t1", "completed");
    h.seedEvent(s, 1, { turnId: "t1", payload: { content: { type: "text", text: "ok" } } });
    const task = await store(h).get(taskIdFor(s, "t1"));
    const result = (task as { result: Result & { content: { text: string }[] } }).result;
    expect(result.structuredContent).toEqual({
      sessionId: s,
      turnId: "t1",
      status: "completed",
      text: "ok",
    });
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expectRule("tasks/get completed", result);
  });

  it("a completed task holds the rule for any text, JSON-looking or empty", () => {
    const ref = { sessionId: "s1", turnId: "t1", createdAtMs: NOW, ttlMs: null };
    for (const text of ["", "ok", '{"a":1}', "line one\nline two", "123"]) {
      const result = completedResult(ref, text);
      expect(result.structuredContent.text).toBe(text);
      expect(result.content[0]?.text).toBe(text);
      expectRule(`completedResult(${JSON.stringify(text)})`, result);
    }
  });

  it("a failed task carries its reason in the error, and has no result", async () => {
    const h = buildInProcess();
    const s = h.seedSession({ id: "s1", status: "idle" });
    await putTurn(h, s, "t1", "failed", { stopReason: "error" });
    const task = await store(h).get(taskIdFor(s, "t1"));
    expect(task).not.toHaveProperty("result");
    expect(task?.error).toMatchObject({
      message: "The Kiro turn failed: error.",
      data: { sessionId: s, turnId: "t1", status: "failed", reason: "error" },
    });
  });

  it("reports what was checked", () => {
    // Printed by vitest's reporter; keeps the list in the output.
    console.log(`rule held for ${checked.length} results:\n${checked.join("\n")}`);
    expect(checked.length).toBeGreaterThanOrEqual(TOOL_NAMES.length + 2);
  });
});
