/**
 * Guard test for the bridge image's build-time esbuild bundling.
 *
 * The bridge container used to run the RAW workspace entry
 * `node packages/bridge/src/cli.ts`, which imports `@nikovirtala/kiro-remote-core`
 * whose package.json exports `./src/index.ts` -- a raw `.ts` file resolved
 * under pnpm's node_modules symlink. Node refuses to type-strip `.ts` files
 * under a node_modules path, so the container crashed at module load before
 * logging anything. The fix bundles the CLI into a single self-contained
 * CommonJS file at image-build time (mirroring the API Lambda in
 * `api-asset.ts`), inlining the `@nikovirtala/*` workspace code so there is no
 * bare `@nikovirtala` import -- and no `.ts` under node_modules -- at runtime.
 *
 * This test reproduces that exact esbuild invocation in-process (no Docker) and
 * asserts the produced bundle inlines the workspace code: it contains NO bare
 * `require("@nikovirtala/...")`. That is the deterministic, fast proof that the
 * container can no longer crash on the type-strip path.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

/** The repo-root-relative path to the bridge CLI entry (packages/cdk/src -> repo root). */
const CLI_ENTRY = join(here, "..", "..", "bridge", "src", "cli.ts");

describe("bridge image bundle", () => {
  test("bundling packages/bridge/src/cli.ts inlines the @nikovirtala/* workspace code (no bare require)", async () => {
    // EXACTLY the Dockerfile `deps`-stage invocation: bundle, node platform,
    // cjs, resolve .ts specifiers, @aws-sdk/* bundled IN (no external). Write to
    // an in-memory result instead of disk so the test stays hermetic.
    const result = await build({
      entryPoints: [CLI_ENTRY],
      bundle: true,
      platform: "node",
      target: "node22",
      format: "cjs",
      resolveExtensions: [".ts", ".js", ".mjs", ".json"],
      write: false,
      logLevel: "silent",
    });

    const code = result.outputFiles.map((f) => f.text).join("\n");

    // The whole point: the workspace entry is INLINED, so there is no bare
    // `@nikovirtala/...` module left to resolve under node_modules at runtime.
    expect(code).not.toMatch(/require\(["']@nikovirtala\//);
    expect(code).not.toMatch(/\bfrom\s+["']@nikovirtala\//);

    // Sanity: the bundle actually contains the bridge's own runtime surface
    // (it reached and inlined the application code, not just an empty shell).
    expect(code).toContain("bridge_starting");
  });
});
