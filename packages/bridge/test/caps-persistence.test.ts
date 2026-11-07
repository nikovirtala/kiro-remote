/**
 * CONFIG#CAPS persistence: after the bridge initializes it must write the RAW
 * initialize result so the REST API GET /v1/capabilities, the lambda capability
 * gate, and the MCP kiro_capabilities tool reconstruct the advertisement via
 * core's deriveCapabilities. These tests prove the write happens at start(),
 * that it round-trips, and that no secret leaks into the item or the logs.
 */

import { capabilities as deriveCapabilities } from "@nikovirtala/kiro-remote-core";
import { afterEach, describe, expect, test } from "vitest";
import { createLogger } from "../src/logger.ts";
import { persistCaps } from "../src/persist-caps.ts";
import { createHarness, type Harness, requireHarness } from "./harness.ts";
import { initResult } from "./scenarios.ts";

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) {
    await harness.stop();
    harness = null;
  }
});

describe("CONFIG#CAPS persistence", () => {
  test("start() persists CONFIG#CAPS whose raw initializeResult derives the advertisement", async () => {
    harness = await createHarness({
      newSessionId: "cloud-caps-1",
      initialize: initResult({
        extensionMethods: ["_kiro/openExternalUrl", "_kiro/session/context"],
        executionTargets: ["cloud", "local"],
        sessionSources: ["remote", "local"],
        listScopes: ["cloud"],
      }),
      onPrompt: { response: { stopReason: "end_turn" } },
    });
    await harness.server.start();

    const h = requireHarness(harness);
    const caps = await h.repo.getCaps();
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
    const models = await h.repo.getModels();
    expect(models?.models).toEqual(["claude-sonnet", "claude-haiku"]);
    expect(models?.source).toBe("config_option");

    // A redaction-safe confirmation line was logged.
    const confirmed = h.logLines.find((l) => l.includes("config_caps_persisted"));
    expect(confirmed).toBeDefined();
    const record = JSON.parse(confirmed as string) as Record<string, unknown>;
    expect(record.extensionMethodCount).toBe(2);
    expect(record.cloudExecution).toBe(true);
  });

  test("no ksk_ secret leaks into the persisted item or the logs", async () => {
    harness = await createHarness({
      newSessionId: "cloud-caps-2",
      initialize: initResult(),
      onPrompt: { response: { stopReason: "end_turn" } },
    });
    await harness.server.start();

    const h = requireHarness(harness);
    const caps = await h.repo.getCaps();
    const serialized = JSON.stringify(caps);
    expect(serialized).not.toContain("ksk_");
    expect(h.logLines.join("\n")).not.toContain("ksk_");
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
    const gateway = {
      initializeResult: secretBearingInit,
      capabilities: () => deriveCapabilities(secretBearingInit),
    };

    // biome-ignore lint/suspicious/noExplicitAny: focused unit with minimal fakes.
    await persistCaps(repo as any, gateway as any, logger);

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

  test("persistCaps swallows a putCaps failure and logs a warning", async () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l), level: "debug" });
    // A repo whose putCaps rejects must not propagate; reconnect/startup stays up.
    const repo = {
      putCaps: async () => {
        throw new Error("ddb unavailable ksk_live_should_be_redacted");
      },
      putModels: async () => {},
    };
    const gateway = {
      initializeResult: {},
      capabilities: () => deriveCapabilities(initResult()),
    };
    // biome-ignore lint/suspicious/noExplicitAny: focused unit with minimal fakes.
    await expect(persistCaps(repo as any, gateway as any, logger)).resolves.toBeUndefined();
    const warn = lines.find((l) => l.includes("config_caps_persist_failed"));
    expect(warn).toBeDefined();
    // The error string is routed through the redacting logger.
    expect(lines.join("\n")).not.toContain("ksk_live_should_be_redacted");
  });
});
