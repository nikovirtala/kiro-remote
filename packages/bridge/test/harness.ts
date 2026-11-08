/**
 * Integration-test harness: wires a {@link BridgeServer} against the FAKE
 * scripted ACP agent (spawned as a real Node child) and in-memory AWS fakes.
 */

import { fileURLToPath } from "node:url";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { Repository, type SessionMetaItem, sessionPk } from "@nikovirtala/kiro-remote-core";
import type { HeadlessRunner } from "../src/headless.ts";
import { createLogger } from "../src/logger.ts";
import { CollectingMetricSink } from "../src/metrics.ts";
import { BridgeServer } from "../src/serve.ts";
import { defaultSpawn, type SpawnFn } from "../src/transport.ts";
import { FakeDocClient, FakeS3Client, FakeSqsClient } from "./fakes.ts";

const FAKE_AGENT = fileURLToPath(new URL("./fake-acp-agent.ts", import.meta.url));

export interface Harness {
  server: BridgeServer;
  ddb: FakeDocClient;
  s3: FakeS3Client;
  sqs: FakeSqsClient;
  repo: Repository;
  metrics: CollectingMetricSink;
  logLines: string[];
  seedSession(id: string, overrides?: Partial<SessionMetaItem>): Promise<SessionMetaItem>;
  stop(): Promise<void>;
}

/** Options for the harness. `headlessRunner` overrides the default cloud fake. */
export interface HarnessOptions {
  /** Scenario for the fake ACP agent (advertisement, replay, prompt scripting). */
  scenario?: unknown;
  /** Override the injectable headless runner (the chat --cloud subprocess fake). */
  headlessRunner?: HeadlessRunner;
}

/**
 * Build the plain-text `kiro-cli chat --cloud` output split across the two
 * streams, EXACTLY as the real --cloud subprocess emits it (there is NO
 * stream-json for --cloud):
 *  - STDERR carries the log-prefixed lines: `[INFO] ...`, `[cloud] session
 *    <uuid>`, `[tool] ...`/`[tool] status: ...`, `[sandbox] ...`.
 *  - STDOUT carries ONLY the assistant's free-text answer (no bracketed lines).
 * This mirrors production so the fakes exercise the same stream split the
 * parser relies on.
 */
export function cloudStreams(opts: {
  cloudSessionId: string;
  tools?: { title: string; status?: string }[];
  assistant?: string;
}): { stdout: string; stderr: string } {
  const errLines: string[] = [
    "[INFO] starting cloud session",
    `[cloud] session ${opts.cloudSessionId}`,
  ];
  for (const t of opts.tools ?? []) {
    errLines.push(`[tool] ${t.title}`);
    if (t.status) {
      errLines.push(`[tool] status: ${t.status}`);
    }
  }
  errLines.push("[sandbox] done");
  const stdout = opts.assistant ? `${opts.assistant}\n` : "";
  return { stdout, stderr: `${errLines.join("\n")}\n` };
}

/** A headless runner that returns a fixed plain-text cloud result for every call. */
export function cloudRunner(opts: {
  cloudSessionId: string;
  tools?: { title: string; status?: string }[];
  assistant?: string;
}): HeadlessRunner {
  return async () => ({ code: 0, ...cloudStreams(opts) });
}

/** Build a spawn fn that launches the fake agent with a scenario env. */
function fakeAgentSpawn(scenario: unknown): SpawnFn {
  return (spec) =>
    defaultSpawn({
      command: process.execPath,
      args: [FAKE_AGENT],
      env: { ...spec.env, FAKE_ACP_SCENARIO: JSON.stringify(scenario) },
    });
}

export async function createHarness(
  scenario: unknown,
  headlessRunner?: HeadlessRunner,
): Promise<Harness> {
  const ddb = new FakeDocClient();
  const s3 = new FakeS3Client();
  const sqs = new FakeSqsClient();
  const metrics = new CollectingMetricSink();
  const logLines: string[] = [];
  const logger = createLogger({
    level: "debug",
    sink: (line) => logLines.push(line),
    bindings: { service: "bridge-test" },
  });

  const docClient = ddb as unknown as DynamoDBDocumentClient;

  // Default headless (chat --cloud) runner: emit valid plain-text cloud output
  // so a launch provisions + reaches idle. The cloud session id defaults to the
  // scenario's `newSessionId` (tests already set a recognizable value) with a
  // UUID fallback. Tests that need specific output pass their own runner.
  const sc = (scenario ?? {}) as { newSessionId?: string };
  const defaultCloudId = sc.newSessionId ?? "08047063-f7b4-4ce5-b79a-2aea9a7a1d29";
  const runner =
    headlessRunner ??
    cloudRunner({
      cloudSessionId: defaultCloudId,
      tools: [{ title: "fs_read /workspace", status: "Completed" }],
      assistant: "done",
    });

  const server = await BridgeServer.create({
    config: {
      tableName: "kiro-remote-test",
      bucketName: "kiro-remote-test-bucket",
      queueUrl: "https://sqs.local/queue.fifo",
      workspaceRoot: "/workspace/project",
      additionalDirectories: ["/workspace/shared"],
      mcpServers: [{ name: "example", command: "x" }],
      region: "us-east-1",
    },
    ddb: docClient,
    // biome-ignore lint/suspicious/noExplicitAny: injecting fake S3/SQS clients.
    s3: s3 as any,
    // biome-ignore lint/suspicious/noExplicitAny: injecting fake S3/SQS clients.
    sqs: sqs as any,
    spawnFn: fakeAgentSpawn(scenario),
    headlessRunner: runner,
    logger,
    metricSink: metrics,
    env: {},
  });

  const repo = new Repository({
    ddb: docClient,
    // biome-ignore lint/suspicious/noExplicitAny: fake S3 client.
    s3: s3 as any,
    tableName: "kiro-remote-test",
    bucketName: "kiro-remote-test-bucket",
  });

  async function seedSession(
    id: string,
    overrides: Partial<SessionMetaItem> = {},
  ): Promise<SessionMetaItem> {
    const ts = new Date().toISOString();
    const item: SessionMetaItem = {
      PK: sessionPk(id),
      SK: "META",
      id,
      kiroSessionId: null,
      title: null,
      repos: ["octo/repo"],
      agent: null,
      mode: null,
      model: null,
      effort: null,
      status: "provisioning",
      activeTurnId: null,
      eventSeq: 0,
      createdBy: "user-sub-1",
      createdAt: ts,
      updatedAt: ts,
      version: 0,
      GSI1PK: "USER#user-sub-1",
      GSI1SK: ts,
      ...overrides,
    };
    await repo.putSession(item);
    return item;
  }

  return {
    server,
    ddb,
    s3,
    sqs,
    repo,
    metrics,
    logLines,
    seedSession,
    stop: async () => {
      await server.shutdown();
    },
  };
}

/** Assert a harness is present (avoids non-null assertions in test closures). */
export function requireHarness(h: Harness | null): Harness {
  if (!h) {
    throw new Error("harness not created");
  }
  return h;
}

/** Poll until `predicate` is true or the timeout elapses. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const intervalMs = opts.intervalMs ?? 10;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor timed out");
}
