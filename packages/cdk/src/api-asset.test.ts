/**
 * Guard test for the API Lambda bundle (see ./api-asset.ts).
 *
 * The API entry imports the auth package's handlers. The auth package also
 * holds the KiroRemoteAuth CDK construct; when its barrel re-exported that
 * construct, esbuild inlined all of aws-cdk-lib into the Lambda (about 65 MB,
 * against about 1.8 MB without it), which slowed cold starts. The construct now
 * lives at the `@nikovirtala/kiro-remote-auth/construct` subpath. This test
 * bundles the entry in memory exactly as buildApiLambdaCode does and fails if
 * any CDK module is reached again.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

test("the API Lambda bundle does not include aws-cdk-lib or constructs", async () => {
  const result = await build({
    entryPoints: [join(here, "lambda", "entry.ts")],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node26",
    resolveExtensions: [".ts", ".js", ".mjs", ".json"],
    external: ["@aws-sdk/*"],
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const cdkInputs = Object.keys(result.metafile.inputs).filter((p) =>
    /node_modules\/(aws-cdk-lib|constructs|@aws-cdk)\//.test(p),
  );
  expect(cdkInputs).toEqual([]);
  // A coarse ceiling: the bundle is about 1.8 MB today.
  const bytes = result.outputFiles.reduce((n, f) => n + f.contents.length, 0);
  expect(bytes).toBeLessThan(5 * 1024 * 1024);
});
