# Registering a user

**Yes, a user is required.** Every `/v1/*` REST call and every MCP request needs a
Cognito OAuth access token, and you can only get one by signing in as a user in
the pool.

The Cognito user pool is created with **self-sign-up OFF** and **`mfa: OFF`**.
There is no public signup endpoint, so **you**, the operator, create users with
the AWS CLI. Sign-in today is by **password** through managed login. Passwordless,
passkey-first sign-in was the original design intent and remains a **planned
enhancement**, but it is not usable yet: the pool's WebAuthn relying-party id is
not configured, so the hosted UI cannot register a passkey. Until that WebAuthn
RP-ID / Cognito custom-domain work lands, password is the only working first-auth
factor.

This matches the auth construct
([`packages/auth/src/construct.ts`](../packages/auth/src/construct.ts)):
`selfSignUpEnabled: false`, `mfa: OFF`, and `AllowedFirstAuthFactors` that
includes both password and passkey. The passkey factor is declared, but passkey
registration requires WebAuthn RP-ID configuration that is not yet set on the
pool, so in practice you sign in with a password.

Because the current path is password with `mfa: OFF`, sign-in for this personal
control plane is **single-factor** today. Hardening it (passkeys or a separate
MFA step) is a planned follow-up; the notes below do not overstate the posture.

## 1. Find the user pool id

The easiest way is to read the stack's named CloudFormation outputs (see
[deploy.md](./deploy.md#6-find-the-resource-identifiers-youll-need)): the
`UserPoolId` output is the pool id, and the `FacadeClientId` output is the public
facade app client id you need for the managed-login branding fix below.

```bash
aws cloudformation describe-stacks --stack-name KiroRemoteStack \
  --query 'Stacks[0].Outputs'
```

Alternatively, read the resources directly:

```bash
aws cloudformation list-stack-resources --stack-name KiroRemoteStack \
  --query "StackResourceSummaries[?ResourceType=='AWS::Cognito::UserPool']"
```

(The facade client is the `AWS::Cognito::UserPoolClient` resource.) Use the
resulting `<user-pool-id>` (and `<facade-client-id>`) below.

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

## 4. Sign in

Sign-in today is by **password** through managed login (the Cognito hosted UI).
You do not open the managed-login domain directly; the login flow (via
`kiro-remote login`, see the next step) redirects you to the hosted UI with the
full OAuth parameters, you enter your username and password, and you are
redirected back with a code that is exchanged for tokens.

Managed login is served from:

```
https://<cognitoDomainPrefix>.auth.<region>.amazoncognito.com
```

with the prefix you passed as `-c cognitoDomainPrefix=...` at deploy time.

> **Passkeys / MFA are a planned enhancement, not yet available.** The original
> design intent was passwordless, passkey-first sign-in, but that needs WebAuthn
> RP-ID configuration (and the Cognito custom-domain work that goes with it),
> which is deferred. For now, password is the only working first-auth factor and
> there is no separate MFA step.

### "Login pages unavailable"

Managed Login v2 only renders the hosted login page when a branding style exists
for the app client; without one the page shows "Login pages unavailable / Please
contact an administrator" (see
[deploy.md](./deploy.md#6-find-the-resource-identifiers-youll-need)). Fresh
deploys get a default branding automatically — the stack provisions it for the
facade client and every pre-registered client. A pool deployed **before** that
change needs a one-time manual branding creation:

```bash
aws cognito-idp create-managed-login-branding \
  --user-pool-id <user-pool-id> \
  --client-id <facade-client-id> \
  --use-cognito-provided-values \
  --region <region>
```

### "Missing Authentication Token" on the bare auth domain

Visiting the bare managed-login domain directly returns "Missing Authentication
Token". This is **expected** — the root URL is not a page you visit; the hosted
UI only renders at the `/login?...` / `/oauth2/authorize?...` endpoint with the
full OAuth parameters, which `kiro-remote login` constructs for you. Use the CLI
rather than opening the domain by hand.

## 5. Get a token

Once the user exists, obtain an access token with the CLI (the simplest path):

```bash
export KIRO_REMOTE_URL=https://<host>
mise exec -- pnpm --filter @nikovirtala/kiro-remote-mcp exec kiro-remote login
```

The `node packages/mcp/src/cli.ts login` form is equivalent if you prefer to run
the CLI entrypoint directly. (If you manage Node/pnpm yourself, drop the
`mise exec --` prefix.)

This runs the OAuth authorization-code + PKCE flow against the facade, opens
managed login in your browser, and stores the resulting tokens in your OS keychain
(with a `0600` file fallback). Login now requests the `openid` scope plus the
three fully-qualified session scopes (`<host>/mcp/sessions:read|write|delete`), so
the issued token can call `/v1`. See [rest-api.md](./rest-api.md) and
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

## Troubleshooting sign-in

- **"Login pages unavailable"** — the app client has no managed-login branding
  style. Create one with `aws cognito-idp create-managed-login-branding` (see
  [Sign in](#4-sign-in) above). Fresh deploys get this automatically.
- **"Missing Authentication Token" on the bare auth domain** — expected; the root
  URL is not a page. Use `kiro-remote login`, which hits the correct
  `/oauth2/authorize` endpoint with the full OAuth parameters.
- **`403 insufficient_scope` on `/v1`** — your token predates the scope fix and
  lacks the session scopes. Re-run `kiro-remote login` to mint a fresh token that
  carries `sessions:read|write|delete`.
