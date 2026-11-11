import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type Command,
  type CommandQueue,
  type GithubQueue,
  type GithubQueueMessage,
  Repository,
} from "@nikovirtala/kiro-remote-core";
import { MemoryDdb, MemoryS3, sessionItem } from "@nikovirtala/kiro-remote-core/testing";
import type { ConsumerDeps } from "../src/consumer.ts";
import { CollectingMetrics, type Logger } from "../src/log.ts";
import type { GithubEvent, RouteConfig, RouteLink } from "../src/types.ts";

export const SHA = "1111111111111111111111111111111111111111";
export const T0 = Date.parse("2026-02-01T11:00:00.000Z");

export function fixture<T = Record<string, unknown>>(name: string): T {
  const url = new URL(`./fixtures/${name}.synthetic.json`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as T;
}

export function coreFixture<T = Record<string, unknown>>(name: string): T {
  const url = new URL(`../../core/test/fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as T;
}

export function event(
  name: string,
  fixtureName: string,
  deliveryId = `del-${fixtureName}`,
): GithubEvent {
  return { name, deliveryId, payload: fixture(fixtureName) };
}

export const LINK: RouteLink = {
  sessionId: "S1",
  pr: "octo/repo#7",
  linkedBy: "harvest",
  prState: "open",
  headSha: SHA,
};

export const CONFIG: RouteConfig = {
  trustedLogins: ["octocat"],
  agentLogins: ["kiro-agent[bot]"],
  autoCloseOnMerge: "off",
  checksDebounceMs: 120_000,
};

export class RecordingCommandQueue implements CommandQueue {
  commands: Command[] = [];
  async enqueue(c: Command): Promise<void> {
    this.commands.push(c);
  }
}

export class RecordingGithubQueue implements GithubQueue {
  sent: Array<{ message: GithubQueueMessage; delaySeconds?: number }> = [];
  failNext = false;
  async send(message: GithubQueueMessage, delaySeconds?: number): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("sqs down");
    }
    this.sent.push({ message, ...(delaySeconds !== undefined ? { delaySeconds } : {}) });
  }
}

export function collectingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const push = (m: string, f?: Record<string, unknown>) => lines.push(JSON.stringify({ m, ...f }));
  return { logger: { info: push, warn: push, error: push }, lines };
}

export interface World {
  repo: Repository;
  ddb: MemoryDdb;
  s3: MemoryS3;
  commands: RecordingCommandQueue;
  githubQueue: RecordingGithubQueue;
  metrics: CollectingMetrics;
  log: { logger: Logger; lines: string[] };
  clock: { now: number };
  deps: ConsumerDeps;
  github: ConsumerDeps["github"] & { pulls: Map<string, unknown>; reviewComments: unknown[] };
  seedSession(id: string, over?: Record<string, unknown>): void;
  ingest(name: string, fixtureName: string, deliveryId?: string): Promise<string>;
}

export function world(config: Partial<ConsumerDeps["config"]> = {}): World {
  const clock = { now: T0 };
  const ddb = new MemoryDdb();
  const s3 = new MemoryS3();
  const repo = new Repository({
    ddb: ddb as never,
    s3: s3 as never,
    tableName: "t",
    bucketName: "b",
    now: () => clock.now,
  });
  const commands = new RecordingCommandQueue();
  const githubQueue = new RecordingGithubQueue();
  const metrics = new CollectingMetrics();
  const log = collectingLogger();
  const pulls = new Map<string, unknown>();
  const reviewComments: unknown[] = [];
  const github = {
    pulls,
    reviewComments,
    async getPull(repoName: string, n: number) {
      return (pulls.get(`${repoName}#${n}`) as never) ?? null;
    },
    async listReviewComments() {
      return reviewComments as never;
    },
    async listAppDeliveries() {
      return [];
    },
    async redeliver() {},
  };
  let ids = 0;
  const deps: ConsumerDeps = {
    repo,
    github,
    queue: commands,
    githubQueue,
    config: { ...CONFIG, trustedLogins: ["octocat"], ...config },
    metrics,
    logger: log.logger,
    now: () => clock.now,
    newId: () => `id-${String(++ids).padStart(4, "0")}`,
  };
  return {
    repo,
    ddb,
    s3,
    commands,
    githubQueue,
    metrics,
    log,
    clock,
    deps,
    github,
    seedSession(id, over = {}) {
      ddb.put(sessionItem(id, { createdAt: "2026-02-01T09:00:00.000Z", ...over }));
    },
    async ingest(name, fixtureName, deliveryId = `del-${fixtureName}`) {
      await repo.putDelivery({
        deliveryId,
        event: name,
        action: null,
        repo: "octo/repo",
        rawBody: JSON.stringify(fixture(fixtureName)),
      });
      return deliveryId;
    },
  };
}
