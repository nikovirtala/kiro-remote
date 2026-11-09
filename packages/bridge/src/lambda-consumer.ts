/**
 * The SERVERLESS bridge consumer: an AWS Lambda SQS handler that drives the
 * cloud path using the SAME gateway-free {@link CloudSession} engine the ECS
 * bridge uses (FEAT-002), with NO ACP child (no gateway, no transport, no
 * supervisor). It is the Lambda-path counterpart to the ECS bridge's
 * {@link CommandIntake} poll loop: a native SQS event-source mapping invokes
 * this handler with a batch of FIFO command messages, and it produces the
 * IDENTICAL durable events/state the ECS path would, because both share the
 * cloud-session primitives.
 *
 * WHY THIS EXISTS (and why it is NOT the ACP bridge)
 * The live account findings show the ACP child NEVER drives a cloud session:
 * every launch is a `chat --cloud` subprocess (launch_path_decision
 * path:headless) and every follow-up is a `chat --resume-id` subprocess. The
 * ACP child's ONLY realized job was a one-shot CONFIG#CAPS publish at boot
 * (handled separately by {@link caps-publisher}). So the cloud path needs no
 * long-running host at all: a short-lived Lambda that spawns the `kiro-cli chat`
 * subprocess per turn and awaits it is sufficient. The persistent Fargate bridge
 * is RETAINED only for the ACP `adopt`/session-load path (which this handler
 * explicitly rejects -- see the `adopt` case below). The operator picks which
 * host(s) to deploy; this feature delivers the Lambda source only (CDK wiring is
 * FEAT-004).
 *
 * KEY DESIGN DECISION: SYNCHRONOUS settlement + SQS FIFO ordering
 * The ECS bridge runs a turn's settlement as BACKGROUND work (tracked on
 * rt.settling) so it can ack the SQS message on DISPATCH and never
 * head-of-line-block a session. This Lambda consumer does the OPPOSITE on
 * purpose: it AWAITS the FEAT-002 `settle()` thunk synchronously before the
 * record is treated as done. That is CORRECT for the native SQS event-source
 * mapping because a Lambda invocation holds the FIFO MessageGroupId (=
 * sessionId) for its whole duration -- so a later prompt/answerPermission/delete
 * in the SAME session waits for the active turn to finish, which is exactly the
 * ordering a non-interactive cloud turn wants. A cloud `--no-interactive` turn
 * is effectively non-interactive: the shared logic already rejects mid-turn
 * steer/cancel and `whenBusy=queue` as {@link UnsupportedCloudOperationError},
 * so there is NO concurrent-within-session work that a held message would block.
 * One observed TimeToFirstEvent was ~73s, well under the 15-minute Lambda
 * ceiling, so holding the group for a turn's duration is safe. Records are
 * processed SEQUENTIALLY within an invocation to honor per-group ordering (a
 * single FIFO group may deliver multiple messages in one batch).
 *
 * OUTCOME HANDLING (mirrors intake.ts)
 *  - An {@link UnsupportedCloudOperationError} is PERMANENT: redelivering would
 *    reject identically forever. Log a warning, persist a client-visible
 *    rejection event (recordUnsupportedRejection), and treat the record as a
 *    SUCCESS -- do NOT add it to batchItemFailures, so SQS deletes it and the
 *    FIFO group keeps moving. (`adopt` is folded into this class on the Lambda
 *    path -- see below.)
 *  - A genuine TRANSIENT error returns the record id in
 *    {@link SQSBatchResponse.batchItemFailures} so the SQS event-source mapping
 *    (configured with ReportBatchItemFailures in FEAT-004) retries only that
 *    message (and, for FIFO, its group tail).
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { type Command, Repository, type SessionInputs } from "@nikovirtala/kiro-remote-core";
import { ulid } from "ulid";
import {
  type CloudLaunchArgs,
  CloudSession,
  createRuntime,
  type SessionRuntime,
  UnsupportedCloudOperationError,
} from "./cloud-session.ts";
import { defaultHeadlessRunner, type HeadlessRunner } from "./headless.ts";
import { createLogger, type Logger } from "./logger.ts";
import { loggerMetricSink, type MetricSink, Metrics } from "./metrics.ts";
import { resolveKiroApiKey } from "./secrets.ts";

/* ----------------------------- SQS event types ---------------------------- */
/**
 * Minimal structural copies of the AWS Lambda SQS event/response contract.
 * The bridge package intentionally has NO @types/aws-lambda dependency (it is
 * not on the allowlist and the handler only needs these few fields), so the
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

/** An SQS handler: a batch in, the partial-failure report out. */
export type SQSHandler = (event: SQSEvent) => Promise<SQSBatchResponse>;

/* -------------------------------- config ---------------------------------- */

/**
 * The consumer's configuration, read from the SAME env contract the ECS bridge
 * uses (see cli.ts configFromEnv) MINUS the ACP-only knobs. There is no
 * COMMAND_QUEUE_URL here: the event-source mapping delivers the messages, so the
 * consumer never polls a queue url itself.
 */
export interface ConsumerConfig {
  tableName: string;
  bucketName: string;
  workspaceRoot: string;
  additionalDirectories?: string[];
  mcpServers?: unknown[];
  region?: string;
}

export interface ConsumerDeps {
  config: ConsumerConfig;
  /** Overrides for tests: injected AWS clients, runner, sinks, clock, env. */
  ddb?: DynamoDBDocumentClient;
  s3?: S3Client;
  secretsManager?: SecretsManagerClient;
  headlessRunner?: HeadlessRunner;
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

/** Build a {@link ConsumerConfig} from the bridge's existing env contract. */
export function consumerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ConsumerConfig {
  return {
    tableName: requireEnv(env, "TABLE_NAME"),
    bucketName: requireEnv(env, "BUCKET_NAME"),
    workspaceRoot: env.WORKSPACE_ROOT ?? "/workspace",
    ...(env.ADDITIONAL_DIRECTORIES
      ? { additionalDirectories: env.ADDITIONAL_DIRECTORIES.split(",").filter(Boolean) }
      : {}),
    ...(env.AWS_REGION ? { region: env.AWS_REGION } : {}),
  };
}

/* ------------------------------ the consumer ------------------------------ */

/**
 * The gateway-free cloud consumer. Owns the per-session runtime map, the
 * cloud->local id map, and the shared {@link CloudSession} engine, and
 * dispatches a single {@link Command} by kind -- mirroring intake.ts dispatch()
 * but awaiting settlement synchronously. Constructed ONCE per warm Lambda
 * container (so the runtime map survives across invocations, giving the same
 * in-memory idempotency the ECS bridge has) and invoked per SQS batch via
 * {@link handleEvent}.
 */
export class LambdaConsumer {
  private readonly repo: Repository;
  private readonly logger: Logger;
  private readonly cloud: CloudSession;
  private readonly workspaceRoot: string;
  private readonly additionalDirectories?: string[];
  private readonly mcpServers: unknown[];
  private readonly now: () => number;

  private readonly runtimes = new Map<string, SessionRuntime>();
  /** Cloud (Kiro) id -> our session id. The SAME instance the engine holds. */
  private readonly kiroToLocal: Map<string, string>;

  private constructor(args: {
    repo: Repository;
    logger: Logger;
    cloud: CloudSession;
    config: ConsumerConfig;
    kiroToLocal: Map<string, string>;
    now: () => number;
  }) {
    this.repo = args.repo;
    this.logger = args.logger;
    this.cloud = args.cloud;
    this.workspaceRoot = args.config.workspaceRoot;
    this.additionalDirectories = args.config.additionalDirectories;
    this.mcpServers = args.config.mcpServers ?? [];
    this.kiroToLocal = args.kiroToLocal;
    this.now = args.now;
  }

  /**
   * Build the consumer with NO AcpGateway/transport/supervisor: just the
   * Repository (DynamoDB + S3), Metrics, Logger, the default headless runner,
   * and the shared CloudSession. KIRO_API_KEY is resolved the SAME way serve.ts
   * does (resolveKiroApiKey) and placed in the child env for the spawned
   * `kiro-cli chat` subprocesses.
   */
  static async create(deps: ConsumerDeps): Promise<LambdaConsumer> {
    const env = deps.env ?? process.env;
    const now = deps.now ?? (() => Date.now());
    const logger = deps.logger ?? createLogger({ bindings: { service: "bridge-lambda" } });
    const metrics = new Metrics(deps.metricSink ?? loggerMetricSink(logger));

    const region = deps.config.region ?? env.AWS_REGION ?? "us-east-1";
    const ddb = deps.ddb ?? DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
    const s3 = deps.s3 ?? new S3Client({ region });
    const secretsManager = deps.secretsManager ?? new SecretsManagerClient({ region });

    const repo = new Repository({
      ddb,
      s3,
      tableName: deps.config.tableName,
      bucketName: deps.config.bucketName,
      now,
    });

    // Resolve the Kiro API key the SAME way the ECS bridge does and place it in
    // the child env for the `kiro-cli chat` subprocesses the headless runner
    // spawns (never logged, never on disk). The default headless runner merges
    // this over process.env for every spawned turn.
    const apiKey = await resolveKiroApiKey({ secretsManager, logger, env });
    const childEnv: Record<string, string> = {};
    if (apiKey) {
      childEnv.KIRO_API_KEY = apiKey;
    }
    childEnv.KIRO_LOG_LEVEL = env.KIRO_LOG_LEVEL ?? "debug";

    const baseRunner = deps.headlessRunner ?? defaultHeadlessRunner;
    // Wrap the runner so EVERY spawned turn carries the resolved API key in its
    // env, matching how serve.ts injects KIRO_API_KEY into the ACP child env.
    const headlessRunner: HeadlessRunner = (spec) =>
      baseRunner({ ...spec, env: { ...childEnv, ...(spec.env ?? {}) } });

    const kiroToLocal = new Map<string, string>();
    const cloud = new CloudSession({
      repo,
      logger,
      metrics,
      headlessRunner,
      kiroToLocal,
      now,
    });

    // Share the single kiroToLocal map instance between the engine and the
    // consumer so a cloud-launched session resolves through the same map.
    return new LambdaConsumer({ repo, logger, cloud, config: deps.config, kiroToLocal, now });
  }

  private inputsFor(inputs?: Partial<SessionInputs>): SessionInputs {
    return {
      cwd: this.workspaceRoot,
      ...(this.additionalDirectories ? { additionalDirectories: this.additionalDirectories } : {}),
      mcpServers: this.mcpServers,
      ...(inputs ?? {}),
    };
  }

  private runtimeFor(id: string): SessionRuntime {
    let rt = this.runtimes.get(id);
    if (!rt) {
      rt = createRuntime(id, this.inputsFor(), this.now);
      this.runtimes.set(id, rt);
    }
    return rt;
  }

  /**
   * Process one SQS batch. Records are handled SEQUENTIALLY so per-group (=
   * per-session) ordering is honored even when one invocation carries several
   * messages of the same FIFO group. Returns the partial-batch failure report:
   * only genuinely TRANSIENT failures appear in batchItemFailures; a permanent
   * UnsupportedCloudOperationError is persisted-as-rejection and acked.
   */
  async handleEvent(event: SQSEvent): Promise<SQSBatchResponse> {
    const batchItemFailures: SQSBatchItemFailure[] = [];
    for (const record of event.Records) {
      const transient = await this.handleRecord(record);
      if (transient) {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }
    return { batchItemFailures };
  }

  /**
   * Handle a single SQS record. Returns true when the record must be RETRIED
   * (a transient failure -> added to batchItemFailures), false when the record
   * is done (success, idempotent no-op, or a PERMANENT rejection that was
   * persisted as a client-visible event and should be deleted).
   */
  private async handleRecord(record: SQSRecord): Promise<boolean> {
    let command: Command;
    try {
      command = JSON.parse(record.body) as Command;
    } catch (err) {
      // An unparseable body can never succeed on retry; ack it (do not retry).
      this.logger.error("consumer_parse_error", {
        messageId: record.messageId,
        error: String(err),
      });
      return false;
    }
    try {
      await this.dispatch(command);
      return false;
    } catch (err) {
      if (err instanceof UnsupportedCloudOperationError) {
        // PERMANENT rejection (mid-turn steer/cancel, a queued follow-up with no
        // drain, or `adopt` on the Lambda path). Redelivering would reject
        // identically forever. Keep it LOUD -- a warn log AND a client-visible
        // rejection event on GET /v1/sessions/{id}/events -- but treat the record
        // as a SUCCESS (NOT added to batchItemFailures) so SQS deletes it and the
        // FIFO group keeps moving. This mirrors intake.ts exactly.
        this.logger.warn("command_unsupported_cloud", {
          kind: command.kind,
          sessionId: command.sessionId,
          operation: err.operation,
          error: err.message,
        });
        try {
          await this.recordUnsupportedRejection(command.sessionId, err.operation, err.message);
        } catch (persistErr) {
          // Persisting the client-visible event is best-effort; never let it
          // turn a permanent rejection into a redelivery loop.
          this.logger.warn("command_rejection_persist_error", {
            sessionId: command.sessionId,
            error: String(persistErr),
          });
        }
        return false;
      }
      // Genuine TRANSIENT failure: return the record for redelivery so only this
      // message (and, for FIFO, its group tail) is retried.
      this.logger.error("command_dispatch_error", {
        kind: command.kind,
        sessionId: command.sessionId,
        error: String(err),
      });
      return true;
    }
  }

  /**
   * Dispatch a command by kind, mirroring intake.ts dispatch() EXCEPT that a
   * cloud turn runs SYNCHRONOUSLY: `launch`/`prompt` AWAIT the FEAT-002
   * `settle()` thunk here (the ECS bridge runs it in the background). Holding
   * the FIFO group for the turn's duration is the correct ordering for a
   * non-interactive cloud turn (see the module header).
   */
  async dispatch(command: Command): Promise<void> {
    const log = this.logger.child({
      sub: command.sub,
      sessionId: command.sessionId,
      commandId: command.commandId,
      kind: command.kind,
    });
    log.info("command_received");
    switch (command.kind) {
      case "launch":
        await this.launch(command.sessionId, {
          prompt: command.prompt,
          repos: command.repos,
          ...(command.mode ? { mode: command.mode } : {}),
          ...(command.model ? { model: command.model } : {}),
          ...(command.effort ? { effort: command.effort } : {}),
        });
        return;
      case "prompt":
        await this.steer(command.sessionId, command.prompt, command.whenBusy, command.turnId);
        return;
      case "steer":
        await this.steer(command.sessionId, command.content, "steer");
        return;
      case "cancel":
        this.cancel(command.sessionId);
        return;
      case "answerPermission":
        // There is NO ACP child on the Lambda path, so there is no held-open
        // permission request to resolve: a cloud `--no-interactive` turn never
        // prompts for a permission (it auto-proceeds/refuses in-subprocess). A
        // stray answerPermission is a clean, logged no-op -- never a hang, never
        // a redelivery loop.
        log.info("answer_permission_noop_cloud", { requestId: command.requestId });
        return;
      case "setConfig":
        // setConfig targets ACP session config options (model/effort/mode) that
        // only a live ACP session exposes. On the Lambda path there is no ACP
        // child; the per-turn model/effort/mode travel with the launch command
        // instead. Treat a standalone setConfig as a logged no-op.
        log.info("set_config_noop_cloud");
        return;
      case "delete":
        await this.markDeleted(command.sessionId);
        return;
      case "adopt":
        // adopt/session-load is the ONE capability the Lambda path intentionally
        // does NOT cover: it requires a live ACP child (gateway.loadSession) that
        // this host does not run. Reject it LOUDLY as an unsupported cloud
        // operation so it is logged + persisted as a client-visible rejection +
        // the message is deleted (never a silent no-op, never a redelivery loop).
        // Fargate is retained specifically for this ACP adopt/session-load path.
        this.runtimeFor(command.sessionId);
        throw new UnsupportedCloudOperationError(
          "adopt",
          "adopt/session-load is not supported on the Lambda bridge; it requires the Fargate (ACP) bridge",
        );
      default: {
        const never: never = command;
        throw new Error(`unknown command kind: ${(never as { kind: string }).kind}`);
      }
    }
  }

  /* --------------------------------- launch -------------------------------- */

  /**
   * Launch a cloud session and AWAIT its settlement (the Lambda wrapping). The
   * idempotency guard + launch-path decision are delegated to the shared engine;
   * a null result is an idempotent redelivery (logged skip) so the record is
   * still acked and the FIFO group unblocks.
   */
  private async launch(id: string, args: CloudLaunchArgs): Promise<void> {
    const rt = this.runtimeFor(id);
    rt.inputs = this.inputsFor({
      ...(args.mode ? { modeId: args.mode } : {}),
      ...(args.model ? { modelId: args.model } : {}),
      ...(args.effort ? { effortLevel: args.effort } : {}),
      ...(args.repos.length > 0 ? { repos: args.repos } : {}),
    });

    const begun = await this.cloud.beginLaunch(rt, id, args);
    if (!begun) {
      return;
    }
    rt.activeTurnId = ulid();
    // AWAIT the SAME settlement primitive the ECS bridge runs in the background.
    await begun.settle();
  }

  /* --------------------------- prompt / steer / cancel --------------------- */

  /**
   * Resolve a follow-up `prompt`/`steer`. The shared engine encodes the "a cloud
   * turn is effectively non-interactive" rule: an already-issued turn id is a
   * logged no-op, an idle session takes a fresh prompt (which we AWAIT), a
   * `whenBusy=reject` is a quiet skip, and a mid-turn steer / `whenBusy=queue`
   * throws {@link UnsupportedCloudOperationError} (handled by handleRecord).
   */
  private async steer(
    id: string,
    content: string,
    whenBusy: "steer" | "queue" | "reject",
    turnId?: string,
  ): Promise<void> {
    const rt = this.runtimeFor(id);
    const decision = this.cloud.classifySteer(rt, id, whenBusy, turnId);
    if (decision === "prompt") {
      await this.prompt(id, content, turnId);
    }
    // "idempotent" and "reject" are logged no-ops inside classifySteer.
  }

  /** Start a follow-up turn and AWAIT its settlement (the Lambda wrapping). */
  private async prompt(id: string, prompt: string, turnId?: string): Promise<void> {
    const rt = this.runtimeFor(id);
    const tid = turnId ?? ulid();
    const begun = await this.cloud.beginResume(rt, id, prompt, turnId, tid);
    if (!begun) {
      return;
    }
    await begun.settle();
  }

  /** Classify a cancel (throws UnsupportedCloudOperationError on a running turn). */
  private cancel(id: string): void {
    const rt = this.runtimeFor(id);
    this.cloud.classifyCancel(rt, id);
  }

  /* -------------------------------- delete --------------------------------- */

  /** Delete the cloud session (CLI delete, best-effort) and mark the row deleted. */
  private async markDeleted(id: string): Promise<void> {
    const rt = this.runtimeFor(id);
    const item = await this.repo.getSession(id);
    const kiroSessionId = rt.kiroSessionId ?? item?.kiroSessionId ?? null;
    await this.cloud.deleteCloud(id, kiroSessionId);
    this.cloud.applyMachine(rt, { kind: "deleted" });
    if (item) {
      await this.repo.updateSession(id, item.version, { status: "deleted", activeTurnId: null });
    }
    this.runtimes.delete(id);
    if (rt.kiroSessionId) {
      this.kiroToLocal.delete(rt.kiroSessionId);
    }
  }

  /* ------------------------- unsupported rejection ------------------------- */

  /**
   * Persist a client-visible rejection for an unsupported operation. A no-op
   * when the runtime is gone. Delegates to the shared engine so the Lambda path
   * persists the identical rejection event the ECS path does.
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
 * The Lambda handler entry. The consumer is built ONCE at module load (outside
 * the handler) so the runtime map + resolved API key survive across warm
 * invocations, giving the Lambda path the SAME in-memory idempotency the ECS
 * bridge has within a container's lifetime. The build is lazy (first invocation
 * awaits it) so module load never blocks on a Secrets Manager call.
 *
 * FEAT-004 points the container-image Lambda at this exported `handler` (the
 * bundle entry runs it via the container runtime); the ESM must be configured
 * with ReportBatchItemFailures so the returned batchItemFailures is honored.
 */
let consumerPromise: Promise<LambdaConsumer> | null = null;

function getConsumer(): Promise<LambdaConsumer> {
  if (!consumerPromise) {
    consumerPromise = LambdaConsumer.create({ config: consumerConfigFromEnv() });
  }
  return consumerPromise;
}

export const handler: SQSHandler = async (event) => {
  const consumer = await getConsumer();
  return consumer.handleEvent(event);
};
