/**
 * Writes the change feed's JSON Schemas to packages/core/schemas/feed/ from the zod objects in
 * src/schemas/feed.ts. `pnpm --filter @nikovirtala/kiro-remote-core gen:feed-schemas`, then commit.
 * A test fails when the checked-in files differ from what this writes.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { feedJsonSchemas } from "../src/schemas/feed.ts";

const dir = fileURLToPath(new URL("../schemas/feed/", import.meta.url));
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
for (const [file, schema] of Object.entries(feedJsonSchemas())) {
  writeFileSync(`${dir}${file}`, `${JSON.stringify(schema, null, 2)}\n`);
}
