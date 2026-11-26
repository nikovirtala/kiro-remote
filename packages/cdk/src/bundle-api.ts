/**
 * Bundle one entry with the API Lambda's esbuild options:
 * `node bundle-api.ts <entry> <outfile>`. Run by buildApiLambdaCode (api-asset.ts)
 * as a child process, because the bundle needs an esbuild plugin and plugins only
 * run in the asynchronous API.
 */

import { build } from "esbuild";
import { apiBundleOptions } from "./api-bundle-options.ts";

const [entry, outfile] = process.argv.slice(2);
if (!entry || !outfile) {
  console.error("usage: node bundle-api.ts <entry> <outfile>");
  process.exit(2);
}

await build({ ...apiBundleOptions(), entryPoints: [entry], outfile });
