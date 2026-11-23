/**
 * CDK assertions for the optional GitHub feature (githubAppSecretArn).
 *
 *  - OFF (no ARN): nothing is deployed for it, and the bridge/API are as before.
 *  - ON: the webhook route, queue + DLQ, consumer, the 15-minute redelivery
 *    schedule and the sweep (its own function and schedule) exist; exactly the webhook, consumer
 *    and sweep roles can read the App secret; the route has no authorizer; cdk-nag passes.
 */

import { SWEEP_INTERVAL_MINUTES } from "@nikovirtala/kiro-remote-core";
import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, test } from "vitest";
import { KiroRemote } from "./construct.ts";
import { applyAwsSolutionsChecks } from "./nag.ts";
import { KiroRemoteStack } from "./stack.ts";

const ENV = { account: "111111111111", region: "us-east-1" };
const SECRET_ARN = "arn:aws:secretsmanager:us-east-1:111111111111:secret:kiro-remote/github-AbCdEf";
const BASE = {
  publicBaseUrl: "https://kiro.example.com",
  cognitoDomainPrefix: "kiro-remote-test",
  allowedRepos: ["acme/*"],
};

function synthStack(extra: Record<string, unknown> = {}): Template {
  const app = new App();
  const stack = new Stack(app, "TestStack", { env: ENV });
  new KiroRemote(stack, "KiroRemote", { ...BASE, ...extra });
  return Template.fromStack(stack);
}

function functionsByLogicalIdPart(t: Template, part: string) {
  return Object.entries(t.findResources("AWS::Lambda::Function")).filter(([id]) =>
    id.includes(part),
  );
}

const on = () => synthStack({ githubAppSecretArn: SECRET_ARN, githubTrustedLogins: ["octocat"] });

describe("GitHub feature OFF (no githubAppSecretArn)", () => {
  const t = synthStack();

  test("deploys nothing for it: no route, functions, queues or schedule", () => {
    expect(JSON.stringify(t.toJSON())).not.toContain("github");
    expect(functionsByLogicalIdPart(t, "Github")).toHaveLength(0);
    t.resourceCountIs("AWS::SQS::Queue", 1); // the command FIFO only
    t.resourceCountIs("AWS::Events::Rule", 1); // only the caps publisher schedule
  });

  test("the bridge consumer gets no wake env and the launch prompt gets no trailer", () => {
    const text = JSON.stringify(t.toJSON());
    expect(text).not.toContain("GITHUB_QUEUE_URL");
    expect(text).not.toContain("GITHUB_PR_TRAILER");
  });
});

describe("GitHub feature ON", () => {
  const t = on();

  test("POST /github/webhook is routed with no authorizer", () => {
    t.hasResourceProperties("AWS::ApiGatewayV2::Route", {
      RouteKey: "POST /github/webhook",
      AuthorizationType: "NONE", // the signature check in the function is the auth
    });
  });

  test("a standard queue with a DLQ, and exactly one extra queue pair", () => {
    t.resourceCountIs("AWS::SQS::Queue", 3); // + the GitHub queue and its DLQ
    t.hasResourceProperties("AWS::SQS::Queue", {
      RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }),
    });
  });

  test("the webhook function responds inside GitHub's 10 s limit", () => {
    const [[, fn]] = functionsByLogicalIdPart(t, "GithubWebhookFn");
    expect((fn as { Properties: { Timeout: number } }).Properties.Timeout).toBeLessThan(10);
  });

  test("a 15-minute schedule invokes the consumer with a redeliver event", () => {
    t.hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "rate(15 minutes)",
      Targets: Match.arrayWith([
        Match.objectLike({ Input: JSON.stringify({ kind: "redeliver" }) }),
      ]),
    });
  });

  test("only the webhook, consumer and sweep roles can read the App secret", () => {
    const policies = Object.entries(t.findResources("AWS::IAM::Policy"));
    const readers = policies
      .filter(([, p]) => JSON.stringify(p).includes(SECRET_ARN))
      .map(([id]) => id)
      .sort();
    expect(readers).toHaveLength(3);
    expect(readers.some((id) => id.includes("GithubWebhookFn"))).toBe(true);
    expect(readers.some((id) => id.includes("GithubConsumerFn"))).toBe(true);
    expect(readers.some((id) => id.includes("GithubSweepFn"))).toBe(true);
  });

  test("the table has GSI2, the sweep's index, beside GSI1", () => {
    t.hasResourceProperties("AWS::DynamoDB::Table", {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: "GSI1" }),
        Match.objectLike({
          IndexName: "GSI2",
          KeySchema: [
            { AttributeName: "GSI2PK", KeyType: "HASH" },
            { AttributeName: "GSI2SK", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        }),
      ]),
    });
  });

  test("the sweep is one function on one schedule, with no retry, at the interval core names", () => {
    expect(SWEEP_INTERVAL_MINUTES).toBe(15);
    const [[sweepId, sweep]] = functionsByLogicalIdPart(t, "GithubSweepFn");
    const props = (
      sweep as {
        Properties: {
          Runtime: string;
          Timeout: number;
          TracingConfig: { Mode: string };
          Environment: { Variables: Record<string, unknown> };
        };
      }
    ).Properties;
    expect(props.Runtime).toBe("nodejs26.x");
    expect(props.TracingConfig.Mode).toBe("Active");
    expect(props.Timeout).toBeGreaterThan(120);
    expect(props.Environment.Variables).toMatchObject({
      POWERTOOLS_SERVICE_NAME: "kiro-remote-github",
      GITHUB_QUEUE_URL: expect.anything(),
      COMMAND_QUEUE_URL: expect.anything(),
      TABLE_NAME: expect.anything(),
    });
    const rules = Object.values(t.findResources("AWS::Events::Rule")).filter((r) =>
      JSON.stringify(r).includes(sweepId),
    );
    expect(rules).toHaveLength(1);
    const rule = (rules[0] as { Properties: Record<string, unknown> }).Properties;
    expect(rule.ScheduleExpression).toBe(`rate(${SWEEP_INTERVAL_MINUTES} minutes)`);
    expect(rule.Targets).toEqual([
      expect.objectContaining({ RetryPolicy: { MaximumRetryAttempts: 0 } }),
    ]);
  });

  test("the bridge consumer can send to the command and GitHub queues but cannot read the secret", () => {
    const [[, bridge]] = Object.entries(t.findResources("AWS::Lambda::Function")).filter(([id]) =>
      id.includes("BridgeConsumerFn"),
    );
    const env = (bridge as { Properties: { Environment: { Variables: Record<string, unknown> } } })
      .Properties.Environment.Variables;
    expect(env).toHaveProperty("GITHUB_QUEUE_URL");
    expect(env).toHaveProperty("COMMAND_QUEUE_URL");
    const bridgePolicy = Object.entries(t.findResources("AWS::IAM::Policy")).find(([id]) =>
      id.includes("BridgeConsumerFn"),
    );
    expect(JSON.stringify(bridgePolicy)).not.toContain("kiro-remote/github");
  });

  test("the API gets the trailer switch (default on) and never the secret", () => {
    const api = functionsByLogicalIdPart(t, "ApiFn")[0][1] as {
      Properties: { Environment: { Variables: Record<string, unknown> } };
    };
    expect(api.Properties.Environment.Variables.GITHUB_PR_TRAILER).toBe("on");
    expect(JSON.stringify(api)).not.toContain("GITHUB_APP_SECRET_ARN");
  });

  test("the API can send to the GitHub queue (to have a wait's PR read) and has no secret", () => {
    const api = functionsByLogicalIdPart(t, "ApiFn")[0][1] as {
      Properties: { Environment: { Variables: Record<string, unknown> } };
    };
    expect(api.Properties.Environment.Variables).toHaveProperty("GITHUB_QUEUE_URL");
    const policy = Object.entries(t.findResources("AWS::IAM::Policy")).find(([id]) =>
      id.includes("ApiFnServiceRoleDefaultPolicy"),
    );
    const text = JSON.stringify(policy);
    expect(text).toContain("sqs:SendMessage");
    expect(text).toContain("GithubQueue");
    expect(text).not.toContain("secretsmanager");
    // The OAuth handlers do not get it.
    for (const part of ["OAuthCallbackFn", "OAuthTokenFn"]) {
      const fn = functionsByLogicalIdPart(t, part)[0][1];
      expect(JSON.stringify(fn)).not.toContain("GITHUB_QUEUE_URL");
    }
  });

  test("prTrailer, autoCloseOnMerge and wakeOnBehind are configurable", () => {
    const t2 = synthStack({
      githubAppSecretArn: SECRET_ARN,
      githubPrTrailer: "off",
      githubAutoCloseOnMerge: "after_turn",
      githubWakeOnBehind: "on",
    });
    const consumer = functionsByLogicalIdPart(t2, "GithubConsumerFn")[0][1] as {
      Properties: { Environment: { Variables: Record<string, unknown> } };
    };
    expect(consumer.Properties.Environment.Variables.GITHUB_AUTO_CLOSE_ON_MERGE).toBe("after_turn");
    expect(consumer.Properties.Environment.Variables.GITHUB_WAKE_ON_BEHIND).toBe("on");
    const api = functionsByLogicalIdPart(t2, "ApiFn")[0][1] as {
      Properties: { Environment: { Variables: Record<string, unknown> } };
    };
    expect(api.Properties.Environment.Variables.GITHUB_PR_TRAILER).toBe("off");
  });

  test("cdk-nag passes with the feature on, and the synth is clean", () => {
    const app = new App();
    new KiroRemoteStack(app, "KiroRemoteStack", {
      env: ENV,
      kiroRemote: { ...BASE, githubAppSecretArn: SECRET_ARN },
    });
    applyAwsSolutionsChecks(app);
    expect(() => app.synth()).not.toThrow();
  });
});

describe("GitHub Lambdas Powertools configuration", () => {
  test("the webhook and consumer (also the redelivery target) set Powertools env and active tracing", () => {
    const t = on();
    for (const part of ["GithubWebhookFn", "GithubConsumerFn"]) {
      const fns = functionsByLogicalIdPart(t, part);
      expect(fns.length).toBe(1);
      const props = fns[0]?.[1].Properties;
      expect(props.TracingConfig).toEqual({ Mode: "Active" });
      expect(props.Environment.Variables).toMatchObject({
        POWERTOOLS_SERVICE_NAME: "kiro-remote-github",
        POWERTOOLS_METRICS_NAMESPACE: "KiroRemote",
        POWERTOOLS_LOG_LEVEL: "INFO",
      });
    }
  });
});
