/**
 * CDK assertion tests for the KiroRemote construct (aws-cdk-lib/assertions).
 *
 * Every test synthesizes the stack offline (no AWS, no Docker: the bridge image
 * defaults to a placeholder ECR reference and the Lambdas to inline
 * placeholders) and asserts the security- and contract-critical properties:
 *   - the table is on-demand + PITR + GSI1 + has a `ttl` TTL attribute,
 *   - the bucket blocks public access and is encrypted,
 *   - the command queue is FIFO,
 *   - the KMS key grants are scoped to EXACTLY the callback/token handler roles,
 *   - there are no ECS or EC2 (VPC) resources,
 *   - the Lambda bridge: two arm64 container-image functions (SQS consumer +
 *     caps publisher), the catch-up queue, the event-source mappings, the caps
 *     schedule, and the consumer role scoped to its own table/bucket/queues/
 *     secret,
 *   - KIRO_API_KEY is resolved at runtime from Secrets Manager via
 *     KIRO_API_KEY_SECRET_ARN (never a plain env var),
 *   - the HTTP API stage is throttled via native API Gateway rate limiting and
 *     carries no WAFv2 web ACL (WAFv2 cannot attach to an HTTP API),
 *   - the Cognito pool has self-sign-up off + passwordless passkey-first sign-in and the resource
 *     server + facade client exist with the specified token lifetimes,
 *   - the region flows from stack props.
 */

import { App, Stack } from "aws-cdk-lib";
import { Annotations, Match, Template } from "aws-cdk-lib/assertions";
import { beforeAll, describe, expect, test } from "vitest";
import { KiroRemote } from "./construct.ts";

function synth(
  region = "eu-west-1",
  customDomain?: {
    domainName: string;
    certificateArn?: string;
    hostedZoneId?: string;
    zoneName?: string;
  },
  kiroApiKeySecretArn?: string,
): { template: Template; stack: Stack } {
  const app = new App();
  const stack = new Stack(app, "TestStack", { env: { account: "111111111111", region } });
  new KiroRemote(stack, "KiroRemote", {
    publicBaseUrl: "https://kiro.example.com",
    cognitoDomainPrefix: "kiro-remote-test",
    allowedRepos: ["acme/*"],
    preRegisteredClients: [
      { name: "ClaudeCode", callbackUrls: ["https://claude.ai/api/mcp/auth_callback"] },
    ],
    ...(customDomain ? { customDomain } : {}),
    ...(kiroApiKeySecretArn ? { kiroApiKeySecretArn } : {}),
  });
  return { template: Template.fromStack(stack), stack };
}

/**
 * Image-package Lambda functions (PackageType: Image) are the bridge consumer +
 * caps publisher. The API/OAuth Lambdas are Zip-package, so this cleanly
 * isolates the bridge functions.
 */
function imageFunctions(t: Template): Array<{ Properties: Record<string, unknown> }> {
  const found = t.findResources("AWS::Lambda::Function", {
    Properties: { PackageType: "Image" },
  });
  return Object.values(found) as Array<{ Properties: Record<string, unknown> }>;
}

/** The environment variables of a synthesized Lambda function. */
function envOf(fn: { Properties: Record<string, unknown> }): Record<string, unknown> {
  return (fn.Properties.Environment as { Variables?: Record<string, unknown> })?.Variables ?? {};
}

/**
 * The Runtime strings of exactly the THREE managed (Zip-package) Lambdas this
 * construct owns -- ApiFn, OAuthCallbackFn, OAuthTokenFn -- identified by their
 * logical-id substrings. This deliberately EXCLUDES both the container-image
 * bridge functions (which carry no Runtime) and any CDK-internal framework
 * Lambda (a custom-resource provider sets its OWN managed runtime, outside our
 * control), so a Node-26 regression on OUR functions cannot be masked.
 */
function managedFunctionRuntimes(t: Template): string[] {
  const fns = t.findResources("AWS::Lambda::Function");
  const owned = ["ApiFn", "OAuthCallbackFn", "OAuthTokenFn"];
  return Object.entries(fns)
    .filter(([logicalId]) => owned.some((name) => logicalId.includes(name)))
    .map(([, fn]) => (fn.Properties as { Runtime?: string }).Runtime)
    .filter((r): r is string => r !== undefined);
}

describe("KiroRemote", () => {
  let template: Template;
  let stack: Stack;

  beforeAll(() => {
    const s = synth();
    template = s.template;
    stack = s.stack;
  });

  test("the table is on-demand, has PITR on, GSI1, and a TTL attribute", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true },
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: "GSI1",
          KeySchema: Match.arrayWith([
            { AttributeName: "GSI1PK", KeyType: "HASH" },
            { AttributeName: "GSI1SK", KeyType: "RANGE" },
          ]),
        }),
      ]),
      KeySchema: [
        { AttributeName: "PK", KeyType: "HASH" },
        { AttributeName: "SK", KeyType: "RANGE" },
      ],
    });
  });

  test("the bucket blocks all public access and is encrypted", () => {
    template.hasResourceProperties("AWS::S3::Bucket", {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({
            ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: "AES256" }),
          }),
        ]),
      },
    });
  });

  test("the command queue is FIFO", () => {
    template.hasResourceProperties("AWS::SQS::Queue", {
      FifoQueue: true,
      ContentBasedDeduplication: true,
    });
  });

  test("there is exactly one KMS key for OAUTH#CODE with rotation", () => {
    template.resourceCountIs("AWS::KMS::Key", 1);
    template.hasResourceProperties("AWS::KMS::Key", { EnableKeyRotation: true });
  });

  test("the KMS key grants are scoped to the callback (encrypt) and token (decrypt) roles", () => {
    // The callback role can Encrypt/GenerateDataKey; the token role can Decrypt.
    // No other policy references the OAUTH#CODE key.
    const policies = template.findResources("AWS::IAM::Policy");
    const kmsActionsByRole: Record<string, string[]> = {};
    for (const policy of Object.values(policies)) {
      const doc = (policy.Properties as { PolicyDocument: { Statement: unknown[] } })
        .PolicyDocument;
      const roles = (policy.Properties as { Roles?: Array<{ Ref?: string }> }).Roles ?? [];
      for (const stmt of doc.Statement as Array<{ Action?: string | string[] }>) {
        const actions = ([] as string[]).concat(stmt.Action ?? []);
        const kms = actions.filter((a) => a.startsWith("kms:"));
        if (kms.length > 0) {
          const roleRef = roles[0]?.Ref ?? "unknown";
          kmsActionsByRole[roleRef] = (kmsActionsByRole[roleRef] ?? []).concat(kms);
        }
      }
    }
    const roleRefs = Object.keys(kmsActionsByRole);
    // Exactly two roles touch KMS: the callback handler and the token handler.
    expect(roleRefs.length).toBe(2);
    const callbackRole = roleRefs.find((r) => r.includes("OAuthCallbackFn"));
    const tokenRole = roleRefs.find((r) => r.includes("OAuthTokenFn"));
    expect(callbackRole).toBeDefined();
    expect(tokenRole).toBeDefined();
    expect(kmsActionsByRole[callbackRole as string].some((a) => a.startsWith("kms:Encrypt"))).toBe(
      true,
    );
    expect(kmsActionsByRole[tokenRole as string]).toContain("kms:Decrypt");
    // The API/bridge roles never touch the key.
    expect(roleRefs.some((r) => r.includes("ApiFn"))).toBe(false);
    expect(roleRefs.some((r) => r.includes("BridgeConsumerFn"))).toBe(false);
    expect(roleRefs.some((r) => r.includes("BridgeCapsPublisherFn"))).toBe(false);
  });

  test("the managed API/OAuth Lambdas target the Node 26 runtime (nodejs26.x)", () => {
    // The three managed (Zip-package) functions -- ApiFn, OAuthCallbackFn,
    // OAuthTokenFn -- must synthesize with Runtime 'nodejs26.x' via the
    // NODEJS_26_X shim (aws/aws-cdk#39021). We isolate OUR functions by their
    // logical-id substrings so neither the container-image bridge functions
    // (which carry NO Runtime) nor any CDK-internal framework Lambda (e.g. a
    // custom-resource provider, which sets its OWN managed runtime outside our
    // control) can mask a regression. This assertion is intentionally
    // reversion-sensitive: reverting the shim to nodejs22.x makes it FAIL.
    const runtimes = managedFunctionRuntimes(template);
    // Exactly the three managed functions we own.
    expect(runtimes.length).toBe(3);
    for (const runtime of runtimes) {
      expect(runtime).toBe("nodejs26.x");
    }
  });

  test("there are no ECS or EC2 (VPC) resources", () => {
    const types = Object.values(
      template.toJSON().Resources as Record<string, { Type: string }>,
    ).map((r) => r.Type);
    expect(types.filter((t) => t.startsWith("AWS::ECS::"))).toEqual([]);
    expect(types.filter((t) => t.startsWith("AWS::EC2::"))).toEqual([]);
  });

  test("the placeholder path (no lambdaImage prop) references the placeholder ECR repo, no Docker asset", () => {
    // With no lambdaImage override both image functions point at the
    // not-yet-deployed placeholder ECR repo -- NOT a CDK container asset
    // (which would require a Docker build at synth time).
    const images = imageFunctions(template);
    expect(images.length).toBe(2);
    for (const fn of images) {
      const imageUri = JSON.stringify((fn.Properties.Code as { ImageUri?: unknown }).ImageUri);
      expect(imageUri).toContain("kiro-remote-bridge-lambda-placeholder");
      expect(imageUri).not.toContain("container-assets");
    }
  });

  test("the bridge functions' env raises verbosity so an engine crash is self-explanatory", () => {
    // BRIDGE_LOG_LEVEL=debug makes the bridge verbose, and KIRO_LOG_LEVEL=debug
    // makes the engine ITSELF emit verbose diagnostics to stderr (which the
    // transport surfaces on failure).
    const images = imageFunctions(template);
    expect(images.length).toBe(2);
    for (const fn of images) {
      expect(envOf(fn).BRIDGE_LOG_LEVEL).toBe("debug");
      expect(envOf(fn).KIRO_LOG_LEVEL).toBe("debug");
    }
  });

  test("without kiroApiKeySecretArn the construct CREATES the KIRO_API_KEY secret (synth/dev fallback)", () => {
    // Today's behaviour: one in-stack secret is created and wired. This is the
    // fallback the recommended ARN path replaces (the created secret is deleted
    // on rollback).
    template.resourceCountIs("AWS::SecretsManager::Secret", 1);
    template.hasResourceProperties("AWS::SecretsManager::Secret", {
      Description: "Kiro API key (ksk_) read by the bridge Lambda functions at runtime",
    });
  });

  test("with kiroApiKeySecretArn the construct IMPORTS the pre-existing secret: no created secret, bridge functions + roles reference THAT ARN", () => {
    // A failed deploy must NOT delete the key, so a real deploy points at a
    // pre-existing secret by its full ARN. The construct imports it (no
    // AWS::SecretsManager::Secret resource), passes it to the bridge functions
    // as KIRO_API_KEY_SECRET_ARN, and grants GetSecretValue on THAT exact ARN
    // -- never a wildcard.
    const arn =
      "arn:aws:secretsmanager:eu-north-1:111122223333:secret:kiro-remote/kiro-api-key-AbCdEf";
    const { template: t } = synth("eu-north-1", undefined, arn);

    // The secret is imported, not created.
    t.resourceCountIs("AWS::SecretsManager::Secret", 0);

    // Both bridge functions resolve the key from the provided ARN.
    const images = imageFunctions(t);
    expect(images.length).toBe(2);
    for (const fn of images) {
      expect(envOf(fn).KIRO_API_KEY_SECRET_ARN).toBe(arn);
    }

    // Exactly the consumer and caps-publisher roles are granted GetSecretValue
    // on the exact imported ARN (no created secret Ref, no wildcard resource).
    const policies = t.findResources("AWS::IAM::Policy");
    const secretGrantRoles = new Set<string>();
    for (const policy of Object.values(policies)) {
      const props = policy.Properties as {
        PolicyDocument: { Statement: Array<{ Action?: string | string[]; Resource?: unknown }> };
        Roles?: Array<{ Ref?: string }>;
      };
      for (const stmt of props.PolicyDocument.Statement) {
        const actions = ([] as string[]).concat(stmt.Action ?? []);
        if (actions.includes("secretsmanager:GetSecretValue")) {
          const resources = ([] as unknown[]).concat(stmt.Resource ?? []);
          // The grant is scoped to exactly the imported ARN -- no wildcard.
          expect(resources).toContain(arn);
          expect(resources).not.toContain("*");
          for (const role of props.Roles ?? []) {
            if (role.Ref) {
              secretGrantRoles.add(role.Ref);
            }
          }
        }
      }
    }
    expect(secretGrantRoles.size).toBe(2);
    expect([...secretGrantRoles].some((r) => r.includes("BridgeConsumerFn"))).toBe(true);
    expect([...secretGrantRoles].some((r) => r.includes("BridgeCapsPublisherFn"))).toBe(true);
  });

  test("the HTTP API stage is throttled (native API Gateway rate limiting; WAFv2 cannot attach to an HTTP API)", () => {
    // WAFv2 can only associate with REST (v1) API stages, never an API Gateway
    // v2 HTTP API, so there is no web ACL or association in the template.
    template.resourceCountIs("AWS::WAFv2::WebACL", 0);
    template.resourceCountIs("AWS::WAFv2::WebACLAssociation", 0);
    // The rate-limiting intent is preserved with native stage-wide throttling.
    template.hasResourceProperties("AWS::ApiGatewayV2::Stage", {
      DefaultRouteSettings: Match.objectLike({
        ThrottlingRateLimit: 50,
        ThrottlingBurstLimit: 100,
      }),
    });
  });

  test("the Cognito pool has self-sign-up off and is passwordless passkey-first", () => {
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      // No separately-required MFA step (the passkey is inherently multi-factor).
      MfaConfiguration: "OFF",
      // Passkey (WebAuthn) is an allowed first-auth factor.
      Policies: Match.objectLike({
        SignInPolicy: { AllowedFirstAuthFactors: Match.arrayWith(["WEB_AUTHN"]) },
      }),
    });
  });

  test("the MCP resource server and facade client exist with the token lifetimes", () => {
    template.hasResourceProperties("AWS::Cognito::UserPoolResourceServer", {
      Identifier: "https://kiro.example.com/mcp",
      Scopes: Match.arrayWith([
        Match.objectLike({ ScopeName: "sessions:read" }),
        Match.objectLike({ ScopeName: "sessions:write" }),
        Match.objectLike({ ScopeName: "sessions:delete" }),
      ]),
    });
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      GenerateSecret: false,
      AllowedOAuthFlows: ["code"],
      CallbackURLs: ["https://kiro.example.com/oauth/callback"],
      EnableTokenRevocation: true,
      AccessTokenValidity: 15,
      RefreshTokenValidity: 43200,
      TokenValidityUnits: Match.objectLike({ AccessToken: "minutes" }),
    });
  });

  test("the region flows from stack props (nothing hardcoded)", () => {
    expect(stack.region).toBe("eu-west-1");
    // A different region synthesizes cleanly too.
    const other = synth("ap-southeast-2");
    expect(other.stack.region).toBe("ap-southeast-2");
  });

  test("the custom domain is opt-in: with no prop there is no cert/domain/mapping/records", () => {
    // The default-domain path (no customDomain prop) must be unchanged.
    template.resourceCountIs("AWS::CertificateManager::Certificate", 0);
    template.resourceCountIs("AWS::ApiGatewayV2::DomainName", 0);
    template.resourceCountIs("AWS::ApiGatewayV2::ApiMapping", 0);
    template.resourceCountIs("AWS::Route53::RecordSet", 0);
  });

  test("with customDomain set it creates a DNS-validated cert, a DomainName, and a mapping", () => {
    const { template: t } = synth("eu-north-1", { domainName: "kiro.example.dev" });
    // A new regional ACM certificate for the host, DNS-validated.
    t.resourceCountIs("AWS::CertificateManager::Certificate", 1);
    t.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: "kiro.example.dev",
      ValidationMethod: "DNS",
    });
    // The apigatewayv2 custom domain and its mapping to the HTTP API.
    t.resourceCountIs("AWS::ApiGatewayV2::DomainName", 1);
    t.hasResourceProperties("AWS::ApiGatewayV2::DomainName", {
      DomainName: "kiro.example.dev",
    });
    t.resourceCountIs("AWS::ApiGatewayV2::ApiMapping", 1);
    // Zone-less (manual-CNAME) fallback: no Route 53 records are created.
    t.resourceCountIs("AWS::Route53::RecordSet", 0);
  });

  test("with customDomain.certificateArn set it imports the cert (no new Certificate)", () => {
    const { template: t } = synth("eu-north-1", {
      domainName: "kiro.example.dev",
      certificateArn:
        "arn:aws:acm:eu-north-1:111111111111:certificate/00000000-0000-0000-0000-000000000000",
    });
    // No new ACM certificate resource -- the existing one is imported.
    t.resourceCountIs("AWS::CertificateManager::Certificate", 0);
    // The DomainName + mapping are still created.
    t.resourceCountIs("AWS::ApiGatewayV2::DomainName", 1);
    t.resourceCountIs("AWS::ApiGatewayV2::ApiMapping", 1);
  });

  test("with a Route 53 hosted zone the cert validates against it and alias A/AAAA records are created", () => {
    // The scoped subdomain IS the zone apex (domainName === zoneName).
    const { template: t } = synth("eu-north-1", {
      domainName: "kiro-remote.example.dev",
      hostedZoneId: "Z123EXAMPLE",
      zoneName: "kiro-remote.example.dev",
    });
    // The cert is DNS-validated AGAINST the supplied hosted zone (automatic
    // validation record, no manual CNAME).
    t.resourceCountIs("AWS::CertificateManager::Certificate", 1);
    t.hasResourceProperties("AWS::CertificateManager::Certificate", {
      DomainName: "kiro-remote.example.dev",
      ValidationMethod: "DNS",
      DomainValidationOptions: Match.arrayWith([
        Match.objectLike({
          DomainName: "kiro-remote.example.dev",
          HostedZoneId: "Z123EXAMPLE",
        }),
      ]),
    });
    // The apigatewayv2 custom domain + its mapping to the HTTP API.
    t.resourceCountIs("AWS::ApiGatewayV2::DomainName", 1);
    t.resourceCountIs("AWS::ApiGatewayV2::ApiMapping", 1);
    // Alias A + AAAA records in the zone, at the apex, targeting the apigw
    // regional custom domain.
    const records = t.findResources("AWS::Route53::RecordSet");
    const types = Object.values(records).map((r) => (r.Properties as { Type: string }).Type);
    expect(types).toContain("A");
    expect(types).toContain("AAAA");
    for (const record of Object.values(records)) {
      const props = record.Properties as {
        Type: string;
        Name: string;
        HostedZoneId: string;
        AliasTarget?: { DNSName: unknown; HostedZoneId: unknown };
      };
      // Apex record (no sub-label) in the supplied zone.
      expect(props.Name).toBe("kiro-remote.example.dev.");
      expect(props.HostedZoneId).toBe("Z123EXAMPLE");
      // An alias to the apigw regional domain (not a plain record).
      expect(props.AliasTarget).toBeDefined();
    }
  });

  test("a sub-record (domainName !== zoneName) sets recordName to the host", () => {
    const { template: t } = synth("eu-north-1", {
      domainName: "api.example.dev",
      hostedZoneId: "Z456EXAMPLE",
      zoneName: "example.dev",
    });
    const records = t.findResources("AWS::Route53::RecordSet");
    expect(Object.keys(records).length).toBe(2);
    for (const record of Object.values(records)) {
      expect((record.Properties as { Name: string }).Name).toBe("api.example.dev.");
    }
  });
});

/**
 * The Lambda bridge resource graph: the consumer + caps publisher, their
 * queues, event-source mappings, schedule and scoped grants.
 */
describe("KiroRemote Lambda bridge", () => {
  let t: Template;

  beforeAll(() => {
    t = synth().template;
  });

  test("provisions the arm64 DockerImageFunction consumer wired to the FIFO queue", () => {
    // Two container-image functions: the SQS consumer + the caps publisher.
    const images = imageFunctions(t);
    expect(images.length).toBe(2);
    // Both are arm64.
    for (const fn of images) {
      expect(fn.Properties.Architectures).toEqual(["arm64"]);
    }

    // The consumer has the 15-minute timeout and the reserved-concurrency cap
    // that maps maxCloudSessions (default 10).
    const consumer = images.find((fn) => (fn.Properties.Timeout as number) === 900);
    expect(consumer).toBeDefined();
    expect(consumer?.Properties.ReservedConcurrentExecutions).toBe(10);

    // Two native SQS event-source mappings (command queue + catch-up queue),
    // each with partial-batch failure reporting and a batch size of 1.
    t.resourceCountIs("AWS::Lambda::EventSourceMapping", 2);
    const mappings = Object.values(t.findResources("AWS::Lambda::EventSourceMapping"));
    for (const esm of mappings) {
      const props = esm.Properties as {
        FunctionResponseTypes?: string[];
        BatchSize?: number;
        FilterCriteria?: unknown;
      };
      expect(props.FunctionResponseTypes).toEqual(["ReportBatchItemFailures"]);
      expect(props.BatchSize).toBe(1);
      // Neither mapping is filtered: the consumer receives every command,
      // including `adopt`, and rejects unsupported ones loudly.
      expect(props.FilterCriteria).toBeUndefined();
    }

    // The command queue visibility timeout is raised to >= the consumer timeout
    // so a long cloud turn does not get redelivered mid-flight.
    t.hasResourceProperties("AWS::SQS::Queue", { FifoQueue: true, VisibilityTimeout: 900 });
    // The catch-up queue is a STANDARD queue (per-message delay) with the same
    // visibility timeout.
    t.resourceCountIs("AWS::SQS::Queue", 2);
    t.hasResourceProperties("AWS::SQS::Queue", {
      FifoQueue: Match.absent(),
      VisibilityTimeout: 900,
    });

    // CATCH_UP_QUEUE_URL is on the consumer only, not the caps publisher.
    expect(
      envOf(consumer as { Properties: Record<string, unknown> }).CATCH_UP_QUEUE_URL,
    ).toBeDefined();
    const publisher = images.find((fn) => (fn.Properties.Timeout as number) === 300);
    expect(publisher).toBeDefined();
    expect(
      envOf(publisher as { Properties: Record<string, unknown> }).CATCH_UP_QUEUE_URL,
    ).toBeUndefined();

    // The caps-publisher is invoked on a schedule.
    t.resourceCountIs("AWS::Events::Rule", 1);
    t.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: Match.stringLikeRegexp("rate\\(6 hours\\)"),
    });
  });

  test("grants the consumer scoped data-plane access to its own table/bucket/queues/secret", () => {
    // Find the consumer role (the function with the 15-minute timeout) and
    // collect the service prefixes it is granted: DynamoDB, S3, SQS,
    // SecretsManager.
    const policies = t.findResources("AWS::IAM::Policy");
    const servicesByRole: Record<string, Set<string>> = {};
    for (const policy of Object.values(policies)) {
      const props = policy.Properties as {
        PolicyDocument: { Statement: Array<{ Action?: string | string[] }> };
        Roles?: Array<{ Ref?: string }>;
      };
      const roleRef = props.Roles?.[0]?.Ref ?? "unknown";
      const set = servicesByRole[roleRef] ?? new Set<string>();
      servicesByRole[roleRef] = set;
      for (const stmt of props.PolicyDocument.Statement) {
        const actions = ([] as string[]).concat(stmt.Action ?? []);
        for (const a of actions) {
          set.add(a.split(":")[0]);
        }
      }
    }
    const consumerRole = Object.keys(servicesByRole).find((r) => r.includes("BridgeConsumerFn"));
    expect(consumerRole).toBeDefined();
    const svc = servicesByRole[consumerRole as string];
    expect(svc.has("dynamodb")).toBe(true);
    expect(svc.has("s3")).toBe(true);
    expect(svc.has("sqs")).toBe(true);
    expect(svc.has("secretsmanager")).toBe(true);
    // Never a star-everything action.
    expect(svc.has("*")).toBe(false);
  });

  test("resolves KIRO_API_KEY at runtime from Secrets Manager (ARN env, never a plain key)", () => {
    const images = imageFunctions(t);
    for (const fn of images) {
      const env = (fn.Properties.Environment as { Variables?: Record<string, unknown> })?.Variables;
      // The secret ARN is passed so resolveKiroApiKey can read it at runtime.
      expect(env?.KIRO_API_KEY_SECRET_ARN).toBeDefined();
      // AWS_REGION is a RESERVED Lambda env var and must never be set here.
      expect(env?.AWS_REGION).toBeUndefined();
      // The key itself is never a plain env var.
      expect(env?.KIRO_API_KEY).toBeUndefined();
    }
  });

  test("the managed Lambdas target nodejs26.x alongside the bridge functions (reversion-sensitive)", () => {
    // Guard the Node 26 choice in a stack that also provisions the
    // container-image bridge functions AND a custom-resource provider framework
    // Lambda: managedFunctionRuntimes isolates OUR three managed functions by
    // logical id, so neither the image functions (no Runtime) nor the CDK
    // framework Lambda can mask a regression. Reverting the shim to nodejs22.x
    // makes this FAIL.
    const runtimes = managedFunctionRuntimes(t);
    expect(runtimes.length).toBe(3);
    for (const runtime of runtimes) {
      expect(runtime).toBe("nodejs26.x");
    }
    // Sanity: the two container-image bridge functions carry no Runtime.
    expect(imageFunctions(t).length).toBe(2);
  });
});

describe("KiroRemote SES sender and passkey add route", () => {
  function synthWith(extra: Record<string, unknown>): { template: Template; stack: Stack } {
    const app = new App();
    const stack = new Stack(app, "SesStack", {
      env: { account: "111111111111", region: "eu-west-1" },
    });
    new KiroRemote(stack, "KiroRemote", {
      publicBaseUrl: "https://kiro.example.com",
      cognitoDomainPrefix: "kiro-remote-test",
      allowedRepos: ["acme/*"],
      ...extra,
    });
    return { template: Template.fromStack(stack), stack };
  }

  test("forwards sesFromEmail to the user pool as a DEVELOPER (SES) sender", () => {
    const { template } = synthWith({
      sesFromEmail: "no-reply@example.com",
      sesVerifiedDomain: "example.com",
    });
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      EmailConfiguration: Match.objectLike({
        EmailSendingAccount: "DEVELOPER",
        From: "no-reply@example.com",
      }),
    });
  });

  test("without sesFromEmail it uses the Cognito default sender and warns", () => {
    const { template, stack } = synthWith({});
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      EmailConfiguration: Match.absent(),
    });
    Annotations.fromStack(stack).hasWarning("*", Match.stringLikeRegexp("sesFromEmail"));
  });

  test("routes GET /passkeys/add to the API", () => {
    const { template } = synthWith({});
    template.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "GET /passkeys/add",
    });
  });
});
