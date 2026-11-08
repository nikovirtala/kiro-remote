/**
 * `bridge serve` wiring.
 *
 * Owns ONE `kiro-cli acp --agent-engine=v3` child, runs initialize + handler
 * registration, consumes the SQS FIFO command queue, and writes events/state to
 * DynamoDB. SIGTERM drains in-flight writes before exit. On child death the
 * {@link Supervisor} restarts + reconnects.
 *
 * The launch flags are the V3 set only: `acp --agent-engine=v3` with the
 * DEFAULT auth method (the CLI owns auth via KIRO_API_KEY in the child env).
 * NO v2-only flags (--agent/--model/--effort/--trust-all-tools/--trust-tools).
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  Repository,
  type SessionInputs,
  type SessionMetaItem,
} from "@nikovirtala/kiro-remote-core";
import { AcpGateway } from "./gateway.ts";
import { defaultHeadlessRunner, type HeadlessRunner } from "./headless.ts";
import { HealthMonitor } from "./health.ts";
import { CommandIntake } from "./intake.ts";
import { createLogger, type Logger } from "./logger.ts";
import { loggerMetricSink, type MetricSink, Metrics } from "./metrics.ts";
import { persistCaps } from "./persist-caps.ts";
import { resolveKiroApiKey } from "./secrets.ts";
import { SessionManager } from "./session-manager.ts";
import { Supervisor } from "./supervisor.ts";
import { defaultSpawn, type SpawnFn, StdioJsonRpcTransport } from "./transport.ts";

/** The V3 ACP launch command. kiro-cli is installed into PATH by the image. */
export const ACP_COMMAND = "kiro-cli";
export const ACP_ARGS = ["acp", "--agent-engine=v3"] as const;

export interface ServeConfig {
  tableName: string;
  bucketName: string;
  queueUrl: string;
  workspaceRoot: string;
  additionalDirectories?: string[];
  mcpServers?: unknown[];
  region?: string;
  /**
   * Bounded wait (ms) on SIGTERM shutdown for in-flight background turn
   * settlement to finish persisting before the transport is stopped. A hard cap
   * -- a turn parked on an unanswered permission never settles, so this must not
   * hang. Defaults to {@link BridgeServer.SHUTDOWN_DRAIN_MS}; tests shrink it.
   */
  shutdownDrainMs?: number;
}

export interface ServeDeps {
  config: ServeConfig;
  /** Overrides for tests: injected AWS clients, spawner, runner, sinks. */
  ddb?: DynamoDBDocumentClient;
  s3?: S3Client;
  sqs?: SQSClient;
  secretsManager?: SecretsManagerClient;
  spawnFn?: SpawnFn;
  headlessRunner?: HeadlessRunner;
  logger?: Logger;
  metricSink?: MetricSink;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

/** A running bridge instance; call {@link BridgeServer.shutdown} on SIGTERM. */
export class BridgeServer {
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly health: HealthMonitor;
  readonly transport: StdioJsonRpcTransport;
  readonly gateway: AcpGateway;
  readonly manager: SessionManager;
  readonly intake: CommandIntake;
  readonly supervisor: Supervisor;
  readonly repo: Repository;

  private readonly config: ServeConfig;
  private shuttingDown = false;

  private constructor(args: {
    config: ServeConfig;
    logger: Logger;
    metrics: Metrics;
    health: HealthMonitor;
    transport: StdioJsonRpcTransport;
    gateway: AcpGateway;
    manager: SessionManager;
    intake: CommandIntake;
    supervisor: Supervisor;
    repo: Repository;
  }) {
    this.config = args.config;
    this.logger = args.logger;
    this.metrics = args.metrics;
    this.health = args.health;
    this.transport = args.transport;
    this.gateway = args.gateway;
    this.manager = args.manager;
    this.intake = args.intake;
    this.supervisor = args.supervisor;
    this.repo = args.repo;
  }

  static async create(deps: ServeDeps): Promise<BridgeServer> {
    const env = deps.env ?? process.env;
    const now = deps.now ?? (() => Date.now());
    const logger = deps.logger ?? createLogger({ bindings: { service: "bridge" } });
    const metrics = new Metrics(deps.metricSink ?? loggerMetricSink(logger));
    const health = new HealthMonitor(now);

    const region = deps.config.region ?? env.AWS_REGION ?? "us-east-1";
    const ddb = deps.ddb ?? DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
    const s3 = deps.s3 ?? new S3Client({ region });
    const sqs = deps.sqs ?? new SQSClient({ region });
    const secretsManager = deps.secretsManager ?? new SecretsManagerClient({ region });

    const repo = new Repository({
      ddb,
      s3,
      tableName: deps.config.tableName,
      bucketName: deps.config.bucketName,
      now,
    });

    // Resolve the Kiro API key for the child env (never logged, never on disk).
    const apiKey = await resolveKiroApiKey({ secretsManager, logger, env });
    const childEnv: Record<string, string> = {};
    if (apiKey) {
      childEnv.KIRO_API_KEY = apiKey;
    }
    // Propagate the Kiro CLI's own log level into the child so kiro-cli emits
    // verbose startup diagnostics to stderr (error|warn|info|debug|trace),
    // which the transport surfaces on failure. Defaults to debug for now so the
    // first diagnostic deploys are maximally verbose; dial back via KIRO_LOG_LEVEL.
    childEnv.KIRO_LOG_LEVEL = env.KIRO_LOG_LEVEL ?? "debug";

    const headlessRunner = deps.headlessRunner ?? defaultHeadlessRunner;

    // The transport is created with an onExit that triggers supervised reconnect.
    const transport = new StdioJsonRpcTransport({
      spec: { command: ACP_COMMAND, args: [...ACP_ARGS], env: childEnv },
      spawnFn: deps.spawnFn ?? defaultSpawn,
      logger,
    });

    const gateway = new AcpGateway({
      transport,
      logger,
      now,
      hooks: {
        onSessionUpdate: (sessionId, update) => {
          health.markActivity();
          manager.track(manager.handleUpdate(sessionId, update));
        },
        onPermissionRequested: (sessionId, requestId, params) => {
          health.markActivity();
          manager.track(manager.handlePermissionRequested(sessionId, requestId, params));
        },
        onAgentNotification: (method, params) => {
          health.markActivity();
          manager.track(manager.handleAgentNotification(method, params));
        },
      },
    });

    const manager: SessionManager = new SessionManager({
      gateway,
      repo,
      logger,
      metrics,
      headlessRunner,
      workspaceRoot: deps.config.workspaceRoot,
      ...(deps.config.additionalDirectories
        ? { additionalDirectories: deps.config.additionalDirectories }
        : {}),
      ...(deps.config.mcpServers ? { mcpServers: deps.config.mcpServers } : {}),
      now,
    });

    const intake = new CommandIntake({
      sqs,
      queueUrl: deps.config.queueUrl,
      manager,
      logger,
    });

    const inputsFor = (session: SessionMetaItem): SessionInputs => ({
      cwd: deps.config.workspaceRoot,
      ...(deps.config.additionalDirectories
        ? { additionalDirectories: deps.config.additionalDirectories }
        : {}),
      mcpServers: deps.config.mcpServers ?? [],
      ...(session.mode ? { modeId: session.mode } : {}),
      ...(session.model ? { modelId: session.model } : {}),
      ...(session.effort ? { effortLevel: session.effort } : {}),
    });

    const supervisor = new Supervisor({
      gateway,
      manager,
      repo,
      logger,
      metrics,
      inputsFor,
      listSessions: async () => {
        // Reconnect scope: non-deleted sessions. The API filters by owner; the
        // bridge reconnects every live session it is responsible for.
        return [];
      },
    });

    return new BridgeServer({
      config: deps.config,
      logger,
      metrics,
      health,
      transport,
      gateway,
      manager,
      intake,
      supervisor,
      repo,
    });
  }

  /** Spawn the child, register handlers, and run initialize (handlers first). */
  async start(): Promise<void> {
    this.logger.info("bridge_starting", { table: this.config.tableName });
    this.transport.start();
    // Handlers BEFORE any session; initialize() registers then negotiates.
    await this.gateway.initialize();
    this.health.markActivity();
    // Log the RAW initialize result once so the real kiro-cli advertisement
    // shape becomes visible after redeploy. Redaction scrubs any secret-bearing
    // values; advertised capability keys are not secrets.
    this.logger.info("bridge_initialize_result", {
      initializeResult: this.gateway.initializeResult,
    });
    this.logger.info("bridge_initialized", {
      extensionMethods: this.gateway.capabilities().extensionMethods,
    });
    // Persist CONFIG#CAPS so the REST API GET /v1/capabilities, the lambda
    // capability gate, and the MCP kiro_capabilities tool serve real data
    // instead of the empty fallback. Guarded so a write failure never kills
    // startup; reconnect retries the write.
    await persistCaps(this.repo, this.gateway, this.logger);
  }

  /** Begin consuming the SQS FIFO command queue (the long-running loop). */
  beginIntake(): void {
    void this.intake.run();
  }

  /**
   * Default bounded wait (ms) on shutdown for in-flight turn settlement. The
   * ack now happens on dispatch (the SQS message is deleted before the turn
   * settles in the background), so a turn that is actively settling at SIGTERM
   * would otherwise be dropped with no redelivery to re-drive it. A couple of
   * seconds gives an in-flight settle time to persist; it is a HARD cap so a
   * turn parked on an unanswered permission never hangs shutdown.
   */
  static readonly SHUTDOWN_DRAIN_MS = 2000;

  /** SIGTERM drain: stop intake, await in-flight settlement (bounded), stop the child. */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    this.logger.info("bridge_shutdown_begin");
    this.intake.stop();
    // Await any outstanding background turn settlement up to a bounded timeout
    // so an in-flight turn gets a chance to finish persisting before we stop the
    // transport. Bounded: a turn parked on an unanswered permission will not
    // settle on its own (it relies on reconnect/replay after restart), so the
    // timeout caps the wait rather than hanging shutdown.
    await this.manager.awaitAllSettled(
      this.config.shutdownDrainMs ?? BridgeServer.SHUTDOWN_DRAIN_MS,
    );
    await this.transport.stop("SIGTERM");
    this.logger.info("bridge_shutdown_done");
  }

  /** Install process signal handlers for graceful drain. */
  installSignalHandlers(): void {
    const handler = (): void => {
      void this.shutdown().then(() => process.exit(0));
    };
    process.once("SIGTERM", handler);
    process.once("SIGINT", handler);
  }
}
