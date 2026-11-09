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

import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  capabilities as deriveCapabilities,
  type InitializeResult,
  Repository,
} from "@nikovirtala/kiro-remote-core";
import { describe, expect, test } from "vitest";
import { publishCaps } from "../src/caps-publisher.ts";
import type { AcpGateway } from "../src/gateway.ts";
import { createLogger } from "../src/logger.ts";
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
