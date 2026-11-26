/**
 * The API Lambda is one bundled file with no `skills` folder beside it, so the
 * MCP skills are embedded at build time (embed-skills.ts). These tests prove it
 * with the same esbuild options the asset uses (apiBundleOptions): the real
 * entry's bundle holds the skill text, and /mcp served from a bundle in an empty
 * directory still lists and reads the skill.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, describe, expect, test } from "vitest";
import { apiBundleOptions } from "./api-bundle-options.ts";
import { readSkillFiles, SKILLS_DIR } from "./embed-skills.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MCP_SRC = join(here, "..", "..", "mcp", "src");
const ENTRY = join(here, "lambda", "entry.ts");

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Bundle `entry` (a file, or inline contents) the way the API asset is bundled. */
async function bundle(entry: string | { contents: string }): Promise<string> {
  const result = await build({
    ...apiBundleOptions(),
    ...(typeof entry === "string"
      ? { entryPoints: [entry] }
      : { stdin: { contents: entry.contents, resolveDir: MCP_SRC, loader: "ts" } }),
    write: false,
    logLevel: "silent",
  });
  return result.outputFiles.map((f) => f.text).join("\n");
}

describe("the API Lambda bundle carries the MCP skills", () => {
  test("the real entry's bundle holds every skill file and no disk reader", {
    timeout: 60_000,
  }, async () => {
    const code = await bundle(ENTRY);
    const files = readSkillFiles(SKILLS_DIR);
    expect(Object.keys(files)).toContain("kiro-remote-sessions/SKILL.md");
    for (const [path, text] of Object.entries(files)) {
      // esbuild may re-quote and escape a string, so look for a plain line of prose.
      const line = text.split("\n").find((l) => /^[A-Za-z ,.]{30,}$/.test(l));
      expect(line, `${path} has a plain line to look for`).toBeDefined();
      expect(code.includes(line ?? ""), `the bundle holds ${path}`).toBe(true);
    }
    // The disk reader is replaced: nothing in the bundle looks for a `skills` folder.
    expect(code).not.toContain("../skills");
    expect(code).toContain("embedded");
  });

  // buildApiLambdaCode runs bundle-api.ts in a child process (esbuild's sync API
  // cannot run the embedding plugin). Run that script as the asset build does.
  test("bundle-api.ts, which builds the asset, embeds the skills", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-bundle-script-"));
    dirs.push(dir);
    const out = join(dir, "index.js");
    execFileSync(process.execPath, [join(here, "bundle-api.ts"), ENTRY, out], { stdio: "pipe" });
    const code = readFileSync(out, "utf8");
    const skill = readFileSync(join(SKILLS_DIR, "kiro-remote-sessions", "SKILL.md"), "utf8");
    const line = skill.split("\n").find((l) => /^[A-Za-z ,.]{30,}$/.test(l)) ?? "";
    expect(line).not.toBe("");
    expect(code).toContain(line);
    expect(code).not.toContain("../skills");
  });

  test("/mcp served from a bundle in an empty directory lists and reads the skill", {
    timeout: 60_000,
  }, async () => {
    const code = await bundle({
      contents: `
        import { createHttpTransportHandler } from "./http-transport.ts";
        module.exports = { createHttpTransportHandler };
      `,
    });
    const dir = mkdtempSync(join(tmpdir(), "mcp-bundle-"));
    dirs.push(dir);
    const file = join(dir, "bundle.cjs");
    writeFileSync(file, code);

    // The bundle is loaded from a directory that holds nothing else, so a
    // skill that is served here came out of the bundled code.
    const { createHttpTransportHandler } = createRequire(file)(file) as {
      createHttpTransportHandler: typeof import("@nikovirtala/kiro-remote-mcp").createHttpTransportHandler;
    };
    const handler = createHttpTransportHandler({ client: {} as never });
    const principal = { sub: "u", clientId: "c", scopes: [] };
    const call = async (method: string, params: Record<string, unknown>) => {
      const res = await handler.handle({
        principal,
        method: "POST",
        headers: {
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": method,
          ...(typeof params.uri === "string" ? { "mcp-name": params.uri } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": { name: "t", version: "0" },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
      return JSON.parse(res.body);
    };

    const list = await call("skills/list", {});
    expect(list.result.skills.map((s: { uri: string }) => s.uri)).toEqual([
      "skill://kiro-remote-sessions/SKILL.md",
    ]);
    const read = await call("resources/read", {
      uri: "skill://kiro-remote-sessions/SKILL.md",
    });
    expect(read.result.contents[0].text).toBe(
      readFileSync(join(SKILLS_DIR, "kiro-remote-sessions", "SKILL.md"), "utf8"),
    );
  });
});
