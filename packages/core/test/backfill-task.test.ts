/** tasks/1-index-open-waits-and-links.ts: its declaration, its dry run and its run, on a fake table. */

import { describe, expect, it } from "vitest";
import { dryRun, execute, needs, run } from "../../../tasks/1-index-open-waits-and-links.ts";
import { memoryRepository, sessionItem } from "../src/testing/memory-ddb.ts";

async function legacyTable() {
  const { repo, ddb } = await memoryRepository();
  ddb.put(sessionItem("S1"));
  await repo.createWait({ sessionId: "S1", pr: "octo/repo#7", source: "mcp" });
  await repo.createLink({
    repo: "octo/repo",
    number: 1,
    sessionId: "S1",
    linkedBy: "harvest",
    prState: "open",
    headSha: "a",
  });
  for (const [pk, sk] of [
    ["SESSION#S1", "WAIT#octo/repo#7"],
    ["GHPR#octo/repo#1", "LINK"],
  ]) {
    const item = ddb.get(pk, sk) as Record<string, unknown>;
    delete item.GSI2PK;
    delete item.GSI2SK;
  }
  return { repo, ddb };
}

const ctx = (outputs: Record<string, string> = { TableName: "t" }) => {
  const log: string[] = [];
  return { region: "eu-north-1", outputs, log: (m: string) => log.push(m), lines: log };
};

describe("task 1: index the open waits and links", () => {
  it("declares a task role of the prefix and the one output it reads", () => {
    expect(needs.role).toBe("kiro-remote-deployment-task-index-sweep");
    expect(needs.outputs).toEqual(["TableName"]);
  });

  it("the dry run says what it would do and changes nothing", async () => {
    const { repo, ddb } = await legacyTable();
    const result = await execute(ctx(), true, ddb as never);
    expect(result.summary).toBe("would index 1 wait(s) and 1 open link(s) (3 scanned, 0 skipped)");
    expect(await repo.queryOpenWaits()).toEqual([]);
  });

  it("the run indexes them, and a second run changes nothing", async () => {
    const { repo, ddb } = await legacyTable();
    const c = ctx();
    expect((await execute(c, false, ddb as never)).summary).toBe(
      "indexed 1 wait(s) and 1 open link(s) (3 scanned, 0 skipped)",
    );
    expect((await repo.queryOpenWaits()).map((w) => w.pr)).toEqual(["octo/repo#7"]);
    expect((await repo.queryOpenLinkIndex()).map((l) => l.pr)).toEqual(["octo/repo#1"]);
    expect((await execute(c, false, ddb as never)).summary).toBe(
      "indexed 0 wait(s) and 0 open link(s) (3 scanned, 2 skipped)",
    );
  });

  it("its summary and log hold counts, never a name from the data", async () => {
    const { ddb } = await legacyTable();
    const c = ctx();
    const { summary } = await execute(c, false, ddb as never);
    for (const text of [summary, ...c.lines]) {
      expect(text).not.toMatch(/octo|S1|SESSION#|GHPR#/);
    }
  });

  it("refuses to run without the table's name", async () => {
    await expect(execute(ctx({}), true, {} as never)).rejects.toThrow("TableName");
  });

  it("exports the entry points the runner's shim calls", () => {
    expect(typeof dryRun).toBe("function");
    expect(typeof run).toBe("function");
  });
});
