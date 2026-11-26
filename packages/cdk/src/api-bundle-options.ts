/**
 * The esbuild options of the API Lambda bundle, kept apart from api-asset.ts so
 * that the bundling script and the tests can use them without loading aws-cdk-lib.
 */

import type { BuildOptions } from "esbuild";
import { embedSkillsPlugin } from "./embed-skills.ts";

/**
 * The esbuild options of the API Lambda bundle. A test builds the same options
 * for other entries, so what it proves holds for the asset.
 */
export function apiBundleOptions(): BuildOptions {
  return {
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
    // The MCP skills are files of the mcp package; the bundle has no folder
    // beside it to read them from, so they are embedded as strings.
    plugins: [embedSkillsPlugin()],
    logLevel: "warning",
  };
}
