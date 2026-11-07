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
import type { Code } from "aws-cdk-lib/aws-lambda";
import { describe, expect, test, vi } from "vitest";
import { type AppAssetsFactories, selectAppAssets } from "./app-assets.ts";

// Sentinel fakes standing in for the real (Docker/esbuild) assets. We only care
// about identity + whether the factory ran, never the real resources.
const FAKE_IMAGE = { __fakeBridgeImage: true } as unknown as ContainerImage;
const FAKE_CODE = { __fakeApiCode: true } as unknown as Code;

function fakeFactories(): AppAssetsFactories & {
  buildBridgeImage: ReturnType<typeof vi.fn>;
  buildApiLambdaCode: ReturnType<typeof vi.fn>;
} {
  return {
    buildBridgeImage: vi.fn((_version: string) => FAKE_IMAGE),
    buildApiLambdaCode: vi.fn(() => FAKE_CODE),
  };
}

describe("selectAppAssets", () => {
  test("flag absent selects the placeholder path and builds nothing", () => {
    const factories = fakeFactories();
    const assets = selectAppAssets({}, factories);

    // No real assets: the construct falls back to its placeholders.
    expect(assets.bridgeImage).toBeUndefined();
    expect(assets.apiLambdaCode).toBeUndefined();
    expect(assets.kiroCliVersion).toBeUndefined();
    // Crucially, no Docker build / bundle was triggered.
    expect(factories.buildBridgeImage).not.toHaveBeenCalled();
    expect(factories.buildApiLambdaCode).not.toHaveBeenCalled();
  });

  test("a concrete version builds both real assets and passes the version through", () => {
    const factories = fakeFactories();
    const assets = selectAppAssets({ kiroCliVersion: "1.2.3" }, factories);

    expect(assets.kiroCliVersion).toBe("1.2.3");
    expect(assets.bridgeImage).toBe(FAKE_IMAGE);
    expect(assets.apiLambdaCode).toBe(FAKE_CODE);
    expect(factories.buildBridgeImage).toHaveBeenCalledWith("1.2.3");
    expect(factories.buildApiLambdaCode).toHaveBeenCalledTimes(1);
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
    expect(factories.buildApiLambdaCode).not.toHaveBeenCalled();
  });

  test("a whitespace-only version throws clearly and builds nothing", () => {
    const factories = fakeFactories();
    expect(() => selectAppAssets({ kiroCliVersion: "   " }, factories)).toThrow(
      /requires a concrete kiro-cli version/,
    );
    expect(factories.buildBridgeImage).not.toHaveBeenCalled();
    expect(factories.buildApiLambdaCode).not.toHaveBeenCalled();
  });
});
