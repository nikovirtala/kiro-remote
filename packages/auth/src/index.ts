/**
 * @nikovirtala/kiro-remote-auth
 *
 * OAuth 2.1 Cognito facade. Cognito is the ONLY token issuer: the facade never
 * mints, signs, or reshapes tokens; it brokers the authorization-code / refresh
 * / revoke flows and returns Cognito tokens unchanged.
 *
 * Exports:
 *  - discovery metadata handlers (RFC 9728 + RFC 8414, advertising CIMD),
 *  - /oauth/authorize, /oauth/callback, /oauth/token, /oauth/revoke,
 *  - /oauth/clients/cli.json (the facade CLI's own CIMD),
 *  - CIMD fetch + validate with an SSRF guard,
 *  - the Cognito + KMS ports (injectable for offline tests),
 *  - the standalone KiroRemoteAuth CDK construct.
 */

export const PACKAGE_NAME = "@nikovirtala/kiro-remote-auth";

export * from "./authorize.ts";
export * from "./callback.ts";
export * from "./cimd.ts";
export * from "./cli-client.ts";
export * from "./clients.ts";
export * from "./cognito.ts";
export * from "./config.ts";
export * from "./construct.ts";
export * from "./kms.ts";
export * from "./metadata.ts";
export * from "./pkce.ts";
export * from "./register.ts";
export * from "./token.ts";
export * from "./types.ts";
