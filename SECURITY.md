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
