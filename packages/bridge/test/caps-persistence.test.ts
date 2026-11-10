/**
 * CONFIG#CAPS persistence: the caps publisher must write the RAW initialize
 * result so the REST API GET /v1/capabilities, the lambda capability gate, and
 * the MCP kiro_capabilities tool reconstruct the advertisement via core's
 * deriveCapabilities. These tests prove the write round-trips and that no
 * secret leaks into the item or the logs.
 */

import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  capabilities as deriveCapabilities,
  kiroCliVersion,
  Repository,
} from "@nikovirtala/kiro-remote-core";
import { describe, expect, test } from "vitest";
import { createLogger } from "../src/logger.ts";
import { persistCaps, withAgentVersion } from "../src/persist-caps.ts";
import { FakeDocClient, FakeS3Client } from "./fakes.ts";
import { initResult } from "./scenarios.ts";

function wireRepo(): Repository {
  return new Repository({
    ddb: new FakeDocClient() as unknown as DynamoDBDocumentClient,
    // biome-ignore lint/suspicious/noExplicitAny: fake S3 client.
    s3: new FakeS3Client() as any,
    tableName: "kiro-remote-test",
    bucketName: "kiro-remote-test-bucket",
  });
}

describe("CONFIG#CAPS persistence", () => {
  test("persistCaps writes CONFIG#CAPS whose raw initializeResult derives the advertisement", async () => {
    const repo = wireRepo();
    const logLines: string[] = [];
    const logger = createLogger({ level: "debug", sink: (l) => logLines.push(l) });
    await persistCaps(
      repo,
      initResult({
        extensionMethods: ["_kiro/openExternalUrl", "_kiro/session/context"],
        executionTargets: ["cloud", "local"],
        sessionSources: ["remote", "local"],
        listScopes: ["cloud"],
      }),
      logger,
    );

    const caps = await repo.getCaps();
    expect(caps).not.toBeNull();

    // The persisted initializeResult must be the RAW result: deriveCapabilities
    // over it reproduces the advertised extension methods / targets / modes.
    const derived = deriveCapabilities((caps as { initializeResult: object }).initializeResult);
    expect(derived.extensionMethods).toEqual(["_kiro/openExternalUrl", "_kiro/session/context"]);
    expect(derived.executionTargets).toEqual(["cloud", "local"]);
    expect(derived.modes.map((m) => m.modeId)).toEqual(["vibe", "planner"]);
    expect(derived.cloudExecution).toBe(true);

    // Normalized convenience arrays were stored too.
    expect(caps?.extensionMethods).toEqual(["_kiro/openExternalUrl", "_kiro/session/context"]);
    expect(caps?.modes.length).toBe(2);

    // Model ids are also persisted as CONFIG#MODELS from the model config option.
    const models = await repo.getModels();
    expect(models?.models).toEqual(["claude-sonnet", "claude-haiku"]);
    expect(models?.source).toBe("config_option");

    // A redaction-safe confirmation line was logged.
    const confirmed = logLines.find((l) => l.includes("config_caps_persisted"));
    expect(confirmed).toBeDefined();
    const record = JSON.parse(confirmed as string) as Record<string, unknown>;
    expect(record.extensionMethodCount).toBe(2);
    expect(record.cloudExecution).toBe(true);
  });

  test("no ksk_ secret leaks into the persisted item or the logs", async () => {
    const repo = wireRepo();
    const logLines: string[] = [];
    const logger = createLogger({ level: "debug", sink: (l) => logLines.push(l) });
    await persistCaps(repo, initResult(), logger);

    const caps = await repo.getCaps();
    expect(caps).not.toBeNull();
    expect(JSON.stringify(caps)).not.toContain("ksk_");
    expect(logLines.join("\n")).not.toContain("ksk_");
  });

  test("a secret-shaped value in the initialize result is redacted before it is persisted", async () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l), level: "debug" });

    // An initialize result that (hypothetically) carries secrets: a sensitive
    // KEY name (access_token) and a secret-pattern string VALUE (ksk_...).
    const secretBearingInit = {
      ...initResult({
        extensionMethods: ["_kiro/openExternalUrl", "_kiro/session/context"],
        executionTargets: ["cloud", "local"],
        modes: [{ modeId: "vibe" }, { modeId: "planner" }],
      }),
      access_token: "ksk_live_super_secret_value",
      sessionHandle: "handle ksk_live_another_secret tail",
    };

    let persisted: Record<string, unknown> | null = null;
    const repo = {
      putCaps: async (item: Record<string, unknown>) => {
        persisted = item;
      },
      putModels: async () => {},
    };
    // biome-ignore lint/suspicious/noExplicitAny: focused unit with minimal fakes.
    await persistCaps(repo as any, secretBearingInit, logger);

    expect(persisted).not.toBeNull();
    const serialized = JSON.stringify(persisted);
    // No secret-shaped value survives into the persisted CONFIG#CAPS item.
    expect(serialized).not.toContain("ksk_");
    expect(serialized).toContain("[REDACTED]");

    // The round-trip for NON-secret capability fields is preserved: redact()
    // leaves the capability name arrays and modes intact.
    const derived = deriveCapabilities(
      (persisted as { initializeResult: object }).initializeResult,
    );
    expect(derived.extensionMethods).toEqual(["_kiro/openExternalUrl", "_kiro/session/context"]);
    expect(derived.executionTargets).toEqual(["cloud", "local"]);
    expect(derived.modes.map((m) => m.modeId)).toEqual(["vibe", "planner"]);
    expect(derived.cloudExecution).toBe(true);
  });

  test("persistCaps records the image's kiro-cli version when the engine reports no agentInfo", async () => {
    const logger = createLogger({ sink: () => {}, level: "debug" });
    // The direct KAS engine's initialize result has no agentInfo.
    const engineInit = initResult({ extensionMethods: ["_kiro/openExternalUrl"] });
    let persisted: { initializeResult: Record<string, unknown> } | null = null;
    const repo = {
      putCaps: async (item: { initializeResult: Record<string, unknown> }) => {
        persisted = item;
      },
      putModels: async () => {},
    };
    // biome-ignore lint/suspicious/noExplicitAny: focused unit with minimal fakes.
    await persistCaps(repo as any, engineInit, logger, { kiroCliVersion: " 3.1.0 " });

    const stored = (persisted as { initializeResult: Record<string, unknown> } | null)
      ?.initializeResult;
    expect(kiroCliVersion(stored)).toBe("3.1.0");
    // Adding agentInfo leaves the derived capabilities unchanged.
    expect(deriveCapabilities(stored ?? {})).toEqual(deriveCapabilities(engineInit));
  });

  test("withAgentVersion keeps a version the agent reported itself", () => {
    const reported = { agentInfo: { name: "Kiro CLI Agent", version: "2.37.1" } };
    expect(withAgentVersion(reported, "3.1.0")).toBe(reported);
    expect(withAgentVersion({}, undefined)).toEqual({});
    expect(withAgentVersion({}, "  ")).toEqual({});
  });

  test("persistCaps swallows a putCaps failure and logs a warning", async () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l), level: "debug" });
    // A repo whose putCaps rejects must not propagate; the publish logs it.
    const repo = {
      putCaps: async () => {
        throw new Error("ddb unavailable ksk_live_should_be_redacted");
      },
      putModels: async () => {},
    };
    // biome-ignore lint/suspicious/noExplicitAny: focused unit with minimal fakes.
    await expect(persistCaps(repo as any, initResult(), logger)).resolves.toBeUndefined();
    const warn = lines.find((l) => l.includes("config_caps_persist_failed"));
    expect(warn).toBeDefined();
    // The error string is routed through the redacting logger.
    expect(lines.join("\n")).not.toContain("ksk_live_should_be_redacted");
  });
});
