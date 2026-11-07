/**
 * CDK assertion tests for the KiroRemoteDnsStack (aws-cdk-lib/assertions).
 *
 * The DNS stack is deployed FIRST to create the delegated subdomain's Route 53
 * public hosted zone; the operator reads its outputs to delegate the zone at
 * the parent DNS provider. These tests assert the zone exists for the given
 * name and that the delegation outputs operators copy-paste are present.
 */

import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, test } from "vitest";
import { KiroRemoteDnsStack } from "./dns-stack.ts";

const ENV = { account: "111111111111", region: "eu-north-1" };

describe("KiroRemoteDnsStack", () => {
  function synth(zoneName = "kiro-remote.example.dev"): Template {
    const app = new App();
    const stack = new KiroRemoteDnsStack(app, "KiroRemoteDnsStack", { env: ENV, zoneName });
    return Template.fromStack(stack);
  }

  test("creates exactly one public hosted zone for the delegated subdomain", () => {
    const t = synth();
    t.resourceCountIs("AWS::Route53::HostedZone", 1);
    // Route 53 stores the zone name with a trailing dot.
    t.hasResourceProperties("AWS::Route53::HostedZone", {
      Name: "kiro-remote.example.dev.",
    });
  });

  test("emits the NameServers / HostedZoneId / HostedZoneName outputs", () => {
    const t = synth();
    for (const logicalId of ["NameServers", "HostedZoneId", "HostedZoneName"]) {
      t.hasOutput(logicalId, Match.objectLike({ Description: Match.anyValue() }));
    }
  });

  test("the zone name flows from props (nothing hardcoded)", () => {
    const t = synth("other.example.dev");
    t.hasResourceProperties("AWS::Route53::HostedZone", { Name: "other.example.dev." });
    expect(Object.keys(t.findResources("AWS::Route53::HostedZone")).length).toBe(1);
  });
});
