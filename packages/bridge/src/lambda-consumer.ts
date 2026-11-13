/**
 * The bridge consumer: an AWS Lambda SQS handler that drives cloud sessions
 * over ACP against the bundled KAS engine ({@link KasEngine}), using the
 * {@link CloudSession} persistence/state primitives for durable events and
 * session state.
 *
 * WHY THE ENGINE IS STARTED DIRECTLY
 * The Kiro CLI cannot start its engine inside Lambda (`prctl(PR_SET_PDEATHSIG)`
 * fails with EPERM), so the Lambda image carries the unpacked engine and this
 * consumer spawns it itself. The turn runs in Kiro's cloud sandbox; the engine
 * only relays `session/update` notifications. One engine process is started
 * and stopped per command or catch-up run (Lambda freezes children between
 * invocations), and a remote `session/load` needs no local state, so any
 * container can serve any session.
 *
 * COMMANDS (the FIFO command queue)
 *  - launch: `initialize` + cloud-sandbox `session/new`, then the first turn.
 *  - prompt: remote `session/load` (its replay is history and is not
 *    recorded), then `session/prompt`.
 *  - delete: remote `session/delete` (best-effort), then mark the row deleted.
 * Each turn's live updates are normalized, coalesced and appended to the event
 * log. The session META is re-read at the start of every command, because
 * another container (or a catch-up) may have moved the session on.
 *
 * DETACH + CATCH-UP (a Lambda durable execution)
 * A Lambda invocation ends at its timeout, but a cloud turn may run longer.
 * When the remaining time falls below {@link DETACH_MARGIN_MS} the consumer
 * flushes what it has, stops the engine (the cloud turn keeps running), leaves
 * META `running`, and starts ONE durable execution of the catch-up function
 * (catch-up-durable.ts) with a {@link CatchUpMessage} payload; the execution
 * name is derived from the turn, so a repeated start is a no-op. The
 * execution repeats {@link LambdaConsumer.catchUpOnce} and a wait: a round
 * loads the remote session, appends the replayed events the log does not hold
 * yet ({@link planCatchUp}), and either settles the turn (the replay reached
 * `turn_end`) or reports it pending. A turn still unfinished
 * {@link CATCH_UP_MAX_AGE_MS} after detaching is failed.
 * While META stays `running`, a mid-turn steer, cancel or `whenBusy=queue` is
 * rejected exactly as before.
 *
 * WAKE TURNS (GitHub, and any later producer)
 * A prompt command may carry a `trigger` (see TurnTrigger): a wake turn that
 * `drainInbox` enqueued for pending inbox items. It always has
 * `whenBusy=reject`; if the session turns out not to be idle, the items are
 * released back to pending instead of being lost. Every point where a turn
 * settles goes through ONE helper (TurnSettler.settled in settle.ts), which
 * closes the TURN# row, harvests PR links, and drains the inbox.
 *
 * OUTCOME HANDLING
 *  - An {@link UnsupportedCloudOperationError} is PERMANENT: log a warning,
 *    persist a client-visible rejection event, and ack the record (`adopt` is
 *    rejected this way).
 *  - A genuine TRANSIENT error returns the record id in
 *    {@link SQSBatchResponse.batchItemFailures} so the event-source mapping
 *    (ReportBatchItemFailures) retries only that message.
 */

import { mkdir } from "node:fs/promises";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  type Command,
  type CommandQueue,
  type EventItem,
  type GithubQueue,
  type NormalizedEvent,
  normalizeUpdate,
  Repository,
  type SessionInputs,
  type SessionMetaItem,
  SqsCommandQueue,
  SqsGithubQueue,
  type TurnTrigger,
} from "@nikovirtala/kiro-remote-core";
import { ulid } from "ulid";
import {
  CATCH_UP_MAX_AGE_MS,
  type CatchUpMessage,
  type CatchUpResult,
  type CatchUpScheduler,
  countTurnStarts,
  planCatchUp,
} from "./catch-up.ts";
import { LambdaCatchUpScheduler } from "./catch-up-scheduler.ts";
import {
  type CloudLaunchArgs,
  CloudSession,
  createRuntime,
  type SessionRuntime,
  stateOf,
  UnsupportedCloudOperationError,
} from "./cloud-session.ts";
import { KasEngine, kasSpawnSpec } from "./kas-engine.ts";
import { createLogger, type Logger } from "./logger.ts";
import { type MetricSink, Metrics, powertoolsMetricSink } from "./metrics.ts";
import { resolveKiroApiKey } from "./secrets.ts";
import { TurnSettler } from "./settle.ts";
import { traced } from "./tracer.ts";
import type { SpawnFn, SpawnSpec } from "./transport.ts";

/**
 * Detach from a running turn when less than this much invocation time is left.
 * The `DETACH_MARGIN_MS` env var overrides it (e.g. `890000` on a 15-minute
 * function detaches ~10 s into a turn, to exercise the catch-up live).
 */
export const DETACH_MARGIN_MS = 90_000;

/** Parse the `DETACH_MARGIN_MS` env override: a non-negative integer, else null. */
function detachMarginFromEnv(env: NodeJS.ProcessEnv, logger: Logger): number | null {
  const raw = env.DETACH_MARGIN_MS;
  if (raw === undefined || raw === "") {
    return null;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    logger.warn("detach_margin_invalid", { value: raw, defaultMs: DETACH_MARGIN_MS });
    return null;
  }
  return value;
}

/* ----------------------------- SQS event types ---------------------------- */
/**
 * Minimal structural copies of the AWS Lambda SQS event/response contract.
 * The bridge package intentionally has NO @types/aws-lambda dependency, so the
 * exact shape the native SQS event-source mapping delivers / expects is encoded
 * here: `Records[].messageId`/`body`/`messageAttributes` in,
 * `batchItemFailures[].itemIdentifier` (= messageId) out. This is the documented
 * ReportBatchItemFailures contract.
 */
export interface SQSRecord {
  messageId: string;
  receiptHandle?: string;
  body: string;
  attributes?: Record<string, string>;
  messageAttributes?: Record<string, unknown>;
}

export interface SQSEvent {
  Records: SQSRecord[];
}

export interface SQSBatchItemFailure {
  itemIdentifier: string;
}

export interface SQSBatchResponse {
  batchItemFailures: SQSBatchItemFailure[];
}

/** The part of the Lambda context the consumer reads. */
export interface LambdaContext {
  getRemainingTimeInMillis(): number;
}

/** An SQS handler: a batch in, the partial-failure report out. */
export type SQSHandler = (event: SQSEvent, context?: LambdaContext) => Promise<SQSBatchResponse>;

/** Per-invocation options. */
export interface HandleOptions {
  /** Remaining invocation time; without it a turn never detaches. */
  remainingTimeMs?: () => number;
}

/* -------------------------------- config ---------------------------------- */

/**
 * The consumer's configuration, read from the function env. There is no
 * COMMAND_QUEUE_URL here: the event-source mapping delivers the messages.
 */
export interface ConsumerConfig {
  tableName: string;
  bucketName: string;
  workspaceRoot: string;
  /**
   * The qualified (alias) ARN of the durable catch-up function. Unset on the
   * durable function itself, which never starts catch-ups.
   */
  catchUpFunctionArn?: string;
  /**
   * The FIFO command queue and the GitHub queue. Both set means the GitHub
   * feature is on: settles then drain the inbox and request PR harvests.
   */
  commandQueueUrl?: string;
  githubQueueUrl?: string;
  additionalDirectories?: string[];
  mcpServers?: unknown[];
  region?: string;
}

export interface ConsumerDeps {
  config: ConsumerConfig;
  /** Overrides for tests: injected AWS clients, spawner, scheduler, sinks, clock, env. */
  ddb?: DynamoDBDocumentClient;
  s3?: S3Client;
  secretsManager?: SecretsManagerClient;
  sqs?: SQSClient;
  spawnFn?: SpawnFn;
  catchUpScheduler?: CatchUpScheduler;
  /** Wake plumbing; defaults are built from the queue URLs in the config. */
  commandQueue?: CommandQueue;
  githubQueue?: GithubQueue;
  /** Detach margin (default: env `DETACH_MARGIN_MS`, else {@link DETACH_MARGIN_MS}). */
  detachMarginMs?: number;
  logger?: Logger;
  metricSink?: MetricSink;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`missing required env var: ${name}`);
  }
  return value;
}

/** Build a {@link ConsumerConfig} from the function env. */
export function consumerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ConsumerConfig {
  return {
    tableName: requireEnv(env, "TABLE_NAME"),
    bucketName: requireEnv(env, "BUCKET_NAME"),
    workspaceRoot: env.WORKSPACE_ROOT ?? "/workspace",
    ...(env.CATCH_UP_FUNCTION_ARN ? { catchUpFunctionArn: env.CATCH_UP_FUNCTION_ARN } : {}),
    ...(env.COMMAND_QUEUE_URL ? { commandQueueUrl: env.COMMAND_QUEUE_URL } : {}),
    ...(env.GITHUB_QUEUE_URL ? { githubQueueUrl: env.GITHUB_QUEUE_URL } : {}),
    ...(env.ADDITIONAL_DIRECTORIES
      ? { additionalDirectories: env.ADDITIONAL_DIRECTORIES.split(",").filter(Boolean) }
      : {}),
    ...(env.AWS_REGION ? { region: env.AWS_REGION } : {}),
  };
}

/** The trigger recorded on turns a person started. */
const USER_TRIGGER: TurnTrigger = { source: "user", deliveryIds: [] };

/** How a turn's `session/prompt` race ended. */
type TurnOutcome =
  | { kind: "done"; stopReason?: string }
  | { kind: "error"; error: unknown }
  | { kind: "detach" };

/* ------------------------------ the consumer ------------------------------ */

/**
 * The engine-driven cloud consumer. Owns the per-session runtime map, the
 * cloud->local id map, and the shared {@link CloudSession} primitives, and
 * dispatches a single {@link Command}. Constructed ONCE per warm Lambda
 * container and invoked per SQS batch via {@link handleEvent}; durable
 * catch-up rounds call {@link catchUpOnce} directly.
 */
export class LambdaConsumer {
  private readonly repo: Repository;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly cloud: CloudSession;
  private readonly scheduler: CatchUpScheduler | undefined;
  private readonly settler: TurnSettler;
  private readonly engineSpec: SpawnSpec;
  private readonly spawnFn?: SpawnFn;
  private readonly detachMarginMs: number;
  private readonly workspaceRoot: string;
  private readonly additionalDirectories?: string[];
  private readonly mcpServers: unknown[];
  private readonly now: () => number;

  private readonly runtimes = new Map<string, SessionRuntime>();
  /** Cloud (Kiro) id -> our session id. */
  private readonly kiroToLocal: Map<string, string>;

  private constructor(args: {
    repo: Repository;
    logger: Logger;
    metrics: Metrics;
    cloud: CloudSession;
    scheduler: CatchUpScheduler | undefined;
    settler: TurnSettler;
    engineSpec: SpawnSpec;
    spawnFn?: SpawnFn;
    detachMarginMs: number;
    config: ConsumerConfig;
    kiroToLocal: Map<string, string>;
    now: () => number;
  }) {
    this.repo = args.repo;
    this.logger = args.logger;
    this.metrics = args.metrics;
    this.cloud = args.cloud;
    this.scheduler = args.scheduler;
    this.settler = args.settler;
    this.engineSpec = args.engineSpec;
    if (args.spawnFn) {
      this.spawnFn = args.spawnFn;
    }
    this.detachMarginMs = args.detachMarginMs;
    this.workspaceRoot = args.config.workspaceRoot;
    this.additionalDirectories = args.config.additionalDirectories;
    this.mcpServers = args.config.mcpServers ?? [];
    this.kiroToLocal = args.kiroToLocal;
    this.now = args.now;
  }

  /**
   * Build the consumer: the Repository (DynamoDB + S3), Metrics, Logger, the
   * CloudSession primitives, the catch-up scheduler, and the engine spawn
   * spec. KIRO_API_KEY is resolved once per container and placed only in the
   * engine's env.
   */
  static async create(deps: ConsumerDeps): Promise<LambdaConsumer> {
    const env = deps.env ?? process.env;
    const now = deps.now ?? (() => Date.now());
    const logger = deps.logger ?? createLogger({ bindings: { component: "bridge-lambda" } });
    const metrics = new Metrics(deps.metricSink ?? powertoolsMetricSink());

    const region = deps.config.region ?? env.AWS_REGION ?? "us-east-1";
    const ddb = deps.ddb ?? DynamoDBDocumentClient.from(traced(new DynamoDBClient({ region })));
    const s3 = deps.s3 ?? traced(new S3Client({ region }));
    const secretsManager = deps.secretsManager ?? traced(new SecretsManagerClient({ region }));

    const repo = new Repository({
      ddb,
      s3,
      tableName: deps.config.tableName,
      bucketName: deps.config.bucketName,
      now,
    });

    const apiKey = await resolveKiroApiKey({ secretsManager, logger, env });
    const engineSpec = kasSpawnSpec({ env, apiKey });

    const sqs = deps.sqs ?? traced(new SQSClient({ region }));
    const scheduler =
      deps.catchUpScheduler ??
      (deps.config.catchUpFunctionArn
        ? new LambdaCatchUpScheduler({
            lambda: traced(new LambdaClient({ region })),
            functionArn: deps.config.catchUpFunctionArn,
            logger,
          })
        : undefined);

    // The GitHub feature is on only when BOTH queues are known.
    const githubQueue =
      deps.githubQueue ??
      (deps.config.githubQueueUrl
        ? new SqsGithubQueue({ sqs, queueUrl: deps.config.githubQueueUrl })
        : undefined);
    const commandQueue =
      deps.commandQueue ??
      (deps.config.commandQueueUrl
        ? new SqsCommandQueue({ sqs, queueUrl: deps.config.commandQueueUrl })
        : undefined);
    const wakeEnabled = githubQueue !== undefined && commandQueue !== undefined;

    // The engine's session cwd; Lambda only allows writes under /tmp.
    try {
      await mkdir(deps.config.workspaceRoot, { recursive: true });
    } catch (err) {
      logger.warn("workspace_mkdir_failed", {
        workspaceRoot: deps.config.workspaceRoot,
        error: String(err),
      });
    }

    const kiroToLocal = new Map<string, string>();
    const cloud = new CloudSession({ repo, logger, metrics, now });
    const settler = new TurnSettler({
      repo,
      logger,
      metrics,
      now,
      ...(wakeEnabled ? { queue: commandQueue, githubQueue } : {}),
    });

    return new LambdaConsumer({
      repo,
      logger,
      metrics,
      cloud,
      scheduler,
      settler,
      engineSpec,
      ...(deps.spawnFn ? { spawnFn: deps.spawnFn } : {}),
      detachMarginMs: deps.detachMarginMs ?? detachMarginFromEnv(env, logger) ?? DETACH_MARGIN_MS,
      config: deps.config,
      kiroToLocal,
      now,
    });
  }

  private inputsFor(inputs?: Partial<SessionInputs>): SessionInputs {
    return {
      cwd: this.workspaceRoot,
      ...(this.additionalDirectories ? { additionalDirectories: this.additionalDirectories } : {}),
      mcpServers: this.mcpServers,
      ...(inputs ?? {}),
    };
  }

  /**
   * Get (or create) the runtime and sync it with the durable META row, which
   * another container or a catch-up may have changed since this container
   * last saw the session.
   */
  private async refresh(id: string): Promise<{ rt: SessionRuntime; item: SessionMetaItem | null }> {
    let rt = this.runtimes.get(id);
    if (!rt) {
      rt = createRuntime(id, this.inputsFor(), this.now);
      this.runtimes.set(id, rt);
    }
    const item = await this.repo.getSession(id);
    if (item) {
      rt.machine = stateOf(item);
      rt.kiroSessionId = item.kiroSessionId;
      rt.activeTurnId = item.activeTurnId;
      rt.launched ||= item.status !== "provisioning";
      if (item.kiroSessionId) {
        this.kiroToLocal.set(item.kiroSessionId, id);
      }
    }
    return { rt, item };
  }

  /** Start an engine, run `fn` against it, and always stop it. */
  private async withEngine<T>(fn: (engine: KasEngine) => Promise<T>): Promise<T> {
    const engine = new KasEngine({
      spec: this.engineSpec,
      ...(this.spawnFn ? { spawnFn: this.spawnFn } : {}),
      logger: this.logger,
    });
    engine.start();
    try {
      return await fn(engine);
    } finally {
      await engine.stop();
    }
  }

  /**
   * Process one SQS batch. Records are handled SEQUENTIALLY so per-group (=
   * per-session) ordering is honored. Returns the partial-batch failure report:
   * only genuinely TRANSIENT failures appear in batchItemFailures.
   */
  async handleEvent(event: SQSEvent, opts: HandleOptions = {}): Promise<SQSBatchResponse> {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    try {
      for (const record of event.Records) {
        const transient = await this.handleRecord(record, opts);
        if (transient) {
          batchItemFailures.push({ itemIdentifier: record.messageId });
        }
      }
    } finally {
      this.metrics.flush();
    }
    return { batchItemFailures };
  }

  /**
   * Handle a single SQS record. Returns true when the record must be RETRIED
   * (a transient failure), false when it is done (success, idempotent no-op,
   * or a PERMANENT rejection persisted as a client-visible event).
   */
  private async handleRecord(record: SQSRecord, opts: HandleOptions): Promise<boolean> {
    let body: unknown;
    try {
      body = JSON.parse(record.body);
    } catch (err) {
      // An unparseable body can never succeed on retry; ack it (do not retry).
      this.logger.error("consumer_parse_error", {
        messageId: record.messageId,
        error: String(err),
      });
      return false;
    }
    const command = body as Command;
    try {
      await this.dispatch(command, opts);
      return false;
    } catch (err) {
      if (err instanceof UnsupportedCloudOperationError) {
        // PERMANENT rejection (mid-turn steer/cancel, a queued follow-up with no
        // drain, or `adopt`). Keep it LOUD -- a warn log AND a client-visible
        // rejection event -- but ack the record so SQS deletes it and the FIFO
        // group keeps moving.
        this.logger.warn("command_unsupported_cloud", {
          kind: command.kind,
          sessionId: command.sessionId,
          operation: err.operation,
          error: err.message,
        });
        try {
          await this.recordUnsupportedRejection(command.sessionId, err.operation, err.message);
        } catch (persistErr) {
          this.logger.warn("command_rejection_persist_error", {
            sessionId: command.sessionId,
            error: String(persistErr),
          });
        }
        return false;
      }
      this.logger.error("command_dispatch_error", {
        kind: command.kind,
        sessionId: command.sessionId,
        error: String(err),
      });
      return true;
    }
  }

  /** Dispatch a command by kind. */
  async dispatch(command: Command, opts: HandleOptions = {}): Promise<void> {
    const log = this.logger.child({
      sub: command.sub,
      sessionId: command.sessionId,
      commandId: command.commandId,
      kind: command.kind,
    });
    log.info("command_received");
    switch (command.kind) {
      case "launch":
        await this.launch(
          command.sessionId,
          {
            prompt: command.prompt,
            repos: command.repos,
            ...(command.mode ? { mode: command.mode } : {}),
            ...(command.model ? { model: command.model } : {}),
            ...(command.effort ? { effort: command.effort } : {}),
          },
          opts,
        );
        return;
      case "prompt":
        await this.steer(
          command.sessionId,
          command.prompt,
          command.whenBusy,
          command.turnId,
          opts,
          command.trigger,
        );
        return;
      case "steer":
        await this.steer(command.sessionId, command.content, "steer", undefined, opts);
        return;
      case "cancel":
        await this.cancel(command.sessionId);
        return;
      case "answerPermission":
        // Cloud turns never ask for a permission, so there is no held-open
        // request to resolve: a stray answerPermission is a logged no-op.
        log.info("answer_permission_noop_cloud", { requestId: command.requestId });
        return;
      case "setConfig":
        // The per-turn model/effort/mode travel with the launch command; a
        // standalone setConfig is a logged no-op.
        log.info("set_config_noop_cloud");
        return;
      case "delete":
        await this.markDeleted(command.sessionId);
        return;
      case "adopt":
        // adopt is not supported; reject it LOUDLY so it is logged + persisted
        // as a client-visible rejection + deleted.
        await this.refresh(command.sessionId);
        throw new UnsupportedCloudOperationError(
          "adopt",
          "adopt/session-load is not supported by the bridge",
        );
      default: {
        const never: never = command;
        throw new Error(`unknown command kind: ${(never as { kind: string }).kind}`);
      }
    }
  }

  /* --------------------------------- launch -------------------------------- */

  /**
   * Launch a cloud session (session/new) and run its first turn. A redelivered
   * launch is a logged no-op; if the earlier delivery left a running turn
   * behind (a hard kill before it could detach), a catch-up is scheduled.
   */
  private async launch(id: string, args: CloudLaunchArgs, opts: HandleOptions): Promise<void> {
    const { rt, item } = await this.refresh(id);
    rt.inputs = this.inputsFor({
      ...(args.mode ? { modeId: args.mode } : {}),
      ...(args.model ? { modelId: args.model } : {}),
      ...(args.effort ? { effortLevel: args.effort } : {}),
      ...(args.repos.length > 0 ? { repos: args.repos } : {}),
    });

    if (await this.cloud.launchAlreadyIssued(id, rt)) {
      this.logger.info("launch_idempotent_skip", { sessionId: id });
      await this.catchUpLeftover(item);
      return;
    }
    rt.launched = true;
    rt.launchStartedAt = this.now();
    rt.turnStartedAt = this.now();
    const turnId = ulid();
    const afterSeq = item?.eventSeq ?? 0;
    this.logger.info("launch_path_decision", {
      sessionId: id,
      path: "engine",
      repoCount: args.repos.length,
    });

    await this.withEngine(async (engine) => {
      let kiroSessionId: string;
      try {
        await engine.initialize();
        kiroSessionId = await engine.newCloudSession({
          cwd: this.workspaceRoot,
          repos: args.repos,
        });
      } catch (err) {
        // LOUD FAILURE: no cloud session. Drive the session to `failed`.
        this.cloud.applyMachine(rt, { kind: "provision_failed" });
        this.metrics.count("CloudLaunchFailed");
        this.logger.error("cloud_launch_failed", { sessionId: id, error: String(err) });
        rt.activeTurnId = null;
        rt.turnStartedAt = null;
        await this.repo.patchSession(id, { status: rt.machine.session, activeTurnId: null });
        // The session is failed: any pending wake items are dropped.
        await this.settler.settled({ sessionId: id, turnId: null, outcome: "session_failed" });
        return;
      }

      rt.kiroSessionId = kiroSessionId;
      this.kiroToLocal.set(kiroSessionId, id);
      this.cloud.applyMachine(rt, { kind: "provisioned" });
      this.cloud.applyMachine(rt, { kind: "prompt.sent" });
      rt.activeTurnId = turnId;
      const current = await this.repo.getSession(id);
      if (current) {
        await this.repo.patchSession(id, {
          status: rt.machine.session,
          activeTurnId: turnId,
          kiroSessionId,
          model: args.model ?? current.model,
          mode: args.mode ?? current.mode,
          effort: args.effort ?? current.effort,
        });
      }
      this.metrics.count("SessionsLaunched");
      this.metrics.count("LaunchPath", 1, { path: "engine" });
      this.logger.info("session_launched", { sessionId: id, path: "engine", kiroSessionId });

      // The launch turn is the session's first turn.
      await this.cloud.recordTurnStart(rt, turnId, args.prompt, USER_TRIGGER);
      await this.runTurn(rt, engine, turnId, args.prompt, { afterSeq, turnOrdinal: 1 }, opts);
    });
  }

  /* --------------------------- prompt / steer / cancel --------------------- */

  /**
   * Resolve a follow-up `prompt`/`steer`. A redelivery of the turn that META
   * says is active is a no-op (plus a catch-up, in case it was left behind);
   * otherwise the shared rules apply: an idle session takes a fresh prompt, a
   * `whenBusy=reject` is a quiet skip, and a mid-turn steer / `whenBusy=queue`
   * throws {@link UnsupportedCloudOperationError}.
   */
  private async steer(
    id: string,
    content: string,
    whenBusy: "steer" | "queue" | "reject",
    turnId: string | undefined,
    opts: HandleOptions,
    trigger?: TurnTrigger,
  ): Promise<void> {
    const { rt, item } = await this.refresh(id);
    if (turnId !== undefined && item?.activeTurnId === turnId) {
      this.logger.info("prompt_idempotent_skip", { sessionId: id, turnId });
      await this.catchUpLeftover(item);
      return;
    }
    // A wake turn only ever starts an idle session. If a manual prompt (or
    // anything else) got there first, put the items back: the settle of the
    // turn that is running drains them again.
    if (trigger && turnId !== undefined && item?.status !== "idle") {
      this.logger.info("wake_turn_not_started", { sessionId: id, turnId, status: item?.status });
      await this.releaseWake(id, turnId, trigger);
      return;
    }
    const decision = this.cloud.classifySteer(rt, id, whenBusy, turnId);
    if (decision === "prompt") {
      await this.prompt(rt, id, content, turnId, item?.eventSeq ?? 0, opts, trigger);
    } else if (decision === "reject" && trigger && turnId !== undefined) {
      await this.releaseWake(id, turnId, trigger);
    }
    // "idempotent" and "reject" are logged no-ops inside classifySteer.
  }

  /** Return a wake turn's inbox items to pending, or drop them when the session can no longer run. */
  private async releaseWake(id: string, turnId: string, trigger: TurnTrigger): Promise<void> {
    const ids = trigger.inboxIds ?? [];
    if (ids.length === 0) {
      return;
    }
    await this.repo.releaseInbox(id, ids, turnId);
    await this.settler.drainSoon(id);
  }

  /** Run a follow-up turn: load the remote session, then prompt it. */
  private async prompt(
    rt: SessionRuntime,
    id: string,
    prompt: string,
    turnId: string | undefined,
    afterSeq: number,
    opts: HandleOptions,
    trigger?: TurnTrigger,
  ): Promise<void> {
    const tid = turnId ?? ulid();
    const begun = await this.cloud.beginResume(rt, id, turnId, tid);
    if (!begun) {
      return;
    }
    await this.cloud.recordTurnStart(rt, tid, prompt, trigger ?? USER_TRIGGER);
    const cloudId = rt.kiroSessionId;
    if (!cloudId) {
      await this.failTurn(rt, new Error("no cloud session id to resume"), "turn_failed", afterSeq);
      return;
    }
    await this.withEngine(async (engine) => {
      // The load replay is history the log already holds: not recorded. Its
      // turn count places the new turn for a later catch-up.
      const replay: unknown[] = [];
      const unsubscribe = engine.onUpdate((sessionId, update) => {
        if (sessionId === cloudId) {
          replay.push(update);
        }
      });
      try {
        await engine.initialize();
        await engine.loadRemote(cloudId, this.workspaceRoot);
      } catch (err) {
        await this.failTurn(rt, err, "turn_failed", afterSeq);
        return;
      } finally {
        unsubscribe();
      }
      const turnOrdinal = countTurnStarts(replay) + 1;
      await this.runTurn(rt, engine, tid, prompt, { afterSeq, turnOrdinal }, opts);
    });
  }

  /** Classify a cancel (throws UnsupportedCloudOperationError on a running turn). */
  private async cancel(id: string): Promise<void> {
    const { rt } = await this.refresh(id);
    this.cloud.classifyCancel(rt, id);
  }

  /* ---------------------------------- turn --------------------------------- */

  /**
   * Prompt the engine and persist the turn's live updates until the prompt
   * resolves (settle the turn), fails (loud turn failure), or the invocation
   * nears its deadline (detach + schedule a catch-up; META stays `running`).
   * The caller stops the engine afterwards.
   */
  private async runTurn(
    rt: SessionRuntime,
    engine: KasEngine,
    turnId: string,
    text: string,
    place: { afterSeq: number; turnOrdinal: number },
    opts: HandleOptions,
  ): Promise<void> {
    const cloudId = rt.kiroSessionId;
    if (!cloudId) {
      throw new Error("runTurn needs a cloud session id");
    }

    // Writes run on one serialized chain; the first failure stops the chain
    // and is rethrown after the turn (the record is then retried).
    let chain: Promise<void> = Promise.resolve();
    let writeError: unknown = null;
    const write = (ev: NormalizedEvent): void => {
      chain = chain.then(async () => {
        if (writeError !== null) {
          return;
        }
        try {
          await this.cloud.writeEvent(rt, ev, this.now());
        } catch (err) {
          writeError = err;
        }
      });
    };

    const unsubscribe = engine.onUpdate((sessionId, update) => {
      if (sessionId !== cloudId) {
        return;
      }
      const ev = normalizeUpdate(rt.id, update, {
        turnId,
        hooks: { onUnmapped: () => this.metrics.count("RawEventsUnmapped") },
      });
      for (const out of rt.coalescer.push(ev, this.now())) {
        write(out);
      }
    });

    const prompted: Promise<TurnOutcome> = engine.prompt(cloudId, text).then(
      (res) => ({ kind: "done", ...(res.stopReason ? { stopReason: res.stopReason } : {}) }),
      (error: unknown) => ({ kind: "error", error }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const contenders: Promise<TurnOutcome>[] = [prompted];
    if (opts.remainingTimeMs) {
      const delay = Math.max(0, opts.remainingTimeMs() - this.detachMarginMs);
      contenders.push(
        new Promise<TurnOutcome>((resolve) => {
          timer = setTimeout(() => resolve({ kind: "detach" }), delay);
        }),
      );
    }
    let outcome: TurnOutcome;
    try {
      outcome = await Promise.race(contenders);
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }

    for (const ev of rt.coalescer.flushAll()) {
      write(ev);
    }
    await chain;
    if (writeError !== null) {
      throw writeError;
    }

    switch (outcome.kind) {
      case "done":
        this.cloud.applyMachine(rt, {
          kind: "prompt.response",
          stopReason: outcome.stopReason ?? "end_turn",
        });
        if (rt.turnStartedAt !== null) {
          this.metrics.duration("TurnDuration", this.now() - rt.turnStartedAt);
        }
        rt.activeTurnId = null;
        rt.turnStartedAt = null;
        await this.cloud.persistSessionStatus(rt);
        await this.settler.settled({
          sessionId: rt.id,
          turnId,
          outcome: "completed",
          stopReason: outcome.stopReason ?? "end_turn",
          afterSeq: place.afterSeq,
        });
        return;
      case "error":
        await this.failTurn(rt, outcome.error, "turn_failed", place.afterSeq);
        return;
      case "detach": {
        this.logger.info("turn_detached", { sessionId: rt.id, turnId, kiroSessionId: cloudId });
        this.metrics.count("TurnDetached");
        await this.startCatchUp({
          kind: "catchUp",
          sessionId: rt.id,
          kiroSessionId: cloudId,
          turnId,
          afterSeq: place.afterSeq,
          attempt: 1,
          detachedAt: this.now(),
          turnOrdinal: place.turnOrdinal,
        });
        return;
      }
    }
  }

  /**
   * LOUD turn failure: a CloudTurnFailed metric, an error log, a client-visible
   * turn.failed event, and the session back to idle.
   */
  private async failTurn(
    rt: SessionRuntime,
    err: unknown,
    rawType = "turn_failed",
    afterSeq = 0,
  ): Promise<void> {
    const failedTurnId = rt.activeTurnId;
    this.metrics.count("CloudTurnFailed");
    this.logger.error("cloud_turn_failed", { sessionId: rt.id, rawType, error: String(err) });
    await this.cloud.writeEvent(
      rt,
      {
        type: "turn.failed",
        sessionId: rt.id,
        turnId: rt.activeTurnId,
        replay: false,
        rawType,
        failureReason: "error",
        payload: { source: "kas-engine", error: String(err) },
      },
      this.now(),
    );
    this.cloud.applyMachine(rt, { kind: "prompt.error" });
    if (rt.turnStartedAt !== null) {
      this.metrics.duration("TurnDuration", this.now() - rt.turnStartedAt);
    }
    rt.activeTurnId = null;
    rt.turnStartedAt = null;
    await this.cloud.persistSessionStatus(rt);
    await this.settler.settled({
      sessionId: rt.id,
      turnId: failedTurnId,
      outcome: "failed",
      afterSeq,
    });
  }

  /* -------------------------------- catch-up ------------------------------- */

  /**
   * Schedule a catch-up for a turn a redelivered command finds still running
   * (its first delivery died before it could detach). The turn's ordinal is
   * not known here, so the catch-up falls back to the replay's last turn and
   * writes nothing when that turn's text diverges from the log.
   */
  private async catchUpLeftover(item: SessionMetaItem | null): Promise<void> {
    if (item?.status !== "running" || !item.activeTurnId || !item.kiroSessionId) {
      return;
    }
    await this.startCatchUp({
      kind: "catchUp",
      sessionId: item.id,
      kiroSessionId: item.kiroSessionId,
      turnId: item.activeTurnId,
      afterSeq: 0,
      attempt: 1,
      detachedAt: this.now(),
    });
  }

  /** Start the durable catch-up execution for a detached turn. */
  private async startCatchUp(msg: CatchUpMessage): Promise<void> {
    if (!this.scheduler) {
      throw new Error("no catch-up scheduler configured (set CATCH_UP_FUNCTION_ARN)");
    }
    await this.scheduler.start(msg);
    this.logger.info("catch_up_started", { sessionId: msg.sessionId, turnId: msg.turnId });
  }

  /**
   * One catch-up round for a detached turn: load the remote session, append
   * the replayed events the log is missing, and settle the turn once the
   * replay reaches `turn_end`. Idempotent (the event log is the ledger) and
   * never schedules anything: the durable catch-up execution decides what
   * happens next.
   */
  async catchUpOnce(msg: CatchUpMessage): Promise<CatchUpResult> {
    try {
      return await this.runCatchUpOnce(msg);
    } finally {
      this.metrics.flush();
    }
  }

  private async runCatchUpOnce(msg: CatchUpMessage): Promise<CatchUpResult> {
    const id = msg.sessionId;
    const { rt, item } = await this.refresh(id);
    const fields = { sessionId: id, turnId: msg.turnId, attempt: msg.attempt };
    if (
      !item ||
      item.status === "deleted" ||
      item.status === "failed" ||
      item.activeTurnId !== msg.turnId
    ) {
      this.logger.info("catch_up_stale", { ...fields, status: item?.status ?? null });
      return { state: "stale", eventsWritten: 0 };
    }

    if (this.now() - msg.detachedAt > CATCH_UP_MAX_AGE_MS) {
      this.metrics.count("CatchUpExpired");
      await this.failTurn(
        rt,
        new Error(`turn did not finish within ${CATCH_UP_MAX_AGE_MS} ms of detaching`),
        "catch_up_expired",
        msg.afterSeq,
      );
      return { state: "expired", eventsWritten: 0 };
    }

    const updates: unknown[] = [];
    try {
      await this.withEngine(async (engine) => {
        const unsubscribe = engine.onUpdate((sessionId, update) => {
          if (sessionId === msg.kiroSessionId) {
            updates.push(update);
          }
        });
        await engine.initialize();
        await engine.loadRemote(msg.kiroSessionId, this.workspaceRoot);
        unsubscribe();
      });
    } catch (err) {
      this.logger.warn("catch_up_load_failed", { ...fields, error: String(err) });
      return { state: "load_failed", eventsWritten: 0 };
    }

    const recorded = (await this.allEventsAfter(id, msg.afterSeq))
      .filter((e) => e.turnId === msg.turnId)
      .map((e) => e.payload as NormalizedEvent);
    const plan = planCatchUp({
      sessionId: id,
      turnId: msg.turnId,
      updates,
      recorded,
      ...(msg.turnOrdinal !== undefined ? { turnOrdinal: msg.turnOrdinal } : {}),
      onUnmapped: () => this.metrics.count("RawEventsUnmapped"),
    });
    if (plan.mismatch) {
      this.logger.warn("catch_up_segment_mismatch", fields);
    }
    for (const ev of plan.events) {
      await this.cloud.writeEvent(rt, ev, this.now());
    }

    if (!plan.ended) {
      this.logger.info("catch_up_pending", {
        ...fields,
        turnFound: plan.turnFound,
        eventsWritten: plan.events.length,
      });
      return { state: "pending", eventsWritten: plan.events.length };
    }
    this.cloud.applyMachine(rt, {
      kind: "prompt.response",
      stopReason: plan.stopReason ?? "end_turn",
    });
    rt.activeTurnId = null;
    rt.turnStartedAt = null;
    await this.cloud.persistSessionStatus(rt);
    this.metrics.count("CatchUpCompleted");
    this.logger.info("catch_up_completed", { ...fields, eventsWritten: plan.events.length });
    await this.settler.settled({
      sessionId: id,
      turnId: msg.turnId,
      outcome: "completed",
      stopReason: plan.stopReason ?? "end_turn",
      afterSeq: msg.afterSeq,
    });
    return { state: "completed", eventsWritten: plan.events.length };
  }

  /**
   * Every event with seq > afterSeq. One Query returns at most 1 MB, so page
   * on the last seq until a page comes back empty.
   */
  private async allEventsAfter(id: string, afterSeq: number): Promise<EventItem[]> {
    const all: EventItem[] = [];
    let after = afterSeq;
    for (;;) {
      const page = await this.repo.queryEvents(id, after);
      const last = page[page.length - 1];
      if (!last) {
        return all;
      }
      all.push(...page);
      after = last.seq;
    }
  }

  /* -------------------------------- delete --------------------------------- */

  /** Delete the cloud session (remote session/delete, best-effort) and mark the row deleted. */
  private async markDeleted(id: string): Promise<void> {
    const { rt, item } = await this.refresh(id);
    const kiroSessionId = rt.kiroSessionId;
    if (kiroSessionId) {
      try {
        await this.withEngine(async (engine) => {
          await engine.initialize();
          await engine.deleteRemote(kiroSessionId);
        });
      } catch (err) {
        this.logger.warn("delete_session_engine_failed", { sessionId: id, error: String(err) });
      }
    }
    this.cloud.applyMachine(rt, { kind: "deleted" });
    if (item) {
      await this.repo.updateSession(id, item.version, { status: "deleted", activeTurnId: null });
    }
    this.runtimes.delete(id);
    if (kiroSessionId) {
      this.kiroToLocal.delete(kiroSessionId);
    }
    await this.settler.dropPending(id, "session_deleted");
  }

  /* ------------------------- unsupported rejection ------------------------- */

  /**
   * Persist a client-visible rejection for an unsupported operation. A no-op
   * when the runtime is gone.
   */
  private async recordUnsupportedRejection(
    id: string,
    operation: string,
    reason: string,
  ): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) {
      return;
    }
    await this.cloud.recordUnsupportedRejection(rt, operation, reason);
  }

  /** Test seam: the per-session runtime, if any. */
  runtime(id: string): SessionRuntime | undefined {
    return this.runtimes.get(id);
  }
}

/* ----------------------------- handler export ----------------------------- */

/**
 * The Lambda handler entry. The consumer is built ONCE per container (lazily,
 * on the first invocation) so the resolved API key and runtime map survive
 * across warm invocations. The command queue's event-source mapping invokes
 * this handler, with ReportBatchItemFailures.
 */
let consumerPromise: Promise<LambdaConsumer> | null = null;

function getConsumer(): Promise<LambdaConsumer> {
  if (!consumerPromise) {
    consumerPromise = LambdaConsumer.create({ config: consumerConfigFromEnv() });
  }
  return consumerPromise;
}

/** Build an SQS handler that hands the Lambda context's remaining time to the consumer. */
export function createHandler(consumer: () => Promise<LambdaConsumer>): SQSHandler {
  return async (event, context) =>
    (await consumer()).handleEvent(
      event,
      context ? { remainingTimeMs: () => context.getRemainingTimeInMillis() } : {},
    );
}

export const handler: SQSHandler = createHandler(getConsumer);
