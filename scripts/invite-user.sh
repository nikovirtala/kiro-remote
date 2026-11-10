#!/usr/bin/env bash
#
# Invite a user to kiro-remote (admin invite-only, passkey-only sign-in).
#
#   ./scripts/invite-user.sh you@example.com
#   pnpm run invite -- you@example.com
#
# What it does:
#   1. reads AWS_PROFILE / AWS_REGION from deploy.env (same file deploy.sh uses),
#   2. reads the UserPoolId output of KiroRemoteStack,
#   3. admin-create-user with the email as username, email_verified=true and an
#      invitation EMAIL (explains passkey registration),
#   4. IMMEDIATELY replaces the emailed temporary password with a random 64+
#      character permanent password that is never printed or stored. Cognito
#      requires the password first factor to stay enabled, so this is what
#      guarantees nobody (including the invitee and you) knows a password.
#      Account recovery is disabled on the pool, so "forgot password" cannot
#      set one either. The emailed temporary password is valid only until this
#      step finishes (seconds); Cognito offers no way to create a user with an
#      emailed invitation that omits it.
#
# The invitee then signs in with an emailed one-time code and adds a
# passkey at <host>/passkeys/add (Cognito does not prompt admin-created users). See docs/users.md.
#
# If step 4 fails or the script is interrupted (INT/TERM) the user is deleted again, so no user is ever left holding
# the emailed temporary password.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="${DEPLOY_ENV_FILE:-$ROOT/deploy.env}"
APP_STACK="KiroRemoteStack"

usage() {
  cat <<USAGE
Usage: $(basename "$0") [--profile <name>] <email>

Invite <email> as a passkey-only kiro-remote user.
Settings come from deploy.env (AWS_PROFILE, AWS_REGION); override the file
with DEPLOY_ENV_FILE=/path.
USAGE
}

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

PROFILE_FLAG=""
EMAIL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) [ $# -ge 2 ] || die "--profile needs a value"; PROFILE_FLAG="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) usage >&2; die "unknown argument: $1" ;;
    *) [ -z "$EMAIL" ] || die "only one email may be given"; EMAIL="$1" ;;
  esac
  shift
done
[ -n "$EMAIL" ] || { usage >&2; exit 2; }
case "$EMAIL" in
  *[!A-Za-z0-9._%+@-]*|""|@*|*@|*@*@*) die "not a plausible email address: $EMAIL" ;;
  *@*.*) ;;
  *) die "not a plausible email address: $EMAIL" ;;
esac

command -v aws >/dev/null 2>&1 || die "'aws' not found on PATH."
command -v openssl >/dev/null 2>&1 || die "'openssl' not found on PATH."

[ -f "$CONFIG_FILE" ] || die "config file not found: $CONFIG_FILE (copy deploy.env.example)"
EXPORTED_PROFILE="${AWS_PROFILE:-${AWS_DEFAULT_PROFILE:-}}"
unset AWS_PROFILE
set -a
# shellcheck disable=SC1090
. "$CONFIG_FILE"
set +a

AWS_PROFILE="${PROFILE_FLAG:-${AWS_PROFILE:-$EXPORTED_PROFILE}}"
[ -n "$AWS_PROFILE" ] || die "no AWS profile set (deploy.env AWS_PROFILE, --profile, or export AWS_PROFILE)."
AWS_REGION="${AWS_REGION:-eu-north-1}"
export AWS_PROFILE AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"

POOL_ID="$(aws cloudformation describe-stacks --stack-name "$APP_STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue | [0]" --output text)"
{ [ -n "$POOL_ID" ] && [ "$POOL_ID" != "None" ]; } \
  || die "UserPoolId output not found on $APP_STACK in $AWS_REGION"

printf 'Inviting %s to user pool %s (%s)\n' "$EMAIL" "$POOL_ID" "$AWS_REGION"

aws cognito-idp admin-create-user \
  --user-pool-id "$POOL_ID" \
  --username "$EMAIL" \
  --user-attributes "Name=email,Value=$EMAIL" "Name=email_verified,Value=true" \
  --desired-delivery-mediums EMAIL \
  --output text --query 'User.Username' >/dev/null

# From here on, never leave a user whose emailed temporary password is valid.
discard_user() {
  printf 'ERROR: temporary password not discarded (error or interrupt); deleting %s\n' "$EMAIL" >&2
  aws cognito-idp admin-delete-user --user-pool-id "$POOL_ID" --username "$EMAIL" || true
}
DISCARDED=0
INPUT_FILE=""
cleanup() {
  [ -z "$INPUT_FILE" ] || rm -f "$INPUT_FILE"
  [ "$DISCARDED" = 1 ] || discard_user
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# 64 random bytes -> 88 base64 chars, plus a suffix to satisfy the pool's
# default password policy. The value goes through a private (mode 600) temp
# file passed as file://, not argv (so it is not visible in `ps`), and is never
# echoed. A temp file is used because AWS CLI v2 cannot reliably read
# file:///dev/stdin from a pipe. The file is removed on every exit path by the
# EXIT trap (INT/TERM exit through it too). base64 characters and the validated
# email need no JSON escaping.
umask 077
INPUT_FILE="$(mktemp "${TMPDIR:-/tmp}/invite-user.XXXXXX")"
RANDOM_PASSWORD="$(openssl rand -base64 64 | tr -d '\n=')Aa1!"
printf '{"UserPoolId":"%s","Username":"%s","Password":"%s","Permanent":true}' \
  "$POOL_ID" "$EMAIL" "$RANDOM_PASSWORD" >"$INPUT_FILE"
unset RANDOM_PASSWORD
aws cognito-idp admin-set-user-password --cli-input-json "file://$INPUT_FILE"
rm -f "$INPUT_FILE"
INPUT_FILE=""
DISCARDED=1
trap - EXIT INT TERM

printf 'Invited %s. They have no password: they sign in with the emailed code, then add a passkey at the passkeys/add page.\n' "$EMAIL"
