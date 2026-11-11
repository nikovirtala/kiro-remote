# Security policy

kiro-remote is a personal project maintained by a single person, so there is no
formal bug-bounty program and no guaranteed response time.

## Reporting a vulnerability

Please report security-sensitive issues **privately** by email to
[niko.virtala@hey.com](mailto:niko.virtala@hey.com) rather than opening a public
[GitHub issue](https://github.com/nikovirtala/kiro-remote/issues). This keeps the
details out of public view until there is a fix.

Non-sensitive bugs, questions, and feature requests are welcome as public
[GitHub issues](https://github.com/nikovirtala/kiro-remote/issues).

## Sign-in posture

- **Invite-only.** Self-sign-up is off; only an administrator can create users
  (`scripts/invite-user.sh`).
- **Passkeys.** WebAuthn with user verification required is the intended and
  normal sign-in. MFA is `OFF` because Cognito does not allow requiring MFA when
  passkey is an allowed first factor, and a passkey is already multi-factor.
- **No usable password.** Cognito forces the password first factor to stay
  enabled. The invite script sets a random, discarded permanent password, and
  account recovery is disabled, so no password is known or resettable by users.
- **Known limit: passkey-only is not enforced by Cognito.** The email one-time
  code factor stays enabled (needed to bootstrap and recover passkeys), so
  someone with access to a user's mailbox can sign in without the passkey.
  Cognito's pre-authentication and pre-token-generation trigger events do not
  report which first factor was used, so a trigger cannot reject non-passkey
  sign-ins. Protect invitee mailboxes accordingly. If you need stronger
  guarantees, disable the email-code factor after everyone has registered a
  passkey (remove `emailOtp` in `packages/auth/src/construct.ts` and redeploy;
  recovery then requires deleting and re-inviting the user).

## GitHub webhook (optional feature)

When the optional GitHub wake feature is deployed (`GITHUB_APP_SECRET_ARN`, see
[docs/github.md](./docs/github.md)), the stack exposes `POST /github/webhook`.

- **The signature is the authentication.** GitHub cannot send an OAuth bearer
  token, so this route bypasses `authenticate()` on purpose (it is not an
  authorized route and never produces a `Principal`). The function verifies
  `X-Hub-Signature-256` (HMAC-SHA256 with the webhook secret) over the **raw
  request bytes**, with a constant-time compare, **before** anything is parsed.
  A bad or missing signature is a `401` with an empty body: nothing from the
  request is echoed or logged.
- **Replay.** Each `X-GitHub-Delivery` id is claimed with a conditional write
  (7 day TTL). A replayed or redelivered delivery is a no-op.
- **Scope.** Events for repositories outside `ALLOWED_REPOS` are dropped after
  verification and counted.
- **The App is read-only.** Its permissions are Metadata, Pull requests, Issues,
  Checks and Actions, all read-only, and it can be installed only on your account
  and only on the allow-listed repos. It cannot push, comment or merge.
- **Secrets.** The App secret (app id, private key, webhook secret) is read by
  exactly two functions: the webhook ingress and the GitHub consumer. Installation
  tokens are minted on demand, cached in memory until 5 minutes before expiry, and
  never logged; the logger redacts `ghs_`/`ghp_`/`github_pat_` tokens, PEM private
  keys and webhook signatures anywhere they appear.
- **Prompt injection.** Anything a GitHub user writes (review text, comments, PR
  titles, branch names) is untrusted. It is never forwarded to the agent unless the
  author is in `GITHUB_TRUSTED_LOGINS` (default: the App installation owner), and
  then only quoted as data inside delimited blocks, capped at 8,000 characters.
  Check and workflow names are flattened to one bounded line. Every wake prompt
  begins with a fixed line saying it came from GitHub.
- **Links are never guessed.** A PR is linked to a session only by the PR URL in
  the session's own events, by a `Kiro-Remote-Session` trailer that passes the
  checks in docs/github.md, or by hand. A forged trailer naming another session,
  a deleted session, or a repo outside the session's `repos[]` is refused. There
  is no branch-name or title matching.
