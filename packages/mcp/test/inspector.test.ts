/**
 * The MCP Inspector CLI against the real servers, over a real connection:
 * `skills/list --verify` (SEP-2640 conformance, sizes and digests), `initialize`
 * (the instructions) and `tools/list`, for stdio and for the /mcp handler served
 * on a local port, in each protocol era (`--protocol-era legacy` and `modern`).
 *
 * This is the same Inspector the live harness uses (e2e/src/inspector.ts), at
 * the release that has `--verify` and `--protocol-era`. It is fetched with npx,
 * so the test needs the npm registry, as `pnpm install` does. There is no
 * sign-in: the servers here hold every scope, and the sign-in is the live
 * harness's to prove.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INSTRUCTIONS } from "../src/instructions.ts";
import { TOOL_NAMES } from "../src/tools.ts";
import { startLocalHttp } from "./local-http.ts";

/** The Inspector release with `--verify` and `--protocol-era`. Keep in step with e2e/src/inspector.ts. */
const INSPECTOR = "@modelcontextprotocol/inspector@2.16.0";
const STDIO_SERVER = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "stdio-server.ts");

const storage = mkdtempSync(join(tmpdir(), "kiro-mcp-inspector-"));
let http: Awaited<ReturnType<typeof startLocalHttp>>;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run npx without a shell. A non-zero exit is a result, not an exception. */
function npx(args: string[], timeoutMs: number): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      "npx",
      ["--yes", INSPECTOR, ...args],
      {
        timeout: timeoutMs,
        env: {
          ...process.env,
          MCP_STORAGE_DIR: storage,
          MCP_INSPECTOR_SECRET_STORE: "memory",
        },
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const code = err ? ((err as { code?: unknown }).code as number | undefined) : 0;
        resolve({ code: typeof code === "number" ? code : 1, stdout, stderr });
      },
    );
  });
}

beforeAll(async () => {
  http = await startLocalHttp();
  // Fetch the Inspector once, with retries, so a slow registry does not fail a case.
  let last: Run | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    last = await npx(["--version"], 240_000);
    if (last.code === 0) {
      return;
    }
  }
  throw new Error(`could not run ${INSPECTOR}: ${last?.stderr.slice(-300)}`);
}, 800_000);

afterAll(async () => {
  await http?.close();
  rmSync(storage, { recursive: true, force: true });
});

type Transport = "http" | "stdio";
type Era = "legacy" | "modern";

/** The Inspector arguments that name the server and the era. */
function target(transport: Transport, era: Era): string[] {
  return transport === "http"
    ? ["--cli", http.url, "--transport", "http", "--protocol-era", era]
    : ["--cli", "--transport", "stdio", "--protocol-era", era];
}

/** The server command goes last for stdio. */
function serverCommand(transport: Transport): string[] {
  return transport === "stdio" ? ["node", STDIO_SERVER] : [];
}

const cases: Array<[Transport, Era]> = [
  ["http", "legacy"],
  ["http", "modern"],
  ["stdio", "legacy"],
  ["stdio", "modern"],
];

describe.each(cases)("Inspector over %s, %s era", (transport, era) => {
  it("skills/list --verify passes: conformance, sizes and digests", {
    timeout: 120_000,
  }, async () => {
    const run = await npx(
      [
        ...target(transport, era),
        "--method",
        "skills/list",
        "--verify",
        ...serverCommand(transport),
      ],
      110_000,
    );
    expect(run.code, run.stderr.slice(-500)).toBe(0);
    const reports = run.stdout
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map(
        (l) => JSON.parse(l) as { name: string; ok: boolean; outcome: string; files: unknown[] },
      );
    expect(reports.map((r) => r.name)).toEqual(["kiro-remote-sessions"]);
    expect(reports[0]).toMatchObject({ ok: true, outcome: "verified" });
    expect(reports[0]?.files).toHaveLength(4);
  });

  it("initialize shows the instructions and the Tasks capability", {
    timeout: 120_000,
  }, async () => {
    const run = await npx(
      [...target(transport, era), "--method", "initialize", ...serverCommand(transport)],
      110_000,
    );
    expect(run.code, run.stderr.slice(-500)).toBe(0);
    const init = JSON.parse(run.stdout);
    expect(init.instructions).toBe(INSTRUCTIONS);
    // The Tasks extension is advertised next to Skills (served on the modern era only).
    expect(init.capabilities.extensions).toHaveProperty("io.modelcontextprotocol/tasks");
  });

  it("tools/list is the same 19 tools", { timeout: 120_000 }, async () => {
    const run = await npx(
      [
        ...target(transport, era),
        "--method",
        "tools/list",
        "--format",
        "json",
        ...serverCommand(transport),
      ],
      110_000,
    );
    expect(run.code, run.stderr.slice(-500)).toBe(0);
    const names = (JSON.parse(run.stdout).result.tools as Array<{ name: string }>).map(
      (t) => t.name,
    );
    expect(names).toEqual([...TOOL_NAMES]);
  });
});
