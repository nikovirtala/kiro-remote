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

  test("is invite-only with a passkey-first factor set and the invite template", () => {
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: Match.objectLike({
        AllowAdminCreateUserOnly: true,
        InviteMessageTemplate: Match.objectLike({
          EmailSubject: Match.stringLikeRegexp("passkey"),
          EmailMessage: Match.stringLikeRegexp("passkeys/add"),
        }),
      }),
      Policies: Match.objectLike({
        SignInPolicy: {
          AllowedFirstAuthFactors: Match.arrayEquals(["PASSWORD", "EMAIL_OTP", "WEB_AUTHN"]),
        },
      }),
      // No self-service password reset path to set a known password.
      AccountRecoverySetting: {
        RecoveryMechanisms: [{ Name: "admin_only", Priority: 1 }],
      },
    });
  });

  test("enables choice-based sign-in (ALLOW_USER_AUTH) on every app client", () => {
    const clients = Object.values(template.findResources("AWS::Cognito::UserPoolClient"));
    expect(clients.length).toBeGreaterThan(0);
    for (const c of clients) {
      const flows = (c.Properties as { ExplicitAuthFlows?: string[] }).ExplicitAuthFlows ?? [];
      expect(flows).toContain("ALLOW_USER_AUTH");
    }
  });

  test("requires passkey user verification and defaults the RP id to the managed-login host", () => {
    const pools = Object.values(template.findResources("AWS::Cognito::UserPool"));
    const rp = JSON.stringify(
      (pools[0]?.Properties as { WebAuthnRelyingPartyID?: unknown } | undefined)
        ?.WebAuthnRelyingPartyID,
    );
    expect(rp).toContain("kiro-remote-test.auth.");
    expect(rp).toContain(".amazoncognito.com");
    template.hasResourceProperties("AWS::Cognito::UserPool", {
      WebAuthnUserVerification: "required",
    });
  });

  test("honours an explicit passkeyRelyingPartyId override", () => {
    const stack = new Stack(new App(), "RpStack");
    new KiroRemoteAuth(stack, "Auth", {
      publicBaseUrl: "https://kiro.example.com",
      cognitoDomainPrefix: "x",
      passkeyRelyingPartyId: "kiro.example.com",
    });
    Template.fromStack(stack).hasResourceProperties("AWS::Cognito::UserPool", {
      WebAuthnRelyingPartyID: "kiro.example.com",
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

  test("provisions a default Managed Login v2 branding for the facade client", () => {
    // Managed Login v2 will not render the hosted login page without a branding
    // style for the client, so every client gets a Cognito-provided default.
    const brandings = template.findResources("AWS::Cognito::ManagedLoginBranding");
    const defaults = Object.values(brandings).filter(
      (b) =>
        (b.Properties as { UseCognitoProvidedValues?: boolean }).UseCognitoProvidedValues === true,
    );
    // One for the facade client + one for the single pre-registered client.
    expect(defaults).toHaveLength(2);
    for (const b of defaults) {
      expect((b.Properties as { UserPoolId?: unknown }).UserPoolId).toBeDefined();
      expect((b.Properties as { ClientId?: unknown }).ClientId).toBeDefined();
    }
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
