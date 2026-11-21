/**
 * The names shared by the pipeline stack (`pipeline-stack.ts`), the deploy run (`deploy.toml` at the
 * repository root, read by `@nikovirtala/deployment`), the smoke checks and the policy simulator.
 * One place, so a rename is one edit, and `names.test.ts` fails when deploy.toml says otherwise.
 *
 * The pipeline lives in its own CDK app and stack, apart from KiroRemoteStack, so a deploy of the
 * service never touches it and destroying the service never takes the pipeline, its ledger or its
 * settings with it. Every name here is therefore fixed: the service's resources are reached by name,
 * never by reference.
 */
export const REGION = "eu-north-1";
export const PIPELINE_STACK_NAME = "KiroRemotePipelineStack";
export const SERVICE_STACK_NAME = "KiroRemoteStack";
export const DNS_STACK_NAME = "KiroRemoteDnsStack";
export const PIPELINE_NAME = "kiro-remote-deploy";
export const BUILD_PROJECT_NAME = "kiro-remote-deploy-run";

/** The ledger: deployment task results, the runs and the last good commit. */
export const LEDGER_TABLE_NAME = "kiro-remote-deployment-ledger";
/** The freeze flag. Absent = not frozen. */
export const FREEZE_PARAMETER = "/kiro-remote/deployment/frozen";
/** The service's non-secret deploy settings, one parameter per deploy.env key. */
export const SETTINGS_PREFIX = "/kiro-remote/deployment/settings/";
/** Where a failed run says what failed. kiro-remote has no alarm topic of its own, so the pipeline stack owns this one. */
export const NOTIFY_TOPIC_NAME = "kiro-remote-deployment";
/** The secret with a GitHub token that may write deployments (fine-grained, Deployments: write, this repository only). */
export const GITHUB_TOKEN_SECRET = "kiro-remote/deployment/github-token";

export const ROLE_NAMES = {
  /** The build's service role. It deploys nothing and reads no data: it assumes the roles below. */
  runner: "kiro-remote-deployment-runner",
  /** Assumed by the runner for `cdk deploy`: it may assume the CDK bootstrap roles and read what the preflight checks. */
  deploy: "kiro-remote-deployment-deploy",
  /** Assumed for the smoke checks: read-only, and no read of session data. */
  smoke: "kiro-remote-deployment-smoke",
} as const;

/** Every deployment task runs as a role of this prefix, declared by the task (`tasks/`). */
export const TASK_ROLE_PREFIX = "kiro-remote-deployment-task-";

/** The CDK bootstrap qualifier of the account (`cdk bootstrap` default). */
export const CDK_QUALIFIER = "hnb659fds";

/** What the service stack names its resources with: CloudFormation's generated names start with the stack name. */
export const SERVICE_NAME_PREFIX = "KiroRemoteStack-";
/** The service's secrets (the Kiro API key, the GitHub App): `kiro-remote/<name>`. */
export const SERVICE_SECRET_PREFIX = "kiro-remote/";
