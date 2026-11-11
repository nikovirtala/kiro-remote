/**
 * CDK assertions for the optional GitHub feature (githubAppSecretArn).
 *
 *  - OFF (no ARN): nothing is deployed for it, and the bridge/API are as before.
 *  - ON: the webhook route, queue + DLQ, consumer, and 15-minute redelivery
 *    schedule exist; exactly the webhook and consumer roles can read the App
 *    secret; the route has no authorizer; cdk-nag passes.
 */

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
    t.resourceCountIs("AWS::SQS::Queue", 2); // command FIFO and catch-up only
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
    t.resourceCountIs("AWS::SQS::Queue", 4); // + the GitHub queue and its DLQ
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

  test("only the webhook and consumer roles can read the App secret", () => {
    const policies = Object.entries(t.findResources("AWS::IAM::Policy"));
    const readers = policies
      .filter(([, p]) => JSON.stringify(p).includes(SECRET_ARN))
      .map(([id]) => id)
      .sort();
    expect(readers).toHaveLength(2);
    expect(readers.some((id) => id.includes("GithubWebhookFn"))).toBe(true);
    expect(readers.some((id) => id.includes("GithubConsumerFn"))).toBe(true);
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

  test("prTrailer and autoCloseOnMerge are configurable", () => {
    const t2 = synthStack({
      githubAppSecretArn: SECRET_ARN,
      githubPrTrailer: "off",
      githubAutoCloseOnMerge: "after_turn",
    });
    const consumer = functionsByLogicalIdPart(t2, "GithubConsumerFn")[0][1] as {
      Properties: { Environment: { Variables: Record<string, unknown> } };
    };
    expect(consumer.Properties.Environment.Variables.GITHUB_AUTO_CLOSE_ON_MERGE).toBe("after_turn");
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
