/**
 * Provenance: a deploy through the pipeline passes the commit, the repository URL and the
 * environment as CDK context (@nikovirtala/deployment's CDK target), and every function of the
 * service gets them as its OpenTelemetry resource attributes. A synth without them stamps nothing.
 */
import { PROVENANCE_CONTEXT, provenanceFromContext } from "@nikovirtala/deployment/cdk";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, test } from "vitest";
import { KiroRemote } from "./construct.ts";

const COMMIT = "9bb4f62677da076832417924196766b5006babdb";

function synth(context: Record<string, string>) {
  const app = new App({ context });
  const stack = new Stack(app, "TestStack", {
    env: { account: "111111111111", region: "eu-north-1" },
  });
  const provenance = provenanceFromContext(app.node);
  new KiroRemote(stack, "KiroRemote", {
    publicBaseUrl: "https://kiro.example.com",
    cognitoDomainPrefix: "kiro-remote-test",
    allowedRepos: ["acme/*"],
    githubAppSecretArn:
      "arn:aws:secretsmanager:eu-north-1:111111111111:secret:kiro-remote/github-app-AbC123",
    ...(provenance ? { provenance } : {}),
  });
  return Template.fromStack(stack);
}

const ownFunctions = (t: Template) =>
  Object.entries(t.findResources("AWS::Lambda::Function")).filter(([id]) =>
    id.startsWith("KiroRemote"),
  );

describe("provenance", () => {
  test("every function of the service carries the deploy's resource attributes", () => {
    const t = synth({
      [PROVENANCE_CONTEXT.commit]: COMMIT,
      [PROVENANCE_CONTEXT.repositoryUrl]: "https://github.com/nikovirtala/kiro-remote",
      [PROVENANCE_CONTEXT.environment]: "production",
    });
    const fns = ownFunctions(t);
    expect(fns.length).toBeGreaterThanOrEqual(8); // API, OAuth callback and token, the three bridge functions, GitHub webhook and consumer
    for (const [id, fn] of fns) {
      const env =
        (fn.Properties as { Environment?: { Variables?: Record<string, string> } }).Environment
          ?.Variables ?? {};
      expect(env.OTEL_RESOURCE_ATTRIBUTES, id).toBe(
        `vcs.ref.head.revision=${COMMIT},vcs.repository.url.full=https://github.com/nikovirtala/kiro-remote,deployment.environment.name=production,service.version=${COMMIT}`,
      );
    }
  });

  test("a synth without the pipeline's context stamps nothing, so its template does not change per commit", () => {
    for (const [id, fn] of ownFunctions(synth({}))) {
      const env =
        (fn.Properties as { Environment?: { Variables?: Record<string, string> } }).Environment
          ?.Variables ?? {};
      expect(env.OTEL_RESOURCE_ATTRIBUTES, id).toBeUndefined();
    }
  });
});
