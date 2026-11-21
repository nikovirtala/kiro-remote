# Stamp every function with the deploy's provenance

## Context
Nothing in kiro-remote's telemetry says which commit produced a log line or a trace, so a regression found in the logs cannot be tied to a deploy. The deployment pipeline knows the commit, the repository and the environment, and passes them into the CDK app as context (deploymentCommit, deploymentRepositoryUrl, deploymentEnvironment, deploymentVersion).

## Decision
bin/app.ts reads them with provenanceFromContext from @nikovirtala/deployment/cdk, and the KiroRemote construct sets OTEL_RESOURCE_ATTRIBUTES on every function to vcs.ref.head.revision, vcs.repository.url.full, deployment.environment.name and service.version (the commit). The api, bridge and github loggers add those attributes to every log line. A synth or a deploy.sh deploy without the context stamps nothing. A smoke check fails when a function does not carry the commit that was deployed.

## Scope
packages/cdk (bin/app.ts and the construct's stampProvenance), packages/core/src/provenance.ts and the loggers of packages/api, packages/bridge and packages/github.

## Consequences
- Every log line names its commit, and an OpenTelemetry SDK added later reads the same attributes.
- The value changes with every commit, so every function's configuration is updated on every deploy.
- A deploy by hand with deploy.sh leaves the functions unstamped: a smoke run by hand then fails on it, and the next pipeline deploy stamps them again.
