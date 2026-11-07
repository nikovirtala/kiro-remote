/**
 * CDK assertion tests for the KiroRemote construct (aws-cdk-lib/assertions).
 *
 * Every test synthesizes the stack offline (no AWS, no Docker: the bridge image
 * defaults to a placeholder and the Lambdas to inline placeholders) and asserts
 * the security- and contract-critical properties:
 *   - the table is on-demand + PITR + GSI1 + has a `ttl` TTL attribute,
 *   - the bucket blocks public access and is encrypted,
 *   - the command queue is FIFO,
 *   - the KMS key grants are scoped to EXACTLY the callback/token handler roles,
 *   - the Fargate service runs in public subnets with a public IP, a
 *     no-ingress / egress-443-only SG, and the VPC has no NAT gateway,
 *   - the task role is scoped to its own table/bucket/queue/secret,
 *   - KIRO_API_KEY is a Secrets Manager ECS `secrets` entry (not a plain env),
 *   - the HTTP API stage is throttled via native API Gateway rate limiting and
 *     carries no WAFv2 web ACL (WAFv2 cannot attach to an HTTP API),
 *   - the Cognito pool has self-sign-up off + passwordless passkey-first sign-in and the resource
 *     server + facade client exist with the specified token lifetimes,
 *   - the region flows from stack props.
 */

import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
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
  });
  return { template: Template.fromStack(stack), stack };
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
    expect(roleRefs.some((r) => r.includes("TaskRole"))).toBe(false);
  });

  test("the VPC has no NAT gateway", () => {
    template.resourceCountIs("AWS::EC2::NatGateway", 0);
  });

  test("the Fargate service runs in public subnets with a public IP", () => {
    template.hasResourceProperties("AWS::ECS::Service", {
      DesiredCount: 1,
      LaunchType: "FARGATE",
      NetworkConfiguration: {
        AwsvpcConfiguration: Match.objectLike({ AssignPublicIp: "ENABLED" }),
      },
    });
    // The subnets map a public IP on launch (public subnets).
    const publicSubnets = template.findResources("AWS::EC2::Subnet", {
      Properties: { MapPublicIpOnLaunch: true },
    });
    expect(Object.keys(publicSubnets).length).toBeGreaterThanOrEqual(2);
  });

  test("the bridge SG has NO ingress and egress on 443 only", () => {
    template.hasResourceProperties("AWS::EC2::SecurityGroup", {
      SecurityGroupEgress: [
        Match.objectLike({ FromPort: 443, ToPort: 443, IpProtocol: "tcp", CidrIp: "0.0.0.0/0" }),
      ],
    });
    // No SecurityGroup carries an ingress rule.
    const sgs = template.findResources("AWS::EC2::SecurityGroup");
    for (const sg of Object.values(sgs)) {
      const ingress = (sg.Properties as { SecurityGroupIngress?: unknown[] }).SecurityGroupIngress;
      expect(ingress === undefined || ingress.length === 0).toBe(true);
    }
  });

  test("the placeholder path (no bridgeImage prop) references the placeholder registry image, no Docker asset", () => {
    // With no bridgeImage override the task definition points at the public
    // placeholder registry image -- a plain string image, NOT an ECR asset
    // reference (which would require a Docker build at synth time).
    const taskDefs = template.findResources("AWS::ECS::TaskDefinition");
    const container = (
      Object.values(taskDefs)[0].Properties as {
        ContainerDefinitions: Array<{ Image: unknown }>;
      }
    ).ContainerDefinitions[0];
    expect(container.Image).toBe("public.ecr.aws/amazonlinux/amazonlinux:2023");
  });

  test("the bridge container runs the bundle (command 'serve') and its healthCheck never touches the raw cli.ts path or an unimplemented subcommand", () => {
    const taskDefs = template.findResources("AWS::ECS::TaskDefinition");
    const def = (
      Object.values(taskDefs)[0].Properties as {
        ContainerDefinitions: Array<{
          Command?: string[];
          HealthCheck?: { Command?: string[] };
        }>;
      }
    ).ContainerDefinitions[0];
    // The container runs the bundled entrypoint's `serve` subcommand.
    expect(def.Command).toEqual(["serve"]);
    // The old probe ran `node packages/bridge/src/cli.ts healthcheck`, which
    // both hit the node_modules .ts type-strip crash and called a subcommand
    // cli.ts does not implement. The new probe must do neither.
    const healthCommand = (def.HealthCheck?.Command ?? []).join(" ");
    expect(healthCommand).not.toContain("cli.ts");
    expect(healthCommand).not.toContain("healthcheck");
    expect(healthCommand).toContain("process.exit(0)");
  });

  test("the bridge log group is RETAINed so a rollback keeps the container logs", () => {
    template.hasResource("AWS::Logs::LogGroup", {
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
  });

  test("the arm64 Graviton runtime platform is set on the task definition", () => {
    template.hasResourceProperties("AWS::ECS::TaskDefinition", {
      RuntimePlatform: { CpuArchitecture: "ARM64", OperatingSystemFamily: "LINUX" },
    });
  });

  test("KIRO_API_KEY is a Secrets Manager ECS secret, never a plain env var", () => {
    const taskDefs = template.findResources("AWS::ECS::TaskDefinition");
    const container = Object.values(taskDefs)[0].Properties as {
      ContainerDefinitions: Array<{
        Secrets?: Array<{ Name: string; ValueFrom: unknown }>;
        Environment?: Array<{ Name: string }>;
      }>;
    };
    const def = container.ContainerDefinitions[0];
    expect(def.Secrets?.some((s) => s.Name === "KIRO_API_KEY")).toBe(true);
    // It must NOT appear as a plain environment variable.
    expect(def.Environment?.some((e) => e.Name === "KIRO_API_KEY")).not.toBe(true);
  });

  test("the task role is scoped to its own table/bucket/queue/secret", () => {
    // The task-role policy references the table, bucket, queue, and secret -- and
    // only DynamoDB/S3/SQS/SecretsManager actions (no Action:* ).
    const policies = template.findResources("AWS::IAM::Policy");
    const taskPolicy = Object.values(policies).find((p) =>
      ((p.Properties as { Roles?: Array<{ Ref?: string }> }).Roles ?? []).some((r) =>
        (r.Ref ?? "").includes("BridgeTaskTaskRole"),
      ),
    );
    expect(taskPolicy).toBeDefined();
    const doc = (taskPolicy as { Properties: { PolicyDocument: { Statement: unknown[] } } })
      .Properties.PolicyDocument;
    const actions = (doc.Statement as Array<{ Action?: string | string[] }>).flatMap((s) =>
      ([] as string[]).concat(s.Action ?? []),
    );
    const services = new Set(actions.map((a) => a.split(":")[0]));
    expect(services.has("dynamodb")).toBe(true);
    expect(services.has("s3")).toBe(true);
    expect(services.has("sqs")).toBe(true);
    expect(services.has("secretsmanager")).toBe(true);
    // No star-everything action.
    expect(actions).not.toContain("*");
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
