/**
 * Pure selection logic for the opt-in production assets wired by bin/app.ts.
 *
 * `-c kiroCliVersion=<ver>` is the SINGLE opt-in trigger for BOTH real assets:
 *   - the real bridge container image, built from
 *     [`packages/bridge/Dockerfile`](../../bridge/Dockerfile) via
 *     `ContainerImage.fromAsset` (needs Docker, happens on the operator's
 *     machine), and
 *   - the real bundled API Lambda {@link Code} (esbuild in-process, no Docker;
 *     see [`./api-asset.ts`](./api-asset.ts)).
 *
 * When the flag is ABSENT, both selections stay `undefined` so the construct
 * falls back to its lightweight placeholders and `cdk synth` needs no Docker
 * and no bundler (the constrained CI/sandbox path).
 *
 * The Dockerfile's `KIRO_CLI_VERSION` build ARG has NO default, so the real
 * path must be rejected with a CLEAR error whenever the trigger is present but
 * blank. This module stays pure and side-effect free: the Docker build and the
 * esbuild bundle are provided as factory callbacks so this logic (and its fail-
 * clear behaviour) is unit-testable WITHOUT invoking Docker or esbuild.
 */

import type { ContainerImage } from "aws-cdk-lib/aws-ecs";
import type { Code } from "aws-cdk-lib/aws-lambda";

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
  /** Build the real bridge image from the Dockerfile (needs Docker). */
  buildBridgeImage: (kiroCliVersion: string) => ContainerImage;
  /** Bundle the real API Lambda code with esbuild (in-process, no Docker). */
  buildApiLambdaCode: () => Code;
}

/** The resolved asset selection passed through to the construct props. When a
 * field is `undefined` the construct uses its placeholder. */
export interface AppAssets {
  /** The validated kiro-cli version, when the real path is opted into. */
  kiroCliVersion?: string;
  /** The real bridge image, or `undefined` for the placeholder. */
  bridgeImage?: ContainerImage;
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
 *     (the Dockerfile's `KIRO_CLI_VERSION` ARG has no default, so an empty
 *     value would produce an unusable image).
 *   - flag present and non-blank => builds both real assets via the injected
 *     factories and returns them alongside the trimmed version.
 */
export function selectAppAssets(input: AppAssetsInput, factories: AppAssetsFactories): AppAssets {
  const raw = input.kiroCliVersion;

  // Flag omitted entirely: placeholder path, build nothing.
  if (raw === undefined) {
    return {};
  }

  // Flag present (the opt-in trigger fired) but blank: fail clearly. The
  // Dockerfile ARG has no default so an empty version cannot build a real
  // image, and silently dropping back to placeholders would hide the mistake.
  const kiroCliVersion = raw.trim();
  if (kiroCliVersion === "") {
    throw new Error(
      "kiroCliVersion context was supplied but is empty: the real-asset path " +
        "requires a concrete kiro-cli version (the bridge Dockerfile's " +
        "KIRO_CLI_VERSION build arg has no default). Pass a version, e.g. " +
        "`-c kiroCliVersion=1.2.3`, or omit the flag entirely to use the " +
        "placeholder path (no Docker, no bundler).",
    );
  }

  return {
    kiroCliVersion,
    bridgeImage: factories.buildBridgeImage(kiroCliVersion),
    apiLambdaCode: factories.buildApiLambdaCode(),
  };
}
