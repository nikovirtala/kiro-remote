/**
 * The smoke checks against a fake account shaped like the deployed one (the outputs, functions and
 * queues of KiroRemoteStack as `describe-stacks`, `list-stack-resources` and
 * `get-function-configuration` return them), and the rule that ties them to the smoke role: every
 * AWS call a check makes is an action the role is granted, and a read-only one.
 */

import {
  type AwsRunner,
  dryRunChecks,
  isReadOnlyCommand,
  runChecks,
} from "@nikovirtala/deployment";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { afterEach, describe, expect, it } from "vitest";
import { REGION } from "../names.ts";
import { readPipelineContext } from "../pipeline-config.ts";
import { PipelineStack, smokeStatements } from "../pipeline-stack.ts";
import { CHECKS, parseResourceAttributes } from "./checks.ts";

const COMMIT = "9bb4f62677da076832417924196766b5006babdb";
const ORIGIN = "https://kiro-remote.nikovirtala.dev";
const API = "https://exasb4746j.execute-api.eu-north-1.amazonaws.com";
const GITHUB_QUEUE_URL =
  "https://sqs.eu-north-1.amazonaws.com/1/KiroRemoteStack-KiroRemoteGithubQueue";
const OTEL = `vcs.ref.head.revision=${COMMIT},vcs.repository.url.full=https://github.com/nikovirtala/kiro-remote,deployment.environment.name=production,service.version=${COMMIT}`;

interface World {
  /** The sweep's schedule: present, or not deployed (a stack without GitHub wake has none). */
  sweep: {
    rule?: { state: string; expression: string };
    targets: string[];
    invocations: number;
    /** Minutes since the function last changed. */
    changedMinutesAgo: number;
  } | null;
  outputs: Record<string, string>;
  branding: boolean;
  functions: Array<{
    logicalId: string;
    name: string;
    image?: boolean;
    runtime?: string;
    env: Record<string, string>;
    tracing?: string;
  }>;
  status: Record<string, number>;
  /** What a POST to /mcp without a token gets, per protocol era. */
  mcp: Record<"legacy" | "modern", { status: number; challenge?: string }>;
}

const zip = (logicalId: string, extra: Record<string, string> = {}) => ({
  logicalId,
  name: `KiroRemoteStack-${logicalId}-AbC`,
  runtime: "nodejs26.x",
  env: { POWERTOOLS_SERVICE_NAME: "kiro-remote-api", OTEL_RESOURCE_ATTRIBUTES: OTEL, ...extra },
});
const image = (logicalId: string) => ({
  logicalId,
  name: `KiroRemoteStack-${logicalId}-AbC`,
  image: true,
  env: {
    POWERTOOLS_SERVICE_NAME: "kiro-remote-bridge",
    TZ: "UTC",
    KIRO_API_KEY_SECRET_ARN:
      "arn:aws:secretsmanager:eu-north-1:827333031966:secret:kiro-remote/kiro-api-key-x1y2z3",
    COMMAND_QUEUE_URL: "https://sqs.eu-north-1.amazonaws.com/827333031966/command.fifo",
    OTEL_RESOURCE_ATTRIBUTES: OTEL,
  },
});

const SWEEP_FN_ARN = "arn:aws:lambda:eu-north-1:827333031966:function:KiroRemoteStack-Sweep-AbC";

function healthy(): World {
  return {
    sweep: {
      rule: { state: "ENABLED", expression: "rate(15 minutes)" },
      targets: [SWEEP_FN_ARN],
      invocations: 3,
      changedMinutesAgo: 24 * 60,
    },
    outputs: {
      UserPoolId: "eu-north-1_f7watYE0D",
      FacadeClientId: "client",
      ApiUrl: API,
      ManagedLoginDomainUrl: "https://kiro-remote.auth.eu-north-1.amazoncognito.com",
      McpResourceIdentifier: `${ORIGIN}/mcp`,
      CustomDomainTarget: "d-x.execute-api.eu-north-1.amazonaws.com",
      CustomDomainHostedZoneId: "Z3UWIKFBOOGXPP",
    },
    branding: true,
    functions: [
      zip("KiroRemoteApiFnAEA3E115", { GITHUB_QUEUE_URL }),
      zip("KiroRemoteOAuthTokenFn282F6F1C"),
      image("KiroRemoteBridgeConsumerFn322E483B"),
      image("KiroRemoteCatchUpFn7627B437"),
      zip("KiroRemoteGithubSweepFn9A1B2C3D", { POWERTOOLS_SERVICE_NAME: "kiro-remote-github" }),
    ],
    status: {
      "/openapi.json": 200,
      "/.well-known/oauth-protected-resource/mcp": 200,
      "/.well-known/oauth-authorization-server": 200,
      "/v1/sessions": 401,
      "/mcp": 401,
    },
    mcp: {
      legacy: {
        status: 401,
        challenge: `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
      },
      modern: {
        status: 401,
        challenge: `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
      },
    },
  };
}

function fakeAccount(w: World) {
  const calls: string[] = [];
  const aws: AwsRunner = (service, command, args = []) => {
    calls.push(`${service} ${command}`);
    const arg = (flag: string) => args[args.indexOf(flag) + 1];
    if (service === "cloudformation" && command === "describe-stacks") {
      if (arg("--stack-name") === "KiroRemoteDnsStack")
        return { Stacks: [{ StackStatus: "CREATE_COMPLETE" }] };
      return {
        Stacks: [
          {
            StackStatus: "UPDATE_COMPLETE",
            Outputs: Object.entries(w.outputs).map(([OutputKey, OutputValue]) => ({
              OutputKey,
              OutputValue,
            })),
          },
        ],
      };
    }
    if (service === "cloudformation" && command === "list-stack-resources") {
      return {
        StackResourceSummaries: [
          ...w.functions.map((f) => ({
            LogicalResourceId: f.logicalId,
            PhysicalResourceId: f.name,
            ResourceType: "AWS::Lambda::Function",
          })),
          {
            LogicalResourceId: "AWSCDKTriggerCustomResourceProviderFn",
            PhysicalResourceId: "KiroRemoteStack-AWSCDKTrigger",
            ResourceType: "AWS::Lambda::Function",
          },
          {
            LogicalResourceId: "KiroRemoteGithubQueue5B1C4A07",
            PhysicalResourceId: GITHUB_QUEUE_URL,
            ResourceType: "AWS::SQS::Queue",
          },
          ...(w.sweep
            ? [
                {
                  LogicalResourceId: "KiroRemoteGithubSweepScheduleE1F2A3B4",
                  PhysicalResourceId: "KiroRemoteStack-KiroRemoteGithubSweepSchedule-XyZ",
                  ResourceType: "AWS::Events::Rule",
                },
              ]
            : []),
          {
            LogicalResourceId: "KiroRemoteGithubDlqC543AD13",
            PhysicalResourceId:
              "https://sqs.eu-north-1.amazonaws.com/1/KiroRemoteStack-KiroRemoteGithubDlq",
            ResourceType: "AWS::SQS::Queue",
          },
        ],
      };
    }
    if (service === "events" && command === "describe-rule") {
      if (!w.sweep?.rule) throw new Error("ResourceNotFoundException");
      return { State: w.sweep.rule.state, ScheduleExpression: w.sweep.rule.expression };
    }
    if (service === "events" && command === "list-targets-by-rule")
      return { Targets: (w.sweep?.targets ?? []).map((Arn) => ({ Arn })) };
    if (service === "cloudwatch" && command === "get-metric-statistics") {
      // The window is two intervals: 30 minutes for a 15 minute schedule.
      expect(arg("--period")).toBe("1800");
      return {
        Datapoints: w.sweep && w.sweep.invocations > 0 ? [{ Sum: w.sweep.invocations }] : [],
      };
    }
    if (service === "lambda" && command === "get-function-configuration") {
      const f = w.functions.find((x) => x.name === arg("--function-name"));
      if (!f) throw new Error("ResourceNotFoundException");
      return {
        FunctionName: f.name,
        FunctionArn: f.logicalId.includes("GithubSweepFn")
          ? SWEEP_FN_ARN
          : `arn:aws:lambda:eu-north-1:827333031966:function:${f.name}`,
        LastModified: new Date(
          Date.now() -
            (f.logicalId.includes("GithubSweepFn") ? (w.sweep?.changedMinutesAgo ?? 0) : 0) *
              60_000,
        ).toISOString(),
        PackageType: f.image ? "Image" : "Zip",
        Runtime: f.image ? undefined : f.runtime,
        TracingConfig: { Mode: f.tracing ?? "Active" },
        Environment: { Variables: f.env },
      };
    }
    if (service === "cognito-idp") {
      if (!w.branding) throw new Error("An error occurred (ResourceNotFoundException)");
      return { ManagedLoginBranding: { ManagedLoginBrandingId: "b-1" } };
    }
    if (service === "secretsmanager") return "kiro-remote/kiro-api-key";
    if (service === "sqs") return { Attributes: { ApproximateNumberOfMessages: "0" } };
    throw new Error(`unexpected call aws ${service} ${command}`);
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.origin === API ? "api:" : ""}${url.pathname}`);
    // A POST to /mcp is answered by its own entry, per era (the 2026-07-28 request names its version).
    const headers = new Headers(init?.headers);
    const era = headers.get("mcp-protocol-version") === "2026-07-28" ? "modern" : "legacy";
    if (method === "POST" && url.pathname === "/mcp") {
      const answer = w.mcp[era];
      return new Response(JSON.stringify({}), {
        status: answer.status,
        headers: {
          "content-type": "application/json",
          ...(answer.challenge ? { "www-authenticate": answer.challenge } : {}),
        },
      });
    }
    const status = w.status[url.pathname] ?? 404;
    const body =
      url.pathname === "/openapi.json"
        ? { openapi: "3.1.0" }
        : url.pathname.includes("protected-resource")
          ? { resource: `${ORIGIN}/mcp` }
          : url.pathname.includes("authorization-server")
            ? { issuer: ORIGIN }
            : {};
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { aws, fetch: fetchImpl, calls };
}

afterEach(() => {
  delete process.env.DEPLOY_COMMIT;
});

describe("the smoke checks", () => {
  it("pass on a healthy deploy, with nothing but PASS and INFO", async () => {
    process.env.DEPLOY_COMMIT = COMMIT;
    const { aws, fetch } = fakeAccount(healthy());
    const results = await runChecks(CHECKS, { aws, fetch });
    expect(results.filter((r) => r.status !== "PASS" && r.status !== "INFO")).toEqual([]);
    expect(results.filter((r) => r.status === "INFO").map((r) => r.task)).toEqual(["queues"]);
    expect(results.filter((r) => r.task === "sweep").map((r) => r.status)).toEqual([
      "PASS",
      "PASS",
      "PASS",
      "PASS",
    ]);
    expect(results.length).toBeGreaterThan(20);
  });

  it("fail when the API does not name the GitHub queue", async () => {
    process.env.DEPLOY_COMMIT = COMMIT;
    const w = healthy();
    delete w.functions[0].env.GITHUB_QUEUE_URL;
    const { aws, fetch } = fakeAccount(w);
    const failed = (await runChecks(CHECKS, { aws, fetch })).filter((r) => r.status === "FAIL");
    expect(failed.map((r) => r.name)).toEqual([
      "the API names the GitHub queue (waits for pull requests)",
    ]);
  });

  it("fail when the API function is not the one carrying the queue", async () => {
    process.env.DEPLOY_COMMIT = COMMIT;
    const w = healthy();
    w.functions[0].env.GITHUB_QUEUE_URL = "https://sqs.eu-north-1.amazonaws.com/1/other";
    const { aws, fetch } = fakeAccount(w);
    const failed = (await runChecks(CHECKS, { aws, fetch })).filter((r) => r.status === "FAIL");
    expect(failed).toHaveLength(1);
  });

  describe("the sweep", () => {
    const sweepResults = async (w: World) => {
      const { aws, fetch } = fakeAccount(w);
      return (await runChecks(CHECKS, { aws, fetch })).filter((r) => r.task === "sweep");
    };

    it("is INFO, not FAIL, on its first deploy: the function changed within two intervals and has not run", async () => {
      const w = healthy();
      (w.sweep as NonNullable<World["sweep"]>).invocations = 0;
      (w.sweep as NonNullable<World["sweep"]>).changedMinutesAgo = 5;
      const results = await sweepResults(w);
      expect(results.map((r) => r.status)).toEqual(["PASS", "PASS", "PASS", "INFO"]);
      expect(results[3].detail).toContain("not run yet");
    });

    it("fails when it has not run for two intervals and was not just deployed", async () => {
      const w = healthy();
      (w.sweep as NonNullable<World["sweep"]>).invocations = 0;
      const results = await sweepResults(w);
      expect(results.filter((r) => r.status === "FAIL").map((r) => r.detail)).toEqual([
        "no invocation",
      ]);
    });

    it.each([
      [
        "a disabled schedule",
        (s: NonNullable<World["sweep"]>) => {
          s.rule = { state: "DISABLED", expression: "rate(15 minutes)" };
        },
      ],
      [
        "a schedule that is not a fixed rate",
        (s: NonNullable<World["sweep"]>) => {
          s.rule = { state: "ENABLED", expression: "cron(0 * * * ? *)" };
        },
      ],
      [
        "a schedule that targets another function",
        (s: NonNullable<World["sweep"]>) => {
          s.targets = ["arn:aws:lambda:eu-north-1:827333031966:function:other"];
        },
      ],
    ])("fails on %s", async (_what, change) => {
      const w = healthy();
      change(w.sweep as NonNullable<World["sweep"]>);
      expect((await sweepResults(w)).some((r) => r.status === "FAIL")).toBe(true);
    });

    it("fails when GitHub wake is deployed without the sweep's schedule", async () => {
      const w = healthy();
      w.sweep = null;
      const results = await sweepResults(w);
      expect(results.map((r) => [r.status, r.detail])).toEqual([["FAIL", "no schedule"]]);
    });

    it("measures the window from the schedule's own rate", async () => {
      const w = healthy();
      (w.sweep as NonNullable<World["sweep"]>).rule = {
        state: "ENABLED",
        expression: "rate(1 minute)",
      };
      const { aws, fetch } = fakeAccount(w);
      const seen: string[] = [];
      const spy: AwsRunner = (service, command, args = []) => {
        if (command === "get-metric-statistics")
          seen.push(args[args.indexOf("--period") + 1] ?? "");
        return aws(service, command, args);
      };
      await runChecks(CHECKS, { aws: spy, fetch }).catch(() => undefined);
      expect(seen[0]).toBe("120");
    });
  });

  it("fail when a function runs another commit than the one deployed, or carries none", async () => {
    process.env.DEPLOY_COMMIT = "a".repeat(40);
    const w = healthy();
    w.functions.push(zip("KiroRemoteGithubWebhookFnCDEE4EF6", { OTEL_RESOURCE_ATTRIBUTES: "" }));
    const { aws, fetch } = fakeAccount(w);
    const failed = (await runChecks(CHECKS, { aws, fetch })).filter((r) => r.status === "FAIL");
    expect(failed.filter((r) => r.task === "provenance")).toHaveLength(6);
    expect(failed.find((r) => r.name.startsWith("KiroRemoteGithubWebhookFn"))?.detail).toBe(
      "no vcs.ref.head.revision",
    );
  });

  it.each([
    [
      "no branding style for the facade client",
      (w: World) => {
        w.branding = false;
      },
      "auth",
    ],
    [
      "a route that answers without a token",
      (w: World) => {
        w.status["/v1/sessions"] = 200;
      },
      "api",
    ],
    [
      "/mcp answering a 2026-07-28 request without a token",
      (w: World) => {
        w.mcp.modern = { status: 200 };
      },
      "api",
    ],
    [
      "/mcp answering a 2025-06-18 request without a token",
      (w: World) => {
        w.mcp.legacy = { status: 200 };
      },
      "api",
    ],
    [
      "a 401 from /mcp that does not name the resource metadata",
      (w: World) => {
        w.mcp.modern = { status: 401, challenge: "Bearer" };
      },
      "api",
    ],
    ["a missing named output", (w: World) => void delete w.outputs.FacadeClientId, "outputs"],
    [
      "a function off Node 26",
      (w: World) => {
        (w.functions[0] as { runtime?: string }).runtime = "nodejs24.x";
      },
      "functions",
    ],
    [
      "a bridge function without TZ=UTC",
      (w: World) => void delete (w.functions[2] as { env: Record<string, string> }).env.TZ,
      "functions",
    ],
    [
      "a bridge function that cannot start a queued prompt (no COMMAND_QUEUE_URL)",
      (w: World) =>
        void delete (w.functions[3] as { env: Record<string, string> }).env.COMMAND_QUEUE_URL,
      "queued-prompts",
    ],
    [
      "a function with the Kiro API key as a plain variable",
      (w: World) => {
        (w.functions[0] as { env: Record<string, string> }).env.KIRO_API_KEY = "ksk_x";
      },
      "secrets",
    ],
  ])("fail on %s", async (_what, change, task) => {
    const w = healthy();
    change(w);
    const { aws, fetch } = fakeAccount(w);
    const failed = (await runChecks(CHECKS, { aws, fetch })).filter((r) => r.status === "FAIL");
    expect(failed.map((r) => r.task)).toContain(task);
  });

  it("read the resource attributes the deploy stamps", () => {
    expect(parseResourceAttributes(OTEL)["vcs.repository.url.full"]).toBe(
      "https://github.com/nikovirtala/kiro-remote",
    );
    expect(parseResourceAttributes("service.version=1.0%20beta")).toEqual({
      "service.version": "1.0 beta",
    });
    expect(parseResourceAttributes(undefined)).toEqual({});
  });
});

describe("the smoke role and the checks", () => {
  /** The IAM action of an AWS CLI sub-command: `get-function-configuration` -> `GetFunctionConfiguration`. */
  const action = (call: string): string => {
    const [service = "", command = ""] = call.split(" ");
    return `${service}:${command
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join("")}`;
  };

  it("every AWS call of every check is a read-only call the smoke role is granted", async () => {
    const { aws, fetch, calls } = fakeAccount(healthy());
    await runChecks(CHECKS, { aws, fetch });
    const awsCalls = [
      ...new Set(calls.filter((c) => !c.startsWith("GET ") && !c.startsWith("POST "))),
    ];
    expect(awsCalls.length).toBeGreaterThan(4);
    const granted = new Set(
      smokeStatements({ account: "1", region: REGION })
        .flatMap((s) => s.toStatementJson().Action as string | string[])
        .flat(),
    );
    for (const c of awsCalls) {
      const [service = "", command = ""] = c.split(" ");
      expect(isReadOnlyCommand(service, command), c).toBe(true);
      expect(granted.has(action(c)), `${c} needs ${action(c)} in smokeStatements`).toBe(true);
    }
  });

  it("the role in the template is the one the checks were held to", () => {
    const app = new cdk.App();
    const t = Template.fromStack(
      new PipelineStack(app, "P", {
        env: { account: "123456789012", region: REGION },
        config: readPipelineContext(app.node),
      }),
    );
    const json = JSON.stringify(
      t.findResources("AWS::IAM::Role", {
        Properties: { RoleName: "kiro-remote-deployment-smoke" },
      }),
    );
    for (const s of smokeStatements({ account: "1", region: REGION }))
      for (const a of [s.toStatementJson().Action].flat() as string[]) expect(json).toContain(a);
  });

  it("dry-run without calling anything, and every planned call is read-only", async () => {
    const planned = await dryRunChecks(CHECKS);
    expect(planned.map((p) => p.task)).toEqual([
      "stack",
      "outputs",
      "auth",
      "api",
      "functions",
      "secrets",
      "provenance",
      "queued-prompts",
      "queues",
      "sweep",
    ]);
    expect(planned.flatMap((p) => p.calls).every((c) => c.readOnly)).toBe(true);
  });
});
