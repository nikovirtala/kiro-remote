/**
 * Where the served skills are read from: the `skills` folder of this package,
 * one folder per skill, read from disk (stdio, tests).
 *
 * The API Lambda is a single bundled file with no `skills` folder next to it,
 * so packages/cdk/src/api-asset.ts replaces this module with one that holds the
 * same files as strings, read at build time (see embedSkillsPlugin). Adding a
 * skill is adding a folder under `skills/`: neither version needs a code change.
 */

import { fileURLToPath } from "node:url";
import { nodeSkillFiles } from "@modelcontextprotocol/server/ext/skills/node";
import type { SkillFiles } from "./skills.ts";

/** The folder that holds one folder per skill. */
export const SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));

/** The skill files, from disk. */
export function skillFiles(): SkillFiles {
  return nodeSkillFiles(SKILLS_DIR);
}
