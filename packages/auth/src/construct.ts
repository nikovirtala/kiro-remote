/**
 * KiroRemoteAuth: a standalone, reusable CDK construct for the Cognito side of
 * the OAuth facade.
 *
 * It provisions:
 *   - a Cognito user pool with self-sign-up OFF and MFA REQUIRED via passkey
 *     (WebAuthn) or TOTP, using the newer managed-login experience,
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

import { Duration } from "aws-cdk-lib";
import {
  FeaturePlan,
  type ManagedLoginVersion,
  Mfa,
  OAuthScope,
  PasskeyUserVerification,
  ResourceServerScope,
  UserPool,
  type UserPoolClient,
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
   * Optional passkey relying-party id (the facade's fully-qualified domain)
   * required when the pool is served from a custom domain.
   */
  passkeyRelyingPartyId?: string;
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

    this.userPool = new UserPool(this, "UserPool", {
      selfSignUpEnabled: false,
      // Passkey + TOTP require the Essentials feature plan.
      featurePlan: FeaturePlan.ESSENTIALS,
      mfa: Mfa.REQUIRED,
      // TOTP as the classic second factor; no SMS.
      mfaSecondFactor: { sms: false, otp: true },
      // Allow passkey (WebAuthn) as a first-auth factor alongside password.
      signInPolicy: { allowedFirstAuthFactors: { password: true, passkey: true } },
      // Require user verification when a passkey is used for MFA.
      passkeyUserVerification: PasskeyUserVerification.REQUIRED,
      ...(props.passkeyRelyingPartyId
        ? { passkeyRelyingPartyId: props.passkeyRelyingPartyId }
        : {}),
      signInCaseSensitive: false,
    });

    // Managed login (newer experience) served from a Cognito prefix domain.
    this.userPool.addDomain("ManagedLoginDomain", {
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
      authFlows: { user: false, userSrp: false, adminUserPassword: false, custom: false },
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

    for (const client of props.preRegisteredClients ?? []) {
      this.preRegisteredClients[client.name] = this.userPool.addClient(`Client${client.name}`, {
        generateSecret: false,
        authFlows: { user: false, userSrp: false, adminUserPassword: false, custom: false },
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
    }
  }
}
