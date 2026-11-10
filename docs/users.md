# Registering a user

**Yes, a user is required.** Every `/v1/*` REST call and every MCP request needs a
Cognito OAuth access token, and you can only get one by signing in as a user in
the pool.

The Cognito user pool is **invite-only** (self-sign-up OFF, admin-create-user
only) and users sign in with a **passkey** (WebAuthn, user verification
required). There is no public signup endpoint, so **you**, the operator, invite
users with [`scripts/invite-user.sh`](../scripts/invite-user.sh). No password is
ever issued to anyone.

How it works, and what Cognito does and does not enforce:

- **Allowed first factors** are `PASSWORD`, `EMAIL_OTP` and `WEB_AUTHN`.
  Cognito requires `PASSWORD` to stay enabled and offers no way to remove it.
  The invite script therefore replaces the emailed temporary password with a
  random 64+ character permanent password that is never shown or stored, and the
  pool disables account recovery so "forgot password" cannot set a known one.
  Net effect: no one knows a password, but the password factor is not switched
  off in Cognito.
- **Email code** is enabled only so an invitee can bootstrap their first
  passkey. Cognito does not offer "email code until a passkey exists", so this
  factor stays usable afterwards too; it is also the recovery path (below).
  Anyone who controls the invitee's mailbox can therefore sign in with the email
  code. Passkey-only is **not** enforced server-side: Cognito's pre-authentication
  and pre-token-generation triggers do not expose which factor was used, so no
  trigger can reject non-passkey logins. See [SECURITY.md](../SECURITY.md).
- **MFA is `OFF`**, deliberately. Cognito rejects requiring MFA when passkey is
  an allowed first factor, because a passkey sign-in is already multi-factor
  (possession plus required biometric/PIN).
- The **passkey relying-party id** defaults to the managed-login host
  `<cognitoDomainPrefix>.auth.<region>.amazoncognito.com`, so registration works
  without a custom domain. Passkeys are bound to it: changing the prefix or
  region invalidates existing passkeys.

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

## 2. Invite the user

```bash
./scripts/invite-user.sh you@example.com
# or: pnpm run invite -- you@example.com
```

The script reads `AWS_PROFILE` / `AWS_REGION` from `deploy.env`, looks up the
`UserPoolId` stack output, creates the user (`email_verified=true`, invitation
email sent), and immediately sets a random permanent password that it discards.
If discarding fails it deletes the user again, so a user is never left with the
emailed temporary password. Until the discard step finishes (seconds) the emailed
temporary password is valid; Ctrl-C or SIGTERM also triggers the delete. **Email
codes need SES**: Cognito does not deliver email OTP through its default sender,
so pass `email: UserPoolEmail.withSES(...)` to `KiroRemoteAuth` (verified SES
identity) or the email-code bootstrap will not work. The app clients enable
`ALLOW_USER_AUTH` (choice-based sign-in), which email code and passkey need.

The invitation email says to ignore the legacy temporary password (Cognito
requires that placeholder in the template; it is invalid once the script
finishes).

Do **not** create users with `aws cognito-idp admin-create-user` and
`admin-set-user-password` by hand with a password you choose: that leaves a
known, usable password.

## 3. Register a passkey (first sign-in)

1. Run `kiro-remote login` (step 5) or connect your MCP client; managed login
   opens in the browser.
2. Enter your email, choose the **email code** option, and enter the code
   Cognito emails you.
3. Cognito does **not** prompt admin-created users to register a passkey. After
   signing in, open
   `https://<cognitoDomainPrefix>.auth.<region>.amazoncognito.com/passkeys/add?client_id=<facade-client-id>&redirect_uri=<host>/oauth/callback`
   (the invitation email points to the same page) while the session is active,
   and complete the biometric/PIN prompt.
4. From then on, choose the passkey option at sign-in.

## 4. Sign in

Sign in with your passkey through managed login (the Cognito hosted UI). You do
not open the managed-login domain directly; the login flow (via
`kiro-remote login`, see the next step) redirects you to the hosted UI with the
full OAuth parameters, and you are redirected back with a code that is exchanged
for tokens.

Managed login is served from:

```
https://<cognitoDomainPrefix>.auth.<region>.amazoncognito.com
```

with the prefix you passed as `-c cognitoDomainPrefix=...` at deploy time.

### Lost passkey / new device

Sign in with the email code and register another passkey. To remove a lost
passkey, `aws cognito-idp delete-web-authn-credential` needs an access token
carrying `aws.cognito.signin.user.admin`, which `kiro-remote login` tokens do
not have (they carry only `openid` and the MCP scopes), and Cognito has no
admin-side API for it. This is untested; the dependable path is delete and
re-invite (below). Removing `emailOtp` after enrolment (and redeploying) closes
the mailbox bypass but removes the email-code recovery path. If the mailbox or account is compromised, delete the user
(`aws cognito-idp admin-delete-user`) and re-run the invite script. Note that a
re-created user gets a new `sub`, so sessions created by the old one are no
longer visible to them.

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

- **No invitation email**: check spam; the default Cognito sender is rate
  limited (about 50/day). The user exists once the script succeeds, so you can
  also just ask them to start `kiro-remote login` and request an email code.
- **Passkey registration fails or is not offered**: passkeys are bound to the
  relying-party id (`<prefix>.auth.<region>.amazoncognito.com`); open managed
  login from that host (via `kiro-remote login`), not a different domain, and
  use a browser/authenticator that supports user verification.
- **Password prompt appears**: managed login still lists the password option
  because Cognito cannot disable it; nobody knows a password, so use the passkey
  or email code instead.

- **"Login pages unavailable"** — the app client has no managed-login branding
  style. Create one with `aws cognito-idp create-managed-login-branding` (see
  [Sign in](#4-sign-in) above). Fresh deploys get this automatically.
- **"Missing Authentication Token" on the bare auth domain** — expected; the root
  URL is not a page. Use `kiro-remote login`, which hits the correct
  `/oauth2/authorize` endpoint with the full OAuth parameters.
- **`403 insufficient_scope` on `/v1`** — your token predates the scope fix and
  lacks the session scopes. Re-run `kiro-remote login` to mint a fresh token that
  carries `sessions:read|write|delete`.
