/**
 * Unit tests for the one-shot capability publisher.
 *
 * The publisher writes CONFIG#CAPS with a single ACP `initialize` to obtain the
 * real initializeResult, then persistCaps. These tests drive
 * {@link publishCaps} with a FAKE engine (no real ACP child) over the in-memory
 * DynamoDB/S3 fakes and prove CONFIG#CAPS is written and round-trips via core's
 * deriveCapabilities, then run {@link runCapsPublish} end to end against the
 * fake ACP agent as a real child.
 */

import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { capabilities as deriveCapabilities, Repository } from "@nikovirtala/kiro-remote-core";
import { describe, expect, test } from "vitest";
import { CAPS_CLIENT_CAPABILITIES, publishCaps, runCapsPublish } from "../src/caps-publisher.ts";
import { KAS_NODE_PATH, KAS_SERVER_PATH } from "../src/kas-engine.ts";
import { createLogger } from "../src/logger.ts";
import { echoed, exited, fakeAgentSpawner } from "./fake-agent-spawn.ts";
import { FakeDocClient, FakeS3Client } from "./fakes.ts";
import { initResult } from "./scenarios.ts";

function wireRepo(): { repo: Repository; ddb: FakeDocClient } {
  const ddb = new FakeDocClient();
  const s3 = new FakeS3Client();
  const repo = new Repository({
    ddb: ddb as unknown as DynamoDBDocumentClient,
    // biome-ignore lint/suspicious/noExplicitAny: fake S3 client.
    s3: s3 as any,
    tableName: "kiro-remote-test",
    bucketName: "kiro-remote-test-bucket",
  });
  return { repo, ddb };
}

/**
 * A fake engine whose `initialize()` records the client capabilities it was
 * given and returns a prepared raw initialize result, like the real
 * {@link KasEngine} does after negotiating with the child.
 */
function fakeEngine(raw: Record<string, unknown>): {
  initialize: (cc?: Record<string, unknown>) => Promise<unknown>;
  calls: (Record<string, unknown> | undefined)[];
} {
  const calls: (Record<string, unknown> | undefined)[] = [];
  return {
    calls,
    initialize: async (cc) => {
      calls.push(cc);
      return raw;
    },
  };
}

describe("caps-publisher publishCaps", () => {
  test("initializes once and writes CONFIG#CAPS whose raw result derives the advertisement", async () => {
    const { repo } = wireRepo();
    const logLines: string[] = [];
    const logger = createLogger({ level: "debug", sink: (l) => logLines.push(l) });
    const engine = fakeEngine(
      initResult({
        extensionMethods: ["_kiro/openExternalUrl", "_kiro/session/context"],
        executionTargets: ["cloud", "local"],
      }),
    );

    await publishCaps(repo, engine, logger);

    // The one realized job: a single initialize, advertising the publisher's
    // client capabilities.
    expect(engine.calls).toEqual([CAPS_CLIENT_CAPABILITIES]);
    expect(CAPS_CLIENT_CAPABILITIES).toEqual({ _meta: { kiro: { openExternalUrl: true } } });

    const caps = await repo.getCaps();
    expect(caps).not.toBeNull();
    const derived = deriveCapabilities((caps as { initializeResult: object }).initializeResult);
    expect(derived.extensionMethods).toEqual(["_kiro/openExternalUrl", "_kiro/session/context"]);
    expect(derived.executionTargets).toEqual(["cloud", "local"]);
    expect(derived.cloudExecution).toBe(true);

    // Model ids persisted from the model config option.
    const models = await repo.getModels();
    expect(models?.models).toEqual(["claude-sonnet", "claude-haiku"]);

    // Redaction-safe confirmation line logged.
    expect(logLines.some((l) => l.includes("config_caps_persisted"))).toBe(true);
    // And the publisher's own initialize-result breadcrumb.
    expect(logLines.some((l) => l.includes("caps_publisher_initialize_result"))).toBe(true);
  });

  test("a null initialize result persists an empty advertisement", async () => {
    const { repo } = wireRepo();
    const logger = createLogger({ level: "error", sink: () => {} });
    await publishCaps(repo, { initialize: async () => null }, logger);
    const caps = await repo.getCaps();
    expect(caps).not.toBeNull();
    expect(deriveCapabilities((caps as { initializeResult: object }).initializeResult)).toEqual(
      deriveCapabilities({}),
    );
  });

  test("no ksk_ secret leaks into the persisted item or the logs", async () => {
    const { repo } = wireRepo();
    const logLines: string[] = [];
    const logger = createLogger({ level: "debug", sink: (l) => logLines.push(l) });
    const engine = fakeEngine({
      ...initResult(),
      access_token: "ksk_live_super_secret_value",
    });

    await publishCaps(repo, engine, logger);

    const caps = await repo.getCaps();
    expect(JSON.stringify(caps)).not.toContain("ksk_");
    expect(logLines.join("\n")).not.toContain("ksk_");
  });
});

describe("caps-publisher runCapsPublish lifecycle", () => {
  test("spawns the engine, publishes CONFIG#CAPS, and stops the child on finish", async () => {
    const { ddb } = wireRepo();
    const logLines: string[] = [];
    const logger = createLogger({ level: "debug", sink: (l) => logLines.push(l) });
    const { spawnFn, specs, children } = fakeAgentSpawner([
      {
        initialize: initResult({
          extensionMethods: ["_kiro/openExternalUrl", "_kiro/session/context"],
          executionTargets: ["cloud", "local"],
        }),
      },
    ]);

    await runCapsPublish({
      config: { tableName: "kiro-remote-test", bucketName: "kiro-remote-test-bucket" },
      ddb: ddb as unknown as DynamoDBDocumentClient,
      // biome-ignore lint/suspicious/noExplicitAny: fake S3 client (unused on the publish path).
      s3: new FakeS3Client() as any,
      // The real engine client and transport run; only the child process is faked.
      spawnFn,
      logger,
      // No real Secrets Manager: resolveKiroApiKey falls back to the env key so
      // the publish runs fully offline (the key is still placed in the child env).
      env: { KIRO_API_KEY: "ksk_test_key" },
    });

    // The child was actually spawned (the real transport ran against it).
    expect(children.length).toBe(1);

    // The publisher starts the bundled engine directly, not kiro-cli.
    const spec = specs[0];
    expect(spec?.command).toBe(KAS_NODE_PATH);
    expect(spec?.args).toEqual([
      "--experimental-wasm-modules",
      KAS_SERVER_PATH,
      "--transport=stdio",
    ]);
    expect(spec?.env?.CLOUD_CONFIG_ENDPOINT).toBe("https://app.kiro.dev");
    // Compare, never print: the resolved key reaches the child env.
    expect(spec?.env?.KIRO_API_KEY !== undefined).toBe(true);

    // The engine received the publisher's client capabilities on initialize.
    const initParams = echoed(logLines, "fakeAgentInitializeParams") as {
      clientCapabilities?: unknown;
    }[];
    expect(initParams.length).toBe(1);
    expect(initParams[0]?.clientCapabilities).toEqual(CAPS_CLIENT_CAPABILITIES);

    // runCapsPublish stops the engine in its finally; wait for the exit to
    // land so the assertion is not racy, then confirm it was killed.
    const child = children[0];
    if (!child) {
      throw new Error("no child spawned");
    }
    await exited(child);
    expect(child.killed).toBe(true);

    // CONFIG#CAPS was written via the real initialize handshake over the
    // transport (not a fake engine), proving the spawn->initialize->persist
    // ->stop lifecycle end to end.
    const caps = await new Repository({
      ddb: ddb as unknown as DynamoDBDocumentClient,
      // biome-ignore lint/suspicious/noExplicitAny: fake S3 client (unused for getCaps).
      s3: new FakeS3Client() as any,
      tableName: "kiro-remote-test",
      bucketName: "kiro-remote-test-bucket",
    }).getCaps();
    expect(caps).not.toBeNull();
    const derived = deriveCapabilities((caps as { initializeResult: object }).initializeResult);
    expect(derived.extensionMethods).toEqual(["_kiro/openExternalUrl", "_kiro/session/context"]);
    expect(derived.cloudExecution).toBe(true);

    // The transport logged the child's clean exit (the stop path).
    expect(logLines.some((l) => l.includes("acp_child_exit"))).toBe(true);
    // No secret leaked through the real child env into the persisted item or logs.
    expect(JSON.stringify(caps)).not.toContain("ksk_");
    expect(logLines.join("\n")).not.toContain("ksk_");
  });
});
