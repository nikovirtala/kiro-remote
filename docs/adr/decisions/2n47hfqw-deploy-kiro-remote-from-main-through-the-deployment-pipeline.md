# Deploy kiro-remote from main through the deployment pipeline

## Context
kiro-remote is deployed by hand with scripts/deploy.sh, from a laptop, with no smoke checks after it and no record of which commit runs. longplay's platform pipeline does that work (check, deploy with rollback triggers, smoke checks, one-off tasks run once, freeze on failure) and is now an ark member, @nikovirtala/deployment ([its design](https://github.com/nikovirtala/ark/blob/main/docs/04-deployment-v1.md)).

## Decision
Every merge to main deploys KiroRemoteDnsStack and KiroRemoteStack through CodePipeline V2 (SUPERSEDED, one CodeBuild action, sourced through CodeConnections) running @nikovirtala/deployment, configured by deploy.toml. The pipeline is its own CDK app and stack (packages/pipeline, KiroRemotePipelineStack), deployed by hand once, so a deploy of the service never touches it. The build's role assumes a deploy role, a read-only smoke role and one role per deployment task, each trusted by it alone. The settings live in SSM, copied from deploy.env, with the schema in deploy.toml; GITHUB_APP_SECRET_ARN is REQUIRED there though deploy.sh treats it as optional, because a deploy without it removes GitHub wake and the pipeline deploys unattended. scripts/deploy.sh stays as the break-glass path. There are no rollback triggers until the service has CloudWatch alarms.

## Scope
deploy.toml, packages/pipeline, tasks/, scripts/pipeline.sh and docs/pipeline.md; how KiroRemoteStack and KiroRemoteDnsStack are deployed.

## Consequences
- A merge deploys within the hour with the same checks every time, and a failure freezes the pipeline until Niko clears it.
- Agents never deploy: their AWS access is read-only, the work roles trust the runner only, and the deploy CLI refuses run, unfreeze, forget and settings to an agent.
- Two places name the settings (deploy.sh and deploy.toml); a test compares them.
- The pipeline cannot express deploy.sh's blank-means-off for CUSTOM_DOMAIN_NAME and DNS_ZONE_NAME: SSM holds no blank value.
- The pipeline costs a CodeBuild ARM run per merge and a KMS key for its artifact bucket.
