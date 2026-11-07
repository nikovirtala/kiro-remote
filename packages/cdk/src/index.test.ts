import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { expect, test } from "vitest";
import { PACKAGE_NAME } from "./index.ts";
import { KiroRemoteStack } from "./stack.ts";

test("cdk package exposes its name", () => {
  expect(PACKAGE_NAME).toBe("@nikovirtala/kiro-remote-cdk");
});

test("the stack emits the named CfnOutputs operators look up", () => {
  const app = new App();
  const stack = new KiroRemoteStack(app, "KiroRemoteStack", {
    env: { account: "111111111111", region: "eu-west-1" },
    kiroRemote: {
      publicBaseUrl: "https://kiro.example.com",
      cognitoDomainPrefix: "kiro-remote-test",
      allowedRepos: ["acme/*"],
    },
  });
  const template = Template.fromStack(stack);

  for (const logicalId of [
    "UserPoolId",
    "FacadeClientId",
    "ApiUrl",
    "ManagedLoginDomainUrl",
    "McpResourceIdentifier",
  ]) {
    template.hasOutput(logicalId, Match.objectLike({ Description: Match.anyValue() }));
  }
  // Without a custom domain the custom-domain outputs are absent (opt-in).
  expect(Object.keys(template.findOutputs("CustomDomainTarget")).length).toBe(0);
});

test("a custom domain adds the CustomDomainTarget output the operator CNAMEs to", () => {
  const app = new App();
  const stack = new KiroRemoteStack(app, "KiroRemoteStack", {
    env: { account: "111111111111", region: "eu-north-1" },
    kiroRemote: {
      publicBaseUrl: "https://kiro-remote.example.dev",
      cognitoDomainPrefix: "kiro-remote-test",
      allowedRepos: ["acme/*"],
      customDomain: { domainName: "kiro-remote.example.dev" },
    },
  });
  const template = Template.fromStack(stack);

  for (const logicalId of ["CustomDomainTarget", "CustomDomainHostedZoneId"]) {
    template.hasOutput(logicalId, Match.objectLike({ Description: Match.anyValue() }));
  }
});
