/**
 * KiroRemote: the single reusable CDK construct that provisions the whole
 * control plane.
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

import { KiroRemoteAuth, type PreRegisteredClientProps } from "@nikovirtala/auth";
import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import { HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import {
  AttributeType,
  BillingMode,
  ProjectionType,
  Table,
  TableEncryption,
} from "aws-cdk-lib/aws-dynamodb";
import { Peer, Port, SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
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
import { Key } from "aws-cdk-lib/aws-kms";
import { Code, Function as LambdaFunction, Runtime } from "aws-cdk-lib/aws-lambda";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { BlockPublicAccess, Bucket, BucketEncryption } from "aws-cdk-lib/aws-s3";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { CfnWebACL, CfnWebACLAssociation } from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";

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

  /** Optional pre-registered public clients passed through to the facade. */
  preRegisteredClients?: PreRegisteredClientProps[];

  /**
   * Override for the bridge container image. When omitted, a lightweight
   * placeholder registry image is used so `cdk synth` runs WITHOUT a Docker
   * build in constrained CI/sandboxes. Production deploys pass
   * `ContainerImage.fromAsset(repoRoot, { file: "packages/bridge/Dockerfile",
   * buildArgs: { KIRO_CLI_VERSION }, platform: Platform.LINUX_ARM64 })`.
   */
  bridgeImage?: ContainerImage;

  /**
   * Override for the API Lambda code. When omitted, a tiny inline placeholder
   * handler is used so `cdk synth` runs WITHOUT a Node bundling step in
   * constrained CI/sandboxes. Production deploys pass a bundled asset whose
   * handler builds the {@link import("@nikovirtala/api").ApiContext} from env
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
  readonly kiroApiKeySecret: Secret;
  /** The Cognito facade (user pool, resource server, facade client). */
  readonly auth: KiroRemoteAuth;
  /** The ECS Fargate bridge service. */
  readonly bridgeService: FargateService;
  /** The HTTP API fronting the api Lambdas at base path /v1. */
  readonly httpApi: HttpApi;
  /** The WAFv2 web ACL protecting the API. */
  readonly webAcl: CfnWebACL;
  /** The OAUTH#CODE callback Lambda. */
  readonly callbackFn: LambdaFunction;
  /** The OAUTH#CODE token Lambda. */
  readonly tokenFn: LambdaFunction;
  /** The main REST/MCP Lambda. */
  readonly apiFn: LambdaFunction;

  constructor(scope: Construct, id: string, props: KiroRemoteProps) {
    super(scope, id);

    const region = Stack.of(this).region;
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
    this.commandQueue = new Queue(this, "CommandQueue.fifo", {
      fifo: true,
      contentBasedDeduplication: true,
      retentionPeriod: Duration.days(4),
      visibilityTimeout: Duration.seconds(60),
      enforceSSL: true,
    });

    /* ------------------------------- Secret ------------------------------ */

    // KIRO_API_KEY (ksk_) lives ONLY in Secrets Manager and is injected into
    // the bridge container as an ECS secret at runtime -- never a plain env
    // var, never baked into the image, never in synthesized output.
    this.kiroApiKeySecret = new Secret(this, "KiroApiKeySecret", {
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
      CIMD_ALLOWED_HOSTS: cimdAllowedHosts.join(","),
      OAUTH_CODE_KMS_KEY_ID: this.oauthCodeKey.keyId,
    };

    // The main REST + /mcp Lambda.
    this.apiFn = new LambdaFunction(this, "ApiFn", {
      runtime: Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambdaCode,
      memorySize: 512,
      timeout: Duration.seconds(29),
      environment: commonEnv,
    });

    // The OAUTH#CODE callback handler (encrypts the Cognito token set).
    this.callbackFn = new LambdaFunction(this, "OAuthCallbackFn", {
      runtime: Runtime.NODEJS_22_X,
      handler: "index.handler",
      code: lambdaCode,
      memorySize: 256,
      timeout: Duration.seconds(29),
      environment: commonEnv,
    });

    // The OAUTH#CODE token handler (decrypts + returns the Cognito tokens).
    this.tokenFn = new LambdaFunction(this, "OAuthTokenFn", {
      runtime: Runtime.NODEJS_22_X,
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

    this.httpApi = new HttpApi(this, "HttpApi", {
      description: "kiro-remote control plane HTTP API",
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

    /* --------------------------------- WAF ------------------------------- */

    this.webAcl = new CfnWebACL(this, "WebAcl", {
      defaultAction: { allow: {} },
      scope: "REGIONAL",
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: "kiroRemoteWebAcl",
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: "RateLimitOAuth",
          priority: 0,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 300,
              aggregateKeyType: "IP",
              scopeDownStatement: {
                byteMatchStatement: {
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: "STARTS_WITH",
                  searchString: "/oauth/",
                  textTransformations: [{ priority: 0, type: "NONE" }],
                },
              },
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "rateLimitOAuth",
            sampledRequestsEnabled: true,
          },
        },
        {
          name: "RateLimitMcp",
          priority: 1,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 600,
              aggregateKeyType: "IP",
              scopeDownStatement: {
                byteMatchStatement: {
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: "STARTS_WITH",
                  searchString: "/mcp",
                  textTransformations: [{ priority: 0, type: "NONE" }],
                },
              },
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: "rateLimitMcp",
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    // Associate the web ACL with the HTTP API's default stage.
    const stage = this.httpApi.defaultStage;
    const stageArn = Stack.of(this).formatArn({
      service: "apigateway",
      resource: "/apis",
      account: "",
      resourceName: `${this.httpApi.apiId}/stages/${stage?.stageName ?? "$default"}`,
    });
    const association = new CfnWebACLAssociation(this, "WebAclAssociation", {
      resourceArn: stageArn,
      webAclArn: this.webAcl.attrArn,
    });
    association.node.addDependency(this.webAcl);

    /* --------------------------- Fargate bridge -------------------------- */

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
      removalPolicy: RemovalPolicy.DESTROY,
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
      },
      // KIRO_API_KEY arrives as an ECS SECRET (not a plain env var).
      secrets: {
        KIRO_API_KEY: EcsSecret.fromSecretsManager(this.kiroApiKeySecret),
      },
      logging: LogDrivers.awsLogs({ streamPrefix: "bridge", logGroup: bridgeLogGroup }),
      // Health check fails if the ACP process has been silent for 60 s: the
      // bridge writes its liveness; the probe times out inside that window.
      healthCheck: {
        command: ["CMD-SHELL", "node packages/bridge/src/cli.ts healthcheck || exit 1"],
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
    this.kiroApiKeySecret.grantRead(taskDef.obtainExecutionRole());

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
}
