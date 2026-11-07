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

// Optional API Gateway v2 custom domain. Enabled by passing
// `-c customDomainName=<host>` (and optionally `-c certificateArn=<arn>` to
// import an existing cert instead of creating a DNS-validated one). Omitted =>
// default execute-api domain only, so synth without it is unchanged.
const customDomainName = app.node.tryGetContext("customDomainName") as string | undefined;
const certificateArn = app.node.tryGetContext("certificateArn") as string | undefined;
const customDomain = customDomainName
  ? { domainName: customDomainName, ...(certificateArn ? { certificateArn } : {}) }
  : undefined;

new KiroRemoteStack(app, "KiroRemoteStack", {
  ...(account && region ? { env: { account, region } } : {}),
  kiroRemote: {
    publicBaseUrl,
    cognitoDomainPrefix,
    allowedRepos,
    ...(customDomain ? { customDomain } : {}),
  },
});

// AwsSolutions checks run on the whole app at synth time.
applyAwsSolutionsChecks(app);

app.synth();
