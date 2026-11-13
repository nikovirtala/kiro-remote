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
 *   - the Lambda bridge: three container-image functions (arm64) built from
 *     one image -- an SQS consumer that drives cloud sessions over ACP against
 *     kiro-cli's bundled engine, a durable catch-up function for turns that
 *     outlive one consumer invocation, and a CONFIG#CAPS publisher run on
 *     deploy and every 6 h. Their roles are scoped to this construct's own
 *     resources and read the KIRO_API_KEY secret at runtime,
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
import { Annotations, Duration, RemovalPolicy } from "aws-cdk-lib";
import { type CfnStage, DomainName, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import {
  Certificate,
  CertificateValidation,
  type ICertificate,
} from "aws-cdk-lib/aws-certificatemanager";
import { UserPoolEmail } from "aws-cdk-lib/aws-cognito";
import {
  AttributeType,
  BillingMode,
  ProjectionType,
  Table,
  TableEncryption,
} from "aws-cdk-lib/aws-dynamodb";
import { Repository as EcrRepository } from "aws-cdk-lib/aws-ecr";
import { Rule, RuleTargetInput, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction as LambdaFunctionTarget } from "aws-cdk-lib/aws-events-targets";
import {
  ManagedPolicy,
  Policy,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { Key } from "aws-cdk-lib/aws-kms";
import {
  Alias,
  Architecture,
  Code,
  DockerImageCode,
  DockerImageFunction,
  Function as LambdaFunction,
  Runtime,
  RuntimeFamily,
} from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
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
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { Trigger } from "aws-cdk-lib/triggers";
import { Construct } from "constructs";

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
/**
 * Memory for every Node.js Lambda function (API, OAuth, bridge consumer and
 * caps publisher). The OAuth callback ran out of memory at 256 MB.
 */
export const LAMBDA_MEMORY_MB = 2048;

/**
 * The bridge gives up on a detached turn this long after it detached
 * (CATCH_UP_MAX_AGE_MS in packages/bridge/src/catch-up.ts; the CDK package does
 * not import the bridge, so keep the two in step).
 */
export const CATCH_UP_MAX_AGE_HOURS = 6;

/**
 * Margin added to the durable execution timeout so the code's own 6 h expiry
 * check (which fails the turn cleanly) always fires before the platform
 * times the execution out.
 */
export const CATCH_UP_EXECUTION_MARGIN_MINUTES = 30;

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

  /**
   * SES sender for the user pool (e.g. "no-reply@example.com"). Cognito's
   * default sender does not deliver the email one-time code that invited
   * users sign in with, so set this for a usable invite-only bootstrap. The
   * address (or its domain) must be verified in SES in the stack's region.
   * When omitted, Cognito's default sender is used and synth warns.
   */
  sesFromEmail?: string;

  /** SES verified domain for {@link sesFromEmail}, when it differs from the address's domain. */
  sesVerifiedDomain?: string;

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

  /**
   * The kiro-cli version baked into the Lambda bridge image via the
   * KIRO_CLI_VERSION build arg. The construct itself does not read it: the
   * caller's {@link lambdaImage} factory passes it to the image build.
   */
  kiroCliVersion?: string;

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
   * Override factory for the Lambda bridge container image used by the SQS
   * consumer and the caps-publisher functions. It is called ONCE PER FUNCTION
   * with that function's handler `cmd` (so each runs its own entry from the ONE
   * image asset, which CDK dedups by hash). When omitted, a placeholder
   * {@link DockerImageCode} referencing a not-yet-deployed ECR repo is used so
   * `cdk synth` runs WITHOUT a Docker build in constrained CI/sandboxes.
   * Production deploys pass a factory wrapping `DockerImageCode.fromImageAsset(repoRoot, { file:
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

  /**
   * Full ARN of a Secrets Manager secret holding the GitHub App credentials as
   * JSON: `{ "appId": "...", "privateKey": "-----BEGIN ...", "webhookSecret": "..." }`
   * (see docs/github.md). OPTIONAL: when absent the whole GitHub feature is
   * off and NOTHING is deployed for it (no route, queues, functions or
   * schedule, and the bridge keeps its original behaviour). When present, only
   * the webhook and consumer functions can read it.
   */
  githubAppSecretArn?: string;

  /**
   * GitHub logins whose review/comment text may be quoted to the agent. When
   * empty, the owner of the repo an event is about (the App installation
   * owner) is trusted.
   */
  githubTrustedLogins?: string[];

  /**
   * The Kiro agent's own GitHub identities (its comments never wake a
   * session). Set it to also require that a trailer-linked PR is authored by
   * the agent.
   */
  githubAgentLogins?: string[];

  /**
   * Ask the agent (one line appended to the launch prompt) to put a
   * `Kiro-Remote-Session: <id>` trailer in its PR body. Defaults to "on": the
   * trailer is the link method that does not depend on the PR URL appearing in
   * the event log (see docs/github.md).
   */
  githubPrTrailer?: "on" | "off";

  /** "after_turn" deletes the session once the post-merge wake turn completes. Defaults to "off". */
  githubAutoCloseOnMerge?: "off" | "after_turn";

  /** Bundled code for the webhook ingress function. Defaults to an inline placeholder (synth only). */
  githubWebhookCode?: Code;

  /** Bundled code for the GitHub consumer function. Defaults to an inline placeholder (synth only). */
  githubConsumerCode?: Code;
}

/** A tiny inline Lambda placeholder so synth needs no bundling. Override in prod. */
function placeholderLambdaCode(): Code {
  return Code.fromInline(
    "export const handler = async () => ({ statusCode: 501, body: 'not wired' });",
  );
}

/**
 * A placeholder {@link DockerImageCode} for the bridge functions so `cdk synth`
 * needs no Docker build. It references a not-yet-deployed ECR repo by name (the
 * image URI is synthesized but never built/pulled). The `cmd` (the
 * per-function handler) is carried through so
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
  /** The bridge's SQS FIFO command consumer (container-image Lambda). */
  readonly consumerFn: DockerImageFunction;
  /** The durable catch-up function (one durable execution per detached turn). */
  readonly catchUpFn: DockerImageFunction;
  /** Alias the consumer invokes to start durable executions. */
  readonly catchUpAlias: Alias;
  /** The bridge's one-shot CONFIG#CAPS publisher (container-image Lambda). */
  readonly capsPublisherFn: DockerImageFunction;
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
  /** GitHub feature (present only when githubAppSecretArn is set): the webhook ingress function. */
  readonly githubWebhookFn?: LambdaFunction;
  /** GitHub feature: the queue consumer (also invoked by the 15-minute redelivery schedule). */
  readonly githubConsumerFn?: LambdaFunction;
  /** GitHub feature: the standard queue of verified deliveries, harvest requests and delayed drains. */
  readonly githubQueue?: Queue;
  /** GitHub feature: the dead-letter queue for the GitHub queue. */
  readonly githubDlq?: Queue;

  constructor(scope: Construct, id: string, props: KiroRemoteProps) {
    super(scope, id);

    const base = props.publicBaseUrl.replace(/\/+$/, "");
    const ownHost = base.replace(/^https?:\/\//, "").split("/")[0];
    const eventTtlDays = props.eventTtlDays ?? DEFAULT_EVENT_TTL_DAYS;
    const maxCloudSessions = props.maxCloudSessions ?? DEFAULT_MAX_CLOUD_SESSIONS;
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
    // VISIBILITY TIMEOUT. The Lambda SQS event-source mapping REQUIRES the
    // source queue's visibility timeout to be at least the consumer function's
    // timeout (the consumer AWAITs a whole cloud turn, up to its 15-minute
    // ceiling) -- otherwise a message would become visible again mid-turn and
    // be redelivered.
    this.commandQueue = new Queue(this, "CommandQueue.fifo", {
      fifo: true,
      contentBasedDeduplication: true,
      retentionPeriod: Duration.days(4),
      visibilityTimeout: Duration.minutes(15),
      enforceSSL: true,
    });

    /* ------------------------------- Secret ------------------------------ */

    // KIRO_API_KEY (ksk_) lives ONLY in Secrets Manager; the bridge functions
    // read it at runtime via KIRO_API_KEY_SECRET_ARN -- never a plain env var,
    // never baked into the image, never in synthesized output.
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
          description: "Kiro API key (ksk_) read by the bridge Lambda functions at runtime",
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

    if (!props.sesFromEmail) {
      Annotations.of(this).addWarningV2(
        "kiro-remote:no-ses-sender",
        "No sesFromEmail set: Cognito's default sender does not deliver the email one-time code invited users sign in with. Set sesFromEmail (SES_FROM_EMAIL).",
      );
    }

    this.auth = new KiroRemoteAuth(this, "Auth", {
      publicBaseUrl: base,
      cognitoDomainPrefix: props.cognitoDomainPrefix,
      ...(props.sesFromEmail
        ? {
            email: UserPoolEmail.withSES({
              fromEmail: props.sesFromEmail,
              ...(props.sesVerifiedDomain ? { sesVerifiedDomain: props.sesVerifiedDomain } : {}),
            }),
          }
        : {}),
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

    // The launch prompt asks the agent for the session trailer only when the
    // GitHub feature is deployed (otherwise the line would be pointless).
    if (props.githubAppSecretArn) {
      commonEnv.GITHUB_PR_TRAILER = props.githubPrTrailer ?? "on";
    }

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
      memorySize: LAMBDA_MEMORY_MB,
      timeout: Duration.seconds(29),
      environment: commonEnv,
    });

    // The OAUTH#CODE callback handler (encrypts the Cognito token set).
    this.callbackFn = new LambdaFunction(this, "OAuthCallbackFn", {
      runtime: NODEJS_26_X,
      handler: "index.handler",
      code: lambdaCode,
      memorySize: LAMBDA_MEMORY_MB,
      timeout: Duration.seconds(29),
      environment: commonEnv,
    });

    // The OAUTH#CODE token handler (decrypts + returns the Cognito tokens).
    this.tokenFn = new LambdaFunction(this, "OAuthTokenFn", {
      runtime: NODEJS_26_X,
      handler: "index.handler",
      code: lambdaCode,
      memorySize: LAMBDA_MEMORY_MB,
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
    // Public redirect to the Cognito managed-login passkey registration page
    // (the invitation email links here; see the router).
    this.httpApi.addRoutes({ path: "/passkeys/add", methods: [HttpMethod.GET], integration });
    this.httpApi.addRoutes({ path: "/passkeys/added", methods: [HttpMethod.GET], integration });
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

    /* ---------------------------- Lambda bridge -------------------------- */

    // The bridge is a container-image Lambda (arm64) that CONSUMES the SAME SQS
    // FIFO command queue the API Lambda produces to, plus a second function
    // that publishes CONFIG#CAPS. Both start kiro-cli's bundled engine (KAS)
    // directly from /opt/kiro; the runtime image carries no kiro-cli (its
    // engine spawn calls prctl(PR_SET_PDEATHSIG), which Lambda rejects). A
    // durable catch-up function finishes turns that outlive one consumer
    // invocation.
    //
    // One image carries BOTH handlers; each function selects its handler via
    // the image CMD. Gated behind the `-c kiroCliVersion` opt-in: with no flag
    // the placeholder DockerImageCode is used and synth needs no Docker. The
    // factory is called once per function with the handler cmd so each runs
    // its own entry from the ONE image asset.
    const CONSUMER_CMD = ["lambda-consumer.handler"];
    const CAPS_CMD = ["caps-publisher.handler"];
    const CATCH_UP_CMD = ["catch-up-durable.handler"];
    const buildLambdaImage = (cmd: string[]): DockerImageCode =>
      props.lambdaImage ? props.lambdaImage(cmd) : placeholderLambdaImage(this, cmd);

    // CRITICALLY, AWS_REGION is a RESERVED Lambda environment variable and MUST
    // NOT be set here (the handlers read the region from the ambient Lambda env
    // / AWS SDK default). KIRO_API_KEY is NOT a plain env var: the functions
    // resolve it at RUNTIME from Secrets Manager via KIRO_API_KEY_SECRET_ARN
    // (resolveKiroApiKey), and the function roles are granted read on that
    // exact secret below. Both log levels are verbose while the engine's
    // behaviour on Lambda is still being diagnosed; dial back to "info" once
    // stable.
    const bridgeLambdaEnv: Record<string, string> = {
      TABLE_NAME: this.table.tableName,
      BUCKET_NAME: this.bucket.bucketName,
      EVENT_TTL_DAYS: String(eventTtlDays),
      ALLOWED_REPOS: props.allowedRepos.join(","),
      KIRO_API_KEY_SECRET_ARN: this.kiroApiKeySecret.secretArn,
      KIRO_LOG_LEVEL: "debug",
      BRIDGE_LOG_LEVEL: "debug",
    };

    // GitHub feature queues. Created only when githubAppSecretArn is set; the
    // bridge needs them to harvest and drain at turn settle.
    const githubEnabled = props.githubAppSecretArn !== undefined;
    if (githubEnabled) {
      // A consumer timeout of 120 s, so visibility is 6x that (AWS guidance).
      this.githubDlq = new Queue(this, "GithubDlq", {
        retentionPeriod: Duration.days(14),
        enforceSSL: true,
        encryption: QueueEncryption.SQS_MANAGED,
      });
      this.githubQueue = new Queue(this, "GithubQueue", {
        retentionPeriod: Duration.days(4),
        visibilityTimeout: Duration.minutes(12),
        enforceSSL: true,
        encryption: QueueEncryption.SQS_MANAGED,
        deadLetterQueue: { queue: this.githubDlq, maxReceiveCount: 5 },
      });
    }

    // The SQS FIFO command consumer. 15-minute timeout (the ceiling): a turn
    // is AWAITed in the invocation (holding the FIFO MessageGroupId =
    // sessionId) until it ends or the invocation nears its deadline, at which
    // point it detaches and starts a durable catch-up execution
    // (lambda-consumer.ts). arm64 to match the Graviton image.
    //
    // CONCURRENCY: maxCloudSessions maps to the function's RESERVED
    // CONCURRENCY. Because the queue is FIFO and the producer sets
    // MessageGroupId = sessionId, SQS already serializes per session; the
    // reserved concurrency caps the number of DISTINCT sessions processed in
    // parallel.
    this.consumerFn = new DockerImageFunction(this, "BridgeConsumerFn", {
      code: buildLambdaImage(CONSUMER_CMD),
      architecture: Architecture.ARM_64,
      memorySize: LAMBDA_MEMORY_MB,
      timeout: Duration.minutes(15),
      reservedConcurrentExecutions: maxCloudSessions,
      environment: {
        ...bridgeLambdaEnv,
        // On Lambda only /tmp is writable, so the per-turn working directory
        // lives under it (durable state is in DynamoDB/S3, never on local
        // disk).
        WORKSPACE_ROOT: "/tmp/workspace",
        // Consumer only: the caps publisher never detaches a turn. Set below,
        // once the alias exists.
        // With the GitHub feature on, the consumer drains wake items and asks
        // the GitHub consumer to harvest PR links when a turn settles. It holds
        // no GitHub credentials.
        ...(this.githubQueue
          ? {
              COMMAND_QUEUE_URL: this.commandQueue.queueUrl,
              GITHUB_QUEUE_URL: this.githubQueue.queueUrl,
            }
          : {}),
      },
    });

    // Native SQS event-source mapping on the command queue. FIFO-appropriate
    // batchSize of 1 so each invocation handles a single command (the handler
    // AWAITs settlement); reportBatchItemFailures honors the handler's
    // returned batchItemFailures so only genuinely transient failures are
    // redelivered (lambda-consumer.ts). There is no filter: the consumer
    // receives every command, including `adopt`, which it rejects with a
    // client-visible event rather than letting it sit on the queue and expire.
    this.consumerFn.addEventSource(
      new SqsEventSource(this.commandQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );

    // The durable catch-up function: same image, its own entry. One durable
    // execution per detached turn polls the cloud turn (session/load) until it
    // ends. The consumer starts it asynchronously (a durable function cannot be
    // an SQS event-source target for longer than 15 minutes in total, and
    // Lambda's recursive loop detection must stay on). It has NO event-source
    // mapping. The function timeout covers one load round only; waits between
    // rounds are suspended by the platform and cost nothing.
    // An explicit role keeps CDK from attaching the broad AWS managed
    // AWSLambdaBasicDurableExecutionRolePolicy (logs and the durable APIs on
    // Resource "*"); the durable APIs are granted below, scoped to this function.
    const catchUpRole = new Role(this, "CatchUpFnRole", {
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSLambdaBasicExecutionRole"),
      ],
    });
    this.catchUpFn = new DockerImageFunction(this, "CatchUpFn", {
      role: catchUpRole,
      code: buildLambdaImage(CATCH_UP_CMD),
      architecture: Architecture.ARM_64,
      memorySize: LAMBDA_MEMORY_MB,
      timeout: Duration.minutes(5),
      // The code gives up (and fails the turn) 6 h after detach; the execution
      // timeout sits above that so the code's check always fires first.
      durableConfig: {
        executionTimeout: Duration.minutes(
          CATCH_UP_MAX_AGE_HOURS * 60 + CATCH_UP_EXECUTION_MARGIN_MINUTES,
        ),
        retentionPeriod: Duration.days(14),
      },
      environment: {
        ...bridgeLambdaEnv,
        WORKSPACE_ROOT: "/tmp/workspace",
        ...(this.githubQueue
          ? {
              COMMAND_QUEUE_URL: this.commandQueue.queueUrl,
              GITHUB_QUEUE_URL: this.githubQueue.queueUrl,
            }
          : {}),
      },
    });

    // Checkpoint and state APIs for durable executions, and nothing else. The
    // execution ARN is qualified with the resolved version, so the resource is
    // `<function-arn>:*`. A standalone Policy (not the role's default policy)
    // avoids a circular dependency: the function depends on the role's default
    // policy, while this policy depends on the function's ARN.
    new Policy(this, "CatchUpDurablePolicy", {
      roles: [catchUpRole],
      statements: [
        new PolicyStatement({
          actions: ["lambda:CheckpointDurableExecution", "lambda:GetDurableExecutionState"],
          resources: [`${this.catchUpFn.functionArn}:*`],
        }),
      ],
    });

    // Durable executions are pinned to the version that started them, so old
    // versions must outlive the deployment that replaced them: RETAIN keeps
    // them when a new version is published. Durable functions require a
    // qualified ARN, hence the alias the consumer invokes.
    const catchUpVersion = this.catchUpFn.currentVersion;
    catchUpVersion.applyRemovalPolicy(RemovalPolicy.RETAIN);
    this.catchUpAlias = new Alias(this, "CatchUpAlias", {
      aliasName: "live",
      version: catchUpVersion,
    });
    this.consumerFn.addEnvironment("CATCH_UP_FUNCTION_ARN", this.catchUpAlias.functionArn);
    // InvokeFunction on the alias ARN only.
    this.catchUpAlias.grantInvoke(this.consumerFn);

    // The caps-publisher runs the SAME image with a different handler CMD.
    // It is short-lived: start the bundled engine, `initialize`, write
    // CONFIG#CAPS, exit. A few minutes of timeout is ample.
    this.capsPublisherFn = new DockerImageFunction(this, "BridgeCapsPublisherFn", {
      code: buildLambdaImage(CAPS_CMD),
      architecture: Architecture.ARM_64,
      memorySize: LAMBDA_MEMORY_MB,
      timeout: Duration.minutes(5),
      environment: bridgeLambdaEnv,
    });

    // Scoped IAM grants: the consumer reads/writes the table + bucket,
    // consumes the command queue, reads the secret, and invokes the catch-up
    // alias (granted above). The publisher only needs table write + secret read
    // (it writes CONFIG#CAPS and starts the engine).
    this.table.grantReadWriteData(this.consumerFn);
    this.bucket.grantReadWrite(this.consumerFn);
    this.commandQueue.grantConsumeMessages(this.consumerFn);
    this.kiroApiKeySecret.grantRead(this.consumerFn);
    if (this.githubQueue) {
      this.commandQueue.grantSendMessages(this.consumerFn);
      this.githubQueue.grantSendMessages(this.consumerFn);
    }

    // The durable catch-up function gets what the consumer needs to load and
    // settle a turn (no command-queue consumption).
    this.table.grantReadWriteData(this.catchUpFn);
    this.bucket.grantReadWrite(this.catchUpFn);
    this.kiroApiKeySecret.grantRead(this.catchUpFn);
    if (this.githubQueue) {
      this.commandQueue.grantSendMessages(this.catchUpFn);
      this.githubQueue.grantSendMessages(this.catchUpFn);
    }

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

    /* ------------------------------ GitHub ------------------------------- */

    if (props.githubAppSecretArn && this.githubQueue) {
      const appSecret = Secret.fromSecretCompleteArn(
        this,
        "GithubAppSecret",
        props.githubAppSecretArn,
      );
      const githubEnv: Record<string, string> = {
        TABLE_NAME: this.table.tableName,
        BUCKET_NAME: this.bucket.bucketName,
        GITHUB_APP_SECRET_ARN: props.githubAppSecretArn,
        GITHUB_QUEUE_URL: this.githubQueue.queueUrl,
        ALLOWED_REPOS: props.allowedRepos.join(","),
      };

      // Ingress: verifies the signature, dedupes, stores and enqueues; returns
      // inside GitHub's 10 s limit (so a 9 s timeout). Reads the App secret.
      const webhookFn = new LambdaFunction(this, "GithubWebhookFn", {
        runtime: NODEJS_26_X,
        handler: "index.handler",
        code: props.githubWebhookCode ?? placeholderLambdaCode(),
        memorySize: 512,
        timeout: Duration.seconds(9),
        environment: githubEnv,
      });
      this.githubWebhookFn = webhookFn;
      this.table.grantReadWriteData(webhookFn);
      this.bucket.grantReadWrite(webhookFn);
      this.githubQueue.grantSendMessages(webhookFn);
      appSecret.grantRead(webhookFn);

      // The route has NO OAuth authentication: the X-Hub-Signature-256 check in
      // the function is the authentication (see SECURITY.md).
      this.httpApi.addRoutes({
        path: "/github/webhook",
        methods: [HttpMethod.POST],
        integration: new HttpLambdaIntegration("GithubWebhookIntegration", webhookFn),
      });

      // Consumer: routes deliveries, links PRs, writes inbox items, drains. Also
      // run by the redelivery schedule, so exactly two functions read the secret.
      const consumerFn = new LambdaFunction(this, "GithubConsumerFn", {
        runtime: NODEJS_26_X,
        handler: "index.handler",
        code: props.githubConsumerCode ?? placeholderLambdaCode(),
        memorySize: 512,
        timeout: Duration.seconds(120),
        environment: {
          ...githubEnv,
          COMMAND_QUEUE_URL: this.commandQueue.queueUrl,
          GITHUB_TRUSTED_LOGINS: (props.githubTrustedLogins ?? []).join(","),
          GITHUB_AGENT_LOGINS: (props.githubAgentLogins ?? []).join(","),
          GITHUB_AUTO_CLOSE_ON_MERGE: props.githubAutoCloseOnMerge ?? "off",
        },
      });
      this.githubConsumerFn = consumerFn;
      this.table.grantReadWriteData(consumerFn);
      this.bucket.grantRead(consumerFn);
      this.commandQueue.grantSendMessages(consumerFn);
      this.githubQueue.grantSendMessages(consumerFn);
      appSecret.grantRead(consumerFn);
      consumerFn.addEventSource(
        new SqsEventSource(this.githubQueue, { batchSize: 5, reportBatchItemFailures: true }),
      );

      // Missed deliveries: GitHub does not retry failed deliveries, so every 15
      // minutes the consumer lists the App's failed deliveries and asks GitHub
      // to redeliver up to 50 of them.
      new Rule(this, "GithubRedeliverySchedule", {
        schedule: Schedule.rate(Duration.minutes(15)),
        targets: [
          new LambdaFunctionTarget(consumerFn, {
            event: RuleTargetInput.fromObject({ kind: "redeliver" }),
          }),
        ],
      });
    }
  }
}
