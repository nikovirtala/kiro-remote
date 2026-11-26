/**
 * Builds the real API Lambda {@link Code} asset by bundling the production
 * entry (`src/lambda/entry.ts`) with esbuild -- no Docker, no
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

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Code } from "aws-cdk-lib/aws-lambda";

const here = dirname(fileURLToPath(import.meta.url));

/** The production entry whose default export `handler` becomes index.handler. */
const ENTRY = join(here, "lambda", "entry.ts");

/** The script that builds the bundle (a child process: see {@link buildApiLambdaCode}). */
const BUNDLE_SCRIPT = join(here, "bundle-api.ts");

/** Where the bundled single-file asset is written (gitignored). */
const OUT_DIR = join(here, "..", ".api-bundle");

/**
 * Bundle `src/lambda/entry.ts` to `<cdk>/.api-bundle/index.js` and return a
 * {@link Code} asset pointing at that directory. The handler is `index.handler`.
 *
 * esbuild's synchronous API cannot run plugins, and the bundle needs one (it
 * embeds the MCP skills, see embed-skills.ts), while the CDK app wants its asset
 * at once. So the bundle is built by bundle-api.ts in a child process, which uses
 * the asynchronous API, and this call waits for it.
 */
export function buildApiLambdaCode(): Code {
  execFileSync(process.execPath, [BUNDLE_SCRIPT, ENTRY, join(OUT_DIR, "index.js")], {
    stdio: "inherit",
  });
  return Code.fromAsset(OUT_DIR);
}
