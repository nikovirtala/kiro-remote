/**
 * Bundles the GitHub Lambda handlers (webhook ingress and queue consumer) with
 * esbuild, in-process, no Docker. Same approach and flags as
 * {@link import("./api-asset.ts").buildApiLambdaCode}; the Octokit packages
 * are bundled in, the AWS SDK v3 stays external (the managed runtime has it).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Code } from "aws-cdk-lib/aws-lambda";
import { buildSync } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY_DIR = join(here, "..", "..", "github", "src", "lambda");
const OUT_ROOT = join(here, "..");

export type GithubHandlerName = "webhook" | "consumer";

/** Bundle `packages/github/src/lambda/<name>.ts` to `<cdk>/.github-<name>-bundle/index.js`. */
export function buildGithubLambdaCode(name: GithubHandlerName): Code {
  const outDir = join(OUT_ROOT, `.github-${name}-bundle`);
  buildSync({
    entryPoints: [join(ENTRY_DIR, `${name}.ts`)],
    outfile: join(outDir, "index.js"),
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node26",
    resolveExtensions: [".ts", ".js", ".mjs", ".json"],
    external: ["@aws-sdk/*"],
    logLevel: "warning",
  });
  return Code.fromAsset(outDir);
}
