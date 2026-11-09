/**
 * Unit tests for the pure opt-in asset selection logic (src/app-assets.ts).
 *
 * These exercise the `-c kiroCliVersion=<ver>` context plumbing WITHOUT ever
 * invoking a Docker build or an esbuild bundle: the asset factories are fakes,
 * and the tests assert WHEN they are (not) called. The real
 * `ContainerImage.fromAsset` / `buildApiLambdaCode` are never touched here
 * (they would need Docker/esbuild), which keeps this suite headless.
 */

import type { ContainerImage } from "aws-cdk-lib/aws-ecs";
import type { Code, DockerImageCode } from "aws-cdk-lib/aws-lambda";
import { describe, expect, test, vi } from "vitest";
import { type AppAssetsFactories, BRIDGE_IMAGE_EXCLUDES, selectAppAssets } from "./app-assets.ts";

// Sentinel fakes standing in for the real (Docker/esbuild) assets. We only care
// about identity + whether the factory ran, never the real resources.
const FAKE_IMAGE = { __fakeBridgeImage: true } as unknown as ContainerImage;
const FAKE_LAMBDA_IMAGE = { __fakeLambdaImage: true } as unknown as DockerImageCode;
const FAKE_CODE = { __fakeApiCode: true } as unknown as Code;

function fakeFactories(): AppAssetsFactories & {
  buildBridgeImage: ReturnType<typeof vi.fn>;
  buildLambdaImage: ReturnType<typeof vi.fn>;
  buildApiLambdaCode: ReturnType<typeof vi.fn>;
} {
  return {
    buildBridgeImage: vi.fn((_version: string) => FAKE_IMAGE),
    buildLambdaImage: vi.fn((_version: string, _cmd: string[]) => FAKE_LAMBDA_IMAGE),
    buildApiLambdaCode: vi.fn(() => FAKE_CODE),
  };
}

describe("selectAppAssets", () => {
  test("flag absent selects the placeholder path and builds nothing", () => {
    const factories = fakeFactories();
    const assets = selectAppAssets({}, factories);

    // No real assets: the construct falls back to its placeholders.
    expect(assets.bridgeImage).toBeUndefined();
    expect(assets.lambdaImage).toBeUndefined();
    expect(assets.apiLambdaCode).toBeUndefined();
    expect(assets.kiroCliVersion).toBeUndefined();
    // Crucially, no Docker build / bundle was triggered.
    expect(factories.buildBridgeImage).not.toHaveBeenCalled();
    expect(factories.buildLambdaImage).not.toHaveBeenCalled();
    expect(factories.buildApiLambdaCode).not.toHaveBeenCalled();
  });

  test("a concrete version builds all real assets and passes the version through", () => {
    const factories = fakeFactories();
    const assets = selectAppAssets({ kiroCliVersion: "1.2.3" }, factories);

    expect(assets.kiroCliVersion).toBe("1.2.3");
    expect(assets.bridgeImage).toBe(FAKE_IMAGE);
    expect(assets.apiLambdaCode).toBe(FAKE_CODE);
    expect(factories.buildBridgeImage).toHaveBeenCalledWith("1.2.3");
    expect(factories.buildApiLambdaCode).toHaveBeenCalledTimes(1);
  });

  test("the Lambda image is returned as a version-bound factory, invoked per handler cmd", () => {
    const factories = fakeFactories();
    const assets = selectAppAssets({ kiroCliVersion: "1.2.3" }, factories);

    // The Lambda image is a factory (so the construct can supply a per-function
    // handler cmd), NOT eagerly built: the Docker build only happens when the
    // construct invokes it with a cmd.
    expect(typeof assets.lambdaImage).toBe("function");
    expect(factories.buildLambdaImage).not.toHaveBeenCalled();

    const image = assets.lambdaImage?.(["lambda-consumer.handler"]);
    expect(image).toBe(FAKE_LAMBDA_IMAGE);
    expect(factories.buildLambdaImage).toHaveBeenCalledWith("1.2.3", ["lambda-consumer.handler"]);
  });

  test("a version with surrounding whitespace is trimmed before building", () => {
    const factories = fakeFactories();
    const assets = selectAppAssets({ kiroCliVersion: "  1.0.0  " }, factories);

    expect(assets.kiroCliVersion).toBe("1.0.0");
    expect(factories.buildBridgeImage).toHaveBeenCalledWith("1.0.0");
  });

  test("an empty-string version throws clearly and builds nothing (ARG has no default)", () => {
    const factories = fakeFactories();
    expect(() => selectAppAssets({ kiroCliVersion: "" }, factories)).toThrow(
      /kiroCliVersion context was supplied but is empty/,
    );
    expect(factories.buildBridgeImage).not.toHaveBeenCalled();
    expect(factories.buildLambdaImage).not.toHaveBeenCalled();
    expect(factories.buildApiLambdaCode).not.toHaveBeenCalled();
  });

  test("a whitespace-only version throws clearly and builds nothing", () => {
    const factories = fakeFactories();
    expect(() => selectAppAssets({ kiroCliVersion: "   " }, factories)).toThrow(
      /requires a concrete kiro-cli version/,
    );
    expect(factories.buildBridgeImage).not.toHaveBeenCalled();
    expect(factories.buildLambdaImage).not.toHaveBeenCalled();
    expect(factories.buildApiLambdaCode).not.toHaveBeenCalled();
  });
});

describe("BRIDGE_IMAGE_EXCLUDES", () => {
  // These globs are passed as the `exclude` option to the bridge image's
  // `ContainerImage.fromAsset(repoRoot, ...)` so CDK does not recursively stage
  // packages/cdk/cdk.out into the asset (ENAMETOOLONG). We assert the critical
  // entries directly here because the fromAsset excludes are not observable in
  // the synthesized template (they only affect the staged context on disk).

  test("excludes cdk.out (the recursion source) and node_modules", () => {
    // cdk.out is the entry that actually triggered the failure; node_modules is
    // re-installed by the Dockerfile's own deps stage so the host copy is waste.
    expect(BRIDGE_IMAGE_EXCLUDES).toContain("**/cdk.out");
    expect(BRIDGE_IMAGE_EXCLUDES).toContain("**/node_modules");
  });

  test("excludes the gitignored esbuild output and the .git tree", () => {
    expect(BRIDGE_IMAGE_EXCLUDES).toContain("**/.api-bundle");
    expect(BRIDGE_IMAGE_EXCLUDES).toContain(".git");
  });

  test("does NOT exclude any path the Dockerfile COPYs from the context", () => {
    // The staged context must still contain everything the bridge build needs.
    // None of these required COPY sources may match an exclude glob.
    const requiredCopySources = [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.base.json",
      "packages/core",
      "packages/bridge",
      "packages/bridge/Dockerfile",
    ];
    for (const source of requiredCopySources) {
      expect(BRIDGE_IMAGE_EXCLUDES).not.toContain(source);
    }
  });
});
