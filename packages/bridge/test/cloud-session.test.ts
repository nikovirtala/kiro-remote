/**
 * Direct unit tests for the engine-free cloud-session primitives. These
 * construct {@link CloudSession} with only a Repository over the in-memory
 * DynamoDB fake, the collecting metric sink, and a logger -- exactly what the
 * Lambda consumer does -- and exercise the shared rules without a child
 * process.
 *
 * They assert the idempotency skips (including the durable-row runtime-reset
 * case and issuedTurns eviction at MAX_ISSUED_TURNS), the follow-up turn
 * start, the UnsupportedCloudOperationError rejections, and the persisted
 * rejection event -- so they would FAIL if those rules were silently changed.
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
import { createLogger } from "../src/logger.ts";
import { CollectingMetricSink, Metrics } from "../src/metrics.ts";
import { FakeDocClient, FakeS3Client } from "./fakes.ts";

const CLOUD_ID = "08047063-f7b4-4ce5-b79a-2aea9a7a1d29";

/** The stored event `payload` is the whole NormalizedEvent; read it as a bag. */
function top(ev: { payload: unknown } | undefined): Record<string, unknown> {
  return (ev?.payload ?? {}) as Record<string, unknown>;
}

/** The NormalizedEvent's nested `payload` (where the source markers live). */
function inner(ev: { payload: unknown } | undefined): Record<string, unknown> {
  return (top(ev).payload ?? {}) as Record<string, unknown>;
}

interface Wired {
  cloud: CloudSession;
  repo: Repository;
  metrics: CollectingMetricSink;
  logLines: string[];
  seed(id: string, overrides?: Partial<SessionMetaItem>): Promise<SessionMetaItem>;
  runtime(id: string): SessionRuntime;
}

/** Build a CloudSession over the AWS fakes. */
function wire(): Wired {
  const ddb = new FakeDocClient();
  const s3 = new FakeS3Client();
  const repo = new Repository({
    ddb: ddb as unknown as DynamoDBDocumentClient,
    // biome-ignore lint/suspicious/noExplicitAny: fake S3 client.
    s3: s3 as any,
    tableName: "kiro-remote-test",
    bucketName: "kiro-remote-test-bucket",
  });
  const metrics = new CollectingMetricSink();
  const logLines: string[] = [];
  const logger = createLogger({ level: "debug", sink: (l) => logLines.push(l) });
  // A fixed clock so timings are deterministic.
  let clock = 1_000;
  const now = () => (clock += 1);
  const cloud = new CloudSession({ repo, logger, metrics: new Metrics(metrics), now });

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

  return { cloud, repo, metrics, logLines, seed, runtime };
}

/**
 * A launched, idle session: META `idle` with the cloud id, and a runtime that
 * has launched and holds the same id (what the consumer has after a launch
 * turn settles).
 */
async function idleLaunched(w: Wired, id: string): Promise<SessionRuntime> {
  await w.seed(id, { status: "idle", kiroSessionId: CLOUD_ID });
  const rt = w.runtime(id);
  rt.launched = true;
  rt.kiroSessionId = CLOUD_ID;
  rt.machine = { session: "idle", turn: null };
  return rt;
}

describe("CloudSession launch idempotency", () => {
  test("launchAlreadyIssued is true for a launched runtime", async () => {
    const w = wire();
    const rt = await idleLaunched(w, "sdup");
    expect(await w.cloud.launchAlreadyIssued("sdup", rt)).toBe(true);
  });

  test("launchAlreadyIssued is true after a runtime reset (durable-row check)", async () => {
    const w = wire();
    // A durable row ALREADY past provisioning (as if a prior container launched
    // it before this container's runtime map existed).
    await w.seed("sreset", { status: "idle", kiroSessionId: CLOUD_ID });
    // A FRESH runtime (launched=false, kiroSessionId=null) -- the runtime-reset
    // case. The durable row must still short-circuit the launch.
    const rt = w.runtime("sreset");
    expect(rt.launched).toBe(false);
    expect(rt.kiroSessionId).toBeNull();
    expect(await w.cloud.launchAlreadyIssued("sreset", rt)).toBe(true);
  });

  test("launchAlreadyIssued is false for a fresh provisioning row", async () => {
    const w = wire();
    await w.seed("sfresh");
    expect(await w.cloud.launchAlreadyIssued("sfresh", w.runtime("sfresh"))).toBe(false);
  });
});

describe("CloudSession follow-up turn (resume)", () => {
  test("beginResume starts the turn: running in memory and on the durable row", async () => {
    const w = wire();
    const rt = await idleLaunched(w, "sr");

    expect(await w.cloud.beginResume(rt, "sr", "turn-1", "turn-1")).toBe(true);
    expect(rt.machine.turn).toBe("running");
    expect(rt.activeTurnId).toBe("turn-1");
    const session = await w.repo.getSession("sr");
    expect(session?.status).toBe("running");
    expect(session?.activeTurnId).toBe("turn-1");
  });

  test("dedupes a redelivered prompt by turn id (issuedTurns)", async () => {
    const w = wire();
    const rt = await idleLaunched(w, "sdd");

    expect(await w.cloud.beginResume(rt, "sdd", "t-7", "t-7")).toBe(true);
    // Redelivery of the SAME turn id is a logged no-op (returns false).
    expect(await w.cloud.beginResume(rt, "sdd", "t-7", "t-7")).toBe(false);
    expect(w.logLines.some((l) => l.includes("prompt_idempotent_skip"))).toBe(true);
  });

  test("evicts the oldest issued turn id at MAX_ISSUED_TURNS", () => {
    const w = wire();
    const rt = w.runtime("sev");
    // Record one more than the cap; the first (oldest) id must be evicted.
    for (let i = 0; i < MAX_ISSUED_TURNS + 1; i++) {
      w.cloud.recordIssuedTurn(rt, `turn-${i}`);
    }
    expect(rt.issuedTurns.size).toBe(MAX_ISSUED_TURNS);
    expect(rt.issuedTurns.has("turn-0")).toBe(false);
    expect(rt.issuedTurns.has(`turn-${MAX_ISSUED_TURNS}`)).toBe(true);
  });
});

describe("CloudSession unsupported operations", () => {
  async function busy(w: Wired, id: string): Promise<SessionRuntime> {
    const rt = await idleLaunched(w, id);
    // Begin a turn so the machine is turn=running.
    await w.cloud.beginResume(rt, id, "t-busy", "t-busy");
    expect(rt.machine.turn).toBe("running");
    return rt;
  }

  test("rejects a mid-turn steer with UnsupportedCloudOperationError", async () => {
    const w = wire();
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
    const w = wire();
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
    const w = wire();
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
    const w = wire();
    const rt = await idleLaunched(w, "sidle");
    // Idle session -> a follow-up is a fresh prompt.
    expect(w.cloud.classifySteer(rt, "sidle", "steer", undefined)).toBe("prompt");

    // Make it busy, then whenBusy=reject is a quiet skip (not a throw).
    await w.cloud.beginResume(rt, "sidle", "t-r", "t-r");
    expect(w.cloud.classifySteer(rt, "sidle", "reject", undefined)).toBe("reject");
  });

  test("classifyCancel is a no-op when no turn is running", async () => {
    const w = wire();
    const rt = await idleLaunched(w, "snc");
    expect(w.cloud.classifyCancel(rt, "snc")).toBe("no_active_turn");
  });

  test("recordUnsupportedRejection persists a client-visible turn.failed event", async () => {
    const w = wire();
    const rt = await idleLaunched(w, "srej");

    await w.cloud.recordUnsupportedRejection(rt, "steer", "nope");
    const events = await w.repo.queryEvents("srej", 0, { limit: 100 });
    const rejected = events.find(
      (e) => e.type === "turn.failed" && e.rawType === "operation_rejected",
    );
    expect(rejected).toBeDefined();
    expect(inner(rejected).source).toBe("chat-cloud");
    expect(inner(rejected).operation).toBe("steer");
    expect(inner(rejected).reason).toBe("nope");
    expect(w.metrics.sum("EventsWritten")).toBe(1);
  });
});
