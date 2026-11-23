import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as codepipeline from "aws-cdk-lib/aws-codepipeline";
import * as cpActions from "aws-cdk-lib/aws-codepipeline-actions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";
import {
  BUILD_PROJECT_NAME,
  CDK_QUALIFIER,
  DNS_STACK_NAME,
  FREEZE_PARAMETER,
  GITHUB_TOKEN_SECRET,
  LEDGER_TABLE_NAME,
  NOTIFY_TOPIC_NAME,
  PIPELINE_NAME,
  ROLE_NAMES,
  SERVICE_NAME_PREFIX,
  SERVICE_SECRET_PREFIX,
  SERVICE_STACK_NAME,
  SETTINGS_PREFIX,
  TASK_ROLE_PREFIX,
} from "./names.ts";
import type { PipelineConfig } from "./pipeline-config.ts";
import { TASK_ROLES } from "./task-roles.ts";

export interface PipelineStackProps extends cdk.StackProps {
  readonly config: PipelineConfig;
}

/** The mise version the build installs its toolchain with (Node and pnpm from `.mise.toml`). A bump is a reviewed change. */
export const MISE_VERSION = "v2026.11.10";

/**
 * The deploy pipeline of KiroRemoteStack (docs/pipeline.md), on @nikovirtala/deployment.
 *
 * Its own CDK app and stack, deployed by hand once, so a deploy of the service never touches it and
 * a destroy of the service never takes the pipeline, its ledger or its settings with it. Nothing here
 * references the service stack: its resources are reached by their names.
 *
 *   GitHub (push to main) -> CodeConnections -> CodePipeline V2, SUPERSEDED -> one stage, one CodeBuild action
 *
 * The build is one process (`deploy run`) that assumes a separate role for each kind of work, so the
 * build's own role can deploy nothing and read no data:
 *   runner  the build's service role: the settings, the freeze flag, the ledger, the topic, the GitHub token, sts:AssumeRole
 *   deploy  `cdk deploy` of the service (through the CDK bootstrap roles), and the preflight's reads
 *   smoke   read-only, and no read of session data (`smoke/checks.ts`)
 *   task    one role per deployment task (`task-roles.ts`)
 */
export class PipelineStack extends cdk.Stack {
  public readonly ledger: dynamodb.Table;
  public readonly pipeline: codepipeline.Pipeline;
  public readonly project: codebuild.PipelineProject;
  public readonly topic: sns.Topic;
  public readonly roles: Record<keyof typeof ROLE_NAMES, iam.Role> & { tasks: iam.Role[] };

  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);
    const { config } = props;
    cdk.Tags.of(this).add("project", "kiro-remote");
    cdk.Tags.of(this).add("component", "deploy-pipeline");
    const account = this.account;
    const region = this.region;
    const [owner = "", repo = ""] = config.repository.split("/");

    // ---- The ledger ---------------------------------------------------------------------------
    // Retained, with point-in-time recovery: it is what stops a deployment task from running twice.
    this.ledger = new dynamodb.Table(this, "Ledger", {
      tableName: LEDGER_TABLE_NAME,
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ---- Where a failed run says so -----------------------------------------------------------
    this.topic = new sns.Topic(this, "Notify", {
      topicName: NOTIFY_TOPIC_NAME,
      displayName: "kiro-remote deploy pipeline",
      enforceSSL: true,
    });
    if (config.alarmEmail)
      this.topic.addSubscription(new subscriptions.EmailSubscription(config.alarmEmail));

    // ---- The roles ----------------------------------------------------------------------------
    const roleArn = (name: string): string => `arn:aws:iam::${account}:role/${name}`;
    const parameter = (name: string): string => `arn:aws:ssm:${region}:${account}:parameter${name}`;
    const runnerArn = roleArn(ROLE_NAMES.runner);

    const runner = new iam.Role(this, "Runner", {
      roleName: ROLE_NAMES.runner,
      description:
        "The deploy pipeline's build. It deploys nothing and reads no data: it keeps the ledger and the freeze flag, publishes to the pipeline's topic and assumes the roles that do the work.",
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
      inlinePolicies: {
        Policy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              sid: "ReadSettings",
              actions: ["ssm:GetParametersByPath", "ssm:GetParameter"],
              resources: [
                parameter(SETTINGS_PREFIX.replace(/\/$/, "")),
                parameter(`${SETTINGS_PREFIX}*`),
              ],
            }),
            // Read and set the freeze flag. Not delete: only a person clears it.
            new iam.PolicyStatement({
              sid: "FreezeFlag",
              actions: ["ssm:GetParameter", "ssm:PutParameter"],
              resources: [parameter(FREEZE_PARAMETER)],
            }),
            // No DeleteItem: a ledger entry is removed by a person (`deploy forget`), never by the build.
            new iam.PolicyStatement({
              sid: "Ledger",
              actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:Scan"],
              resources: [this.ledger.tableArn],
            }),
            new iam.PolicyStatement({
              sid: "Notify",
              actions: ["sns:Publish"],
              resources: [this.topic.topicArn],
            }),
            // The token that records the run as a GitHub deployment. Its value only; it can change nothing else.
            new iam.PolicyStatement({
              sid: "GitHubDeploymentsToken",
              actions: ["secretsmanager:GetSecretValue"],
              resources: [
                `arn:aws:secretsmanager:${region}:${account}:secret:${GITHUB_TOKEN_SECRET}-??????`,
              ],
            }),
            new iam.PolicyStatement({
              sid: "AssumeTheWorkRoles",
              actions: ["sts:AssumeRole"],
              resources: [
                roleArn(ROLE_NAMES.deploy),
                roleArn(ROLE_NAMES.smoke),
                roleArn(`${TASK_ROLE_PREFIX}*`),
              ],
            }),
            new iam.PolicyStatement({
              sid: "CloneTheRepository",
              actions: [
                "codeconnections:UseConnection",
                "codeconnections:GetConnectionToken",
                "codeconnections:GetConnection",
                "codestar-connections:UseConnection",
                "codestar-connections:GetConnectionToken",
                "codestar-connections:GetConnection",
              ],
              resources: [
                config.connectionArn,
                config.connectionArn.replace(":codeconnections:", ":codestar-connections:"),
              ],
            }),
          ],
        }),
      },
    });

    // Trusted by the runner role only: the other roles name it as their one principal, so the agent's
    // read-only role, the service's function roles and everyone else are refused by the roles' trust.
    const role = (
      cid: string,
      name: string,
      description: string,
      statements: iam.PolicyStatement[],
    ): iam.Role => {
      const r = new iam.Role(this, cid, {
        roleName: name,
        description,
        assumedBy: new iam.ArnPrincipal(runnerArn),
        maxSessionDuration: cdk.Duration.hours(1),
        inlinePolicies: { Policy: new iam.PolicyDocument({ statements }) },
      });
      r.node.addDependency(runner);
      return r;
    };

    const cdkBootstrapRole = (kind: string): string =>
      `arn:aws:iam::${account}:role/cdk-${CDK_QUALIFIER}-${kind}-role-${account}-${region}`;
    const deploy = role(
      "Deploy",
      ROLE_NAMES.deploy,
      "Runs `cdk deploy` of KiroRemoteStack and KiroRemoteDnsStack through the CDK bootstrap roles, and reads what the preflight checks.",
      deployStatements({ account, region }, cdkBootstrapRole),
    );
    const smoke = role(
      "Smoke",
      ROLE_NAMES.smoke,
      "Read-only, for the smoke checks and the stack outputs tasks ask for. It cannot read session data: no table item, no object, no log line, no secret value, no user.",
      smokeStatements({ account, region }),
    );
    const tasks = TASK_ROLES.map((def) =>
      role(`Task-${def.name}`, def.name, def.description, def.statements({ account, region })),
    );
    this.roles = { runner, deploy, smoke, tasks };

    // ---- The build ----------------------------------------------------------------------------
    const logGroup = new logs.LogGroup(this, "BuildLogs", {
      logGroupName: `/aws/codebuild/${BUILD_PROJECT_NAME}`,
      // What checks and tasks print stays here: nothing leaves the account.
      retention: logs.RetentionDays.SIX_MONTHS,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });
    this.project = new codebuild.PipelineProject(this, "Build", {
      projectName: BUILD_PROJECT_NAME,
      description:
        "One run of the kiro-remote deploy pipeline: check, deploy, smoke, tasks, roll back and freeze on failure.",
      role: runner,
      // ARM, because the bridge's container image is linux/arm64 and cdk builds it on this host: no emulation.
      environment: {
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
        computeType: codebuild.ComputeType.MEDIUM,
        // The bridge's Lambda image is built with Docker.
        privileged: true,
      },
      timeout: cdk.Duration.minutes(90),
      logging: { cloudWatch: { logGroup } },
      buildSpec: codebuild.BuildSpec.fromObject(buildSpec()),
    });

    // ---- The pipeline -------------------------------------------------------------------------
    const sourceOutput = new codepipeline.Artifact("Source");
    const source = new cpActions.CodeStarConnectionsSourceAction({
      actionName: "GitHub",
      owner,
      repo,
      branch: config.branch,
      connectionArn: config.connectionArn,
      output: sourceOutput,
      // The build needs the history, not a zip: the rollback checks out the last good commit.
      codeBuildCloneOutput: true,
      // The trigger below says when to start; the action does not also detect changes.
      triggerOnPush: false,
    });
    this.pipeline = new codepipeline.Pipeline(this, "Pipeline", {
      pipelineName: PIPELINE_NAME,
      pipelineType: codepipeline.PipelineType.V2,
      // One execution in the Deploy stage at a time, and a waiting one is replaced by a newer one.
      // Tasks come from the ledger, not from the commit that added them, so skipping an intermediate
      // commit loses nothing, and the tip is what gets deployed.
      executionMode: codepipeline.ExecutionMode.SUPERSEDED,
      restartExecutionOnUpdate: false,
      triggers: [
        {
          providerType: codepipeline.ProviderType.CODE_STAR_SOURCE_CONNECTION,
          gitConfiguration: {
            sourceAction: source,
            pushFilter: [{ branchesIncludes: [config.branch] }],
          },
        },
      ],
      stages: [
        { stageName: "Source", actions: [source] },
        {
          stageName: "Deploy",
          actions: [
            new cpActions.CodeBuildAction({
              actionName: "CheckDeploySmokeTasks",
              project: this.project,
              input: sourceOutput,
              environmentVariables: {
                COMMIT_ID: { value: source.variables.commitId },
                EXECUTION_ID: { value: codepipeline.GlobalVariables.executionId },
                MONITORING_MINUTES: { value: String(config.monitoringMinutes) },
              },
            }),
          ],
        },
      ],
    });

    // ---- The backstop -------------------------------------------------------------------------
    // The run reports what it knows to the topic itself. This is for a build that dies before it
    // can (a failed install or check, an expired connection).
    const failed = new cloudwatch.Alarm(this, "AlarmBuildFailed", {
      alarmName: "kiro-remote-deploy-pipeline-build-failed",
      alarmDescription:
        "A run of the kiro-remote deploy pipeline failed: a failed check, a refused deploy, a rollback, a frozen pipeline or a build that crashed. Read the run's output first (docs/pipeline.md).",
      metric: this.project.metricFailedBuilds({
        period: cdk.Duration.minutes(5),
        statistic: "Sum",
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    failed.addAlarmAction(new cwActions.SnsAction(this.topic));

    new cdk.CfnOutput(this, "PipelineName", { value: this.pipeline.pipelineName });
    new cdk.CfnOutput(this, "LedgerTableName", { value: this.ledger.tableName });
    new cdk.CfnOutput(this, "NotifyTopicArn", { value: this.topic.topicArn });
    new cdk.CfnOutput(this, "RunnerRoleArn", { value: runner.roleArn });
    new cdk.CfnOutput(this, "BuildLogGroup", { value: logGroup.logGroupName });
  }
}

type Where = { account: string; region: string };

/** The deploy role: the CDK bootstrap roles, and the preflight's reads (deploy.sh's guards). */
export function deployStatements(
  { account, region }: Where,
  bootstrapRole: (kind: string) => string,
): iam.PolicyStatement[] {
  return [
    new iam.PolicyStatement({
      sid: "CdkBootstrapRoles",
      actions: ["sts:AssumeRole"],
      resources: ["deploy", "file-publishing", "image-publishing", "lookup"].map(bootstrapRole),
    }),
    // deploy.sh's guard: the service stack exists in this region, so a wrong region fails here.
    new iam.PolicyStatement({
      sid: "PreflightStacks",
      actions: ["cloudformation:DescribeStacks"],
      resources: [SERVICE_STACK_NAME, DNS_STACK_NAME].map(
        (s) => `arn:aws:cloudformation:${region}:${account}:stack/${s}/*`,
      ),
    }),
    // The secrets the settings name exist (names only, never values).
    new iam.PolicyStatement({
      sid: "PreflightSecrets",
      actions: ["secretsmanager:DescribeSecret"],
      resources: [`arn:aws:secretsmanager:${region}:${account}:secret:${SERVICE_SECRET_PREFIX}*`],
    }),
  ];
}

/** The smoke role: exactly what the checks call (`smoke/checks.ts`), and nothing that reads session data. */
export function smokeStatements({ account, region }: Where): iam.PolicyStatement[] {
  return [
    new iam.PolicyStatement({
      sid: "DescribeTheStacks",
      actions: ["cloudformation:DescribeStacks", "cloudformation:ListStackResources"],
      resources: [SERVICE_STACK_NAME, DNS_STACK_NAME].map(
        (s) => `arn:aws:cloudformation:${region}:${account}:stack/${s}/*`,
      ),
    }),
    // The functions' configuration: runtime, tracing and environment (names and ARNs, never a secret).
    new iam.PolicyStatement({
      sid: "DescribeTheFunctions",
      actions: ["lambda:GetFunctionConfiguration"],
      resources: [`arn:aws:lambda:${region}:${account}:function:${SERVICE_NAME_PREFIX}*`],
    }),
    // The facade client's branding style. Not a user: no ListUsers, no AdminGetUser.
    new iam.PolicyStatement({
      sid: "DescribeTheBranding",
      actions: ["cognito-idp:DescribeManagedLoginBrandingByClient"],
      resources: [`arn:aws:cognito-idp:${region}:${account}:userpool/*`],
    }),
    // A secret's metadata, never its value.
    new iam.PolicyStatement({
      sid: "DescribeTheSecrets",
      actions: ["secretsmanager:DescribeSecret"],
      resources: [`arn:aws:secretsmanager:${region}:${account}:secret:${SERVICE_SECRET_PREFIX}*`],
    }),
    // How many messages wait, never a message.
    new iam.PolicyStatement({
      sid: "CountTheQueues",
      actions: ["sqs:GetQueueAttributes"],
      resources: [`arn:aws:sqs:${region}:${account}:${SERVICE_NAME_PREFIX}*`],
    }),
    // The sweep's schedule: its rate, whether it is enabled, and what it targets.
    new iam.PolicyStatement({
      sid: "DescribeTheSchedules",
      actions: ["events:DescribeRule", "events:ListTargetsByRule"],
      resources: [`arn:aws:events:${region}:${account}:rule/${SERVICE_NAME_PREFIX}*`],
    }),
    // How often a function ran, as a count. CloudWatch has no resource-level permission for this
    // read; it returns numbers per metric, never a log line or an item.
    new iam.PolicyStatement({
      sid: "CountTheInvocations",
      actions: ["cloudwatch:GetMetricStatistics"],
      resources: ["*"],
    }),
  ];
}

/** The build, in order. Kept here (not in a file of the repo) so a commit cannot change what the pipeline's role runs before the checks. */
export function buildSpec(): Record<string, unknown> {
  return {
    version: "0.2",
    env: { variables: { CI: "true", MISE_YES: "1", MISE_VERSION } },
    phases: {
      install: {
        commands: [
          // 1. The freeze flag, before anything is installed or run. Fails closed: if it cannot be read, it is frozen.
          `if aws ssm get-parameter --name ${FREEZE_PARAMETER} --query Parameter.Value --output text > /tmp/frozen 2> /tmp/frozen.err; then echo "PIPELINE FROZEN: nothing was deployed, checked or run."; cat /tmp/frozen; echo "After fixing it, clear the flag with: ./scripts/pipeline.sh unfreeze"; exit 1; fi`,
          `if ! grep -q ParameterNotFound /tmp/frozen.err; then echo "PIPELINE FROZEN: the freeze flag could not be read, so it is treated as set:"; cat /tmp/frozen.err; exit 1; fi`,
          // 2. Node and pnpm, as .mise.toml pins them for everyone.
          "curl -fsSL https://mise.run | sh",
          'export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"',
          "mise install",
        ],
      },
      pre_build: {
        commands: [
          'export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"',
          "node --version && pnpm --version",
          "pnpm install --frozen-lockfile",
          // 3. The repository's checks, so a commit that would not pass them never deploys.
          "pnpm check",
        ],
      },
      build: {
        commands: [
          'export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"',
          // 4 onwards: settings, preflight, synth, deploy, smoke, tasks, rollback, freeze, ledger (deploy.toml).
          "pnpm --filter @nikovirtala/kiro-remote-pipeline exec deploy run",
        ],
      },
    },
  };
}
