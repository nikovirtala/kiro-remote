/**
 * The one-shot capability publisher.
 *
 * The REST API GET /v1/capabilities, the lambda capability gate, and the MCP
 * kiro_capabilities tool all READ one CONFIG#CAPS item. Writing it takes a
 * single ACP `initialize`, so no long-running ACP host is needed: this
 * publisher starts the bundled KAS engine directly (see {@link kasSpawnSpec}),
 * `initialize`s it to obtain the REAL initializeResult, writes
 * CONFIG#CAPS via the SAME {@link persistCaps} logic the ECS bridge uses, then
 * stops the engine. On the Lambda deployment it is invoked once on deploy and
 * on a schedule (EventBridge), so a transient failure self-heals on the next
 * run and the API's empty-caps fallback is the only impact until a publish
 * succeeds.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { Repository } from "@nikovirtala/kiro-remote-core";
import { AcpGateway } from "./gateway.ts";
import { kasSpawnSpec } from "./kas-engine.ts";
import { createLogger, type Logger } from "./logger.ts";
import { type PersistCapsOptions, persistCaps } from "./persist-caps.ts";
import { resolveKiroApiKey } from "./secrets.ts";
import { defaultSpawn, type SpawnFn, StdioJsonRpcTransport } from "./transport.ts";

export interface CapsPublisherConfig {
  tableName: string;
  bucketName: string;
  region?: string;
}

export interface CapsPublisherDeps {
  config: CapsPublisherConfig;
  /** Overrides for tests: injected AWS clients, spawner, sinks, env. */
  ddb?: DynamoDBDocumentClient;
  s3?: S3Client;
  secretsManager?: SecretsManagerClient;
  spawnFn?: SpawnFn;
  logger?: Logger;
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

/** Build a {@link CapsPublisherConfig} from the bridge's existing env contract. */
export function capsPublisherConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CapsPublisherConfig {
  return {
    tableName: requireEnv(env, "TABLE_NAME"),
    bucketName: requireEnv(env, "BUCKET_NAME"),
    ...(env.AWS_REGION ? { region: env.AWS_REGION } : {}),
  };
}

/**
 * Run the one-shot capability publish against the provided gateway + repo: a
 * single ACP `initialize` to obtain the real initializeResult, then persistCaps.
 * Split out from {@link runCapsPublish} so a test can drive it with a FAKE
 * gateway/initializeResult over the in-memory fakes (no real ACP child).
 */
export async function publishCaps(
  repo: Repository,
  gateway: Pick<AcpGateway, "initialize" | "initializeResult" | "capabilities">,
  logger: Logger,
  options: PersistCapsOptions = {},
): Promise<void> {
  // Register handlers (inside initialize) + negotiate to obtain the REAL
  // advertisement. This is the ONLY RPC the publisher makes.
  await gateway.initialize();
  logger.info("caps_publisher_initialize_result", {
    initializeResult: gateway.initializeResult,
  });
  // Persist CONFIG#CAPS via the SAME logic the ECS bridge uses at boot. The
  // direct engine reports no agentInfo, so pass the image's kiro-cli version.
  await persistCaps(repo, gateway as AcpGateway, logger, options);
}

/**
 * Start the engine, initialize, publish CONFIG#CAPS, and stop the engine.
 * Resolves once the publish completes (or its guarded failure is logged) and
 * the transport is stopped, so the Lambda invocation returns promptly.
 */
export async function runCapsPublish(deps: CapsPublisherDeps): Promise<void> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => Date.now());
  const logger = deps.logger ?? createLogger({ bindings: { service: "bridge-caps" } });

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

  // The engine needs KIRO_API_KEY in its env (never logged).
  const apiKey = await resolveKiroApiKey({ secretsManager, logger, env });

  const transport = new StdioJsonRpcTransport({
    spec: kasSpawnSpec({ env, apiKey }),
    spawnFn: deps.spawnFn ?? defaultSpawn,
    logger,
  });
  const gateway = new AcpGateway({
    transport,
    logger,
    now,
    // The publisher never drives sessions, so the hooks are inert.
    hooks: {
      onSessionUpdate: () => {},
      onPermissionRequested: () => {},
    },
  });

  transport.start();
  try {
    await publishCaps(repo, gateway, logger, {
      ...(env.KIRO_CLI_VERSION ? { kiroCliVersion: env.KIRO_CLI_VERSION } : {}),
    });
  } finally {
    // Always stop the short-lived engine so the invocation returns.
    await transport.stop("SIGTERM");
  }
}

/**
 * The Lambda handler entry for the capability publisher. The event payload is
 * ignored (it is invoked on deploy + on a schedule). A failure PROPAGATES so
 * the invocation is marked failed and the schedule retries it; the API's
 * empty-caps fallback is the only impact until a run succeeds.
 *
 * FEAT-004 points a Lambda at this exported `handler`; the bundle entry runs it
 * via the container runtime.
 */
export const handler = async (): Promise<void> => {
  await runCapsPublish({ config: capsPublisherConfigFromEnv() });
};
