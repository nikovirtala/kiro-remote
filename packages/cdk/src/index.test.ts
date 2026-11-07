import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { expect, test } from "vitest";
import { PACKAGE_NAME } from "./index.ts";
import { KiroRemoteStack } from "./stack.ts";

test("cdk package exposes its name", () => {
  expect(PACKAGE_NAME).toBe("@nikovirtala/cdk");
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
});
