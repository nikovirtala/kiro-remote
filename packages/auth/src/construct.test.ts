/**
 * CDK assertion test for KiroRemoteAuth. Confirms the construct synthesizes a
 * user pool (self-sign-up off, passwordless passkey-first), a resource server with the three
 * scopes, a public no-secret facade client with the right token lifetimes and
 * the single callback URL, and an optional pre-registered client. Full stack
 * assembly + cdk-nag run in FEAT-007; here we only assert the resource graph.
 */

import { App, Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, test } from "vitest";
import { KiroRemoteAuth } from "./construct.ts";

function synth(): Template {
  const app = new App();
  const stack = new Stack(app, "TestStack");
  new KiroRemoteAuth(stack, "Auth", {
    publicBaseUrl: "https://kiro.example.com",
    cognitoDomainPrefix: "kiro-remote-test",
    preRegisteredClients: [
      { name: "ClaudeCode", callbackUrls: ["https://claude.ai/api/mcp/auth_callback"] },
    ],
  });
  return Template.fromStack(stack);
}

describe("KiroRemoteAuth", () => {
  const template = synth();

  test("creates a passwordless passkey-first user pool with self sign-up off", () => {
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      // No separately-required MFA step (the passkey is inherently multi-factor).
      MfaConfiguration: "OFF",
      // Passkey (WebAuthn) is an allowed first-auth factor.
      Policies: Match.objectLike({
        SignInPolicy: { AllowedFirstAuthFactors: Match.arrayWith(["WEB_AUTHN"]) },
      }),
    });
  });

  test("creates the MCP resource server with three scopes", () => {
    template.hasResourceProperties("AWS::Cognito::UserPoolResourceServer", {
      Identifier: "https://kiro.example.com/mcp",
      Scopes: Match.arrayWith([
        Match.objectLike({ ScopeName: "sessions:read" }),
        Match.objectLike({ ScopeName: "sessions:write" }),
        Match.objectLike({ ScopeName: "sessions:delete" }),
      ]),
    });
  });

  test("creates a public no-secret facade client with PKCE, one callback, and revocation on", () => {
    template.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      GenerateSecret: false,
      AllowedOAuthFlows: ["code"],
      CallbackURLs: ["https://kiro.example.com/oauth/callback"],
      EnableTokenRevocation: true,
      AccessTokenValidity: 15,
      RefreshTokenValidity: 43200, // 30 days in minutes
      TokenValidityUnits: Match.objectLike({ AccessToken: "minutes" }),
    });
  });

  test("creates the optional pre-registered client with its own callback URL", () => {
    const clients = template.findResources("AWS::Cognito::UserPoolClient");
    const callbackSets = Object.values(clients).map(
      (c) => (c.Properties as { CallbackURLs?: string[] }).CallbackURLs,
    );
    expect(callbackSets).toContainEqual(["https://claude.ai/api/mcp/auth_callback"]);
  });

  test("exposes the resource identifier on the construct", () => {
    const app = new App();
    const stack = new Stack(app, "S2");
    const auth = new KiroRemoteAuth(stack, "A", {
      publicBaseUrl: "https://kiro.example.com/",
      cognitoDomainPrefix: "p",
    });
    expect(auth.mcpResourceIdentifier).toBe("https://kiro.example.com/mcp");
  });
});
