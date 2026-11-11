/** Shared wiring for the three GitHub Lambda handlers, built once per container from the function env. */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  GITHUB_CHECKS_DEBOUNCE_MS,
  Repository,
  SqsCommandQueue,
  SqsGithubQueue,
} from "@nikovirtala/kiro-remote-core";
import { type AppCredentials, GithubClient, parseAppSecret } from "../app-client.ts";
import type { ConsumerConfig } from "../consumer.ts";

const SECRET_TTL_MS = 5 * 60 * 1000;

/**
 * The GitHub App Kiro's agent acts through. Its PR comments are posted as the
 * user with `performed_via_github_app.slug` set to this (seen in a live run).
 */
export const KIRO_AGENT_APP_SLUGS: readonly string[] = ["kiro-agent"];

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return v;
}

export function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The consumer's policy, from env. */
export function consumerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ConsumerConfig {
  return {
    trustedLogins: splitList(env.GITHUB_TRUSTED_LOGINS),
    agentLogins: splitList(env.GITHUB_AGENT_LOGINS),
    agentApps: KIRO_AGENT_APP_SLUGS,
    autoCloseOnMerge: env.GITHUB_AUTO_CLOSE_ON_MERGE === "after_turn" ? "after_turn" : "off",
    checksDebounceMs: GITHUB_CHECKS_DEBOUNCE_MS,
  };
}

/** Reads the App secret from Secrets Manager, cached for a few minutes (so a rotation is picked up). */
export function secretLoader(
  env: NodeJS.ProcessEnv,
  sm?: SecretsManagerClient,
  now = () => Date.now(),
) {
  const client = sm ?? new SecretsManagerClient({});
  const arn = required(env, "GITHUB_APP_SECRET_ARN");
  let cached: { creds: AppCredentials; at: number } | null = null;
  return async (): Promise<AppCredentials> => {
    if (cached && now() - cached.at < SECRET_TTL_MS) {
      return cached.creds;
    }
    const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
    if (!res.SecretString) {
      throw new Error("GitHub App secret has no SecretString");
    }
    cached = { creds: parseAppSecret(res.SecretString), at: now() };
    return cached.creds;
  };
}

export function buildRepository(env: NodeJS.ProcessEnv): Repository {
  return new Repository({
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    s3: new S3Client({}),
    tableName: required(env, "TABLE_NAME"),
    bucketName: required(env, "BUCKET_NAME"),
  });
}

export function buildQueues(env: NodeJS.ProcessEnv) {
  const sqs = new SQSClient({});
  return {
    githubQueue: new SqsGithubQueue({ sqs, queueUrl: required(env, "GITHUB_QUEUE_URL") }),
    commandQueue: env.COMMAND_QUEUE_URL
      ? new SqsCommandQueue({ sqs, queueUrl: env.COMMAND_QUEUE_URL })
      : undefined,
  };
}

/** A GithubClient built lazily from the (cached) secret; recreated when the secret changes. */
export function lazyClient(load: () => Promise<AppCredentials>) {
  let current: { key: string; client: GithubClient } | null = null;
  return async (): Promise<GithubClient> => {
    const creds = await load();
    const key = `${creds.appId}:${creds.privateKey.length}`;
    if (!current || current.key !== key) {
      current = { key, client: new GithubClient({ credentials: creds }) };
    }
    return current.client;
  };
}

/** Defer-calling proxy so handlers can pass a client without awaiting the secret at import time. */
export function deferredClient(
  get: () => Promise<GithubClient>,
): Pick<GithubClient, "getPull" | "listReviewComments" | "listAppDeliveries" | "redeliver"> {
  return {
    getPull: async (...a) => (await get()).getPull(...a),
    listReviewComments: async (...a) => (await get()).listReviewComments(...a),
    listAppDeliveries: async (...a) => (await get()).listAppDeliveries(...a),
    redeliver: async (...a) => (await get()).redeliver(...a),
  };
}
