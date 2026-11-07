# Registering a user

**Yes, a user is required.** Every `/v1/*` REST call and every MCP request needs a
Cognito OAuth access token, and you can only get one by signing in as a user in
the pool.

The Cognito user pool is created with **self-sign-up OFF** and **MFA required**
(passkey/WebAuthn or TOTP). There is no public signup endpoint, so **you**, the
operator, create users with the AWS CLI, and each user enrolls MFA on first
sign-in through managed login.

This matches the auth construct
([`packages/auth/src/construct.ts`](../packages/auth/src/construct.ts)):
`selfSignUpEnabled: false`, `mfa: REQUIRED`, TOTP enabled, and passkey allowed as a
first-auth factor.

## 1. Find the user pool id

The IDs are not exported as named CloudFormation outputs; read them from the
deployed stack (see [deploy.md](./deploy.md#6-find-the-resource-identifiers-youll-need)):

```bash
aws cloudformation list-stack-resources --stack-name KiroRemoteStack \
  --query "StackResourceSummaries[?ResourceType=='AWS::Cognito::UserPool']"
```

Use the resulting `<user-pool-id>` below.

## 2. Create the user

```bash
aws cognito-idp admin-create-user \
  --user-pool-id <user-pool-id> \
  --username you@example.com \
  --message-action SUPPRESS
```

`--message-action SUPPRESS` skips the invitation email (you are setting the
password yourself in the next step). Adjust attributes to your pool's
configuration as needed.

## 3. Set a password

```bash
aws cognito-idp admin-set-user-password \
  --user-pool-id <user-pool-id> \
  --username you@example.com \
  --password '<a-strong-password>' \
  --permanent
```

`--permanent` avoids the force-change-password state so you can sign in directly.

## 4. Enroll MFA on first sign-in

MFA is **required** by the pool, so the first interactive sign-in through managed
login will prompt you to enroll a second factor:

- a **passkey** (WebAuthn), or
- **TOTP** (an authenticator app).

Managed login (the Cognito hosted UI) is served from:

```
https://<cognitoDomainPrefix>.auth.<region>.amazoncognito.com
```

with the prefix you passed as `-c cognitoDomainPrefix=...` at deploy time. You do
not open this URL directly for day-to-day use; the login flow (via
`kiro-remote login` or the OAuth authorize chain) redirects you there, you
authenticate and complete MFA, and you are redirected back with a code that is
exchanged for tokens.

## 5. Get a token

Once the user exists and MFA is enrolled, obtain an access token with the CLI (the
simplest path):

```bash
export KIRO_REMOTE_URL=https://<host>
mise exec -- pnpm --filter @nikovirtala/kiro-remote-mcp exec kiro-remote login
```

This runs the OAuth authorization-code + PKCE flow against the facade, opens
managed login in your browser, and stores the resulting tokens in your OS keychain
(with a `0600` file fallback). See [rest-api.md](./rest-api.md) and
[mcp.md](./mcp.md) for using the token.

## Scopes

The access token carries one or more of these resource-server scopes, which gate
what you can do:

| Scope             | Grants                                                               |
| ----------------- | -------------------------------------------------------------------- |
| `sessions:read`   | Read sessions, turns, events, permissions, capabilities, models.     |
| `sessions:write`  | Launch, adopt, prompt, steer, cancel, configure, answer permissions. |
| `sessions:delete` | Delete sessions.                                                     |

A session is visible only to the user who created it (its `createdBy` sub).
