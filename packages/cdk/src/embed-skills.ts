/**
 * An esbuild plugin that embeds the MCP skills in a bundle.
 *
 * The API Lambda is one bundled file: there is no `skills` folder next to it at
 * run time, so packages/mcp/src/skills-files.ts (which reads that folder from
 * disk) cannot work there. This plugin replaces that one module with a module that
 * holds every file of every skill folder as a string, read when the bundle is built.
 * Adding a skill folder needs no code change: the next build embeds it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

/** The skills the MCP package serves: `<mcp>/skills`, one folder per skill. */
export const SKILLS_DIR = join(here, "..", "..", "mcp", "skills");

/** The module to replace: the disk reader of the MCP package. */
const DISK_READER = /packages[\\/]mcp[\\/]src[\\/]skills-files\.ts$/;

/** Every file under `dir`, keyed by its `/`-separated path relative to `dir`. */
export function readSkillFiles(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const full = join(entry.parentPath, entry.name);
      files[relative(dir, full).split(sep).join("/")] = readFileSync(full, "utf8");
    }
  }
  return files;
}

/** Replace the MCP package's skills-files.ts with the files of `skillsDir`, embedded. */
export function embedSkillsPlugin(skillsDir: string = SKILLS_DIR): Plugin {
  return {
    name: "embed-skills",
    setup(build) {
      build.onLoad({ filter: DISK_READER }, (args) => {
        const files = readSkillFiles(skillsDir);
        return {
          resolveDir: dirname(args.path),
          loader: "ts",
          contents: `
            import { memorySkillFiles } from "@modelcontextprotocol/server/ext/skills";
            import type { SkillFiles } from "./skills.ts";
            export const SKILLS_DIR = "embedded";
            const FILES: Record<string, string> = ${JSON.stringify(files)};
            export function skillFiles(): SkillFiles {
              return memorySkillFiles(FILES);
            }
          `,
        };
      });
    },
  };
}
