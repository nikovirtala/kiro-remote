/**
 * cdk-nag assertion tests.
 *
 * cdk-nag v3 reports findings through CDK's policy-validation framework: when a
 * plugin reports a violation, `app.synth()` is INTERRUPTED. So the "no
 * un-suppressed AwsSolutions error" gate is simply: synth the app with the
 * AwsSolutions plugin applied and every intentional finding acknowledged, and
 * assert synth does NOT throw. The negative control asserts that WITHOUT the
 * acknowledgments synth DOES throw -- proving the gate is live.
 */

import { App, Stack } from "aws-cdk-lib";
import { describe, expect, test } from "vitest";
import { KiroRemote } from "./construct.ts";
import { KiroRemoteDnsStack } from "./dns-stack.ts";
import { applyAwsSolutionsChecks, suppressIntentionalFindings } from "./nag.ts";
import { KiroRemoteStack } from "./stack.ts";

const KIRO_REMOTE_PROPS = {
  publicBaseUrl: "https://kiro.example.com",
  cognitoDomainPrefix: "kiro-remote-test",
  allowedRepos: ["acme/*"],
};
const ENV = { account: "111111111111", region: "us-east-1" };

describe("cdk-nag AwsSolutions", () => {
  test("synth succeeds with every intentional finding acknowledged", () => {
    const app = new App();
    // KiroRemoteStack acknowledges every intentional finding in its ctor.
    new KiroRemoteStack(app, "KiroRemoteStack", { env: ENV, kiroRemote: KIRO_REMOTE_PROPS });
    applyAwsSolutionsChecks(app);
    expect(() => app.synth()).not.toThrow();
  });

  test("synth FAILS when the intentional findings are not acknowledged (gate is live)", () => {
    const app = new App();
    // A bare stack with the raw construct and NO acknowledgments.
    const stack = new Stack(app, "Unsuppressed", { env: ENV });
    new KiroRemote(stack, "KiroRemote", KIRO_REMOTE_PROPS);
    applyAwsSolutionsChecks(app);
    expect(() => app.synth()).toThrow();
  });

  test("suppressIntentionalFindings can be applied to a stack explicitly", () => {
    const app = new App();
    const stack = new Stack(app, "Explicit", { env: ENV });
    new KiroRemote(stack, "KiroRemote", KIRO_REMOTE_PROPS);
    suppressIntentionalFindings(stack);
    applyAwsSolutionsChecks(app);
    expect(() => app.synth()).not.toThrow();
  });

  test("synth with a custom domain stays green (ACM cert + DomainName add no un-acknowledged finding)", () => {
    const app = new App();
    new KiroRemoteStack(app, "KiroRemoteStack", {
      env: ENV,
      kiroRemote: { ...KIRO_REMOTE_PROPS, customDomain: { domainName: "kiro.example.dev" } },
    });
    applyAwsSolutionsChecks(app);
    expect(() => app.synth()).not.toThrow();
  });

  test("synth with a Route 53 custom domain stays green (cert + alias records add no finding)", () => {
    const app = new App();
    new KiroRemoteStack(app, "KiroRemoteStack", {
      env: ENV,
      kiroRemote: {
        ...KIRO_REMOTE_PROPS,
        customDomain: {
          domainName: "kiro-remote.example.dev",
          hostedZoneId: "Z123EXAMPLE",
          zoneName: "kiro-remote.example.dev",
        },
      },
    });
    applyAwsSolutionsChecks(app);
    expect(() => app.synth()).not.toThrow();
  });

  test("synth of the DNS stack stays green (public hosted zone adds no un-acknowledged finding)", () => {
    const app = new App();
    new KiroRemoteDnsStack(app, "KiroRemoteDnsStack", {
      env: ENV,
      zoneName: "kiro-remote.example.dev",
    });
    applyAwsSolutionsChecks(app);
    expect(() => app.synth()).not.toThrow();
  });
});
