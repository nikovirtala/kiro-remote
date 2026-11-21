/** The policy simulation's cases: a refusal beside every grant, every role covered, and the trust evaluator. */
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import {
  CASES,
  type Template as CfnTemplate,
  pipelineRoleStatements,
  pipelineRoleTrust,
  ROLE_ORDER,
  TRUST_CASES,
  trustAllows,
} from "../scripts/simulate-pipeline-policy.ts";
import { REGION } from "./names.ts";
import { readPipelineContext } from "./pipeline-config.ts";
import { PipelineStack } from "./pipeline-stack.ts";

const app = new cdk.App();
const template = Template.fromStack(
  new PipelineStack(app, "KiroRemotePipelineStack", {
    env: { account: "827333031966", region: REGION },
    config: readPipelineContext(app.node),
  }),
).toJSON() as CfnTemplate;

describe("the policy simulation's cases", () => {
  it("cover every role, with at least as many refusals as grants for each", () => {
    for (const role of ROLE_ORDER) {
      const cases = CASES.filter((c) => c.role === role);
      const grants = cases.filter((c) => c.expected === "allowed").length;
      expect(grants, role).toBeGreaterThan(0);
      expect(cases.length - grants, role).toBeGreaterThanOrEqual(grants);
    }
  });

  it("put a refusal beside every grant: the same action elsewhere, or another action on the same resource", () => {
    for (const g of CASES.filter((c) => c.expected === "allowed")) {
      const beside = CASES.some(
        (c) =>
          c.role === g.role &&
          c.expected !== "allowed" &&
          (c.action === g.action ||
            c.resource === g.resource ||
            c.action.split(":")[0] === g.action.split(":")[0]),
      );
      expect(beside, `${g.role} ${g.action} ${g.resource}`).toBe(true);
    }
  });

  it("ask only about roles and statements the template has", () => {
    for (const role of ROLE_ORDER)
      expect(pipelineRoleStatements(template, role).length, role).toBeGreaterThan(0);
  });

  it("decide trust as the stack emits it: the runner by the build service, every work role by the runner alone", () => {
    for (const c of TRUST_CASES)
      expect(
        trustAllows(pipelineRoleTrust(template, c.role), c.caller),
        `${c.role}: ${c.why}`,
      ).toBe(c.expected);
  });

  it("refuse a trust policy shape the evaluator does not understand", () => {
    const conditional = {
      Statement: [
        {
          Effect: "Allow",
          Action: "sts:AssumeRole",
          Principal: { AWS: "arn:aws:iam::1:role/r" },
          Condition: { Bool: { x: "true" } },
        },
      ],
    };
    expect(trustAllows(conditional, { kind: "role", arn: "arn:aws:iam::1:role/r" })).toBe(false);
  });
});
