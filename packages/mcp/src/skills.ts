/**
 * The Skills extension (io.modelcontextprotocol/skills, SEP-2640): one catalog
 * of every skill under `skills/`, attached to the shared server by
 * {@link loadExtensions}.
 *
 * A skill teaches a model how to use these tools, and its content is the same
 * for every caller and holds no data. So any authenticated principal may list
 * and read skills (the API authenticated the request before the seam; stdio
 * serves the logged-in user), no session scope is needed, and clients may share
 * a cached answer.
 */

import type { SkillFiles } from "@modelcontextprotocol/server/ext/skills";
import { SkillCatalog } from "@modelcontextprotocol/server/ext/skills";
import { redactingLogger } from "./logger.ts";
import { skillFiles } from "./skills-files.ts";

export type { SkillFiles };

/**
 * How long a client may reuse an answer to skills/list, skills/get and a skill
 * file read, and who may share it. The content is identical for every user, so
 * the answer is public.
 */
export const SKILLS_CACHE_HINT = { ttlMs: 300_000, cacheScope: "public" } as const;

/** Build the catalog of every skill folder in `files` (the served skills by default). */
export function loadSkillCatalog(
  files: SkillFiles = skillFiles(),
  options: { strict?: boolean } = {},
): Promise<SkillCatalog> {
  return SkillCatalog.load(files, {
    cacheHint: SKILLS_CACHE_HINT,
    ...(options.strict ? { strict: true } : {}),
    // A skill with a problem is left out and named here, redacted like every log line.
    onWarning: (w) => redactingLogger.error("skill warning", w),
  });
}
