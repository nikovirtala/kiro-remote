/**
 * The one-shot capability publisher.
 *
 * The REST API GET /v1/capabilities, the lambda capability gate, and the MCP
 * kiro_capabilities tool all READ one CONFIG#CAPS item. Writing it takes a
 * single ACP `initialize`, so no long-running ACP host is needed: this
 * publisher starts the bundled KAS engine through {@link KasEngine} (see
 * {@link kasSpawnSpec}), `initialize`s it to obtain the REAL initializeResult,
 * writes CONFIG#CAPS via {@link persistCaps}, then stops the engine. It is
 * invoked once on deploy and on a schedule (EventBridge), so a transient
 * failure self-heals on the next run and the API's empty-caps fallback is the
 * only impact until a publish succeeds.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { type InitializeResult, Repository } from "@nikovirtala/kiro-remote-core";
import { KasEngine, kasSpawnSpec } from "./kas-engine.ts";
import { createLogger, type Logger } from "./logger.ts";
import { type PersistCapsOptions, persistCaps } from "./persist-caps.ts";
import { resolveKiroApiKey } from "./secrets.ts";
import { traced } from "./tracer.ts";
import type { SpawnFn } from "./transport.ts";

/**
 * The client capabilities the publisher advertises on `initialize`, so the
 * persisted advertisement reflects a client that can open external URLs.
 */
export const CAPS_CLIENT_CAPABILITIES = { _meta: { kiro: { openExternalUrl: true } } };

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

/** Build a {@link CapsPublisherConfig} from the function env. */
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
 * Run the one-shot capability publish against the provided engine + repo: a
 * single ACP `initialize` to obtain the real initializeResult, then persistCaps.
 * Split out from {@link runCapsPublish} so a test can drive it with a FAKE
 * engine/initializeResult over the in-memory fakes (no real ACP child).
 */
export async function publishCaps(
  repo: Repository,
  engine: Pick<KasEngine, "initialize">,
  logger: Logger,
  options: PersistCapsOptions = {},
): Promise<void> {
  // Negotiate to obtain the REAL advertisement. This is the ONLY RPC the
  // publisher makes.
  const initializeResult = ((await engine.initialize(CAPS_CLIENT_CAPABILITIES)) ??
    {}) as InitializeResult;
  logger.info("caps_publisher_initialize_result", { initializeResult });
  // The direct engine reports no agentInfo, so options carry the image's
  // kiro-cli version.
  await persistCaps(repo, initializeResult, logger, options);
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

  // The engine needs KIRO_API_KEY in its env (never logged).
  const apiKey = await resolveKiroApiKey({ secretsManager, logger, env });

  const engine = new KasEngine({
    spec: kasSpawnSpec({ env, apiKey }),
    ...(deps.spawnFn ? { spawnFn: deps.spawnFn } : {}),
    logger,
  });

  engine.start();
  try {
    await publishCaps(repo, engine, logger, {
      ...(env.KIRO_CLI_VERSION ? { kiroCliVersion: env.KIRO_CLI_VERSION } : {}),
    });
  } finally {
    // Always stop the short-lived engine so the invocation returns.
    await engine.stop();
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
