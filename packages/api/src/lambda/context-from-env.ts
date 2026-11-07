/**
 * Production {@link ApiContext} assembly from environment variables.
 *
 * This is the real counterpart to the offline test harness in
 * `packages/api/test/helpers.ts` (`buildHarness`): it assembles the SAME
 * context shape but with REAL AWS clients and the production adapters:
 *   - a {@link Repository} over a real DynamoDBDocumentClient + S3Client,
 *   - the {@link SqsCommandQueue} producer onto the FIFO command queue,
 *   - the aws-jwt-verify {@link CognitoTokenVerifier},
 *   - the OAuth facade deps (CognitoAdapter + KmsAdapter + ClientResolver +
 *     CimdFetcher),
 *   - {@link PowertoolsObservability}.
 *
 * All AWS SDK clients are constructed from the ambient Lambda execution
 * environment (region/credentials resolved by the default provider chain). The
 * `mcp` transport handler is injected (not built here) because wiring it would
 * require @nikovirtala/kiro-remote-mcp, and mcp already depends on api -- importing it
 * here would create a package dependency cycle. The Lambda entry (built in the
 * non-cyclic cdk layer) injects it via {@link BuildContextOptions.mcp}.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { KMSClient } from "@aws-sdk/client-kms";
import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  CimdFetcher,
  ClientResolver,
  CognitoAdapter,
  type FacadeConfig,
  KmsAdapter,
  type PreRegisteredClient,
} from "@nikovirtala/kiro-remote-auth";
import {
  CognitoTokenVerifier,
  capabilities as deriveCapabilities,
  Repository,
  SqsCommandQueue,
} from "@nikovirtala/kiro-remote-core";
import type { ApiContext, FacadeDeps } from "../context.ts";
import type { McpTransportHandler } from "../mcp-seam.ts";
import { PowertoolsObservability } from "../observability.ts";

/** The scopes exposed by the MCP resource server (fixed by the auth construct). */
const SCOPES_SUPPORTED = ["sessions:read", "sessions:write", "sessions:delete"] as const;

/** Read a required env var or throw a clear configuration error. */
function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
}

/** Split a comma-separated env var into a trimmed, non-empty list. */
function splitList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse the `PREREGISTERED_CLIENTS` env var into the resolver's pre-registration
 * list. The construct serializes each pre-registered client the auth construct
 * provisions as `{ clientId, clientName, redirectUris }` (the `client_id` the
 * client presents at /oauth/authorize plus its exact allowed redirect URIs), so
 * a non-CIMD client can complete /oauth/authorize against the deployed facade.
 * Returns an empty list when the var is absent or empty; throws a clear
 * configuration error when the var is present but not a valid JSON array of the
 * expected shape (fail-fast on a misconfigured deploy).
 */
function parsePreRegisteredClients(value: string | undefined): PreRegisteredClient[] {
  if (!value) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("invalid PREREGISTERED_CLIENTS env var: not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("invalid PREREGISTERED_CLIENTS env var: expected a JSON array");
  }
  return parsed.map((entry, index) => {
    const e = entry as Record<string, unknown>;
    const clientId = e.clientId;
    const clientName = e.clientName;
    const redirectUris = e.redirectUris;
    if (typeof clientId !== "string" || !clientId) {
      throw new Error(
        `invalid PREREGISTERED_CLIENTS[${index}]: clientId must be a non-empty string`,
      );
    }
    if (typeof clientName !== "string" || !clientName) {
      throw new Error(
        `invalid PREREGISTERED_CLIENTS[${index}]: clientName must be a non-empty string`,
      );
    }
    if (!Array.isArray(redirectUris) || !redirectUris.every((u) => typeof u === "string")) {
      throw new Error(
        `invalid PREREGISTERED_CLIENTS[${index}]: redirectUris must be an array of strings`,
      );
    }
    return { clientId, clientName, redirectUris };
  });
}

/** Derive the Cognito JWKS URI for a user pool in the given region. */
function cognitoJwksUri(region: string, userPoolId: string): string {
  return `https://cognito-idp.${region}.amazonaws.com/${userPoolId}/.well-known/jwks.json`;
}

export interface BuildContextOptions {
  /** Environment source (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /**
   * Optional MCP transport handler to mount at /mcp. Injected by the Lambda
   * entry (which lives in a non-cyclic layer so it may depend on
   * @nikovirtala/kiro-remote-mcp). When omitted, /mcp keeps its 501 seam.
   */
  mcp?: McpTransportHandler;
  /** Injectable AWS clients (for tests). */
  clients?: {
    ddb?: DynamoDBDocumentClient;
    s3?: S3Client;
    sqs?: SQSClient;
    kms?: KMSClient;
  };
}

/**
 * Assemble a live {@link ApiContext} from environment variables. Mirrors
 * `buildHarness` but with real clients and the production adapters.
 */
export function buildContextFromEnv(options: BuildContextOptions = {}): ApiContext {
  const env = options.env ?? process.env;
  const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1";

  const tableName = required(env, "TABLE_NAME");
  const bucketName = required(env, "BUCKET_NAME");
  const commandQueueUrl = required(env, "COMMAND_QUEUE_URL");
  const publicBaseUrl = required(env, "PUBLIC_BASE_URL").replace(/\/+$/, "");
  const mcpResource = required(env, "MCP_RESOURCE");
  const userPoolId = required(env, "COGNITO_USER_POOL_ID");
  const cognitoClientId = required(env, "COGNITO_CLIENT_ID");
  const kmsKeyId = required(env, "OAUTH_CODE_KMS_KEY_ID");
  const cognitoDomain = required(env, "COGNITO_DOMAIN").replace(/\/+$/, "");

  const ddb = options.clients?.ddb ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const s3 = options.clients?.s3 ?? new S3Client({});
  const sqs = options.clients?.sqs ?? new SQSClient({});
  const kms = options.clients?.kms ?? new KMSClient({});

  const repo = new Repository({ ddb, s3, tableName, bucketName });
  const queue = new SqsCommandQueue({ sqs, queueUrl: commandQueueUrl });

  const verifier = new CognitoTokenVerifier({ userPoolId });

  const cimdAllowedHosts = splitList(env.CIMD_ALLOWED_HOSTS);
  const preRegisteredClients = parsePreRegisteredClients(env.PREREGISTERED_CLIENTS);

  const facadeConfig: FacadeConfig = {
    publicBaseUrl,
    mcpResource,
    scopesSupported: [...SCOPES_SUPPORTED],
    cognitoDomain,
    cognitoClientId,
    cognitoJwksUri: cognitoJwksUri(region, userPoolId),
    cimdAllowedHosts,
    kmsKeyId,
  };

  const cognito = new CognitoAdapter({
    tokenEndpoint: `${cognitoDomain}/oauth2/token`,
    revocationEndpoint: `${cognitoDomain}/oauth2/revoke`,
    clientId: cognitoClientId,
  });
  const kmsAdapter = new KmsAdapter({ client: kms, keyId: kmsKeyId });
  const cimd = new CimdFetcher({ allowedHosts: cimdAllowedHosts });
  // Pre-registered (non-CIMD) clients provisioned by the construct's
  // `preRegisteredClients` prop are propagated here via PREREGISTERED_CLIENTS
  // (id + name + exact redirect URIs) so they can complete /oauth/authorize.
  // CIMD URL clients are still resolved dynamically under the SSRF guard.
  const clients = new ClientResolver({ cimd, preRegistered: preRegisteredClients });

  const facade: FacadeDeps = {
    config: facadeConfig,
    authorize: { config: facadeConfig, repo, clients },
    callback: { config: facadeConfig, repo, cognito, kms: kmsAdapter },
    token: { repo, cognito, kms: kmsAdapter },
    revoke: { cognito },
  };

  const ctx: ApiContext = {
    service: {
      repo,
      queue,
      allowedRepos: splitList(env.ALLOWED_REPOS),
    },
    repo,
    auth: {
      verifier,
      allowedClientIds: [cognitoClientId],
      resourceIdentifier: mcpResource,
    },
    resourceMetadataUrl: `${publicBaseUrl}/.well-known/oauth-protected-resource/mcp`,
    capabilities: async () => {
      const caps = await repo.getCaps();
      // Same empty-capabilities fallback the REST getCapabilities route uses
      // when CONFIG#CAPS is absent (the bridge has not initialized yet).
      return caps ? deriveCapabilities(caps.initializeResult) : deriveCapabilities({});
    },
    // CONFIG#CAPS is not populated until the bridge initializes, and the CLI
    // version is surfaced there; until then there is no version to report.
    kiroCliVersion: async () => null,
    facade,
    publicBaseUrl,
    obs: new PowertoolsObservability(),
    ...(options.mcp ? { mcp: options.mcp } : {}),
  };

  return ctx;
}
