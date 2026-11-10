/**
 * KiroRemote: the single reusable CDK construct that provisions the whole
 * control plane.
 *
 * BRIDGE MODE (the deploy-time host selector). The cloud command path can be
 * driven by the persistent ECS Fargate ACP bridge, by a serverless Lambda
 * consumer, or by both -- selected per deploy via {@link BridgeMode} (default
 * `fargate`). Fargate is RETAINED as the ONLY host for the ACP
 * adopt/session-load path; the Lambda path is a parallel, serverless cloud path
 * (SQS FIFO consumer + a CONFIG#CAPS publisher). The operator chooses the mode;
 * the default reproduces today's Fargate-only stack exactly.
 *
 * It wires, as one coherent resource graph:
 *   - the single DynamoDB table (on-demand, PITR on, GSI1, a `ttl` attribute),
 *   - the S3 bucket for oversized prompts/payloads (public access blocked,
 *     SSE encryption, SSL enforced),
 *   - the SQS FIFO command queue (MessageGroupId = sessionId, content-based
 *     dedup),
 *   - a KMS key used ONLY by the OAUTH#CODE callback/token handlers (its grants
 *     are scoped to exactly those two Lambda roles),
 *   - the ECS Fargate bridge service (arm64/Graviton, desiredCount 1, PUBLIC
 *     subnets with a public IP, a security group with NO ingress and egress on
 *     443 ONLY, NO NAT gateway, a task role scoped to its own table/bucket/
 *     queue/secret, KIRO_API_KEY injected as an ECS secret, and a container
 *     health check that fails if the ACP process has been silent for 60 s),
 *   - the API Gateway HTTP API at base path /v1 fronting the api Lambdas,
 *   - a WAFv2 web ACL with rate-based rules on /oauth/* and /mcp, and
 *   - the Cognito facade via the reusable {@link KiroRemoteAuth} construct.
 *
 * NOTHING is hardcoded to a region: the region flows from the enclosing stack's
 * `env`. The canonical `<host>` is a prop (a custom domain or the API Gateway
 * default domain) used consistently for PRM / AS-metadata / resource identifier
 * / CIMD.
 *
 * erasableSyntaxOnly applies: no enums/namespaces/parameter properties; union
 * literals and const objects only.
 */

import { KiroRemoteAuth, type PreRegisteredClientProps } from "@nikovirtala/kiro-remote-auth";
import { Duration, RemovalPolicy, Stack, Validations } from "aws-cdk-lib";
import { type CfnStage, DomainName, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import {
  Certificate,
  CertificateValidation,
  type ICertificate,
} from "aws-cdk-lib/aws-certificatemanager";
import {
  AttributeType,
  BillingMode,
  ProjectionType,
  Table,
  TableEncryption,
} from "aws-cdk-lib/aws-dynamodb";
import { Peer, Port, SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { Repository as EcrRepository } from "aws-cdk-lib/aws-ecr";
import {
  Cluster,
  ContainerImage,
  ContainerInsights,
  CpuArchitecture,
  Secret as EcsSecret,
  FargateService,
  FargateTaskDefinition,
  LogDrivers,
  OperatingSystemFamily,
} from "aws-cdk-lib/aws-ecs";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction as LambdaFunctionTarget } from "aws-cdk-lib/aws-events-targets";
import { Key } from "aws-cdk-lib/aws-kms";
import {
  Architecture,
  Code,
  DockerImageCode,
  DockerImageFunction,
  FilterCriteria,
  FilterRule,
  Function as LambdaFunction,
  Runtime,
  RuntimeFamily,
} from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import {
  AaaaRecord,
  ARecord,
  type IPublicHostedZone,
  PublicHostedZone,
  RecordTarget,
} from "aws-cdk-lib/aws-route53";
import { ApiGatewayv2DomainProperties } from "aws-cdk-lib/aws-route53-targets";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { type ISecret, Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { Trigger } from "aws-cdk-lib/triggers";
import { Construct } from "constructs";

/**
 * Which host(s) drive the cloud command path. Selected per deploy; the default
 * is `fargate` so an omitted prop reproduces today's stack exactly.
 *
 *   - `fargate` (default): the persistent ECS Fargate ACP bridge ONLY. This is
 *     the ONLY host for the ACP adopt/session-load path, so Fargate is RETAINED
 *     deliberately and never removed.
 *   - `lambda`: the serverless cloud path ONLY -- a container-image Lambda
 *     consumes the SQS FIFO queue and a second function publishes CONFIG#CAPS.
 *     `adopt`/session-load is NOT supported in this mode (no live ACP child).
 *   - `both`: provision BOTH hosts (the operator picks per deploy).
 *
 * erasableSyntaxOnly: a union literal, not an enum.
 */
export type BridgeMode = "fargate" | "lambda" | "both";

/** Default bridge mode: Fargate-only, preserving the backward-compatible stack. */
export const DEFAULT_BRIDGE_MODE: BridgeMode = "fargate";

/**
 * The Node.js 26 managed Lambda runtime.
 *
 * WHY a hand-rolled shim instead of `Runtime.NODEJS_26_X`: aws-cdk-lib (as of
 * 2.272.0) does NOT yet ship a `Runtime.NODEJS_26_X` constant -- see the
 * tracking issue aws/aws-cdk#39021. Until that constant lands we construct the
 * runtime directly from its name + family, which is the verbatim interim
 * workaround the issue recommends. SWAP THIS FOR `Runtime.NODEJS_26_X` once a
 * released aws-cdk-lib exposes it (then delete this constant and the
 * `RuntimeFamily` import), so we stop carrying a bespoke Runtime instance.
 *
 * `supportsInlineCode: true` mirrors the real managed Node runtimes: the API
 * construct's DEFAULT code is an inline placeholder (used under placeholder-path
 * synth with no bundler), and CDK refuses inline code on a runtime that does not
 * advertise support for it -- so without this flag `pnpm synth` would fail.
 *
 * PREVIEW CAVEAT (surfaced loudly on purpose): AWS lists `nodejs26.x` as a
 * PUBLIC PREVIEW runtime -- it is NOT covered by the Lambda SLA or AWS Support,
 * is explicitly not recommended for production, and GA is targeted for ~Nov 2026
 * (see the AWS Lambda runtimes docs). We adopt it as the default because the
 * repo's .mise.toml already pins Node 26.13.0 and the stack is meant to run on
 * Node 26, but a production operator should weigh the preview status before
 * deploying.
 */
export const NODEJS_26_X = new Runtime("nodejs26.x", RuntimeFamily.NODEJS, {
  supportsInlineCode: true,
});

/** Default CIMD-allowed host besides the facade's own host. */
export const DEFAULT_CIMD_ALLOWED_HOST = "claude.ai";
/** Default concurrent cloud-session cap (includes IDE/Web usage). */
export const DEFAULT_MAX_CLOUD_SESSIONS = 10;
/** Default event TTL in days. */
export const DEFAULT_EVENT_TTL_DAYS = 30;
/** Default permission-answer window. */
export const DEFAULT_PERMISSION_TIMEOUT = Duration.hours(24);

export interface KiroRemoteProps {
  /**
   * The canonical facade origin WITHOUT a trailing slash, e.g.
   * "https://kiro.example.com". Supplied by the deployer: either a custom
   * domain fronting the HTTP API, or the API Gateway default domain
   * ("https://<api-id>.execute-api.<region>.amazonaws.com"). Used verbatim for
   * the RFC 9728 PRM, the RFC 8414 AS-metadata issuer, the Cognito resource
   * identifier (<host>/mcp), and the CIMD allow-list.
   */
  publicBaseUrl: string;

  /** Cognito managed-login domain prefix (<prefix>.auth.<region>...). */
  cognitoDomainPrefix: string;

  /** GitHub repo glob allow-list the bridge may launch sessions against. */
  allowedRepos: string[];

  /**
   * Extra hosts permitted as CIMD client_id URL hosts. The facade's own host
   * and {@link DEFAULT_CIMD_ALLOWED_HOST} are always included.
   */
  cimdAllowedHosts?: string[];

  /** Concurrent cloud-session cap. Defaults to {@link DEFAULT_MAX_CLOUD_SESSIONS}. */
  maxCloudSessions?: number;

  /** Event TTL in days. Defaults to {@link DEFAULT_EVENT_TTL_DAYS}. */
  eventTtlDays?: number;

  /** Permission-answer window. Defaults to {@link DEFAULT_PERMISSION_TIMEOUT}. */
  permissionTimeout?: Duration;

  /**
   * The kiro-cli version baked into the bridge image via the
   * KIRO_CLI_VERSION build arg. Required when building the image from the
   * Dockerfile; ignored when {@link bridgeImage} is supplied.
   */
  kiroCliVersion?: string;

  /**
   * Which host(s) drive the cloud command path. Defaults to
   * {@link DEFAULT_BRIDGE_MODE} (`fargate`), so omitting it reproduces today's
   * Fargate-only stack exactly. See {@link BridgeMode}.
   *
   * Fargate is RETAINED deliberately: it is the ONLY host for the ACP
   * adopt/session-load path, which the Lambda path does not cover. `lambda`
   * provisions the serverless cloud path (SQS consumer + caps publisher) and
   * NO Fargate service; `both` provisions both so the operator can migrate or
   * run them side by side.
   */
  bridgeMode?: BridgeMode;

  /** Optional pre-registered public clients passed through to the facade. */
  preRegisteredClients?: PreRegisteredClientProps[];

  /**
   * Full ARN of a PRE-EXISTING Secrets Manager secret holding the Kiro API
   * key (ksk_). Strongly recommended for real deploys: the secret is created
   * and populated out of band and survives stack rollback, avoiding the
   * chicken-and-egg where an in-stack (empty) secret is deleted on a failed
   * deploy before it can be populated. When omitted, the construct creates an
   * (empty) secret -- fine for synth/dev, but it must be populated and will be
   * destroyed on rollback.
   */
  kiroApiKeySecretArn?: string;

  /**
   * Optional API Gateway v2 custom domain fronting the HTTP API. When set, the
   * construct creates (or imports) a regional ACM certificate for `domainName`
   * and maps the domain to the HTTP API's default stage.
   *
   * There are two DNS modes, both selected by this one prop:
   *
   *   - **Route 53 (recommended for this repo).** Supply `hostedZoneId` +
   *     `zoneName` for a Route 53 PUBLIC hosted zone (e.g. the one created by
   *     {@link import("./dns-stack.ts").KiroRemoteDnsStack} for a delegated
   *     subdomain). The construct then imports the zone, DNS-validates the ACM
   *     cert AGAINST that zone (an automatic validation record, no manual
   *     CNAME) AND creates alias `A`/`AAAA` records pointing the host at the
   *     API Gateway custom domain. After the one-time NS delegation at the
   *     parent provider, there is NO further manual DNS.
   *   - **Zone-less / manual (fallback).** Omit `hostedZoneId`/`zoneName`. A
   *     DNS-validated cert is created with no hosted zone (ACM emits a
   *     validation CNAME the operator adds at their DNS provider) and the
   *     operator points a CNAME at the emitted regional target themselves. No
   *     Route 53 resources are created. This is the historical behaviour.
   *
   * When the whole prop is omitted, only the API Gateway default
   * `https://<api-id>.execute-api.<region>.amazonaws.com` domain is created
   * (the default-domain path is unchanged). See
   * [`docs/deploy.md`](../../../docs/deploy.md) for the exact flow.
   */
  customDomain?: {
    /** The custom host, e.g. "kiro-remote.example.com". */
    domainName: string;
    /**
     * ARN of an existing regional ACM certificate for `domainName`. When
     * omitted, a new DNS-validated certificate is created (against the Route 53
     * zone when one is supplied, otherwise zone-less so the operator adds the
     * emitted validation CNAME at their DNS provider). Pre-creating the
     * certificate and passing its ARN avoids the deploy blocking on validation.
     */
    certificateArn?: string;
    /**
     * Id of a Route 53 PUBLIC hosted zone that owns `domainName` (typically a
     * delegated subdomain created by
     * {@link import("./dns-stack.ts").KiroRemoteDnsStack}). When set together
     * with {@link zoneName}, the cert is DNS-validated against this zone and
     * alias `A`/`AAAA` records are created in it -- no manual DNS. Omit for the
     * zone-less manual-CNAME fallback.
     */
    hostedZoneId?: string;
    /**
     * Name of the Route 53 hosted zone identified by {@link hostedZoneId}, e.g.
     * "kiro-remote.nikovirtala.dev". Required alongside `hostedZoneId`. When it
     * equals `domainName` the host IS the zone apex and the alias records are
     * created at the apex.
     */
    zoneName?: string;
  };

  /**
   * Override for the bridge container image. When omitted, a lightweight
   * placeholder registry image is used so `cdk synth` runs WITHOUT a Docker
   * build in constrained CI/sandboxes. Production deploys pass
   * `ContainerImage.fromAsset(repoRoot, { file: "packages/bridge/Dockerfile",
   * buildArgs: { KIRO_CLI_VERSION }, platform: Platform.LINUX_ARM64 })`.
   */
  bridgeImage?: ContainerImage;

  /**
   * Override factory for the serverless (Lambda) bridge container image used by
   * the SQS consumer and the caps-publisher functions in `lambda`/`both` modes.
   * It is called ONCE PER FUNCTION with that function's handler `cmd` (so each
   * runs its own entry from the ONE image asset, which CDK dedups by hash).
   * When omitted, a placeholder {@link DockerImageCode} referencing a
   * not-yet-deployed ECR repo is used so `cdk synth` runs WITHOUT a Docker
   * build (same gating as {@link bridgeImage}). Production deploys pass a
   * factory wrapping `DockerImageCode.fromImageAsset(repoRoot, { file:
   * "packages/bridge/Dockerfile.lambda", buildArgs: { KIRO_CLI_VERSION },
   * platform: Platform.LINUX_ARM64, cmd })`.
   */
  lambdaImage?: (cmd: string[]) => DockerImageCode;

  /**
   * Override for the API Lambda code. When omitted, a tiny inline placeholder
   * handler is used so `cdk synth` runs WITHOUT a Node bundling step in
   * constrained CI/sandboxes. Production deploys pass a bundled asset whose
   * handler builds the {@link import("@nikovirtala/kiro-remote-api").ApiContext} from env
   * and calls `createHandler`.
   */
  apiLambdaCode?: Code;
}

/** A placeholder bridge image so synth needs no Docker. Override in prod. */
function placeholderBridgeImage(): ContainerImage {
  return ContainerImage.fromRegistry("public.ecr.aws/amazonlinux/amazonlinux:2023");
}

/** A tiny inline Lambda placeholder so synth needs no bundling. Override in prod. */
function placeholderLambdaCode(): Code {
  return Code.fromInline(
    "export const handler = async () => ({ statusCode: 501, body: 'not wired' });",
  );
}

/**
 * A placeholder {@link DockerImageCode} for the serverless bridge functions so
 * `cdk synth` needs no Docker build in the `lambda`/`both` modes. It references
 * a not-yet-deployed ECR repo by name (the image URI is synthesized but never
 * built/pulled), mirroring how {@link placeholderBridgeImage} keeps the ECS
 * path Docker-free. The `cmd` (the per-function handler) is carried through so
 * the synthesized function still advertises the right handler. Override in prod
 * with a `DockerImageCode.fromImageAsset` factory. The ECR repo is imported
 * once and reused across functions (CDK requires a unique construct id, so the
 * lookup is memoized on the scope's tree).
 */
function placeholderLambdaImage(scope: Construct, cmd: string[]): DockerImageCode {
  const id = "PlaceholderBridgeLambdaRepo";
  const existing = scope.node.tryFindChild(id) as EcrRepository | undefined;
  const repo =
    existing ??
    EcrRepository.fromRepositoryName(scope, id, "kiro-remote-bridge-lambda-placeholder");
  return DockerImageCode.fromEcr(repo, { tagOrDigest: "latest", cmd });
}

export class KiroRemote extends Construct {
  /** The single DynamoDB table. */
  readonly table: Table;
  /** The S3 bucket for oversized prompts/payloads. */
  readonly bucket: Bucket;
  /** The SQS FIFO command queue. */
  readonly commandQueue: Queue;
  /** The KMS key used ONLY by the OAUTH#CODE callback/token handlers. */
  readonly oauthCodeKey: Key;
  /** The Secrets Manager secret holding KIRO_API_KEY (ksk_). */
  readonly kiroApiKeySecret: ISecret;
  /** The Cognito facade (user pool, resource server, facade client). */
  readonly auth: KiroRemoteAuth;
  /** The selected bridge mode (defaults to {@link DEFAULT_BRIDGE_MODE}). */
  readonly bridgeMode: BridgeMode;
  /**
   * The ECS Fargate bridge service. Present only in `fargate`/`both` modes
   * (the default). `undefined` in `lambda`-only mode.
   */
  readonly bridgeService?: FargateService;
  /**
   * The serverless (Lambda) SQS FIFO command consumer. Present only in
   * `lambda`/`both` modes.
   */
  readonly consumerFn?: DockerImageFunction;
  /**
   * The serverless (Lambda) one-shot CONFIG#CAPS publisher. Present only in
   * `lambda`/`both` modes.
   */
  readonly capsPublisherFn?: DockerImageFunction;
  /**
   * The standard (non-FIFO) SQS queue the Lambda consumer uses to finish a
   * turn it detached from near its deadline (delayed `session/load` catch-up
   * messages). Present only in `lambda`/`both` modes.
   */
  readonly catchUpQueue?: Queue;
  /** The HTTP API fronting the api Lambdas at base path /v1. */
  readonly httpApi: HttpApi;
  /**
   * The optional API Gateway v2 custom domain mapped to the HTTP API. Present
   * only when {@link KiroRemoteProps.customDomain} is supplied. Its
   * `regionalDomainName` is the CNAME target the operator points their DNS at.
   */
  readonly customDomainName?: DomainName;
  /** The OAUTH#CODE callback Lambda. */
  readonly callbackFn: LambdaFunction;
  /** The OAUTH#CODE token Lambda. */
  readonly tokenFn: LambdaFunction;
  /** The main REST/MCP Lambda. */
  readonly apiFn: LambdaFunction;

  constructor(scope: Construct, id: string, props: KiroRemoteProps) {
    super(scope, id);

    const region = Stack.of(this).region;
    this.bridgeMode = props.bridgeMode ?? DEFAULT_BRIDGE_MODE;
    const wantFargate = this.bridgeMode === "fargate" || this.bridgeMode === "both";
    const wantLambda = this.bridgeMode === "lambda" || this.bridgeMode === "both";
    const base = props.publicBaseUrl.replace(/\/+$/, "");
    const ownHost = base.replace(/^https?:\/\//, "").split("/")[0];
    const eventTtlDays = props.eventTtlDays ?? DEFAULT_EVENT_TTL_DAYS;
    const maxCloudSessions = props.maxCloudSessions ?? DEFAULT_MAX_CLOUD_SESSIONS;
    const permissionTimeout = props.permissionTimeout ?? DEFAULT_PERMISSION_TIMEOUT;
    const cimdAllowedHosts = Array.from(
      new Set([DEFAULT_CIMD_ALLOWED_HOST, ownHost, ...(props.cimdAllowedHosts ?? [])]),
    );

    /* --------------------------- DynamoDB table -------------------------- */

    // Single table: PK/SK string keys (matches core's repository). On-demand
    // billing, PITR on, a `ttl` attribute for event/OAuth expiry, and GSI1
    // (GSI1PK/GSI1SK) for the per-user session index.
    this.table = new Table(this, "Table", {
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      encryption: TableEncryption.AWS_MANAGED,
      timeToLiveAttribute: "ttl",
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.table.addGlobalSecondaryIndex({
      indexName: "GSI1",
      partitionKey: { name: "GSI1PK", type: AttributeType.STRING },
      sortKey: { name: "GSI1SK", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    /* ------------------------------- Bucket ------------------------------ */

    this.bucket = new Bucket(this, "PayloadBucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    /* ---------------------------- Command queue -------------------------- */

    // FIFO queue; the producer sets MessageGroupId = sessionId to preserve
    // per-session ordering. Content-based dedup avoids a separate dedup id.
    //
    // VISIBILITY TIMEOUT. The Fargate path long-polls and acks quickly, so 60s
    // is plenty. The Lambda SQS event-source mapping, however, REQUIRES the
    // source queue's visibility timeout to be at least the consumer function's
    // timeout (the consumer AWAITs a whole cloud turn, up to its 15-minute
    // ceiling) -- otherwise a message would become visible again mid-turn and
    // be redelivered. So the visibility timeout is 15 minutes ONLY when the
    // Lambda path is enabled; in the default Fargate-only stack it stays 60s so
    // the template is byte-for-byte unchanged.
    this.commandQueue = new Queue(this, "CommandQueue.fifo", {
      fifo: true,
      contentBasedDeduplication: true,
      retentionPeriod: Duration.days(4),
      visibilityTimeout: wantLambda ? Duration.minutes(15) : Duration.seconds(60),
      enforceSSL: true,
    });

    /* ------------------------------- Secret ------------------------------ */

    // KIRO_API_KEY (ksk_) lives ONLY in Secrets Manager and is injected into
    // the bridge container as an ECS secret at runtime -- never a plain env
    // var, never baked into the image, never in synthesized output.
    //
    // Prefer a PRE-EXISTING secret referenced by its full ARN: it is created
    // and populated out of band and survives stack rollback, so a failed
    // deploy cannot delete the key before it can be populated. The created
    // fallback (no ARN) keeps today's synth/dev behaviour but is destroyed on
    // rollback, so it must be populated out of band and is NOT recommended for
    // real deploys.
    this.kiroApiKeySecret = props.kiroApiKeySecretArn
      ? Secret.fromSecretCompleteArn(this, "KiroApiKeySecret", props.kiroApiKeySecretArn)
      : new Secret(this, "KiroApiKeySecret", {
          description: "Kiro API key (ksk_) injected into the bridge as an ECS secret",
        });

    /* ------------------------------- KMS key ----------------------------- */

    // Used ONLY to envelope-encrypt the one-time OAUTH#CODE token set. Grants
    // are added below for EXACTLY the callback (encrypt) and token (decrypt)
    // Lambda roles -- nothing else can use this key.
    this.oauthCodeKey = new Key(this, "OAuthCodeKey", {
      description: "Envelope key for the one-time OAUTH#CODE token set",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    /* ----------------------------- Cognito auth -------------------------- */

    this.auth = new KiroRemoteAuth(this, "Auth", {
      publicBaseUrl: base,
      cognitoDomainPrefix: props.cognitoDomainPrefix,
      ...(props.preRegisteredClients ? { preRegisteredClients: props.preRegisteredClients } : {}),
    });

    /* ------------------------------- Lambdas ----------------------------- */

    const lambdaCode = props.apiLambdaCode ?? placeholderLambdaCode();
    const commonEnv: Record<string, string> = {
      TABLE_NAME: this.table.tableName,
      BUCKET_NAME: this.bucket.bucketName,
      COMMAND_QUEUE_URL: this.commandQueue.queueUrl,
      PUBLIC_BASE_URL: base,
      MCP_RESOURCE: `${base}/mcp`,
      COGNITO_USER_POOL_ID: this.auth.userPool.userPoolId,
      COGNITO_CLIENT_ID: this.auth.facadeClient.userPoolClientId,
      // The Cognito managed-login domain base URL. The API Lambda derives the
      // OAuth token/revocation endpoints (<domain>/oauth2/token, /oauth2/revoke)
      // from it for the facade's authorization-code / refresh / revoke calls.
      COGNITO_DOMAIN: this.auth.managedLoginDomain.baseUrl(),
      CIMD_ALLOWED_HOSTS: cimdAllowedHosts.join(","),
      OAUTH_CODE_KMS_KEY_ID: this.oauthCodeKey.keyId,
      // The launch allow-list the service layer enforces (owner/name globs).
      ALLOWED_REPOS: props.allowedRepos.join(","),
    };

    // Propagate the pre-registered (non-CIMD) clients the auth construct
    // provisions so the API Lambda's ClientResolver accepts them at
    // /oauth/authorize. The `client_id` a pre-registered client presents is its
    // logical `name` (the authorize flow always uses the single facade client
    // for the upstream Cognito call), and its allowed redirect URIs are the
    // prop's `callbackUrls`. Serialized as JSON so the shape is self-describing
    // and matches the resolver's PreRegisteredClient entry. Omitted entirely
    // when there are no pre-registered clients so the env stays clean.
    if (props.preRegisteredClients && props.preRegisteredClients.length > 0) {
      commonEnv.PREREGISTERED_CLIENTS = JSON.stringify(
        props.preRegisteredClients.map((c) => ({
          clientId: c.name,
          clientName: c.name,
          redirectUris: c.callbackUrls,
        })),
      );
    }

    // The main REST + /mcp Lambda.
    this.apiFn = new LambdaFunction(this, "ApiFn", {
      runtime: NODEJS_26_X,
      handler: "index.handler",
      code: lambdaCode,
      memorySize: 512,
      timeout: Duration.seconds(29),
      environment: commonEnv,
    });

    // The OAUTH#CODE callback handler (encrypts the Cognito token set).
    this.callbackFn = new LambdaFunction(this, "OAuthCallbackFn", {
      runtime: NODEJS_26_X,
      handler: "index.handler",
      code: lambdaCode,
      memorySize: 256,
      timeout: Duration.seconds(29),
      environment: commonEnv,
    });

    // The OAUTH#CODE token handler (decrypts + returns the Cognito tokens).
    this.tokenFn = new LambdaFunction(this, "OAuthTokenFn", {
      runtime: NODEJS_26_X,
      handler: "index.handler",
      code: lambdaCode,
      memorySize: 256,
      timeout: Duration.seconds(29),
      environment: commonEnv,
    });

    // Data-plane grants. The API Lambda reads/writes the table + bucket and
    // enqueues commands; the OAuth handlers read/write the table (TX/CODE
    // items) only.
    this.table.grantReadWriteData(this.apiFn);
    this.bucket.grantReadWrite(this.apiFn);
    this.commandQueue.grantSendMessages(this.apiFn);
    this.table.grantReadWriteData(this.callbackFn);
    this.table.grantReadWriteData(this.tokenFn);

    // KMS: the key is usable by EXACTLY the two OAuth handler roles. The
    // callback encrypts; the token handler decrypts. No other principal.
    this.oauthCodeKey.grantEncrypt(this.callbackFn);
    this.oauthCodeKey.grantDecrypt(this.tokenFn);

    /* --------------------------- HTTP API (/v1) -------------------------- */

    const integration = new HttpLambdaIntegration("ApiIntegration", this.apiFn);
    const callbackIntegration = new HttpLambdaIntegration("CallbackIntegration", this.callbackFn);
    const tokenIntegration = new HttpLambdaIntegration("TokenIntegration", this.tokenFn);

    // Optional API Gateway v2 custom domain. Created before the HttpApi so it
    // can be wired as the default-stage domain mapping. The certificate is
    // regional (same stack region as the HTTP API) -- correct for an apigw v2
    // regional custom domain. DNS records live at the operator's DNS provider.
    if (props.customDomain) {
      const { domainName, certificateArn, hostedZoneId, zoneName } = props.customDomain;

      // When a Route 53 hosted zone is supplied (id + name), import it so the
      // cert can be DNS-validated against it and alias records created in it.
      const hostedZone: IPublicHostedZone | undefined =
        hostedZoneId && zoneName
          ? PublicHostedZone.fromHostedZoneAttributes(this, "ApiHostedZone", {
              hostedZoneId,
              zoneName,
            })
          : undefined;

      const certificate: ICertificate = certificateArn
        ? Certificate.fromCertificateArn(this, "ApiCertificate", certificateArn)
        : new Certificate(this, "ApiCertificate", {
            domainName,
            // With a hosted zone: validate against it (an automatic validation
            // record, no manual CNAME). Without one: zone-less DNS validation
            // -- ACM emits a validation CNAME the operator adds at their DNS
            // provider (Cloudflare, "DNS only").
            validation: hostedZone
              ? CertificateValidation.fromDns(hostedZone)
              : CertificateValidation.fromDns(),
          });
      this.customDomainName = new DomainName(this, "ApiDomainName", {
        domainName,
        certificate,
      });

      // With a hosted zone we also own DNS: create alias A/AAAA records that
      // point the host at the API Gateway regional custom domain. The scoped
      // subdomain IS the zone apex, so when domainName === zoneName the records
      // are created at the apex (omit recordName); otherwise a sub-record.
      if (hostedZone) {
        const aliasTarget = RecordTarget.fromAlias(
          new ApiGatewayv2DomainProperties(
            this.customDomainName.regionalDomainName,
            this.customDomainName.regionalHostedZoneId,
          ),
        );
        const recordName = domainName === zoneName ? undefined : domainName;
        new ARecord(this, "ApiAliasA", {
          zone: hostedZone,
          ...(recordName ? { recordName } : {}),
          target: aliasTarget,
        });
        new AaaaRecord(this, "ApiAliasAaaa", {
          zone: hostedZone,
          ...(recordName ? { recordName } : {}),
          target: aliasTarget,
        });
      }
    }

    this.httpApi = new HttpApi(this, "HttpApi", {
      description: "kiro-remote control plane HTTP API",
      // Map the custom domain to the default stage when one is configured.
      ...(this.customDomainName
        ? { defaultDomainMapping: { domainName: this.customDomainName } }
        : {}),
    });

    // The REST surface and the MCP transport live under /v1 and /mcp.
    this.httpApi.addRoutes({
      path: "/v1/{proxy+}",
      methods: [HttpMethod.ANY],
      integration,
    });
    this.httpApi.addRoutes({ path: "/mcp", methods: [HttpMethod.ANY], integration });
    this.httpApi.addRoutes({
      path: "/.well-known/{proxy+}",
      methods: [HttpMethod.GET],
      integration,
    });
    this.httpApi.addRoutes({ path: "/openapi.json", methods: [HttpMethod.GET], integration });
    // The OAuth facade endpoints route to their dedicated KMS-scoped handlers.
    this.httpApi.addRoutes({
      path: "/oauth/callback",
      methods: [HttpMethod.GET],
      integration: callbackIntegration,
    });
    this.httpApi.addRoutes({
      path: "/oauth/token",
      methods: [HttpMethod.POST],
      integration: tokenIntegration,
    });
    this.httpApi.addRoutes({
      path: "/oauth/{proxy+}",
      methods: [HttpMethod.ANY],
      integration,
    });

    /* --------------------------- Rate limiting --------------------------- */

    // Native API Gateway v2 stage throttling on the HTTP API's default stage.
    //
    // WAFv2 cannot be associated with an API Gateway v2 (HTTP API) stage: the
    // `AWS::WAFv2::WebACLAssociation` resource only supports REST (v1) API
    // stages, not `/apis/<id>/stages/<stage>` HTTP API ARNs. We therefore
    // preserve the rate-limiting intent with the API's built-in throttling.
    //
    // NOTE: these are STAGE-WIDE limits (steady-state requests/second + burst
    // across all callers and routes), NOT the per-IP, per-path rate rules the
    // previous WAFv2 web ACL enforced. True per-IP/path WAF rules require
    // fronting the HTTP API with CloudFront + a WAFv2 web ACL, which is a
    // documented future option.
    const defaultStage = this.httpApi.defaultStage?.node.defaultChild as CfnStage;
    defaultStage.defaultRouteSettings = {
      throttlingRateLimit: 50,
      throttlingBurstLimit: 100,
    };

    /* --------------------------- Fargate bridge -------------------------- */

    // Provisioned in `fargate` (the default) and `both` modes. Fargate is the
    // ONLY host for the ACP adopt/session-load path, so it is RETAINED even
    // when the Lambda path is also enabled. In `lambda`-only mode none of the
    // VPC/cluster/task/service below is created.
    if (wantFargate) {
      // A VPC with ONLY public subnets and NO NAT gateways. The bridge runs with
      // a public IP and reaches AWS APIs / kiro.dev over egress-443-only.
      const vpc = new Vpc(this, "BridgeVpc", {
        maxAzs: 2,
        natGateways: 0,
        subnetConfiguration: [{ name: "public", subnetType: SubnetType.PUBLIC, cidrMask: 24 }],
      });

      const bridgeSg = new SecurityGroup(this, "BridgeSg", {
        vpc,
        allowAllOutbound: false,
        description: "Bridge task SG: no ingress, egress 443 only",
      });
      // Egress on 443 ONLY (HTTPS to AWS APIs + kiro.dev); NO ingress at all.
      bridgeSg.addEgressRule(Peer.anyIpv4(), Port.tcp(443), "HTTPS egress only");

      const cluster = new Cluster(this, "BridgeCluster", {
        vpc,
        containerInsightsV2: ContainerInsights.ENABLED,
      });

      const taskDef = new FargateTaskDefinition(this, "BridgeTask", {
        cpu: 512,
        memoryLimitMiB: 1024,
        runtimePlatform: {
          cpuArchitecture: CpuArchitecture.ARM64,
          operatingSystemFamily: OperatingSystemFamily.LINUX,
        },
      });

      const bridgeLogGroup = new LogGroup(this, "BridgeLogs", {
        retention: RetentionDays.ONE_MONTH,
        // RETAIN so a failed-stack rollback (e.g. the ECS deployment circuit
        // breaker tripping) does NOT delete the container logs -- otherwise the
        // diagnostics for the very failure that caused the rollback are lost
        // ("No CloudWatch Logs found").
        removalPolicy: RemovalPolicy.RETAIN,
      });

      taskDef.addContainer("bridge", {
        image: props.bridgeImage ?? placeholderBridgeImage(),
        command: ["serve"],
        environment: {
          TABLE_NAME: this.table.tableName,
          BUCKET_NAME: this.bucket.bucketName,
          COMMAND_QUEUE_URL: this.commandQueue.queueUrl,
          AWS_REGION: region,
          MAX_CLOUD_SESSIONS: String(maxCloudSessions),
          EVENT_TTL_DAYS: String(eventTtlDays),
          PERMISSION_TIMEOUT_MS: String(permissionTimeout.toMilliseconds()),
          ALLOWED_REPOS: props.allowedRepos.join(","),
          // Verbose by default while the ACP child's startup is being
          // diagnosed: the bridge logger honors BRIDGE_LOG_LEVEL, and serve.ts
          // passes KIRO_LOG_LEVEL=debug into the spawned kiro-cli so its own
          // stderr diagnostics surface (the transport logs the stderr tail at
          // ERROR on a non-zero exit). Dial both back to "info" once stable.
          BRIDGE_LOG_LEVEL: "debug",
          KIRO_LOG_LEVEL: "debug",
        },
        // KIRO_API_KEY arrives as an ECS SECRET (not a plain env var).
        secrets: {
          KIRO_API_KEY: EcsSecret.fromSecretsManager(this.kiroApiKeySecret),
        },
        logging: LogDrivers.awsLogs({ streamPrefix: "bridge", logGroup: bridgeLogGroup }),
        // Cheap liveness probe: a bare Node exec that only proves the container's
        // Node runtime is responsive. It deliberately does NOT invoke the bridge
        // CLI -- the old `node packages/bridge/src/cli.ts healthcheck` both hit
        // the node_modules .ts type-strip crash and called a `healthcheck`
        // subcommand the CLI does not implement (cli.ts exits 2 on unknown
        // commands). This matches the Dockerfile HEALTHCHECK's intent.
        healthCheck: {
          command: ["CMD-SHELL", 'node -e "process.exit(0)" || exit 1'],
          interval: Duration.seconds(30),
          timeout: Duration.seconds(5),
          retries: 2,
          startPeriod: Duration.seconds(20),
        },
      });

      // Task-role grants: scoped to its OWN table/bucket/queue/secret only.
      this.table.grantReadWriteData(taskDef.taskRole);
      this.bucket.grantReadWrite(taskDef.taskRole);
      this.commandQueue.grantConsumeMessages(taskDef.taskRole);
      this.kiroApiKeySecret.grantRead(taskDef.taskRole);
      // The execution role needs to pull the secret to inject it at start.
      const executionRole = taskDef.obtainExecutionRole();
      this.kiroApiKeySecret.grantRead(executionRole);
      // Scoped to the execution role only (not the stack): with an ECR asset
      // image, CDK grants ecr:GetAuthorizationToken on "*", an action that does
      // not support resource-level permissions. Image pulls stay scoped to the
      // asset repository.
      Validations.of(executionRole).acknowledge({
        id: "AwsSolutions-IAM5[Resource::*]",
        reason:
          "ecr:GetAuthorizationToken does not support resource-level permissions and must use Resource '*' (https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonelasticcontainerregistry.html); ECR pull actions remain scoped to the CDK asset repository.",
      });

      this.bridgeService = new FargateService(this, "BridgeService", {
        cluster,
        taskDefinition: taskDef,
        desiredCount: 1,
        assignPublicIp: true,
        vpcSubnets: { subnetType: SubnetType.PUBLIC },
        securityGroups: [bridgeSg],
        minHealthyPercent: 0,
        maxHealthyPercent: 100,
        // Fail fast on repeated task start-up failures (and roll back).
        circuitBreaker: { rollback: true },
      });
    }

    /* ------------------------- Serverless (Lambda) bridge ---------------- */

    // Provisioned in `lambda` and `both` modes. The serverless cloud path is a
    // container-image Lambda (arm64) that CONSUMES the SAME SQS FIFO command
    // queue the API Lambda produces to, plus a second function that publishes
    // CONFIG#CAPS (the one-shot job the persistent ACP bridge did at boot).
    // Both start kiro-cli's bundled engine (KAS) directly from /opt/kiro; the
    // runtime image carries no kiro-cli (its engine spawn calls
    // prctl(PR_SET_PDEATHSIG), which Lambda rejects). A standard catch-up queue
    // lets the consumer finish turns that outlive one invocation. NOTHING here
    // is created in `fargate`-only mode, so the default stack is unchanged.
    if (wantLambda) {
      // One image carries BOTH handlers; each function selects its handler via
      // the image CMD. Gated behind the `-c kiroCliVersion` opt-in exactly like
      // the ECS image: with no flag the placeholder DockerImageCode is used and
      // synth needs no Docker. The factory is called once per function with the
      // handler cmd so each runs its own entry from the ONE image asset.
      const CONSUMER_CMD = ["lambda-consumer.handler"];
      const CAPS_CMD = ["caps-publisher.handler"];
      const buildLambdaImage = (cmd: string[]): DockerImageCode =>
        props.lambdaImage ? props.lambdaImage(cmd) : placeholderLambdaImage(this, cmd);

      // The serverless bridge env mirrors the Fargate task env MINUS the knobs
      // that only make sense for a long-running host. CRITICALLY, AWS_REGION is
      // a RESERVED Lambda environment variable and MUST NOT be set here (the
      // handlers read the region from the ambient Lambda env / AWS SDK default).
      // KIRO_API_KEY is NOT a plain env var: the functions resolve it at RUNTIME
      // from Secrets Manager via KIRO_API_KEY_SECRET_ARN (resolveKiroApiKey),
      // and the function roles are granted read on that exact secret below.
      const bridgeLambdaEnv: Record<string, string> = {
        TABLE_NAME: this.table.tableName,
        BUCKET_NAME: this.bucket.bucketName,
        EVENT_TTL_DAYS: String(eventTtlDays),
        ALLOWED_REPOS: props.allowedRepos.join(","),
        KIRO_API_KEY_SECRET_ARN: this.kiroApiKeySecret.secretArn,
        KIRO_LOG_LEVEL: "debug",
        BRIDGE_LOG_LEVEL: "debug",
      };

      // Catch-up queue: a STANDARD (non-FIFO) queue, because a FIFO queue cannot
      // delay a single message. When a turn is still running ~90 s before the
      // consumer's deadline, the consumer detaches (the cloud turn keeps running
      // in Kiro's sandbox, META stays `running`) and sends a catch-up message
      // here with a 60 s delay. Each catch-up run starts a fresh engine, does
      // one remote `session/load`, appends the events the log is missing, and
      // either settles the turn on `turn_end` or re-schedules itself; after 6 h
      // the turn is failed. Visibility must be >= the consumer's 15-minute
      // timeout, as the event-source mapping requires.
      this.catchUpQueue = new Queue(this, "CatchUpQueue", {
        retentionPeriod: Duration.days(1),
        visibilityTimeout: Duration.minutes(15),
        enforceSSL: true,
      });

      // The SQS FIFO command consumer. 15-minute timeout (the ceiling): a turn
      // is AWAITed in the invocation (holding the FIFO MessageGroupId =
      // sessionId) until it ends or the invocation nears its deadline, at which
      // point it detaches and hands off to the catch-up queue
      // (lambda-consumer.ts). arm64 to match the Graviton image.
      //
      // CONCURRENCY: maxCloudSessions maps to the function's RESERVED
      // CONCURRENCY. Because the queue is FIFO and the producer sets
      // MessageGroupId = sessionId, SQS already serializes per session; the
      // reserved concurrency caps the number of DISTINCT sessions processed in
      // parallel to the same global cap the Fargate host enforces in-process.
      this.consumerFn = new DockerImageFunction(this, "BridgeConsumerFn", {
        code: buildLambdaImage(CONSUMER_CMD),
        architecture: Architecture.ARM_64,
        memorySize: 1024,
        timeout: Duration.minutes(15),
        reservedConcurrentExecutions: maxCloudSessions,
        environment: {
          ...bridgeLambdaEnv,
          // WORKSPACE_ROOT defaults to /workspace in the ECS image; on Lambda
          // only /tmp is writable, so the per-turn working directory lives
          // under it (durable state is in DynamoDB/S3, never on local disk).
          WORKSPACE_ROOT: "/tmp/workspace",
          // Consumer only: the caps publisher never detaches a turn.
          CATCH_UP_QUEUE_URL: this.catchUpQueue.queueUrl,
        },
      });

      // Native SQS event-source mapping on the command queue. FIFO-appropriate
      // batchSize of 1 so each invocation handles a single command (the handler
      // AWAITs settlement); reportBatchItemFailures honors the handler's
      // returned batchItemFailures so only genuinely transient failures are
      // redelivered (lambda-consumer.ts).
      //
      // ADOPT ROUTING IN `both` MODE. Fargate is retained as the ONLY host for
      // the ACP `adopt`/session-load path, but both hosts consume this ONE FIFO
      // queue and SQS delivers each message to exactly one consumer. Without a
      // filter the Lambda consumer could grab an `adopt` command first and
      // reject it, defeating the whole reason Fargate is kept. So in `both`
      // mode we attach an event-source FILTER that makes the Lambda consumer
      // IGNORE `adopt` (kind != "adopt"): a filtered-out record is never
      // delivered to the Lambda, stays on the queue, and is therefore picked up
      // by the Fargate intake loop -- which honors it via the ACP gateway. This
      // makes the "adopt goes to Fargate" guarantee actually hold.
      //
      // In `lambda`-ONLY mode there is NO Fargate to consume a filtered-out
      // adopt, so we deliberately do NOT filter: the consumer still receives
      // `adopt` and rejects it LOUDLY (a client-visible rejection event in
      // lambda-consumer.ts), rather than letting the message sit unconsumed and
      // silently expire. `lambda`-only still does not support adopt; it just
      // fails it visibly instead of silently.
      const wantAdoptFilter = this.bridgeMode === "both";
      this.consumerFn.addEventSource(
        new SqsEventSource(this.commandQueue, {
          batchSize: 1,
          reportBatchItemFailures: true,
          ...(wantAdoptFilter
            ? {
                filters: [FilterCriteria.filter({ body: { kind: FilterRule.notEquals("adopt") } })],
              }
            : {}),
        }),
      );

      // Second mapping: the catch-up queue feeds the SAME handler (it tells a
      // catch-up body apart by `kind: "catchUp"`). No filter in any mode:
      // Fargate never polls this queue, so every message is the consumer's.
      this.consumerFn.addEventSource(
        new SqsEventSource(this.catchUpQueue, {
          batchSize: 1,
          reportBatchItemFailures: true,
        }),
      );

      // The caps-publisher runs the SAME image with a different handler CMD.
      // It is short-lived: start the bundled engine, `initialize`, write
      // CONFIG#CAPS, exit. A few minutes of timeout is ample.
      this.capsPublisherFn = new DockerImageFunction(this, "BridgeCapsPublisherFn", {
        code: buildLambdaImage(CAPS_CMD),
        architecture: Architecture.ARM_64,
        memorySize: 1024,
        timeout: Duration.minutes(5),
        environment: bridgeLambdaEnv,
      });

      // SAME scoped IAM grants the Fargate task role gets, so the serverless
      // path is behaviorally identical: read/write the table + bucket, consume
      // the command queue, read the secret. The consumer also sends to and
      // consumes the catch-up queue. The publisher only needs table write +
      // secret read (it writes CONFIG#CAPS and starts the engine).
      this.table.grantReadWriteData(this.consumerFn);
      this.bucket.grantReadWrite(this.consumerFn);
      this.commandQueue.grantConsumeMessages(this.consumerFn);
      this.catchUpQueue.grantSendMessages(this.consumerFn);
      this.catchUpQueue.grantConsumeMessages(this.consumerFn);
      this.kiroApiKeySecret.grantRead(this.consumerFn);

      this.table.grantReadWriteData(this.capsPublisherFn);
      this.kiroApiKeySecret.grantRead(this.capsPublisherFn);

      // Publish CONFIG#CAPS on a schedule so a transient failure self-heals on
      // the next run; the API serves the empty-caps fallback until the first
      // success (matching docs/deploy.md's CONFIG#CAPS caveat).
      new Rule(this, "CapsPublisherSchedule", {
        schedule: Schedule.rate(Duration.hours(6)),
        targets: [new LambdaFunctionTarget(this.capsPublisherFn)],
      });

      // Run the publisher at least once right after deploy (a CDK Trigger =
      // a custom resource that invokes the function on stack create/update), so
      // CONFIG#CAPS is populated without waiting for the first scheduled run.
      new Trigger(this, "CapsPublisherDeployTrigger", {
        handler: this.capsPublisherFn,
        // Best-effort: a failed publish must not fail the deploy, since the
        // scheduled rule (and the API's empty-caps fallback) cover the gap.
        executeOnHandlerChange: true,
      });
    }
  }
}
