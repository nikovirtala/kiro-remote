/**
 * Pure selection logic for the opt-in production assets wired by bin/app.ts.
 *
 * `-c kiroCliVersion=<ver>` is the SINGLE opt-in trigger for ALL real assets:
 *   - the real Lambda bridge container image, built from
 *     [`packages/bridge/Dockerfile.lambda`](../../bridge/Dockerfile.lambda) via
 *     `DockerImageCode.fromImageAsset` (needs Docker, happens on the
 *     operator's machine); it carries the SQS consumer AND caps-publisher
 *     handlers, and
 *   - the real bundled API Lambda {@link Code} (esbuild in-process, no Docker;
 *     see [`./api-asset.ts`](./api-asset.ts)).
 *
 * When the flag is ABSENT, every selection stays `undefined` so the construct
 * falls back to its lightweight placeholders and `cdk synth` needs no Docker
 * and no bundler (the constrained CI/sandbox path): the bridge functions then
 * use a placeholder {@link DockerImageCode} that references a not-yet-deployed
 * ECR repo.
 *
 * Dockerfile.lambda's `KIRO_CLI_VERSION` build ARG has NO default, so the real
 * path must be rejected with a CLEAR error whenever the trigger is present but
 * blank. This module stays pure and side-effect free: the Docker build and the
 * esbuild bundle are provided as factory callbacks so this logic (and its fail-
 * clear behaviour) is unit-testable WITHOUT invoking Docker or esbuild.
 */

import type { Code, DockerImageCode } from "aws-cdk-lib/aws-lambda";

/**
 * Paths excluded from the bridge image's `DockerImageCode.fromImageAsset`
 * build context (the monorepo root).
 *
 * CDK stages the ENTIRE context directory into `cdk.out/asset.<hash>/` BEFORE
 * invoking Docker. The context root is the repo root, which CONTAINS
 * `packages/cdk/cdk.out` -- so without an exclusion CDK copies cdk.out into the
 * staged asset, which itself contains cdk.out, recursing until the path exceeds
 * the OS limit (ENAMETOOLONG). The repo root has no `.dockerignore` of its own
 * (the `packages/bridge/.dockerignore` is NOT read, since Docker reads the
 * ignore file from the CONTEXT root), so the exclusion must be passed to
 * `fromImageAsset` explicitly -- this is the copy step that actually failed.
 *
 * `**\/cdk.out` (the recursion source) and `**\/node_modules` (huge, and
 * re-installed by the Dockerfile's own pnpm install stage) MUST be excluded.
 * None of these globs touch a path Dockerfile.lambda COPYs (package.json,
 * pnpm-lock.yaml, pnpm-workspace.yaml, tsconfig.base.json, the workspace
 * packages), so the staged context still has everything the build needs.
 */
export const BRIDGE_IMAGE_EXCLUDES: readonly string[] = [
  "**/node_modules",
  "**/cdk.out",
  "**/.api-bundle",
  "**/.github-*-bundle",
  ".git",
  "**/.git",
];

/** The opt-in context inputs resolved by bin/app.ts. */
export interface AppAssetsInput {
  /**
   * The raw `-c kiroCliVersion=<ver>` context value (or `undefined` when the
   * flag is omitted). Any non-undefined value opts into the real assets.
   */
  kiroCliVersion?: string;
}

/** Factories that actually build the (Docker/esbuild) assets. Injected so the
 * selection logic is testable without triggering a build. */
export interface AppAssetsFactories {
  /**
   * Build the real Lambda bridge image from Dockerfile.lambda
   * (needs Docker). It carries both the SQS consumer and the caps-publisher
   * handlers; the construct selects which by passing the handler `cmd` so each
   * function runs its own entry from the ONE image asset (CDK dedups by hash).
   */
  buildLambdaImage: (kiroCliVersion: string, cmd: string[]) => DockerImageCode;
  /** Bundle the real API Lambda code with esbuild (in-process, no Docker). */
  buildApiLambdaCode: () => Code;
}

/** The resolved asset selection passed through to the construct props. When a
 * field is `undefined` the construct uses its placeholder. */
export interface AppAssets {
  /** The validated kiro-cli version, when the real path is opted into. */
  kiroCliVersion?: string;
  /**
   * A factory that builds the real Lambda bridge image for a given
   * handler `cmd`, or `undefined` for the placeholder path. The construct calls
   * it once per function (consumer + publisher) so each runs its own handler
   * from the ONE image asset. Bound to the resolved kiro-cli version.
   */
  lambdaImage?: (cmd: string[]) => DockerImageCode;
  /** The real API Lambda code, or `undefined` for the placeholder. */
  apiLambdaCode?: Code;
}

/**
 * Resolve which assets the app should wire from the opt-in `kiroCliVersion`
 * context value.
 *
 *   - flag absent (`undefined`) => placeholders (all fields `undefined`); no
 *     factory is invoked, so synth needs no Docker/bundler.
 *   - flag present but blank/whitespace => throws a descriptive {@link Error}
 *     (Dockerfile.lambda's `KIRO_CLI_VERSION` ARG has no default, so an empty
 *     value would produce an unusable image).
 *   - flag present and non-blank => bundles the API code, returns a
 *     version-bound Lambda image factory, and returns the trimmed version.
 */
export function selectAppAssets(input: AppAssetsInput, factories: AppAssetsFactories): AppAssets {
  const raw = input.kiroCliVersion;

  // Flag omitted entirely: placeholder path, build nothing.
  if (raw === undefined) {
    return {};
  }

  // Flag present (the opt-in trigger fired) but blank: fail clearly. The
  // Dockerfile.lambda ARG has no default so an empty version cannot build a
  // real image, and silently dropping back to placeholders would hide the
  // mistake.
  const kiroCliVersion = raw.trim();
  if (kiroCliVersion === "") {
    throw new Error(
      "kiroCliVersion context was supplied but is empty: the real-asset path " +
        "requires a concrete kiro-cli version (packages/bridge/Dockerfile.lambda's " +
        "KIRO_CLI_VERSION build arg has no default). Pass a version, e.g. " +
        "`-c kiroCliVersion=1.2.3`, or omit the flag entirely to use the " +
        "placeholder path (no Docker, no bundler).",
    );
  }

  return {
    kiroCliVersion,
    // Bind the version so the construct supplies only the per-function handler
    // `cmd`. Not invoked here: the construct calls it once per bridge function.
    lambdaImage: (cmd: string[]) => factories.buildLambdaImage(kiroCliVersion, cmd),
    apiLambdaCode: factories.buildApiLambdaCode(),
  };
}
