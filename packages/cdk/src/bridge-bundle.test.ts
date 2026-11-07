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

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

/** The repo-root-relative path to the bridge CLI entry (packages/cdk/src -> repo root). */
const CLI_ENTRY = join(here, "..", "..", "bridge", "src", "cli.ts");

/** The bridge Dockerfile (packages/cdk/src -> packages/bridge/Dockerfile). */
const DOCKERFILE = join(here, "..", "..", "bridge", "Dockerfile");

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

  // This guards a DIFFERENT failure class than the in-process bundle test
  // above: the Dockerfile's esbuild *bin path*. esbuild is a devDependency of
  // @nikovirtala/kiro-remote-cdk, so under pnpm's default isolated layout its
  // bin is linked ONLY into packages/cdk/node_modules/.bin -- NOT the
  // workspace-root node_modules/.bin. A `RUN node_modules/.bin/esbuild ...`
  // line (resolving to /app/node_modules/.bin/esbuild) therefore does not exist
  // in the image and the docker build fails before producing the bundle. The
  // in-process build() above cannot catch that because it imports esbuild as a
  // module. This cheap content assertion closes the gap.
  test("the Dockerfile invokes esbuild via a resolvable bin path (not the non-existent root node_modules/.bin)", () => {
    const dockerfile = readFileSync(DOCKERFILE, "utf8");

    // The esbuild invocation must exist and bundle the bridge CLI entry.
    expect(dockerfile).toMatch(/esbuild\s+packages\/bridge\/src\/cli\.ts/);

    // It must NOT use the bare root bin path, which pnpm does not create for a
    // devDependency owned by a workspace package.
    expect(dockerfile).not.toMatch(/(?:RUN\s+|&&\s*)node_modules\/\.bin\/esbuild/);

    // It MUST resolve esbuild through the owning package's bin or via
    // `pnpm --filter <owning-pkg> exec esbuild`, both of which resolve under
    // the filtered install the Dockerfile performs.
    const resolvableInvocation =
      /packages\/cdk\/node_modules\/\.bin\/esbuild/.test(dockerfile) ||
      /pnpm\s+--filter\s+@nikovirtala\/kiro-remote-cdk\s+exec\s+esbuild/.test(dockerfile);
    expect(resolvableInvocation).toBe(true);
  });

  // This guards a THIRD failure class: the runtime `kiro-cli` must be
  // EXECUTABLE by the non-root `bridge` user. The official install script
  // drops the binary into ROOT's home (/root/.local/bin), which is mode 0700;
  // a symlink into /root plus `ENV PATH="/root/.local/bin:..."` left kiro-cli
  // reachable only through a path the non-root user cannot traverse, so the
  // bridge crashed with `spawn kiro-cli EACCES` and ECS tripped the deployment
  // circuit breaker. The fix copies the real binary to a world-executable
  // system path. This cheap content assertion closes that gap.
  test("the Dockerfile installs kiro-cli to a world-executable system path (not a /root-only symlink)", () => {
    const dockerfile = readFileSync(DOCKERFILE, "utf8");

    // kiro-cli must be materialized as a real, world-executable file on a
    // system PATH dir the non-root user can reach.
    expect(dockerfile).toMatch(/cp\s+-L\s+"?\$\{?KIRO_BIN\}?"?\s+\/usr\/local\/bin\/kiro-cli/);
    expect(dockerfile).toMatch(/chmod\s+0755\s+\/usr\/local\/bin\/kiro-cli/);

    // It must NOT keep kiro-cli reachable only via /root: no symlink target
    // under /root and no /root/.local/bin on PATH for the runtime user.
    expect(dockerfile).not.toMatch(/ENV\s+PATH="\/root\/\.local\/bin/);
    expect(dockerfile).not.toMatch(/ln\s+-sf\s+"?\$\(command\s+-v\s+kiro-cli/);

    // A build-time exec check must prove the non-root `bridge` user can run
    // kiro-cli, so a future regression fails the image build loudly.
    expect(dockerfile).toMatch(/runuser\s+-u\s+bridge\s+--\s+kiro-cli\s+--version/);
  });
});
