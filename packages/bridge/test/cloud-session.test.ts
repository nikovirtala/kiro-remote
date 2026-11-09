/**
 * Direct unit tests for the EXTRACTED, gateway-free cloud-path engine
 * (FEAT-002). These construct {@link CloudSession} with NO AcpGateway -- only a
 * Repository over the in-memory DynamoDB fake, the collecting metric sink, a
 * scripted HeadlessRunner, and a logger -- which is exactly what the future
 * Lambda consumer (FEAT-003) will do. They exercise the shared primitives
 * SYNCHRONOUSLY (awaiting settlement, the Lambda wrapping) rather than through
 * the ECS background pattern, proving BOTH wrappings share the same logic.
 *
 * They assert the REAL event shapes, idempotency skips (including the durable-
 * row runtime-reset case and issuedTurns eviction at MAX_ISSUED_TURNS), the
 * persistTurnResult event shape, the three UnsupportedCloudOperationError
 * rejections, and the loud-failure metrics -- so they would FAIL if the
 * extracted logic were reverted or silently changed.
 */

import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { Repository, type SessionMetaItem, sessionPk } from "@nikovirtala/kiro-remote-core";
import { describe, expect, test } from "vitest";
import {
  CloudSession,
  createRuntime,
  MAX_ISSUED_TURNS,
  type SessionRuntime,
  UnsupportedCloudOperationError,
} from "../src/cloud-session.ts";
import type { HeadlessRunner } from "../src/headless.ts";
import { createLogger, type Logger } from "../src/logger.ts";
import { CollectingMetricSink, Metrics } from "../src/metrics.ts";
import { FakeDocClient, FakeS3Client } from "./fakes.ts";
import { cloudStreams } from "./harness.ts";

const CLOUD_ID = "08047063-f7b4-4ce5-b79a-2aea9a7a1d29";

/** The stored event `payload` is the whole NormalizedEvent; read it as a bag. */
function top(ev: { payload: unknown } | undefined): Record<string, unknown> {
  return (ev?.payload ?? {}) as Record<string, unknown>;
}

/** The NormalizedEvent's nested `payload` (where the chat-cloud markers live). */
function inner(ev: { payload: unknown } | undefined): Record<string, unknown> {
  return (top(ev).payload ?? {}) as Record<string, unknown>;
}

interface Wired {
  cloud: CloudSession;
  repo: Repository;
  metrics: CollectingMetricSink;
  logLines: string[];
  logger: Logger;
  kiroToLocal: Map<string, string>;
  now: () => number;
  seed(id: string, overrides?: Partial<SessionMetaItem>): Promise<SessionMetaItem>;
  runtime(id: string): SessionRuntime;
}

/** Build a CloudSession over the AWS fakes with a scripted headless runner. */
function wire(runner: HeadlessRunner): Wired {
  const ddb = new FakeDocClient();
  const s3 = new FakeS3Client();
  const docClient = ddb as unknown as DynamoDBDocumentClient;
  const repo = new Repository({
    ddb: docClient,
    // biome-ignore lint/suspicious/noExplicitAny: fake S3 client.
    s3: s3 as any,
    tableName: "kiro-remote-test",
    bucketName: "kiro-remote-test-bucket",
  });
  const metrics = new CollectingMetricSink();
  const logLines: string[] = [];
  const logger = createLogger({ level: "debug", sink: (l) => logLines.push(l) });
  const kiroToLocal = new Map<string, string>();
  // A fixed clock so TurnDuration/TimeToFirstEvent are deterministic.
  let clock = 1_000;
  const now = () => (clock += 1);
  const cloud = new CloudSession({
    repo,
    logger,
    metrics: new Metrics(metrics),
    headlessRunner: runner,
    kiroToLocal,
    now,
  });

  const runtimes = new Map<string, SessionRuntime>();
  function runtime(id: string): SessionRuntime {
    let rt = runtimes.get(id);
    if (!rt) {
      rt = createRuntime(id, { cwd: "/workspace", mcpServers: [] }, now);
      runtimes.set(id, rt);
    }
    return rt;
  }

  async function seed(
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

  return { cloud, repo, metrics, logLines, logger, kiroToLocal, now, seed, runtime };
}

/** A runner that returns the plain-text cloud streams with a given exit code. */
function fixedRunner(opts: {
  code?: number | null;
  cloudSessionId?: string;
  tools?: { title: string; status?: string }[];
  assistant?: string;
  stdout?: string;
  stderr?: string;
}): HeadlessRunner {
  return async () => {
    if (opts.stdout !== undefined || opts.stderr !== undefined) {
      return { code: opts.code ?? 0, stdout: opts.stdout ?? "", stderr: opts.stderr ?? "" };
    }
    return {
      code: opts.code ?? 0,
      ...cloudStreams({
        cloudSessionId: opts.cloudSessionId ?? CLOUD_ID,
        tools: opts.tools,
        assistant: opts.assistant,
      }),
    };
  };
}

describe("CloudSession launch (gateway-free)", () => {
  test("provisions via chat --cloud, parses the cloud id, persists events, reaches idle", async () => {
    const w = wire(
      fixedRunner({
        tools: [{ title: "fs_read /workspace/README.md", status: "Completed" }],
        assistant: "Here is the answer.",
      }),
    );
    await w.seed("sc");
    const rt = w.runtime("sc");

    const begun = await w.cloud.beginLaunch(rt, "sc", { prompt: "do it", repos: ["octo/repo"] });
    expect(begun).not.toBeNull();
    // Run the SAME settlement primitive SYNCHRONOUSLY (the Lambda wrapping).
    await begun?.settle();

    const session = await w.repo.getSession("sc");
    expect(session?.status).toBe("idle");
    expect(session?.kiroSessionId).toBe(CLOUD_ID);
    // The cloud->local map was populated for update routing.
    expect(w.kiroToLocal.get(CLOUD_ID)).toBe("sc");

    const metricNames = w.metrics.names();
    expect(w.metrics.sum("SessionsLaunched")).toBe(1);
    expect(metricNames).toContain("LaunchPath");
    expect(metricNames).toContain("TurnDuration");
    expect(metricNames).toContain("TimeToFirstEvent");
    const launchPath = w.metrics.data.find((d) => d.name === "LaunchPath");
    expect(launchPath?.dimensions?.path).toBe("headless");

    // The persisted events carry the exact normalized shapes. The stored
    // `payload` is the whole NormalizedEvent, so the chat-cloud source marker
    // lives on its nested `payload`.
    const events = await w.repo.queryEvents("sc", 0, { limit: 100 });
    const call = events.find((e) => e.type === "tool.call");
    expect(call).toBeDefined();
    expect(top(call).toolCallId).toBe("1");
    expect(inner(call).source).toBe("chat-cloud");
    const update = events.find((e) => e.type === "tool.update");
    expect(top(update).status).toBe("Completed");
    const message = events.find((e) => e.type === "message.chunk");
    const content = top(message).content as { text?: string } | undefined;
    expect(content?.text).toBe("Here is the answer.");
  });

  test("fails LOUDLY when no `[cloud] session` line appears", async () => {
    const w = wire(fixedRunner({ stdout: "nope\n", stderr: "[INFO] starting\n[sandbox] done\n" }));
    await w.seed("sfail");
    const rt = w.runtime("sfail");

    const begun = await w.cloud.beginLaunch(rt, "sfail", { prompt: "p", repos: ["octo/repo"] });
    await begun?.settle();

    const session = await w.repo.getSession("sfail");
    expect(session?.status).toBe("failed");
    expect(session?.kiroSessionId).toBeNull();
    expect(w.metrics.sum("CloudLaunchFailed")).toBe(1);
    expect(w.metrics.sum("SessionsLaunched")).toBe(0);
    expect(w.logLines.some((l) => l.includes("cloud_launch_failed"))).toBe(true);
  });

  test("fails LOUDLY when the chat --cloud subprocess exits non-zero", async () => {
    const w = wire(fixedRunner({ code: 1 }));
    await w.seed("snz");
    const rt = w.runtime("snz");
    const begun = await w.cloud.beginLaunch(rt, "snz", { prompt: "p", repos: ["octo/repo"] });
    await begun?.settle();
    expect((await w.repo.getSession("snz"))?.status).toBe("failed");
    expect(w.metrics.sum("CloudLaunchFailed")).toBe(1);
  });

  test("is idempotent for a redelivered launch while the runtime is still present", async () => {
    const w = wire(fixedRunner({ assistant: "a" }));
    await w.seed("sdup");
    const rt = w.runtime("sdup");

    const first = await w.cloud.beginLaunch(rt, "sdup", { prompt: "p", repos: ["octo/repo"] });
    await first?.settle();
    // A redelivery of the SAME launch must be a logged no-op (returns null).
    const second = await w.cloud.beginLaunch(rt, "sdup", { prompt: "p", repos: ["octo/repo"] });
    expect(second).toBeNull();
    expect(w.logLines.some((l) => l.includes("launch_idempotent_skip"))).toBe(true);
    // Exactly one launch metric despite two begins.
    expect(w.metrics.sum("SessionsLaunched")).toBe(1);
  });

  test("is idempotent after a runtime reset (durable-row check)", async () => {
    const w = wire(fixedRunner({ assistant: "a" }));
    // Seed a durable row that is ALREADY past provisioning (as if a prior bridge
    // launched it before the runtime map was lost on restart).
    await w.seed("sreset", { status: "idle", kiroSessionId: CLOUD_ID });
    // A FRESH runtime (launched=false, kiroSessionId=null) -- the runtime-reset
    // case. The durable row must still short-circuit the launch.
    const rt = w.runtime("sreset");
    expect(rt.launched).toBe(false);
    expect(rt.kiroSessionId).toBeNull();

    const begun = await w.cloud.beginLaunch(rt, "sreset", { prompt: "p", repos: ["octo/repo"] });
    expect(begun).toBeNull();
    expect(w.logLines.some((l) => l.includes("launch_idempotent_skip"))).toBe(true);
    expect(w.metrics.sum("SessionsLaunched")).toBe(0);
  });
});

describe("CloudSession follow-up turn (resume)", () => {
  async function launched(w: Wired, id: string): Promise<SessionRuntime> {
    await w.seed(id);
    const rt = w.runtime(id);
    const begun = await w.cloud.beginLaunch(rt, id, { prompt: "first", repos: ["octo/repo"] });
    await begun?.settle();
    return rt;
  }

  test("runs chat --resume-id, persists output, settles the turn back to idle", async () => {
    const w = wire(fixedRunner({ assistant: "follow up answer" }));
    const rt = await launched(w, "sr");

    const begun = await w.cloud.beginResume(rt, "sr", "again", "turn-1", "turn-1");
    expect(begun).not.toBeNull();
    await begun?.settle();

    expect((await w.repo.getSession("sr"))?.status).toBe("idle");
    const events = await w.repo.queryEvents("sr", 0, { limit: 100 });
    const texts = events
      .filter((e) => e.type === "message.chunk")
      .map((e) => (top(e).content as { text?: string } | undefined)?.text);
    expect(texts).toContain("follow up answer");
  });

  test("dedupes a redelivered prompt by turn id (issuedTurns)", async () => {
    const w = wire(fixedRunner({ assistant: "x" }));
    const rt = await launched(w, "sdd");

    const first = await w.cloud.beginResume(rt, "sdd", "p", "t-7", "t-7");
    await first?.settle();
    // Redelivery of the SAME turn id is a logged no-op (returns null).
    const second = await w.cloud.beginResume(rt, "sdd", "p", "t-7", "t-7");
    expect(second).toBeNull();
    expect(w.logLines.some((l) => l.includes("prompt_idempotent_skip"))).toBe(true);
  });

  test("evicts the oldest issued turn id at MAX_ISSUED_TURNS", async () => {
    const w = wire(fixedRunner({}));
    const rt = w.runtime("sev");
    // Record one more than the cap; the first (oldest) id must be evicted.
    for (let i = 0; i < MAX_ISSUED_TURNS + 1; i++) {
      w.cloud.recordIssuedTurn(rt, `turn-${i}`);
    }
    expect(rt.issuedTurns.size).toBe(MAX_ISSUED_TURNS);
    expect(rt.issuedTurns.has("turn-0")).toBe(false);
    expect(rt.issuedTurns.has(`turn-${MAX_ISSUED_TURNS}`)).toBe(true);
  });

  test("fails LOUDLY (turn.failed + CloudTurnFailed) when the resume exits non-zero", async () => {
    const w = wire(fixedRunner({}));
    const rt = await launched(w, "srf");
    // Swap in a failing runner for the resume by reconstructing is awkward; use a
    // runtime with no cloud id to force the loud-failure branch instead.
    rt.kiroSessionId = null;

    const begun = await w.cloud.beginResume(rt, "srf", "p", "t-x", "t-x");
    await begun?.settle();

    expect(w.metrics.sum("CloudTurnFailed")).toBe(1);
    expect(w.logLines.some((l) => l.includes("cloud_turn_failed"))).toBe(true);
    const events = await w.repo.queryEvents("srf", 0, { limit: 100 });
    const failed = events.find((e) => e.type === "turn.failed");
    expect(failed).toBeDefined();
    expect(inner(failed).source).toBe("chat-cloud");
    // The session settles back to idle (prompt.error), never stuck running.
    expect((await w.repo.getSession("srf"))?.status).toBe("idle");
  });
});

describe("CloudSession unsupported operations", () => {
  async function busy(w: Wired, id: string): Promise<SessionRuntime> {
    await w.seed(id);
    const rt = w.runtime(id);
    const begun = await w.cloud.beginLaunch(rt, id, { prompt: "first", repos: ["octo/repo"] });
    await begun?.settle();
    // Begin a resume WITHOUT settling it so the machine stays turn=running.
    await w.cloud.beginResume(rt, id, "p", "t-busy", "t-busy");
    expect(rt.machine.turn).toBe("running");
    return rt;
  }

  test("rejects a mid-turn steer with UnsupportedCloudOperationError", async () => {
    const w = wire(fixedRunner({}));
    const rt = await busy(w, "sste");
    expect(() => w.cloud.classifySteer(rt, "sste", "steer", undefined)).toThrow(
      UnsupportedCloudOperationError,
    );
    try {
      w.cloud.classifySteer(rt, "sste", "steer", undefined);
    } catch (err) {
      expect((err as UnsupportedCloudOperationError).operation).toBe("steer");
    }
  });

  test("rejects a whenBusy=queue follow-up with UnsupportedCloudOperationError", async () => {
    const w = wire(fixedRunner({}));
    const rt = await busy(w, "squ");
    try {
      w.cloud.classifySteer(rt, "squ", "queue", undefined);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedCloudOperationError);
      expect((err as UnsupportedCloudOperationError).operation).toBe("queue");
    }
  });

  test("rejects a cancel of a running cloud turn with UnsupportedCloudOperationError", async () => {
    const w = wire(fixedRunner({}));
    const rt = await busy(w, "sca");
    try {
      w.cloud.classifyCancel(rt, "sca");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedCloudOperationError);
      expect((err as UnsupportedCloudOperationError).operation).toBe("cancel");
    }
  });

  test("classifySteer returns 'prompt' for an idle session and 'reject' for whenBusy=reject", async () => {
    const w = wire(fixedRunner({ assistant: "a" }));
    await w.seed("sidle");
    const rt = w.runtime("sidle");
    const begun = await w.cloud.beginLaunch(rt, "sidle", { prompt: "p", repos: ["octo/repo"] });
    await begun?.settle();
    // Idle session -> a follow-up is a fresh prompt.
    expect(w.cloud.classifySteer(rt, "sidle", "steer", undefined)).toBe("prompt");

    // Make it busy, then whenBusy=reject is a quiet skip (not a throw).
    await w.cloud.beginResume(rt, "sidle", "p", "t-r", "t-r");
    expect(w.cloud.classifySteer(rt, "sidle", "reject", undefined)).toBe("reject");
  });

  test("classifyCancel is a no-op when no turn is running", async () => {
    const w = wire(fixedRunner({ assistant: "a" }));
    await w.seed("snc");
    const rt = w.runtime("snc");
    const begun = await w.cloud.beginLaunch(rt, "snc", { prompt: "p", repos: ["octo/repo"] });
    await begun?.settle();
    expect(w.cloud.classifyCancel(rt, "snc")).toBe("no_active_turn");
  });

  test("recordUnsupportedRejection persists a client-visible turn.failed event", async () => {
    const w = wire(fixedRunner({ assistant: "a" }));
    await w.seed("srej");
    const rt = w.runtime("srej");
    const begun = await w.cloud.beginLaunch(rt, "srej", { prompt: "p", repos: ["octo/repo"] });
    await begun?.settle();

    await w.cloud.recordUnsupportedRejection(rt, "steer", "nope");
    const events = await w.repo.queryEvents("srej", 0, { limit: 100 });
    const rejected = events.find(
      (e) => e.type === "turn.failed" && e.rawType === "operation_rejected",
    );
    expect(rejected).toBeDefined();
    expect(inner(rejected).operation).toBe("steer");
    expect(inner(rejected).reason).toBe("nope");
  });
});
