/**
 * Shared setup for the queue tests: the consumer over the in-memory DynamoDB with the fake ACP
 * agent as the engine, a command queue and GitHub queue that only record, and a `pump` that
 * delivers what the system enqueued the way the command queue would.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Command,
  type CommandQueue,
  type GithubQueue,
  type GithubQueueMessage,
  type InboxItem,
  inboxSk,
  Repository,
  sessionPk,
} from "@nikovirtala/kiro-remote-core";
import { MemoryDdb, MemoryS3, sessionItem } from "@nikovirtala/kiro-remote-core/testing";
import type { CatchUpMessage, CatchUpScheduler } from "../src/catch-up.ts";
import { LambdaConsumer, type SQSEvent } from "../src/lambda-consumer.ts";
import { createLogger } from "../src/logger.ts";
import { CollectingMetricSink } from "../src/metrics.ts";
import { fakeAgentSpawner } from "./fake-agent-spawn.ts";
import { initResult } from "./scenarios.ts";

const CLOUD_ID = "sess_08047063-f7b4-4ce5-b79a-2aea9a7a1d29";
export const SID = "SQUEUE1";
export const SUB = "user-sub-1";

const notify = (params: Record<string, unknown>) => ({
  kind: "notify",
  method: "session/update",
  params,
});
const info = (kind: string, extra: Record<string, unknown> = {}) =>
  notify({ sessionUpdate: "session_info_update", _meta: { kiro: { kind } }, ...extra });
const chunk = (text: string) =>
  notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const completion = () => info("turn_completion", { status: "end_turn" });

/** The first turn: it never ends within the invocation, so the consumer detaches. */
export const LAUNCH_NEVER_ENDS = {
  initialize: initResult(),
  newSessionId: CLOUD_ID,
  onPrompt: { messages: [info("turn_start"), chunk("Hello wo")], neverRespond: true },
};
/** What the catch-up loads: the replay of the detached turn, now finished. */
export const DETACHED_DONE = {
  initialize: initResult(),
  onLoad: {
    replayBeforeResponse: true,
    messages: [info("turn_start"), chunk("Hello world"), completion(), info("turn_end")],
  },
};
/** A first turn that runs to its end within the invocation. */
export const LAUNCH = {
  initialize: initResult(),
  newSessionId: CLOUD_ID,
  onPrompt: {
    messages: [info("turn_start"), chunk("Hello"), completion(), info("turn_end")],
    response: { stopReason: "end_turn" },
  },
};
/** A follow-up turn that runs to its end. */
export const FOLLOW_UP = {
  initialize: initResult(),
  onLoad: {
    replayBeforeResponse: true,
    messages: [info("turn_start"), chunk("old"), info("turn_end")],
  },
  onPrompt: {
    messages: [info("turn_start"), chunk("Done."), completion(), info("turn_end")],
    response: { stopReason: "end_turn" },
  },
};

export class Commands implements CommandQueue {
  commands: Command[] = [];
  async enqueue(c: Command) {
    this.commands.push(c);
  }
}
export class GithubQ implements GithubQueue {
  sent: GithubQueueMessage[] = [];
  async send(m: GithubQueueMessage) {
    this.sent.push(m);
  }
}
export class Scheduler implements CatchUpScheduler {
  scheduled: CatchUpMessage[] = [];
  async start(msg: CatchUpMessage) {
    this.scheduled.push(msg);
  }
}

export const ev = (c: Command | CatchUpMessage, id = "m"): SQSEvent => ({
  Records: [{ messageId: id, body: JSON.stringify(c) }],
});

export async function wire(scenarios: unknown[]) {
  const ddb = new MemoryDdb();
  const s3 = new MemoryS3();
  // One clock for the test's repository and the consumer's, so the order records were written in
  // is the order the test wrote them in.
  let clock = 1_000;
  const now = () => (clock += 1);
  const repo = new Repository({
    ddb: ddb as never,
    s3: s3 as never,
    tableName: "t",
    bucketName: "b",
    now,
  });
  const commands = new Commands();
  const githubQueue = new GithubQ();
  const scheduler = new Scheduler();
  const workspaceRoot = await mkdtemp(join(tmpdir(), "kiro-remote-queue-loss-"));
  const consumer = await LambdaConsumer.create({
    config: { tableName: "t", bucketName: "b", workspaceRoot, region: "us-east-1" },
    ddb: ddb as never,
    s3: s3 as never,
    spawnFn: fakeAgentSpawner(scenarios).spawnFn,
    catchUpScheduler: scheduler,
    commandQueue: commands,
    githubQueue,
    detachMarginMs: 100,
    logger: createLogger({ level: "debug", sink: () => {} }),
    metricSink: new CollectingMetricSink(),
    env: { KIRO_API_KEY: "ksk_test_key" },
    now,
  });
  ddb.put(sessionItem(SID, { status: "provisioning", kiroSessionId: null, repos: ["octo/repo"] }));
  let delivered = 0;
  return {
    consumer,
    repo,
    commands,
    githubQueue,
    scheduler,
    /** Deliver what the system enqueued since the last call, as the command queue would. */
    async pump() {
      while (delivered < commands.commands.length) {
        const c = commands.commands[delivered++];
        await consumer.handleEvent(ev(c, `m-${delivered}`));
      }
    },
    send: (c: Command, id?: string) => consumer.handleEvent(ev(c, id)),
    /** The turn ids that ran, in the order they started. */
    async turnsInOrder(ids: string[]) {
      return (await Promise.all(ids.map((id) => repo.getTurn(SID, id))))
        .filter((t) => t !== null)
        .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
        .map((t) => t.id);
    },
    async addInbox(id: string, over: Partial<InboxItem> = {}) {
      await repo.putInboxItem({
        PK: sessionPk(SID),
        SK: inboxSk(id),
        id,
        sessionId: SID,
        source: "github",
        deliveryId: `d-${id}`,
        deliveryIds: [`d-${id}`],
        kind: "pr_merged",
        key: "octo/repo#7",
        prompt: `[GitHub webhook] wake ${id}`,
        data: null,
        createdAt: new Date(0).toISOString(),
        notBefore: new Date(0).toISOString(),
        status: "pending",
        dropReason: null,
        deliveredTurnId: null,
        autoClose: false,
        ttl: 9_999_999_999,
        ...over,
      });
    },
  };
}
export const launch = (): Command => ({
  kind: "launch",
  sub: SUB,
  sessionId: SID,
  commandId: "c-launch",
  prompt: "first",
  repos: ["octo/repo"],
});
export const prompt = (turnId: string, whenBusy: "steer" | "queue" | "reject"): Command => ({
  kind: "prompt",
  sub: SUB,
  sessionId: SID,
  commandId: `c-${turnId}`,
  turnId,
  prompt: `prompt ${turnId}`,
  whenBusy,
});

/** The launch turn detaches: the session stays `running` and a catch-up is scheduled. */
export async function detachedFirstTurn(w: Awaited<ReturnType<typeof wire>>) {
  await w.consumer.handleEvent(ev(launch()), { remainingTimeMs: () => 300 });
  if ((await w.repo.getSession(SID))?.status !== "running" || w.scheduler.scheduled.length !== 1) {
    throw new Error("the first turn did not detach");
  }
}
