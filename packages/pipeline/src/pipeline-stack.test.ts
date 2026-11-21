import * as cdk from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  FREEZE_PARAMETER,
  LEDGER_TABLE_NAME,
  PIPELINE_NAME,
  REGION,
  ROLE_NAMES,
  TASK_ROLE_PREFIX,
} from "./names.ts";
import { PLACEHOLDER_CONNECTION_ARN, readPipelineContext } from "./pipeline-config.ts";
import { buildSpec, PipelineStack } from "./pipeline-stack.ts";

function synth(context: Record<string, string> = {}) {
  const app = new cdk.App({ context });
  const stack = new PipelineStack(app, "KiroRemotePipelineStack", {
    env: { account: "123456789012", region: REGION },
    config: readPipelineContext(app.node),
  });
  return Template.fromStack(stack);
}

type Statement = { Sid?: string; Action: string | string[]; Resource: unknown };
function roleStatements(t: Template, name: string): Statement[] {
  const roles = t.findResources("AWS::IAM::Role", { Properties: { RoleName: name } });
  const [id, role] = Object.entries(roles)[0] ?? [];
  if (!id || !role) throw new Error(`no role ${name}`);
  const inline = (
    (role.Properties as { Policies?: Array<{ PolicyDocument: { Statement: Statement[] } }> })
      .Policies ?? []
  ).flatMap((p) => p.PolicyDocument.Statement);
  const attached = Object.values(t.findResources("AWS::IAM::Policy"))
    .filter((p) =>
      (p.Properties as { Roles: Array<{ Ref: string }> }).Roles.some((r) => r.Ref === id),
    )
    .flatMap(
      (p) =>
        (p.Properties as { PolicyDocument: { Statement: Statement[] } }).PolicyDocument.Statement,
    );
  return [...inline, ...attached];
}
const actionsOf = (statements: Statement[]): string[] =>
  statements.flatMap((s) => [s.Action].flat());

describe("the pipeline stack", () => {
  const t = synth();

  it("is CodePipeline V2, SUPERSEDED, with a source from CodeConnections and one CodeBuild action", () => {
    t.hasResourceProperties("AWS::CodePipeline::Pipeline", {
      Name: PIPELINE_NAME,
      PipelineType: "V2",
      ExecutionMode: "SUPERSEDED",
      Stages: [
        {
          Name: "Source",
          Actions: [
            Match.objectLike({
              ActionTypeId: Match.objectLike({ Provider: "CodeStarSourceConnection" }),
              Configuration: Match.objectLike({
                ConnectionArn: PLACEHOLDER_CONNECTION_ARN,
                FullRepositoryId: "nikovirtala/kiro-remote",
                BranchName: "main",
                OutputArtifactFormat: "CODEBUILD_CLONE_REF",
              }),
            }),
          ],
        },
        {
          Name: "Deploy",
          Actions: [
            Match.objectLike({ ActionTypeId: Match.objectLike({ Provider: "CodeBuild" }) }),
          ],
        },
      ],
    });
  });

  it("keeps the ledger through any destroy: retained, deletion-protected, with point-in-time recovery", () => {
    t.hasResource("AWS::DynamoDB::Table", {
      DeletionPolicy: "Retain",
      Properties: Match.objectLike({
        TableName: LEDGER_TABLE_NAME,
        DeletionProtectionEnabled: true,
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      }),
    });
  });

  it("references nothing of the service stack, so the service's deploy never touches it", () => {
    expect(JSON.stringify(t.toJSON())).not.toContain("Fn::ImportValue");
  });

  it("builds on ARM with Docker, for the bridge's linux/arm64 image", () => {
    t.hasResourceProperties("AWS::CodeBuild::Project", {
      Environment: Match.objectLike({ Type: "ARM_CONTAINER", PrivilegedMode: true }),
    });
  });

  it("subscribes the notification email only when one is given", () => {
    t.resourceCountIs("AWS::SNS::Subscription", 0);
    synth({ pipelineAlarmEmail: "ops@example.com" }).hasResourceProperties(
      "AWS::SNS::Subscription",
      { Protocol: "email", Endpoint: "ops@example.com" },
    );
  });

  it("checks the freeze flag before it installs anything, then the checks, then the run", () => {
    const phases = (buildSpec() as { phases: Record<string, { commands: string[] }> }).phases;
    const all = [
      ...(phases.install?.commands ?? []),
      ...(phases.pre_build?.commands ?? []),
      ...(phases.build?.commands ?? []),
    ];
    const at = (needle: string): number => all.findIndex((c) => c.includes(needle));
    expect(at(FREEZE_PARAMETER)).toBe(0);
    expect(all[0]).toContain("PIPELINE FROZEN");
    expect(all[1]).toContain("ParameterNotFound"); // anything but "does not exist" counts as frozen
    expect(at("mise.run")).toBeGreaterThan(at("ParameterNotFound"));
    expect(at("pnpm install --frozen-lockfile")).toBeGreaterThan(at("mise install"));
    expect(at("pnpm check")).toBeGreaterThan(at("pnpm install --frozen-lockfile"));
    expect(at("exec deploy run")).toBeGreaterThan(at("pnpm check"));
  });
});

describe("the roles", () => {
  const t = synth();

  it("are the runner (the build's role) and the work roles it assumes, each trusted by the runner only", () => {
    t.hasResourceProperties("AWS::IAM::Role", {
      RoleName: ROLE_NAMES.runner,
      AssumeRolePolicyDocument: {
        Statement: [Match.objectLike({ Principal: { Service: "codebuild.amazonaws.com" } })],
      },
    });
    for (const name of [ROLE_NAMES.deploy, ROLE_NAMES.smoke]) {
      t.hasResourceProperties("AWS::IAM::Role", {
        RoleName: name,
        MaxSessionDuration: 3600,
        AssumeRolePolicyDocument: {
          Statement: [
            Match.objectLike({
              Principal: { AWS: `arn:aws:iam::123456789012:role/${ROLE_NAMES.runner}` },
            }),
          ],
        },
      });
    }
  });

  it("the runner deploys nothing, clears no flag and deletes no ledger item", () => {
    const actions = actionsOf(roleStatements(t, ROLE_NAMES.runner));
    for (const forbidden of [
      "ssm:DeleteParameter",
      "dynamodb:DeleteItem",
      "dynamodb:UpdateItem",
      "cloudformation:UpdateStack",
      "iam:PassRole",
    ])
      expect(actions).not.toContain(forbidden);
    expect(
      actions.filter(
        (a) => a.startsWith("cloudformation:") || a.startsWith("lambda:") || a.startsWith("s3:"),
      ),
    ).toEqual(
      // CodePipeline's own grant to the build role for the artifact bucket is attached by CDK.
      actions.filter((a) => a.startsWith("s3:")),
    );
  });

  it("the runner may assume the deploy, smoke and task roles and no other", () => {
    const assume = roleStatements(t, ROLE_NAMES.runner).find((s) => s.Sid === "AssumeTheWorkRoles");
    expect(JSON.stringify(assume?.Resource)).toContain(`role/${TASK_ROLE_PREFIX}*`);
    expect(JSON.stringify(assume?.Resource)).not.toContain("cdk-hnb659fds");
  });

  it("the smoke role reads no session data: no item, no object, no log line, no secret value, no user, no key", () => {
    const actions = actionsOf(roleStatements(t, ROLE_NAMES.smoke));
    for (const a of actions) {
      expect(a, a).not.toMatch(
        /^(dynamodb:|s3:|logs:|kms:|sqs:ReceiveMessage|secretsmanager:GetSecretValue|cognito-idp:(List|AdminGet))/,
      );
      expect(a, a).toMatch(/:(Describe|Get|List)/);
    }
  });

  it("the deploy role reaches CloudFormation only through the CDK bootstrap roles of this region", () => {
    const st = roleStatements(t, ROLE_NAMES.deploy);
    expect(actionsOf(st).filter((a) => a.startsWith("cloudformation:"))).toEqual([
      "cloudformation:DescribeStacks",
    ]);
    const bootstrap = JSON.stringify(st.find((s) => s.Sid === "CdkBootstrapRoles")?.Resource);
    expect(bootstrap).toContain("cdk-hnb659fds-deploy-role");
    expect(bootstrap).toContain(REGION);
  });
});
