/**
 * Guard tests for the Lambda bridge image (packages/bridge/Dockerfile.lambda).
 *
 * The bridge entries import `@nikovirtala/kiro-remote-core`, whose package.json
 * exports `./src/index.ts` -- a raw `.ts` file resolved under pnpm's
 * node_modules symlink. Node refuses to type-strip `.ts` files under a
 * node_modules path, so running the raw entries would crash at module load.
 * Dockerfile.lambda therefore esbuild-bundles the Lambda entries
 * (`lambda-consumer.ts`, `caps-publisher.ts`, `catch-up-durable.ts`) into self-contained CommonJS
 * files at image-build time, inlining the `@nikovirtala/*` workspace code.
 *
 * The bundle tests reproduce that esbuild invocation in-process (no Docker) and
 * assert the bundles inline the workspace code (no bare `@nikovirtala/...`
 * import). The content tests pin the Dockerfile.lambda lines that earlier
 * builds got wrong: the esbuild bin path, the kiro-cli install invocation, a
 * writable HOME, and no redundant per-FROM `--platform`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

/** The bridge sources (packages/cdk/src -> packages/bridge/src). */
const BRIDGE_SRC = join(here, "..", "..", "bridge", "src");

/** The Lambda bridge Dockerfile (packages/cdk/src -> packages/bridge/Dockerfile.lambda). */
const LAMBDA_DOCKERFILE = join(here, "..", "..", "bridge", "Dockerfile.lambda");

/** Bundle one entry exactly as Dockerfile.lambda does, in memory. */
async function bundle(entry: string): Promise<string> {
  const result = await build({
    entryPoints: [join(BRIDGE_SRC, entry)],
    bundle: true,
    platform: "node",
    target: "node26",
    format: "cjs",
    resolveExtensions: [".ts", ".js", ".mjs", ".json"],
    write: false,
    logLevel: "silent",
  });
  return result.outputFiles.map((f) => f.text).join("\n");
}

describe("Lambda bridge bundles", () => {
  test.each([
    ["lambda-consumer.ts", "command_received"],
    ["caps-publisher.ts", "caps_publisher_initialize_result"],
    ["catch-up-durable.ts", "wait-"],
  ])(
    "bundling %s inlines the @nikovirtala/* workspace code (no bare import)",
    async (entry, marker) => {
      const code = await bundle(entry);

      // The whole point: the workspace code is INLINED, so there is no bare
      // `@nikovirtala/...` module left to resolve under node_modules at runtime.
      expect(code).not.toMatch(/require\(["']@nikovirtala\//);
      expect(code).not.toMatch(/\bfrom\s+["']@nikovirtala\//);

      // Sanity: the bundle actually contains the entry's own runtime surface
      // (it reached and inlined the application code, not just an empty shell).
      expect(code).toContain(marker);
    },
  );
});

describe("Lambda bridge image", () => {
  const dockerfile = readFileSync(LAMBDA_DOCKERFILE, "utf8");

  // The in-process build() above imports esbuild as a module, so it cannot
  // catch a wrong esbuild *bin path* in the Dockerfile. esbuild is a
  // devDependency of @nikovirtala/kiro-remote-cdk, so under pnpm's isolated
  // layout its bin is linked ONLY into packages/cdk/node_modules/.bin -- NOT
  // the workspace-root node_modules/.bin, which does not exist in the image.
  test("invokes esbuild via packages/cdk/node_modules/.bin for both entries (never the root bin)", () => {
    expect(dockerfile).toMatch(
      /packages\/cdk\/node_modules\/\.bin\/esbuild\s+packages\/bridge\/src\/lambda-consumer\.ts/,
    );
    expect(dockerfile).toMatch(
      /packages\/cdk\/node_modules\/\.bin\/esbuild\s+packages\/bridge\/src\/caps-publisher\.ts/,
    );
    expect(dockerfile).not.toMatch(/(?:RUN\s+|&&\s*)node_modules\/\.bin\/esbuild/);
  });

  // An older default `https://kiro.dev/install.sh` returned HTTP 404, the
  // bash-only script was piped to `sh`, and `unzip` (which the script needs on
  // Linux) was missing. These assertions pin the corrected invocation.
  test("installs kiro-cli from the official URL, piped to bash, with unzip available", () => {
    expect(dockerfile).toMatch(/KIRO_CLI_INSTALL_URL=https:\/\/cli\.kiro\.dev\/install\b/);
    expect(dockerfile).not.toMatch(/kiro\.dev\/install\.sh/);

    expect(dockerfile).toMatch(
      /curl\s+-fsSL\s+"?\$\{?KIRO_CLI_INSTALL_URL\}?"?\s*\|\s*Q_INSTALL_GLOBAL=1\s+bash\s+-s\s+--\s+--version\s+"?\$\{?KIRO_CLI_VERSION\}?"?/,
    );
    expect(dockerfile).not.toMatch(/\|\s*(?:\S+\s+)?sh\s+-s\s+--/);

    // The AWS Lambda base is Amazon Linux 2023: packages come from (micro)dnf.
    expect(dockerfile).toMatch(/(?:micro)?dnf\s+install\b[^\n]*\bunzip\b/);
  });

  test("makes kiro-cli world-executable", () => {
    expect(dockerfile).toMatch(/chmod\s+0755\s+\/usr\/local\/bin\/kiro-cli/);
  });

  test("requires a KIRO_CLI_VERSION build arg", () => {
    expect(dockerfile).toMatch(/test\s+-n\s+"?\$\{?KIRO_CLI_VERSION\}?"?/);
  });

  // On Lambda only /tmp is writable, and the engine writes its config and
  // session state under HOME/KIRO_HOME.
  test("points HOME and KIRO_HOME at writable paths under /tmp", () => {
    expect(dockerfile).toMatch(/\bENV\b[\s\S]*?\bHOME=\/tmp\b/);
    expect(dockerfile).toMatch(/KIRO_HOME=\/tmp\/\.kiro\b/);
  });

  test("unpacks the engine with kiro-cli acp --agent-engine=v3", () => {
    expect(dockerfile).toMatch(/kiro-cli\s+acp\s+--agent-engine=v3/);
  });

  test("fails the build unless acp-server.js was unpacked", () => {
    expect(dockerfile).toMatch(
      /test\s+-f\s+\/opt\/kiro\/kas\/current\/node_modules\/@kiro\/agent\/dist\/server\/acp-server\.js/,
    );
  });

  test("drops the kiro-cli lock files", () => {
    expect(dockerfile).toMatch(/rm\s+-f\s+\/opt\/kiro\/kas\/\*\.lock/);
  });

  test("the runtime stage copies only the engine from the kiro stage", () => {
    expect(dockerfile).toContain("COPY --from=kiro /opt/kiro /opt/kiro");
  });

  // kiro-cli 3.x ships one binary (`acp` and `chat` are subcommands). CDK's
  // build-level `--platform linux/arm64` already sets the target platform, so a
  // per-FROM `--platform` is redundant (buildkit warns RedundantTargetPlatform).
  test("references no kiro-cli-chat binary and no per-FROM --platform", () => {
    expect(dockerfile).not.toMatch(/kiro-cli-chat/);
    expect(dockerfile).not.toMatch(/FROM\s+--platform=/);
    expect(dockerfile).not.toMatch(/TARGETPLATFORM/);
  });
});
