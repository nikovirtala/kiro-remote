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

import { App } from "aws-cdk-lib";
import { buildApiLambdaCode } from "../src/api-asset.ts";
import { KiroRemoteDnsStack } from "../src/dns-stack.ts";
import { applyAwsSolutionsChecks } from "../src/nag.ts";
import { KiroRemoteStack } from "../src/stack.ts";

const app = new App();

const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;

// The canonical <host>: a custom domain or the API Gateway default domain.
// Supplied via `-c publicBaseUrl=...` (falls back to a placeholder for synth).
const publicBaseUrl =
  (app.node.tryGetContext("publicBaseUrl") as string | undefined) ?? "https://kiro.example.com";
const cognitoDomainPrefix =
  (app.node.tryGetContext("cognitoDomainPrefix") as string | undefined) ?? "kiro-remote";
const allowedReposCtx = app.node.tryGetContext("allowedRepos") as string | string[] | undefined;
const allowedRepos = Array.isArray(allowedReposCtx)
  ? allowedReposCtx
  : typeof allowedReposCtx === "string"
    ? allowedReposCtx.split(",")
    : ["*/*"];

const env = account && region ? { account, region } : undefined;

// OPT-IN production-asset trigger. The real bridge image (FEAT-003) and the
// real bundled API Lambda code are built ONLY when `-c kiroCliVersion=<ver>`
// is passed. This single flag gates everything that needs a Docker build or a
// Node bundler, so the default placeholder path (no flag) synthesizes with no
// Docker and no bundler and all existing assertion tests stay green.
const kiroCliVersion = app.node.tryGetContext("kiroCliVersion") as string | undefined;

// Build the real API Lambda asset (esbuild, in-process, no Docker) only on the
// opt-in path. When absent, apiLambdaCode stays undefined so the construct
// falls back to its inline placeholder and synth needs no bundler.
const apiLambdaCode = kiroCliVersion ? buildApiLambdaCode() : undefined;

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
    ...(kiroCliVersion ? { kiroCliVersion } : {}),
    ...(apiLambdaCode ? { apiLambdaCode } : {}),
    ...(customDomain ? { customDomain } : {}),
  },
});

// AwsSolutions checks run on the whole app at synth time.
applyAwsSolutionsChecks(app);

app.synth();
