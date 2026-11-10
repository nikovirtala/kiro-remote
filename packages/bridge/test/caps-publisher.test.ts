/**
 * Unit tests for the one-shot capability publisher (FEAT-003).
 *
 * The publisher replaces the persistent bridge's boot-time CONFIG#CAPS write on
 * the serverless path: a single ACP `initialize` to obtain the real
 * initializeResult, then persistCaps. These tests drive {@link publishCaps} with
 * a FAKE gateway (no real ACP child) over the in-memory DynamoDB/S3 fakes and
 * prove CONFIG#CAPS is written and round-trips via core's deriveCapabilities --
 * exactly the one realized job the live ACP child performed.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  capabilities as deriveCapabilities,
  type InitializeResult,
  Repository,
} from "@nikovirtala/kiro-remote-core";
import { describe, expect, test } from "vitest";
import { publishCaps, runCapsPublish } from "../src/caps-publisher.ts";
import type { AcpGateway } from "../src/gateway.ts";
import { KAS_NODE_PATH, KAS_SERVER_PATH } from "../src/kas-engine.ts";
import { createLogger } from "../src/logger.ts";
import { defaultSpawn, type SpawnFn, type SpawnSpec } from "../src/transport.ts";
import { FakeDocClient, FakeS3Client } from "./fakes.ts";
import { initResult } from "./scenarios.ts";

const FAKE_AGENT = fileURLToPath(new URL("./fake-acp-agent.ts", import.meta.url));

/**
 * A SpawnFn that launches the real fake ACP agent as a Node child (exactly the
 * harness pattern) but routes its advertisement through FAKE_ACP_SCENARIO. It
 * records the requested spec and the spawned child so a test can assert what
 * the publisher would start and that the transport actually killed it (the
 * SIGTERM in runCapsPublish's finally).
 */
function recordingFakeAgentSpawn(scenario: unknown): {
  spawnFn: SpawnFn;
  specs: SpawnSpec[];
  children: ChildProcessWithoutNullStreams[];
} {
  const specs: SpawnSpec[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const spawnFn: SpawnFn = (spec) => {
    specs.push(spec);
    const child = defaultSpawn({
      command: process.execPath,
      args: [FAKE_AGENT],
      env: { ...spec.env, FAKE_ACP_SCENARIO: JSON.stringify(scenario) },
    });
    children.push(child);
    return child;
  };
  return { spawnFn, specs, children };
}

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
 * A fake gateway whose `initialize()` latches a prepared initializeResult, just
 * like the real AcpGateway does after negotiating with the child. Only the
 * three members publishCaps uses are implemented.
 */
function fakeGateway(
  raw: Record<string, unknown>,
): Pick<AcpGateway, "initialize" | "initializeResult" | "capabilities"> & { initialized: boolean } {
  let latched: InitializeResult = {};
  return {
    initialized: false,
    async initialize() {
      this.initialized = true;
      latched = raw as InitializeResult;
      return deriveCapabilities(raw);
    },
    get initializeResult(): InitializeResult {
      return latched;
    },
    capabilities() {
      return deriveCapabilities(latched);
    },
  };
}

describe("caps-publisher publishCaps", () => {
  test("initializes once and writes CONFIG#CAPS whose raw result derives the advertisement", async () => {
    const { repo } = wireRepo();
    const logLines: string[] = [];
    const logger = createLogger({ level: "debug", sink: (l) => logLines.push(l) });
    const gateway = fakeGateway(
      initResult({
        extensionMethods: ["_kiro/openExternalUrl", "_kiro/session/context"],
        executionTargets: ["cloud", "local"],
      }),
    );

    // biome-ignore lint/suspicious/noExplicitAny: fake gateway with the used members.
    await publishCaps(repo, gateway as any, logger);

    // The one realized job: a single initialize happened.
    expect(gateway.initialized).toBe(true);

    const caps = await repo.getCaps();
    expect(caps).not.toBeNull();
    const derived = deriveCapabilities((caps as { initializeResult: object }).initializeResult);
    expect(derived.extensionMethods).toEqual(["_kiro/openExternalUrl", "_kiro/session/context"]);
    expect(derived.executionTargets).toEqual(["cloud", "local"]);
    expect(derived.cloudExecution).toBe(true);

    // Model ids persisted from the model config option.
    const models = await repo.getModels();
    expect(models?.models).toEqual(["claude-sonnet", "claude-haiku"]);

    // Redaction-safe confirmation line logged (the same marker the ECS bridge emits).
    expect(logLines.some((l) => l.includes("config_caps_persisted"))).toBe(true);
    // And the publisher's own initialize-result breadcrumb.
    expect(logLines.some((l) => l.includes("caps_publisher_initialize_result"))).toBe(true);
  });

  test("no ksk_ secret leaks into the persisted item or the logs", async () => {
    const { repo } = wireRepo();
    const logLines: string[] = [];
    const logger = createLogger({ level: "debug", sink: (l) => logLines.push(l) });
    const gateway = fakeGateway({
      ...initResult(),
      access_token: "ksk_live_super_secret_value",
    });

    // biome-ignore lint/suspicious/noExplicitAny: fake gateway with the used members.
    await publishCaps(repo, gateway as any, logger);

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
    const { spawnFn, specs, children } = recordingFakeAgentSpawn({
      initialize: initResult({
        extensionMethods: ["_kiro/openExternalUrl", "_kiro/session/context"],
        executionTargets: ["cloud", "local"],
      }),
    });

    await runCapsPublish({
      config: { tableName: "kiro-remote-test", bucketName: "kiro-remote-test-bucket" },
      ddb: ddb as unknown as DynamoDBDocumentClient,
      // biome-ignore lint/suspicious/noExplicitAny: fake S3 client (unused on the publish path).
      s3: new FakeS3Client() as any,
      // The real transport+gateway run; only the child process is faked.
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
    const child = children[0];

    // runCapsPublish SIGTERMs the child in its finally; wait for the exit to
    // land so the assertion is not racy, then confirm it is no longer running.
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    expect(child.killed).toBe(true);

    // CONFIG#CAPS was written via the real initialize handshake over the
    // transport (not a fake gateway), proving the spawn->initialize->persist
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

    // The transport logged the child's clean exit (the SIGTERM stop path).
    expect(logLines.some((l) => l.includes("acp_child_exit"))).toBe(true);
    // No secret leaked through the real child env into the persisted item or logs.
    expect(JSON.stringify(caps)).not.toContain("ksk_");
    expect(logLines.join("\n")).not.toContain("ksk_");
  });
});
