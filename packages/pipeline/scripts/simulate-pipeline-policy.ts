#!/usr/bin/env node
/**
 * Evaluates the roles of the deploy pipeline (src/pipeline-stack.ts) with IAM's own policy evaluation
 * engine (`iam simulate-custom-policy`), on the policies as synthesized, before the bootstrap:
 *
 *   pnpm --filter @nikovirtala/kiro-remote-pipeline synth
 *   node packages/pipeline/scripts/simulate-pipeline-policy.ts [path/to/KiroRemotePipelineStack.template.json]
 *   node packages/pipeline/scripts/simulate-pipeline-policy.ts --deployed   # the roles as deployed (simulate-principal-policy)
 *
 * Read-only: the simulate calls evaluate a policy and change nothing. Needs the AWS CLI and
 * credentials that may call iam:SimulateCustomPolicy (and iam:SimulatePrincipalPolicy and
 * iam:GetRole with --deployed). Ported from longplay's simulate-deploy-pipeline-policy.ts.
 *
 * Two kinds of decision, with a REFUSAL next to every grant:
 *  - what each role may do (its identity policy): the runner, the deploy role and the smoke role
 *    (no read of session data), and each task role;
 *  - who may become each role (its trust policy): the runner and no one else. The simulator does not
 *    evaluate trust policies (longplay found it answers implicitDeny for a named role too), so trust
 *    is decided by `trustAllows`, which handles exactly the two shapes the stack emits.
 * What it cannot prove: that the CDK bootstrap roles accept the deploy role (they trust the account),
 * or that CodeBuild's role session satisfies a trust that names the runner (the first run shows both).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  FREEZE_PARAMETER,
  GITHUB_TOKEN_SECRET,
  LEDGER_TABLE_NAME,
  NOTIFY_TOPIC_NAME,
  PIPELINE_STACK_NAME,
  ROLE_NAMES,
  SETTINGS_PREFIX,
  TASK_ROLE_PREFIX,
} from "../src/names.ts";
import { TASK_ROLES } from "../src/task-roles.ts";

const ACCOUNT = "123456789012";
const REGION = "eu-north-1";
const arn = (service: string, rest: string, region = REGION): string =>
  `arn:aws:${service}:${region}:${ACCOUNT}:${rest}`;
const role = (name: string): string => `arn:aws:iam::${ACCOUNT}:role/${name}`;

const LEDGER = arn("dynamodb", `table/${LEDGER_TABLE_NAME}`);
const SESSIONS = arn("dynamodb", "table/KiroRemoteStack-KiroRemoteTable897F2E95-PD0FG9HY0M7D");
const SWEEP_RULE = arn("events", "rule/KiroRemoteStack-KiroRemoteGithubSweepSchedule-XyZ");
const OTHER_RULE = arn("events", "rule/some-other-teams-rule");
const TOPIC = arn("sns", NOTIFY_TOPIC_NAME);
const OTHER_TOPIC = arn("sns", "somebody-elses-topic");
const FREEZE = arn("ssm", `parameter${FREEZE_PARAMETER}`);
const SETTING = arn("ssm", `parameter${SETTINGS_PREFIX}KIRO_API_KEY_SECRET_ARN`);
const SETTINGS_PATH = arn("ssm", `parameter${SETTINGS_PREFIX.replace(/\/$/, "")}`);
const OTHER_PARAMETER = arn("ssm", "parameter/longplay/pipeline/frozen");
const CDK = (kind: string, region = REGION): string =>
  role(`cdk-hnb659fds-${kind}-role-${ACCOUNT}-${region}`);
const KIRO_KEY = arn("secretsmanager", "secret:kiro-remote/kiro-api-key-AbC123");
const GITHUB_APP = arn("secretsmanager", "secret:kiro-remote/github-app-AbC123");
const GITHUB_TOKEN = arn("secretsmanager", `secret:${GITHUB_TOKEN_SECRET}-AbC123`);
const OTHER_SECRET = arn("secretsmanager", "secret:spotify-new-releases-poller/token-AbC123");
const SERVICE_STACK = arn(
  "cloudformation",
  "stack/KiroRemoteStack/0f1e2d3c-0000-0000-0000-000000000000",
);
const DNS_STACK = arn(
  "cloudformation",
  "stack/KiroRemoteDnsStack/0f1e2d3c-0000-0000-0000-000000000000",
);
const OTHER_STACK = arn(
  "cloudformation",
  "stack/artifact-prod-platform/0f1e2d3c-0000-0000-0000-000000000000",
);
const API_FN = arn("lambda", "function:KiroRemoteStack-KiroRemoteApiFnAEA3E115-OmSHqsW9kQ4R");
const OTHER_FN = arn("lambda", "function:SpotifyNewReleasesPoller-Poller-Fn");
const POOL = arn("cognito-idp", "userpool/eu-north-1_f7watYE0D");
const DLQ = arn("sqs", "KiroRemoteStack-KiroRemoteGithubDlqC543AD13-kUGw4lT2cpKh");
const COMMAND_QUEUE = arn(
  "sqs",
  "KiroRemoteStack-KiroRemoteCommandQueuefifo27BBE5E2-Kkt4XUIx4Su0.fifo",
);
const BUCKET = "arn:aws:s3:::kiroremotestack-kiroremotepayloadbucket47e35ff6-bn3vsxamtlnc";
const LOGS = arn(
  "logs",
  "log-group:/aws/lambda/KiroRemoteStack-KiroRemoteApiFnAEA3E115-OmSHqsW9kQ4R:*",
);
const KEY = arn("kms", "key/ebecd41c-f527-4a30-bc95-1860d17923a6");

export interface RoleCase {
  readonly role: string;
  readonly action: string;
  readonly resource: string;
  readonly expected: "allowed" | "implicitDeny";
  readonly why: string;
}
const allow = (r: string, action: string, resource: string, why: string): RoleCase => ({
  role: r,
  action,
  resource,
  expected: "allowed",
  why,
});
const deny = (r: string, action: string, resource: string, why: string): RoleCase => ({
  role: r,
  action,
  resource,
  expected: "implicitDeny",
  why,
});

const RUNNER = ROLE_NAMES.runner;
const RUNNER_CASES: RoleCase[] = [
  allow(RUNNER, "ssm:GetParametersByPath", SETTINGS_PATH, "read the settings"),
  allow(RUNNER, "ssm:GetParameter", SETTING, "read one setting"),
  deny(RUNNER, "ssm:PutParameter", SETTING, "settings come from a person, never from the build"),
  deny(RUNNER, "ssm:DeleteParameter", SETTING, "same"),
  allow(RUNNER, "ssm:GetParameter", FREEZE, "read the freeze flag"),
  allow(RUNNER, "ssm:PutParameter", FREEZE, "set the freeze flag"),
  deny(RUNNER, "ssm:DeleteParameter", FREEZE, "only a person clears the flag"),
  deny(RUNNER, "ssm:GetParameter", OTHER_PARAMETER, "no other parameter"),
  ...["GetItem", "PutItem", "Query", "Scan"].map((a) =>
    allow(RUNNER, `dynamodb:${a}`, LEDGER, "the ledger"),
  ),
  ...["DeleteItem", "UpdateItem", "DeleteTable", "BatchWriteItem"].map((a) =>
    deny(
      RUNNER,
      `dynamodb:${a}`,
      LEDGER,
      "a ledger entry is removed by a person (deploy forget), never by the build",
    ),
  ),
  deny(RUNNER, "dynamodb:GetItem", SESSIONS, "the sessions table"),
  allow(RUNNER, "sns:Publish", TOPIC, "tell the pipeline's topic"),
  deny(RUNNER, "sns:Publish", OTHER_TOPIC, "no other topic"),
  deny(RUNNER, "sns:DeleteTopic", TOPIC, "publish only"),
  allow(
    RUNNER,
    "secretsmanager:GetSecretValue",
    GITHUB_TOKEN,
    "the token that records GitHub deployments",
  ),
  deny(RUNNER, "secretsmanager:GetSecretValue", KIRO_KEY, "never the Kiro API key"),
  deny(RUNNER, "secretsmanager:GetSecretValue", GITHUB_APP, "never the GitHub App's key"),
  deny(
    RUNNER,
    "secretsmanager:PutSecretValue",
    GITHUB_TOKEN,
    "it reads the token and changes nothing",
  ),
  allow(RUNNER, "sts:AssumeRole", role(ROLE_NAMES.deploy), "the deploy role"),
  allow(RUNNER, "sts:AssumeRole", role(ROLE_NAMES.smoke), "the smoke role"),
  ...TASK_ROLES.map((r) =>
    allow(RUNNER, "sts:AssumeRole", role(r.name), `the task role ${r.name}`),
  ),
  allow(
    RUNNER,
    "sts:AssumeRole",
    role(`${TASK_ROLE_PREFIX}a-task-added-later`),
    `any ${TASK_ROLE_PREFIX}* role`,
  ),
  deny(
    RUNNER,
    "sts:AssumeRole",
    CDK("deploy"),
    "the CDK bootstrap roles are the deploy role's, not the build's",
  ),
  deny(RUNNER, "sts:AssumeRole", CDK("file-publishing"), "same"),
  deny(
    RUNNER,
    "sts:AssumeRole",
    role("KiroRemoteStack-KiroRemoteApiFnServiceRole-AbC"),
    "a service function's role",
  ),
  deny(RUNNER, "sts:AssumeRole", role("OrganizationAccountAccessRole"), "an administrator role"),
  deny(RUNNER, "sts:AssumeRole", role(RUNNER), "itself"),
  deny(
    RUNNER,
    "sts:AssumeRole",
    role("kiro-remote-deployment-taskx"),
    "a name that only starts like a task role",
  ),
  deny(RUNNER, "cloudformation:UpdateStack", SERVICE_STACK, "it deploys nothing"),
  deny(RUNNER, "cloudformation:DescribeStacks", SERVICE_STACK, "it reads nothing of the service"),
  deny(RUNNER, "s3:GetObject", `${BUCKET}/payloads/x`, "it reads no data"),
  deny(RUNNER, "lambda:InvokeFunction", API_FN, "it invokes nothing"),
  deny(
    RUNNER,
    "iam:PassRole",
    role("KiroRemoteStack-KiroRemoteApiFnServiceRole-AbC"),
    "it passes no role",
  ),
];

const DEPLOY = ROLE_NAMES.deploy;
const DEPLOY_CASES: RoleCase[] = [
  ...["deploy", "file-publishing", "image-publishing", "lookup"].map((k) =>
    allow(DEPLOY, "sts:AssumeRole", CDK(k), `the CDK ${k} role`),
  ),
  deny(
    DEPLOY,
    "sts:AssumeRole",
    CDK("deploy", "us-east-1"),
    "the bootstrap roles of another region",
  ),
  deny(DEPLOY, "sts:AssumeRole", role("OrganizationAccountAccessRole"), "an administrator role"),
  deny(DEPLOY, "sts:AssumeRole", role(ROLE_NAMES.smoke), "another pipeline role"),
  deny(DEPLOY, "sts:AssumeRole", role(`${TASK_ROLE_PREFIX}x`), "a task role"),
  allow(
    DEPLOY,
    "cloudformation:DescribeStacks",
    SERVICE_STACK,
    "preflight: the service stack exists in this region",
  ),
  allow(DEPLOY, "cloudformation:DescribeStacks", DNS_STACK, "and the DNS stack"),
  deny(DEPLOY, "cloudformation:DescribeStacks", OTHER_STACK, "no other stack"),
  deny(
    DEPLOY,
    "cloudformation:DeleteStack",
    SERVICE_STACK,
    "it goes through the bootstrap roles; the role itself cannot delete",
  ),
  deny(DEPLOY, "cloudformation:UpdateStack", SERVICE_STACK, "same"),
  allow(
    DEPLOY,
    "secretsmanager:DescribeSecret",
    KIRO_KEY,
    "preflight: the Kiro API key secret exists",
  ),
  allow(
    DEPLOY,
    "secretsmanager:DescribeSecret",
    GITHUB_APP,
    "preflight: the GitHub App secret exists",
  ),
  deny(DEPLOY, "secretsmanager:DescribeSecret", OTHER_SECRET, "only kiro-remote's secrets"),
  deny(DEPLOY, "secretsmanager:GetSecretValue", KIRO_KEY, "never a value"),
  deny(DEPLOY, "iam:CreateRole", role("anything"), "no IAM of its own"),
  deny(DEPLOY, "dynamodb:PutItem", LEDGER, "it cannot write the ledger"),
  deny(DEPLOY, "ssm:PutParameter", FREEZE, "it cannot set the flag"),
  deny(DEPLOY, "ssm:DeleteParameter", FREEZE, "or clear it"),
  deny(DEPLOY, "dynamodb:Scan", SESSIONS, "it reads no session"),
];

const INDEX_TASK = `${TASK_ROLE_PREFIX}index-sweep`;
const TASK_CASES: RoleCase[] = [
  allow(
    INDEX_TASK,
    "dynamodb:Scan",
    `${SESSIONS}/index/GSI1`,
    "the scan runs on the index, for keys",
  ),
  allow(INDEX_TASK, "dynamodb:UpdateItem", SESSIONS, "it adds the two index keys"),
  deny(INDEX_TASK, "dynamodb:Scan", SESSIONS, "never the table itself"),
  deny(INDEX_TASK, "dynamodb:Scan", `${SESSIONS}/index/GSI2`, "no other index"),
  ...["GetItem", "Query", "BatchGetItem"].map((a) =>
    deny(INDEX_TASK, `dynamodb:${a}`, SESSIONS, "it reads no item"),
  ),
  deny(INDEX_TASK, "dynamodb:Query", `${SESSIONS}/index/GSI1`, "no query of the index either"),
  deny(INDEX_TASK, "dynamodb:PutItem", SESSIONS, "it adds keys to items, it writes no item"),
  deny(INDEX_TASK, "dynamodb:DeleteItem", SESSIONS, "it deletes nothing"),
  deny(INDEX_TASK, "dynamodb:Scan", LEDGER, "no other table"),
  deny(INDEX_TASK, "dynamodb:UpdateItem", LEDGER, "not the ledger"),
  deny(INDEX_TASK, "s3:GetObject", `${BUCKET}/payloads/x`, "the payload bucket holds session data"),
  deny(INDEX_TASK, "secretsmanager:GetSecretValue", GITHUB_APP, "no secret"),
  deny(INDEX_TASK, "lambda:InvokeFunction", API_FN, "it invokes nothing"),
];

const SMOKE = ROLE_NAMES.smoke;
const SMOKE_CASES: RoleCase[] = [
  allow(SMOKE, "cloudformation:DescribeStacks", SERVICE_STACK, "stack outputs and status"),
  allow(
    SMOKE,
    "cloudformation:ListStackResources",
    SERVICE_STACK,
    "the functions and queues of the stack",
  ),
  allow(SMOKE, "cloudformation:DescribeStacks", DNS_STACK, "the DNS stack's status"),
  deny(SMOKE, "cloudformation:DescribeStacks", OTHER_STACK, "no other stack"),
  deny(SMOKE, "cloudformation:UpdateStack", SERVICE_STACK, "reads only"),
  allow(SMOKE, "lambda:GetFunctionConfiguration", API_FN, "runtime, tracing and environment"),
  deny(SMOKE, "lambda:GetFunctionConfiguration", OTHER_FN, "only the service's functions"),
  deny(SMOKE, "lambda:InvokeFunction", API_FN, "it invokes nothing"),
  deny(SMOKE, "lambda:UpdateFunctionConfiguration", API_FN, "reads only"),
  allow(
    SMOKE,
    "cognito-idp:DescribeManagedLoginBrandingByClient",
    POOL,
    "the facade client's branding style",
  ),
  deny(SMOKE, "cognito-idp:ListUsers", POOL, "a user is session data: no list of users"),
  deny(SMOKE, "cognito-idp:AdminGetUser", POOL, "and no user"),
  allow(SMOKE, "secretsmanager:DescribeSecret", KIRO_KEY, "the Kiro API key secret exists"),
  deny(SMOKE, "secretsmanager:GetSecretValue", KIRO_KEY, "never its value"),
  deny(SMOKE, "secretsmanager:GetSecretValue", GITHUB_APP, "never the GitHub App's key"),
  deny(SMOKE, "secretsmanager:DescribeSecret", OTHER_SECRET, "only kiro-remote's secrets"),
  allow(SMOKE, "sqs:GetQueueAttributes", DLQ, "how many messages wait in the dead-letter queue"),
  deny(SMOKE, "sqs:ReceiveMessage", DLQ, "never a message"),
  allow(SMOKE, "events:DescribeRule", SWEEP_RULE, "the sweep's schedule: its rate and state"),
  allow(SMOKE, "events:ListTargetsByRule", SWEEP_RULE, "and what it targets"),
  deny(SMOKE, "events:DescribeRule", OTHER_RULE, "only the service's schedules"),
  deny(SMOKE, "events:PutRule", SWEEP_RULE, "it changes no schedule"),
  deny(SMOKE, "events:DisableRule", SWEEP_RULE, "it cannot switch one off"),
  deny(SMOKE, "events:PutTargets", SWEEP_RULE, "or retarget it"),
  allow(SMOKE, "cloudwatch:GetMetricStatistics", "*", "how often a function ran, as a count"),
  deny(SMOKE, "cloudwatch:PutMetricData", "*", "it writes no metric"),
  deny(SMOKE, "cloudwatch:GetMetricData", "*", "only the one read the sweep check makes"),
  deny(SMOKE, "sqs:ReceiveMessage", COMMAND_QUEUE, "never a command"),
  ...["GetItem", "Query", "Scan", "BatchGetItem"].map((a) =>
    deny(SMOKE, `dynamodb:${a}`, SESSIONS, "the sessions table holds session data"),
  ),
  deny(SMOKE, "dynamodb:Query", LEDGER, "nor the ledger: the runner keeps it"),
  deny(SMOKE, "s3:GetObject", `${BUCKET}/payloads/x`, "the payload bucket holds session data"),
  deny(SMOKE, "s3:ListBucket", BUCKET, "not even the names of the objects"),
  deny(SMOKE, "logs:FilterLogEvents", LOGS, "logs can hold session content"),
  deny(SMOKE, "logs:GetLogEvents", LOGS, "same"),
  deny(SMOKE, "logs:StartQuery", LOGS, "same"),
  deny(SMOKE, "kms:Decrypt", KEY, "no key use"),
  deny(SMOKE, "ssm:GetParameter", FREEZE, "the flag is the runner's"),
];

export const CASES: readonly RoleCase[] = [
  ...RUNNER_CASES,
  ...DEPLOY_CASES,
  ...SMOKE_CASES,
  ...TASK_CASES,
];
export const ROLE_ORDER: readonly string[] = [
  RUNNER,
  DEPLOY,
  SMOKE,
  ...TASK_ROLES.map((r) => r.name),
];

// ---- Trust ----------------------------------------------------------------------------------

export interface TrustDocument {
  readonly Statement: ReadonlyArray<{
    Effect: string;
    Action: string | string[];
    Principal: { AWS?: string | string[]; Service?: string | string[] };
    Condition?: unknown;
  }>;
}
export interface Caller {
  readonly kind: "role" | "service" | "root";
  readonly arn?: string;
  readonly service?: string;
}

/** Whether a trust policy of the two shapes the stack emits lets the caller assume the role. Anything else is a refusal. */
export function trustAllows(doc: TrustDocument, caller: Caller): boolean {
  return doc.Statement.some((s) => {
    if (s.Effect !== "Allow" || s.Condition !== undefined) return false;
    if (![s.Action].flat().includes("sts:AssumeRole")) return false;
    if (caller.kind === "service")
      return [s.Principal.Service ?? []].flat().includes(caller.service ?? "?");
    const aws = [s.Principal.AWS ?? []].flat();
    return caller.arn !== undefined && aws.includes(caller.arn);
  });
}

export interface TrustCase {
  readonly role: string;
  readonly caller: Caller;
  readonly expected: boolean;
  readonly why: string;
}

const RUNNER_CALLER: Caller = { kind: "role", arn: role(RUNNER) };
export const TRUST_CASES: readonly TrustCase[] = [
  {
    role: RUNNER,
    caller: { kind: "service", service: "codebuild.amazonaws.com" },
    expected: true,
    why: "the build service",
  },
  {
    role: RUNNER,
    caller: { kind: "service", service: "lambda.amazonaws.com" },
    expected: false,
    why: "no other service",
  },
  {
    role: RUNNER,
    caller: { kind: "role", arn: role("KiroWebRole") },
    expected: false,
    why: "the agent's read-only role",
  },
  {
    role: RUNNER,
    caller: { kind: "root", arn: `arn:aws:iam::${ACCOUNT}:root` },
    expected: false,
    why: "the account is not trusted",
  },
  ...ROLE_ORDER.filter((r) => r !== RUNNER).flatMap((r): TrustCase[] => [
    { role: r, caller: RUNNER_CALLER, expected: true, why: "the runner" },
    {
      role: r,
      caller: { kind: "service", service: "codebuild.amazonaws.com" },
      expected: false,
      why: "the build service itself (it is the runner that assumes)",
    },
    {
      role: r,
      caller: { kind: "role", arn: role("KiroRemoteStack-KiroRemoteApiFnServiceRole-AbC") },
      expected: false,
      why: "a service function's role",
    },
    {
      role: r,
      caller: { kind: "role", arn: role("KiroWebRole") },
      expected: false,
      why: "the agent's read-only role",
    },
    {
      role: r,
      caller: { kind: "role", arn: role(ROLE_NAMES.deploy) },
      expected: false,
      why: "another pipeline role",
    },
    {
      role: r,
      caller: { kind: "role", arn: role(`cdk-hnb659fds-deploy-role-${ACCOUNT}-${REGION}`) },
      expected: false,
      why: "a CDK bootstrap role",
    },
    {
      role: r,
      caller: { kind: "role", arn: `arn:aws:iam::999999999999:role/${RUNNER}` },
      expected: false,
      why: "a role of the same name in another account",
    },
    {
      role: r,
      caller: { kind: "root", arn: `arn:aws:iam::${ACCOUNT}:root` },
      expected: false,
      why: "the account root: no one else in the account",
    },
  ]),
];

// ---- Reading the template ---------------------------------------------------------------------

type Statement = {
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Condition?: unknown;
  Sid?: string;
};
// biome-ignore lint/suspicious/noExplicitAny: CloudFormation properties
type Resources = Record<string, { Type: string; Properties: Record<string, any> }>;
export type Template = { Resources: Resources };

function resolver(template: Template): (value: unknown) => unknown {
  const pseudo: Record<string, string> = {
    "AWS::Partition": "aws",
    "AWS::Region": REGION,
    "AWS::AccountId": ACCOUNT,
    "AWS::URLSuffix": "amazonaws.com",
  };
  const arnOf = (logicalId: string): string => {
    const r = template.Resources[logicalId];
    switch (r?.Type) {
      case "AWS::DynamoDB::Table":
        return arn("dynamodb", `table/${String(r.Properties.TableName)}`);
      case "AWS::SNS::Topic":
        return arn("sns", String(r.Properties.TopicName));
      case "AWS::Logs::LogGroup":
        return arn("logs", `log-group:${String(r.Properties.LogGroupName)}`);
      default:
        // What CDK adds on its own (the artifact bucket, its key, the build project): nothing a case asks about.
        return arn("example", `${String(r?.Type)}/${logicalId}`);
    }
  };
  const resolve = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null) return value;
    if (Array.isArray(value)) return value.map(resolve);
    const o = value as Record<string, unknown>;
    if ("Fn::GetAtt" in o) return arnOf((o["Fn::GetAtt"] as string[])[0] as string);
    if ("Ref" in o && typeof o.Ref === "string")
      return o.Ref in pseudo ? pseudo[o.Ref] : arnOf(o.Ref);
    if ("Fn::Join" in o) {
      const [sep, parts] = o["Fn::Join"] as [string, unknown[]];
      return (parts.map(resolve) as string[]).join(sep);
    }
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, resolve(v)]));
  };
  return (v) =>
    JSON.parse(JSON.stringify(resolve(v)).replace(/(?<!\d)\d{12}(?!\d)/g, ACCOUNT)) as unknown;
}

function findRole(template: Template, roleName: string): [string, Resources[string]] {
  const found = Object.entries(template.Resources).find(
    ([, r]) => r.Type === "AWS::IAM::Role" && r.Properties.RoleName === roleName,
  );
  if (!found) throw new Error(`no role ${roleName} in the template`);
  return found;
}

/** The statements of a role: its inline policy and every policy attached to it, with the tokens replaced by example values. */
export function pipelineRoleStatements(template: Template, roleName: string): Statement[] {
  const [id, r] = findRole(template, roleName);
  const resolve = resolver(template);
  const inline = (r.Properties.Policies ?? []).flatMap(
    (p: { PolicyDocument: { Statement: unknown[] } }) => p.PolicyDocument.Statement,
  );
  const attached = Object.values(template.Resources)
    .filter(
      (x) =>
        x.Type === "AWS::IAM::Policy" &&
        (x.Properties.Roles as Array<{ Ref: string }>).some((ref) => ref.Ref === id),
    )
    .flatMap((x) => (x.Properties.PolicyDocument as { Statement: unknown[] }).Statement);
  return resolve([...inline, ...attached]) as Statement[];
}

export function pipelineRoleTrust(template: Template, roleName: string): TrustDocument {
  return resolver(template)(
    findRole(template, roleName)[1].Properties.AssumeRolePolicyDocument,
  ) as TrustDocument;
}

interface Evaluation {
  EvaluationResults: { EvalActionName: string; EvalResourceName: string; EvalDecision: string }[];
}
function simulate(args: string[]): Evaluation {
  return JSON.parse(
    execFileSync("aws", ["iam", ...args, "--output", "json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  ) as Evaluation;
}

function main(): void {
  const deployed = process.argv.includes("--deployed");
  const file =
    process.argv.slice(2).find((a) => !a.startsWith("--")) ??
    path.join(
      import.meta.dirname,
      "..",
      "cdk.out.pipeline",
      `${PIPELINE_STACK_NAME}.template.json`,
    );
  const account = (
    JSON.parse(
      execFileSync("aws", ["sts", "get-caller-identity", "--output", "json"], { encoding: "utf8" }),
    ) as { Account: string }
  ).Account;
  const template = deployed ? undefined : (JSON.parse(fs.readFileSync(file, "utf8")) as Template);
  let wrong = 0;
  for (const name of ROLE_ORDER) {
    const cases = CASES.filter((c) => c.role === name);
    const policy = template
      ? JSON.stringify({ Version: "2012-10-17", Statement: pipelineRoleStatements(template, name) })
      : undefined;
    console.log(
      `\n${name}: ${cases.filter((c) => c.expected === "allowed").length} grants, ${cases.filter((c) => c.expected !== "allowed").length} refusals`,
    );
    for (const c of cases) {
      const resource = deployed ? c.resource.replaceAll(ACCOUNT, account) : c.resource;
      const base = deployed
        ? [
            "simulate-principal-policy",
            "--policy-source-arn",
            `arn:aws:iam::${account}:role/${name}`,
          ]
        : ["simulate-custom-policy", "--policy-input-list", policy as string];
      const result = simulate([...base, "--action-names", c.action, "--resource-arns", resource])
        .EvaluationResults[0];
      const got = result?.EvalDecision ?? "no result";
      const ok = got === c.expected;
      if (!ok) wrong++;
      console.log(
        `${ok ? "ok      " : "MISMATCH"} ${got === "allowed" ? "allowed " : "refused "} ${c.action.padEnd(50)} ${resource.split(":").slice(5).join(":").slice(0, 48).padEnd(48)} ${c.why}`,
      );
    }
  }
  console.log("\ntrust:");
  for (const name of ROLE_ORDER) {
    let doc: TrustDocument;
    if (template) doc = pipelineRoleTrust(template, name);
    else {
      doc = (
        JSON.parse(
          execFileSync("aws", ["iam", "get-role", "--role-name", name, "--output", "json"], {
            encoding: "utf8",
          }),
        ) as { Role: { AssumeRolePolicyDocument: TrustDocument } }
      ).Role.AssumeRolePolicyDocument;
      doc = JSON.parse(JSON.stringify(doc).replaceAll(account, ACCOUNT)) as TrustDocument;
    }
    const cases = TRUST_CASES.filter((c) => c.role === name);
    const bad = cases.filter((c) => trustAllows(doc, c.caller) !== c.expected);
    wrong += bad.length;
    console.log(
      `${bad.length === 0 ? "ok      " : "MISMATCH"} ${name}: ${cases.filter((c) => c.expected).length} caller(s) trusted, ${cases.filter((c) => !c.expected).length} refused${bad.map((c) => `\n          wrong for ${c.caller.arn ?? c.caller.service}: ${c.why}`).join("")}`,
    );
  }
  console.log(
    wrong === 0
      ? `\nOK: ${CASES.length} policy decisions and ${TRUST_CASES.length} trust decisions match`
      : `\n${wrong} MISMATCH(ES)`,
  );
  process.exit(wrong === 0 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
