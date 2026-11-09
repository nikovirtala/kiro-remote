#!/usr/bin/env node
/**
 * CDK application entrypoint. A THIN consumer of the KiroRemote construct, run
 * as native TypeScript via Node 26 type stripping (cdk.json invokes
 * `node bin/app.ts` -- no ts-node, no compile step).
 *
 * Everything configurable is read from CDK context or the environment so
 * nothing is hardcoded to a region: the account/region flow from the standard
 * CDK_DEFAULT_* variables (Kiro sandboxes resolve to us-east-1 regardless).
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { App } from "aws-cdk-lib";
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import { ContainerImage } from "aws-cdk-lib/aws-ecs";
import { DockerImageCode } from "aws-cdk-lib/aws-lambda";
import { buildApiLambdaCode } from "../src/api-asset.ts";
import { BRIDGE_IMAGE_EXCLUDES, selectAppAssets } from "../src/app-assets.ts";
import type { BridgeMode } from "../src/construct.ts";
import { KiroRemoteDnsStack } from "../src/dns-stack.ts";
import { applyAwsSolutionsChecks } from "../src/nag.ts";
import { KiroRemoteStack } from "../src/stack.ts";

const app = new App();

// The monorepo root, resolved relative to THIS file (packages/cdk/bin/app.ts).
// The bridge Dockerfile's build context MUST be the repo root because it COPYs
// package.json, pnpm-lock.yaml, pnpm-workspace.yaml, tsconfig.base.json and the
// whole packages/core + packages/bridge trees.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;

// Deploy context is REQUIRED and has NO defaults here: a missing key fails the
// synth (and therefore deploy/diff) instead of silently becoming a placeholder
// that would overwrite a live stack. Synths and deploys go through
// scripts/deploy.sh (`pnpm synth` / `pnpm run deploy`), which passes every key
// from deploy.env.
const requiredContextKeys = [
  "publicBaseUrl",
  "cognitoDomainPrefix",
  "allowedRepos",
  "kiroApiKeySecretArn",
  "kiroCliVersion",
];
const isBlank = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === "string" && value.trim() === "") ||
  (Array.isArray(value) && value.length === 0);
const missingContext = requiredContextKeys.filter((key) => isBlank(app.node.tryGetContext(key)));
if (missingContext.length > 0) {
  throw new Error(
    `missing required context: ${missingContext.join(", ")}. Deploy with ./scripts/deploy.sh ` +
      "(reads deploy.env), or pass every key with -c key=value.",
  );
}

// The canonical <host>: a custom domain or the API Gateway default domain.
const publicBaseUrl = app.node.tryGetContext("publicBaseUrl") as string;
const cognitoDomainPrefix = app.node.tryGetContext("cognitoDomainPrefix") as string;
// Comma-separated string from -c, or an array from a context file.
const allowedReposCtx = app.node.tryGetContext("allowedRepos") as string | string[];
const allowedRepos = Array.isArray(allowedReposCtx) ? allowedReposCtx : allowedReposCtx.split(",");

const env = account && region ? { account, region } : undefined;

// Full ARN of a PRE-EXISTING Secrets Manager secret holding KIRO_API_KEY
// (ksk_). The secret is created + populated out of band and survives stack
// rollback, so a failed deploy cannot delete the key before it can be
// populated. Required here: without it the construct would create an EMPTY
// secret and repoint the bridge at it.
const kiroApiKeySecretArn = app.node.tryGetContext("kiroApiKeySecretArn") as string;

// Real production assets: `-c kiroCliVersion=<ver>` (required above) builds the
// real bridge image(s) (Docker) AND bundles the real API Lambda code (esbuild).
//
// `selectAppAssets` is a pure, unit-tested helper (src/app-assets.ts): it
// validates the version (throwing clearly for a blank value, since the bridge
// Dockerfile's KIRO_CLI_VERSION build arg has no default) and only then invokes
// the asset factories.
const { kiroCliVersion, bridgeImage, lambdaImage, apiLambdaCode } = selectAppAssets(
  { kiroCliVersion: app.node.tryGetContext("kiroCliVersion") as string | undefined },
  {
    // Real ECS/Fargate bridge image from the Dockerfile with the repo root as
    // build context (linux/arm64 for Graviton). Needs Docker: this runs at
    // synth time on the operator's machine, not in constrained CI/sandboxes.
    buildBridgeImage: (version: string) =>
      ContainerImage.fromAsset(repoRoot, {
        file: "packages/bridge/Dockerfile",
        platform: Platform.LINUX_ARM64,
        buildArgs: { KIRO_CLI_VERSION: version },
        // The build context is the repo root, which CONTAINS packages/cdk/cdk.out.
        // Exclude it (and node_modules / .api-bundle / .git) so CDK does not
        // recursively stage cdk.out into the asset -- that recursion overflows
        // the path length (ENAMETOOLONG). See BRIDGE_IMAGE_EXCLUDES.
        exclude: [...BRIDGE_IMAGE_EXCLUDES],
      }),
    // Real serverless (Lambda) bridge image from Dockerfile.lambda, same repo
    // root build context + excludes + linux/arm64 as the ECS image. Needs
    // Docker. Carries both the SQS consumer and caps-publisher handlers; the
    // construct selects which via each function's image CMD.
    buildLambdaImage: (version: string, cmd: string[]) =>
      DockerImageCode.fromImageAsset(repoRoot, {
        file: "packages/bridge/Dockerfile.lambda",
        platform: Platform.LINUX_ARM64,
        buildArgs: { KIRO_CLI_VERSION: version },
        cmd,
        exclude: [...BRIDGE_IMAGE_EXCLUDES],
      }),
    // Real API Lambda asset (esbuild, in-process, no Docker).
    buildApiLambdaCode,
  },
);

// The bridge-mode selector: which host(s) drive the cloud path. `fargate`
// (default) keeps today's stack exactly, `lambda` runs the serverless path
// only, `both` provisions both. Passed via `-c bridgeMode=lambda|fargate|both`.
// An unknown value is rejected loudly rather than silently defaulting.
const bridgeModeCtx = app.node.tryGetContext("bridgeMode") as string | undefined;
if (bridgeModeCtx !== undefined && !["fargate", "lambda", "both"].includes(bridgeModeCtx)) {
  throw new Error(
    `invalid bridgeMode context '${bridgeModeCtx}': expected one of 'fargate', 'lambda', 'both'`,
  );
}
const bridgeMode = bridgeModeCtx as BridgeMode | undefined;

// DNS stack (optional, deployed FIRST): a Route 53 PUBLIC hosted zone for the
// delegated subdomain. Enabled by passing `-c dnsZoneName=<zone>`. Deploy it,
// read its `NameServers` output, paste those NS at the parent DNS provider
// (Cloudflare) to delegate the subdomain, then deploy the app stack with
// `-c hostedZoneId=<HostedZoneId output>`. Omitted => single-stack synth is
// unchanged.
const dnsZoneName = app.node.tryGetContext("dnsZoneName") as string | undefined;
if (dnsZoneName) {
  new KiroRemoteDnsStack(app, "KiroRemoteDnsStack", {
    ...(env ? { env } : {}),
    zoneName: dnsZoneName,
  });
}

// Optional API Gateway v2 custom domain. Enabled by passing
// `-c customDomainName=<host>`. DNS modes:
//   - Route 53 (recommended): also pass `-c hostedZoneId=<id>` (the HostedZoneId
//     output of KiroRemoteDnsStack, set AFTER that stack is deployed and the
//     subdomain delegated). The cert is validated against the zone and alias
//     A/AAAA records are created in it -- no manual DNS.
//   - Zone-less manual CNAME (fallback): omit hostedZoneId. A DNS-validated cert
//     is created with no hosted zone and the operator adds the CNAMEs by hand.
//   - Import an existing cert instead with `-c certificateArn=<arn>`.
// Omitted => default execute-api domain only, so synth without it is unchanged.
const customDomainName = app.node.tryGetContext("customDomainName") as string | undefined;
const certificateArn = app.node.tryGetContext("certificateArn") as string | undefined;
const hostedZoneId = app.node.tryGetContext("hostedZoneId") as string | undefined;
// The hosted zone's name defaults to the delegated zone (dnsZoneName) when set,
// else the custom host itself (the scoped subdomain is its own zone apex).
const zoneName =
  (app.node.tryGetContext("hostedZoneName") as string | undefined) ??
  dnsZoneName ??
  customDomainName;
const customDomain = customDomainName
  ? {
      domainName: customDomainName,
      ...(certificateArn ? { certificateArn } : {}),
      ...(hostedZoneId && zoneName ? { hostedZoneId, zoneName } : {}),
    }
  : undefined;

new KiroRemoteStack(app, "KiroRemoteStack", {
  ...(env ? { env } : {}),
  kiroRemote: {
    publicBaseUrl,
    cognitoDomainPrefix,
    allowedRepos,
    ...(bridgeMode ? { bridgeMode } : {}),
    kiroApiKeySecretArn,
    ...(kiroCliVersion ? { kiroCliVersion } : {}),
    ...(bridgeImage ? { bridgeImage } : {}),
    ...(lambdaImage ? { lambdaImage } : {}),
    ...(apiLambdaCode ? { apiLambdaCode } : {}),
    ...(customDomain ? { customDomain } : {}),
  },
});

// AwsSolutions checks run on the whole app at synth time.
applyAwsSolutionsChecks(app);

app.synth();
