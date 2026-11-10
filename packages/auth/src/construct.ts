/**
 * KiroRemoteAuth: a standalone, reusable CDK construct for the Cognito side of
 * the OAuth facade.
 *
 * It provisions:
 *   - a Cognito user pool that is admin invite-only (self-sign-up OFF) with
 *     passkey (WebAuthn) sign-in using the newer managed-login experience.
 *     Email one-time codes are enabled ONLY so an invited user can bootstrap
 *     their first passkey; passwords are never issued (see below). There is no
 *     separately-required MFA step: a passkey login is already multi-factor
 *     (possession + required user verification), which Cognito treats as
 *     mutually exclusive with requiring MFA on top of a passkey first factor,
 *   - a resource server whose identifier is the canonical MCP URL
 *     (https://<host>/mcp) with scopes sessions:read / sessions:write /
 *     sessions:delete,
 *   - ONE public, no-secret facade app client (authorization_code + PKCE,
 *     /oauth/callback as the only callback URL, 15 min access tokens, 30 day
 *     rotating refresh tokens, token revocation enabled),
 *   - OPTIONAL pre-registered public clients from a prop list {name,
 *     callbackUrls} that still flow through the facade.
 *
 * The REST/MCP wiring (Lambdas, API Gateway) is assembled in packages/cdk
 * (FEAT-007); this construct exposes the user pool, resource server, scopes,
 * and client ids that stack needs.
 */

import { Duration, Stack } from "aws-cdk-lib";
import {
  AccountRecovery,
  CfnManagedLoginBranding,
  FeaturePlan,
  type ManagedLoginVersion,
  Mfa,
  OAuthScope,
  PasskeyUserVerification,
  ResourceServerScope,
  UserPool,
  type UserPoolClient,
  type UserPoolDomain,
  type UserPoolEmail,
  type UserPoolResourceServer,
} from "aws-cdk-lib/aws-cognito";
import { Construct } from "constructs";

/** A pre-registered public client that still authorizes through the facade. */
export interface PreRegisteredClientProps {
  /** Logical name, also used to derive the Cognito client construct id. */
  name: string;
  /** Exact callback URLs the client may use. */
  callbackUrls: string[];
}

export interface KiroRemoteAuthProps {
  /**
   * The facade's public origin WITHOUT a trailing slash, e.g.
   * "https://kiro.example.com". Used to derive the resource-server identifier
   * (<host>/mcp) and the facade callback URL (<host>/oauth/callback).
   */
  publicBaseUrl: string;

  /**
   * Prefix for the Cognito-hosted managed-login domain (the
   * `<prefix>.auth.<region>.amazoncognito.com` subdomain).
   */
  cognitoDomainPrefix: string;

  /** Optional pre-registered public clients (Claude Code, VS Code, ...). */
  preRegisteredClients?: PreRegisteredClientProps[];

  /**
   * Optional passkey relying-party id override. Defaults to the managed-login
   * domain host (<prefix>.auth.<region>.amazoncognito.com), which is what
   * passkey registration needs when no custom domain is used. Set it to the
   * fully-qualified custom domain when the pool is served from one.
   */
  passkeyRelyingPartyId?: string;

  /**
   * Email sender for the pool, e.g. `UserPoolEmail.withSES({ fromEmail, ... })`.
   * Cognito does not deliver email OTP (the invitee's bootstrap sign-in) or
   * MFA codes through its default sender, so SES is needed for the email-code
   * bootstrap to work in a deployed pool. Defaults to Cognito's sender.
   */
  email?: UserPoolEmail;
}

/** The resource-server scopes exposed by the facade. */
export interface FacadeScopes {
  read: ResourceServerScope;
  write: ResourceServerScope;
  delete: ResourceServerScope;
}

export class KiroRemoteAuth extends Construct {
  /** The Cognito user pool. */
  readonly userPool: UserPool;
  /** The Cognito-hosted managed-login domain. */
  readonly managedLoginDomain: UserPoolDomain;
  /** The MCP resource server (identifier = <host>/mcp). */
  readonly resourceServer: UserPoolResourceServer;
  /** The canonical MCP resource identifier used as the RFC 8707 audience. */
  readonly mcpResourceIdentifier: string;
  /** The resource-server scopes. */
  readonly scopes: FacadeScopes;
  /** The single public, no-secret facade app client. */
  readonly facadeClient: UserPoolClient;
  /** Any optional pre-registered public clients, keyed by name. */
  readonly preRegisteredClients: Record<string, UserPoolClient> = {};

  constructor(scope: Construct, id: string, props: KiroRemoteAuthProps) {
    super(scope, id);

    const base = props.publicBaseUrl.replace(/\/+$/, "");
    this.mcpResourceIdentifier = `${base}/mcp`;
    const callbackUrl = `${base}/oauth/callback`;

    // Passkeys are bound to the relying-party id. Build it from the prefix and
    // region directly (not from the domain resource) to avoid a dependency
    // cycle between the pool and its domain.
    const relyingPartyId =
      props.passkeyRelyingPartyId ??
      `${props.cognitoDomainPrefix}.auth.${Stack.of(this).region}.amazoncognito.com`;

    this.userPool = new UserPool(this, "UserPool", {
      // Invite-only: only administrators can create users (AllowAdminCreateUserOnly).
      selfSignUpEnabled: false,
      // Passkeys require the Essentials feature plan.
      featurePlan: FeaturePlan.ESSENTIALS,
      // MFA stays OFF. Cognito rejects requiring MFA on top of a passkey
      // first-auth factor ("Cannot set WebAuthn factor configuration to
      // SINGLE_FACTOR if MFA is required and WebAuthn is an allowed first auth
      // factor"), because a passkey login is already multi-factor (possession
      // + required user verification below).
      mfa: Mfa.OFF,
      // Allowed first factors: passkey for every sign-in, email OTP only to let
      // an invited user bootstrap the first passkey. Cognito requires
      // `password` to remain true and offers no way to remove it, so it is
      // neutralised instead: scripts/invite-user.sh sets a random, discarded
      // permanent password right after admin-create-user, and account recovery
      // is NONE so "forgot password" cannot be used to set a known one.
      signInPolicy: {
        allowedFirstAuthFactors: { password: true, passkey: true, emailOtp: true },
      },
      accountRecovery: AccountRecovery.NONE,
      // Require user verification (biometric/PIN) on the passkey. This is the
      // second factor inherent to the passkey and does not conflict with MFA.
      passkeyUserVerification: PasskeyUserVerification.REQUIRED,
      passkeyRelyingPartyId: relyingPartyId,
      // The invitation tells the user to register a passkey. The temporary
      // password placeholder is mandatory in the template but is invalidated by
      // the invite script immediately after the user is created.
      userInvitation: {
        emailSubject: "You are invited to kiro-remote: set up your passkey",
        emailBody: [
          `<p>You have been invited to kiro-remote ({username}).</p>`,
          `<p>There is no password to set. Sign in at ${base}/ (or connect your MCP client),`,
          `choose the email code option and enter the code Cognito emails you.`,
          `Cognito does not prompt for a passkey on its own: once signed in, add one at`,
          `${base}/passkeys/add (it forwards to the Cognito passkey page). From then on, sign in with the passkey.</p>`,
          `<p>Ignore the legacy temporary password {####}: it is disabled and cannot be used.</p>`,
        ].join(" "),
        smsMessage:
          "kiro-remote invite for {username}. Sign in with an email code, then add a passkey (/passkeys/add). {####} is disabled.",
      },
      email: props.email,
      signInCaseSensitive: false,
    });

    // Managed login (newer experience) served from a Cognito prefix domain.
    this.managedLoginDomain = this.userPool.addDomain("ManagedLoginDomain", {
      cognitoDomain: { domainPrefix: props.cognitoDomainPrefix },
      managedLoginVersion: 2 as ManagedLoginVersion,
    });

    const readScope = new ResourceServerScope({
      scopeName: "sessions:read",
      scopeDescription: "Read sessions, turns, and events",
    });
    const writeScope = new ResourceServerScope({
      scopeName: "sessions:write",
      scopeDescription: "Launch, prompt, steer, cancel, and configure sessions",
    });
    const deleteScope = new ResourceServerScope({
      scopeName: "sessions:delete",
      scopeDescription: "Delete sessions",
    });
    this.scopes = { read: readScope, write: writeScope, delete: deleteScope };

    this.resourceServer = this.userPool.addResourceServer("McpResourceServer", {
      identifier: this.mcpResourceIdentifier,
      // The friendly name must match ^[\w\s+=,.@-]+$ (no scheme separators).
      userPoolResourceServerName: "kiro-remote-mcp",
      scopes: [readScope, writeScope, deleteScope],
    });

    const oauthScopes = [
      OAuthScope.OPENID,
      OAuthScope.resourceServer(this.resourceServer, readScope),
      OAuthScope.resourceServer(this.resourceServer, writeScope),
      OAuthScope.resourceServer(this.resourceServer, deleteScope),
    ];

    this.facadeClient = this.userPool.addClient("FacadeClient", {
      generateSecret: false,
      authFlows: { user: true, userSrp: false, adminUserPassword: false, custom: false },
      oAuth: {
        flows: { authorizationCodeGrant: true, implicitCodeGrant: false },
        callbackUrls: [callbackUrl],
        scopes: oauthScopes,
      },
      accessTokenValidity: Duration.minutes(15),
      refreshTokenValidity: Duration.days(30),
      // Non-undefined grace period enables refresh-token rotation.
      refreshTokenRotationGracePeriod: Duration.seconds(0),
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
    });

    // Managed Login v2 refuses to render the hosted login page unless a
    // branding style exists for the client (otherwise the page shows "Login
    // pages unavailable"). The CDK domain with `managedLoginVersion: 2` does
    // NOT auto-create one, so provision a default (Cognito-provided) branding
    // for every client. `useCognitoProvidedValues: true` applies the default
    // styling with no custom design work.
    this.addManagedLoginBranding("FacadeClientBranding", this.facadeClient);

    for (const client of props.preRegisteredClients ?? []) {
      this.preRegisteredClients[client.name] = this.userPool.addClient(`Client${client.name}`, {
        generateSecret: false,
        authFlows: { user: true, userSrp: false, adminUserPassword: false, custom: false },
        oAuth: {
          flows: { authorizationCodeGrant: true, implicitCodeGrant: false },
          callbackUrls: client.callbackUrls,
          scopes: oauthScopes,
        },
        accessTokenValidity: Duration.minutes(15),
        refreshTokenValidity: Duration.days(30),
        refreshTokenRotationGracePeriod: Duration.seconds(0),
        enableTokenRevocation: true,
        preventUserExistenceErrors: true,
      });
      this.addManagedLoginBranding(
        `Branding${client.name.replace(/[^a-zA-Z0-9]/g, "")}`,
        this.preRegisteredClients[client.name],
      );
    }
  }

  /**
   * Provision a default (Cognito-provided) Managed Login v2 branding style for
   * an app client. Managed Login v2 will not render the hosted login page
   * unless a branding style exists for the client. Depends on the managed
   * login domain so the branding is created after the domain exists.
   */
  private addManagedLoginBranding(id: string, client: UserPoolClient): void {
    const branding = new CfnManagedLoginBranding(this, id, {
      userPoolId: this.userPool.userPoolId,
      clientId: client.userPoolClientId,
      useCognitoProvidedValues: true,
    });
    branding.node.addDependency(this.managedLoginDomain);
  }
}
