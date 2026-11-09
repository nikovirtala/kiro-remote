/**
 * Builds the real API Lambda {@link Code} asset by bundling the production
 * entry (`src/lambda/entry.ts`) with esbuild IN-PROCESS -- no Docker, no
 * network. This is the opt-in production path: the construct keeps its inline
 * placeholder default so placeholder-path synth needs no bundler at all.
 *
 * esbuild resolves the repo's `.ts` import specifiers directly via
 * `resolveExtensions` (the sources use explicit `.ts` specifiers because the
 * tsconfig sets allowImportingTsExtensions + rewriteRelativeImportExtensions);
 * no custom resolve plugin is required.
 *
 * The AWS SDK v3 clients are marked external: the NODEJS_26_X managed runtime
 * (see the NODEJS_26_X shim in construct.ts -- a workaround for the missing
 * `Runtime.NODEJS_26_X` constant, aws/aws-cdk#39021; note nodejs26.x is AWS
 * public preview) still ships @aws-sdk/*, so bundling them would only bloat the
 * asset.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Code } from "aws-cdk-lib/aws-lambda";
import { buildSync } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

/** The production entry whose default export `handler` becomes index.handler. */
const ENTRY = join(here, "lambda", "entry.ts");

/** Where the bundled single-file asset is written (gitignored). */
const OUT_DIR = join(here, "..", ".api-bundle");

/**
 * Bundle `src/lambda/entry.ts` to `<cdk>/.api-bundle/index.js` and return a
 * {@link Code} asset pointing at that directory. The handler is `index.handler`.
 */
export function buildApiLambdaCode(): Code {
  buildSync({
    entryPoints: [ENTRY],
    outfile: join(OUT_DIR, "index.js"),
    bundle: true,
    // CJS output so a bare `index.js` is a valid `index.handler` entry on the
    // managed runtime (no package.json "type" shim needed). The entry has no
    // top-level await, so CJS is safe.
    format: "cjs",
    platform: "node",
    target: "node26",
    // Resolve the repo's explicit .ts import specifiers without a plugin.
    resolveExtensions: [".ts", ".js", ".mjs", ".json"],
    // The managed NODEJS_26_X runtime (nodejs26.x; see the shim in construct.ts
    // for the aws/aws-cdk#39021 workaround and the public-preview caveat) still
    // provides the AWS SDK v3, so keep @aws-sdk/* external.
    external: ["@aws-sdk/*"],
    logLevel: "warning",
  });
  return Code.fromAsset(OUT_DIR);
}
