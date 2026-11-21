#!/usr/bin/env node
/**
 * The pipeline's own CDK app: KiroRemotePipelineStack only. The service's app (packages/cdk) never
 * includes it, so `deploy.sh` and the pipeline's deploys of the service never touch the pipeline.
 * Deployed by hand once with `./scripts/pipeline.sh bootstrap` (docs/pipeline.md).
 */
import { App } from "aws-cdk-lib";
import { PIPELINE_STACK_NAME, REGION } from "../src/names.ts";
import { readPipelineContext } from "../src/pipeline-config.ts";
import { PipelineStack } from "../src/pipeline-stack.ts";

const app = new App();
const account = process.env.CDK_DEFAULT_ACCOUNT;
new PipelineStack(app, PIPELINE_STACK_NAME, {
  // The region is fixed: the ledger, the flag and the settings must be where deploy.toml says.
  env: account ? { account, region: REGION } : { region: REGION },
  config: readPipelineContext(app.node),
});
app.synth();
