import { describe, expect, it, vi } from "vitest";
import {
  INSPECTOR_PACKAGE,
  type InspectorSpawn,
  inspectorInvocation,
  parseInspectorToolNames,
  parseSkillReports,
  runInspector,
  runInspectorToolsList,
} from "./inspector.ts";

const BASE = "https://kiro.example.com";

function fakes(result: Awaited<ReturnType<InspectorSpawn>>, stderrLines: string[] = []) {
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const spawn: InspectorSpawn = async (command, args, opts) => {
    calls.push({ command, args, env: opts.env });
    for (const line of stderrLines) {
      opts.onStderrLine(line);
    }
    return result;
  };
  const mkdtemp = vi.fn(async (prefix: string) => `${prefix}abc`);
  const rm = vi.fn(async () => {});
  const progress = vi.fn();
  return { calls, spawn, mkdtemp, rm, progress };
}

describe("inspectorInvocation", () => {
  it("runs tools/list over HTTP with a memory secret store and a temp storage dir", () => {
    const inv = inspectorInvocation(BASE, "/tmp/kiro-e2e-inspector-x");
    expect(inv.command).toBe("npx");
    expect(inv.args).toEqual([
      "--yes",
      INSPECTOR_PACKAGE,
      "--cli",
      `${BASE}/mcp`,
      "--transport",
      "http",
      "--method",
      "tools/list",
      "--format",
      "json",
    ]);
    expect(inv.env).toEqual({
      MCP_STORAGE_DIR: "/tmp/kiro-e2e-inspector-x",
      MCP_INSPECTOR_SECRET_STORE: "memory",
      MCP_AUTO_OPEN_ENABLED: "true",
    });
    const all = JSON.stringify(inv);
    expect(all).not.toMatch(/bearer|token|owner\/repo/i);
  });
});

describe("inspectorInvocation for the other calls", () => {
  it("skills/list --verify asks for the checks, and prints reports, not a tools document", () => {
    const inv = inspectorInvocation(BASE, "/tmp/x", { method: "skills/list", verify: true });
    expect(inv.args).toEqual([
      "--yes",
      INSPECTOR_PACKAGE,
      "--cli",
      `${BASE}/mcp`,
      "--transport",
      "http",
      "--method",
      "skills/list",
      "--verify",
    ]);
  });

  it("names the protocol era when asked", () => {
    const inv = inspectorInvocation(BASE, "/tmp/x", { method: "tools/list", era: "modern" });
    expect(inv.args.slice(5, 8)).toEqual(["http", "--protocol-era", "modern"]);
    expect(inv.args).toContain("tools/list");
  });

  it("is the release that has --verify and --protocol-era", () => {
    expect(INSPECTOR_PACKAGE).toBe("@modelcontextprotocol/inspector@2.16.0");
  });
});

describe("parseSkillReports", () => {
  const report = { name: "a", ok: true, outcome: "verified", files: [{}, {}] };

  it("reads one report per line and ignores the summary line", () => {
    const out = `${JSON.stringify(report)}\n${JSON.stringify({ ...report, name: "b" })}\nVerified 2 skills.\n`;
    expect(parseSkillReports(out).map((r) => r.name)).toEqual(["a", "b"]);
  });

  it("throws on a report that is not JSON or lacks its fields", () => {
    expect(() => parseSkillReports("{nope")).toThrow(/not JSON/);
    expect(() => parseSkillReports('{"name":"a"}')).toThrow(/without name, ok and files/);
  });
});

describe("runInspector", () => {
  it("returns stdout for exit 0, and throws on exit 7 (a skill failed verification)", async () => {
    const ok = fakes({ exitStatus: 0, stdout: "out", stderrTail: "" });
    await expect(runInspector(BASE, { method: "skills/list", verify: true }, ok)).resolves.toBe(
      "out",
    );
    const bad = fakes({ exitStatus: 7, stdout: "", stderrTail: "digest mismatch" });
    await expect(runInspector(BASE, { method: "skills/list", verify: true }, bad)).rejects.toThrow(
      "MCP Inspector exited 7: digest mismatch",
    );
    expect(bad.rm).toHaveBeenCalledTimes(1);
  });
});

describe("parseInspectorToolNames", () => {
  it("reads result.tools[].name", () => {
    expect(parseInspectorToolNames('{"result":{"tools":[{"name":"a"}]}}')).toEqual(["a"]);
  });

  it("throws on any other shape", () => {
    expect(() => parseInspectorToolNames("nope")).toThrow(/not JSON/);
    expect(() => parseInspectorToolNames('{"result":{}}')).toThrow(/result.tools/);
    expect(() => parseInspectorToolNames('{"result":{"tools":[{}]}}')).toThrow(/without a name/);
  });
});

describe("runInspectorToolsList", () => {
  it("returns the tool names, forwards stderr lines, and removes the temp dir", async () => {
    const authorizeLine =
      "Please navigate to: https://kiro.example.com/oauth/authorize?client_id=mcp_1&state=s3cr3t";
    const f = fakes(
      { exitStatus: 0, stdout: '{"result":{"tools":[{"name":"x"}]}}', stderrTail: "" },
      [authorizeLine],
    );
    const names = await runInspectorToolsList(BASE, f);
    expect(names).toEqual(["x"]);
    expect(f.progress).toHaveBeenCalledWith(authorizeLine);
    expect(f.calls[0].env.MCP_STORAGE_DIR).toBe(await f.mkdtemp.mock.results[0].value);
    expect(f.calls[0].env.MCP_INSPECTOR_SECRET_STORE).toBe("memory");
    expect(f.rm).toHaveBeenCalledWith(expect.stringContaining("kiro-e2e-inspector-"), {
      recursive: true,
      force: true,
    });
  });

  it("throws with the exit status and error envelope, and still removes the temp dir", async () => {
    const f = fakes({
      exitStatus: 3,
      stdout: "",
      stderrTail: '{"error":{"code":"auth_required","message":"sign-in needed"}}',
    });
    await expect(runInspectorToolsList(BASE, f)).rejects.toThrow(
      "MCP Inspector exited 3: auth_required sign-in needed",
    );
    expect(f.rm).toHaveBeenCalledTimes(1);
  });
});
