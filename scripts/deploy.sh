#!/usr/bin/env bash
#
# kiro-remote one-command deploy: install + `cdk deploy --all` with the right
# AWS profile, account, region, and CDK context. `--synth` / `--diff` run
# `cdk synth` / `cdk diff` with exactly the same settings instead (what
# `pnpm synth` / `pnpm run diff` run).
#
# Deploy settings live in a gitignored `deploy.env` at the repo root, not in
# packages/cdk/cdk.json. Copy `deploy.env.example` to `deploy.env`, fill it in,
# then run `./scripts/deploy.sh` (or `pnpm run deploy`).
#
# Guards, all run before anything is built or deployed (also under --dry-run):
#   - the AWS profile must resolve to AWS_ACCOUNT_ID,
#   - every aws/cdk call is pinned to AWS_REGION (never the profile default),
#   - KiroRemoteStack must already exist in AWS_REGION unless --first-deploy,
#     so a wrong region fails here instead of half-creating a second stack.
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve the repo root from the script's own location (not the CWD).
# ---------------------------------------------------------------------------
SCRIPT_SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SCRIPT_SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SCRIPT_SOURCE")" >/dev/null 2>&1 && pwd)"
  SCRIPT_SOURCE="$(readlink "$SCRIPT_SOURCE")"
  [[ $SCRIPT_SOURCE != /* ]] && SCRIPT_SOURCE="$DIR/$SCRIPT_SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_SOURCE")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd -P "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"
CONFIG_FILE="$REPO_ROOT/deploy.env"
EXAMPLE_FILE="$REPO_ROOT/deploy.env.example"
CDK_PACKAGE="@nikovirtala/kiro-remote-cdk"
APP_STACK="KiroRemoteStack"

# Project defaults. Account-specific ids (hosted zone, secret ARN) have no
# default and must come from deploy.env. Account ids are not secret.
DEFAULT_AWS_ACCOUNT_ID="827333031966"
DEFAULT_AWS_REGION="eu-north-1"
DEFAULT_DOMAIN="kiro-remote.nikovirtala.dev"

# ---------------------------------------------------------------------------
# Flags.
# ---------------------------------------------------------------------------
FIRST_DEPLOY=false
MODE="deploy"
SKIP_INSTALL=false
DRY_RUN=false
AWS_PROFILE_FLAG=""
EXTRA_CDK_ARGS=()

usage() {
  cat <<EOF
kiro-remote one-command deploy

Usage: ./scripts/deploy.sh [flags] [-- <extra cdk deploy args>]

Reads settings from a gitignored config file:
  $CONFIG_FILE
(copy deploy.env.example to deploy.env and fill it in)

Steps, in order:
  1. verify the AWS profile -> account, and that $APP_STACK exists in the
     target region (skip the stack check: --first-deploy)
  2. pnpm install --frozen-lockfile                (skip: --skip-install)
  3. cdk deploy --all with the mapped -c flags, pinned to AWS_REGION
     (with --synth / --diff: cdk synth / cdk diff with the same flags,
     nothing is deployed)

Flags:
  --synth          run "cdk synth" instead of "cdk deploy" (bundles the API
                   Lambda, stages the bridge image, runs the cdk-nag checks,
                   deploys nothing; needs no Docker)
  --diff           run "cdk diff" against the deployed stacks instead of
                   "cdk deploy" (read-only change set, deploys nothing)
  --profile NAME   AWS named profile for every aws/cdk call. Overrides the
                   AWS_PROFILE config key and any exported AWS_PROFILE.
  --first-deploy   allow deploying when $APP_STACK does not exist yet in the
                   target region (a brand-new environment)
  --skip-install   skip "pnpm install --frozen-lockfile" (reuse node_modules)
  --dry-run        verify profile/account/region, print the plan and the cdk
                   command, deploy nothing
  -h, --help       show this help
  -- ARGS          pass the remaining ARGS to "cdk deploy" verbatim, e.g.
                   -- --require-approval never

Region: every aws/cdk call uses AWS_REGION from deploy.env (default
$DEFAULT_AWS_REGION), exported as AWS_REGION and AWS_DEFAULT_REGION, so the
profile's own default region is never used.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --profile)
      shift
      [ $# -gt 0 ] || { echo "ERROR: --profile needs an argument" >&2; usage >&2; exit 2; }
      AWS_PROFILE_FLAG="$1"
      ;;
    --profile=*) AWS_PROFILE_FLAG="${1#--profile=}" ;;
    --first-deploy) FIRST_DEPLOY=true ;;
    --synth|--diff)
      [ "$MODE" = "deploy" ] || { echo "ERROR: --synth and --diff are mutually exclusive" >&2; exit 2; }
      MODE="${1#--}"
      ;;
    --skip-install) SKIP_INSTALL=true ;;
    --dry-run) DRY_RUN=true ;;
    -h|--help) usage; exit 0 ;;
    --) shift; EXTRA_CDK_ARGS=("$@"); break ;;
    *) echo "ERROR: unknown argument: $1" >&2; echo >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# Helpers.
# ---------------------------------------------------------------------------
log()  { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
require_tool() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' not found on PATH. $2"
}

# ---------------------------------------------------------------------------
# Load the config file.
# ---------------------------------------------------------------------------
if [ ! -f "$CONFIG_FILE" ]; then
  die "config file not found: $CONFIG_FILE
Create it from the committed template:
    cp \"$EXAMPLE_FILE\" \"$CONFIG_FILE\"
    \$EDITOR \"$CONFIG_FILE\""
fi

# Remember an exported profile before deploy.env can overwrite it, so the
# precedence below (flag > deploy.env > exported) holds.
EXPORTED_PROFILE="${AWS_PROFILE:-${AWS_DEFAULT_PROFILE:-}}"
unset AWS_PROFILE

set -a
# shellcheck disable=SC1090
. "$CONFIG_FILE"
set +a

# ---------------------------------------------------------------------------
# Resolve values.
# ---------------------------------------------------------------------------
RESOLVED_PROFILE="${AWS_PROFILE_FLAG:-${AWS_PROFILE:-$EXPORTED_PROFILE}}"
[ -n "$RESOLVED_PROFILE" ] || die "no AWS profile set. Set AWS_PROFILE in $CONFIG_FILE,
pass --profile <name>, or export AWS_PROFILE."
export AWS_PROFILE="$RESOLVED_PROFILE"

AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-$DEFAULT_AWS_ACCOUNT_ID}"
AWS_REGION="${AWS_REGION:-$DEFAULT_AWS_REGION}"
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"

KIRO_CLI_VERSION="${KIRO_CLI_VERSION:-}"
BRIDGE_MODE="${BRIDGE_MODE:-lambda}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://$DEFAULT_DOMAIN}"
COGNITO_DOMAIN_PREFIX="${COGNITO_DOMAIN_PREFIX:-kiro-remote}"
ALLOWED_REPOS="${ALLOWED_REPOS:-*/*}"
CUSTOM_DOMAIN_NAME="${CUSTOM_DOMAIN_NAME-$DEFAULT_DOMAIN}"
DNS_ZONE_NAME="${DNS_ZONE_NAME-$DEFAULT_DOMAIN}"
HOSTED_ZONE_ID="${HOSTED_ZONE_ID:-}"
HOSTED_ZONE_NAME="${HOSTED_ZONE_NAME:-}"
CERTIFICATE_ARN="${CERTIFICATE_ARN:-}"
KIRO_API_KEY_SECRET_ARN="${KIRO_API_KEY_SECRET_ARN:-}"

[ -n "$KIRO_CLI_VERSION" ] || die "KIRO_CLI_VERSION is not set in $CONFIG_FILE.
It pins the kiro-cli version baked into the bridge image."
[ -n "$KIRO_API_KEY_SECRET_ARN" ] || die "KIRO_API_KEY_SECRET_ARN is not set in $CONFIG_FILE.
Without it the stack creates an empty Kiro API key secret that is deleted on rollback."
case "$BRIDGE_MODE" in
  fargate|lambda|both) ;;
  *) die "BRIDGE_MODE must be fargate, lambda, or both (got '$BRIDGE_MODE')." ;;
esac
case "$KIRO_API_KEY_SECRET_ARN" in
  arn:aws:secretsmanager:"$AWS_REGION":"$AWS_ACCOUNT_ID":secret:*) ;;
  *) die "KIRO_API_KEY_SECRET_ARN is not a secret in $AWS_REGION / $AWS_ACCOUNT_ID:
    $KIRO_API_KEY_SECRET_ARN" ;;
esac
if [ -n "$DNS_ZONE_NAME" ] && [ -n "$CUSTOM_DOMAIN_NAME" ] && [ -z "$HOSTED_ZONE_ID" ]; then
  die "DNS_ZONE_NAME is set but HOSTED_ZONE_ID is not.
Without HOSTED_ZONE_ID the custom domain switches to manual-CNAME mode. Set it to
the HostedZoneId output of KiroRemoteDnsStack, or clear DNS_ZONE_NAME."
fi

# ---------------------------------------------------------------------------
# CDK -c flags. Optional keys are passed only when set (never an empty -c k=).
# ---------------------------------------------------------------------------
CDK_ARGS=()
add_opt() {
  if [ -n "$2" ]; then CDK_ARGS+=( -c "$1=$2" ); fi
}
add_opt kiroCliVersion       "$KIRO_CLI_VERSION"
add_opt bridgeMode           "$BRIDGE_MODE"
add_opt publicBaseUrl        "$PUBLIC_BASE_URL"
add_opt cognitoDomainPrefix  "$COGNITO_DOMAIN_PREFIX"
add_opt allowedRepos         "$ALLOWED_REPOS"
add_opt customDomainName     "$CUSTOM_DOMAIN_NAME"
add_opt dnsZoneName          "$DNS_ZONE_NAME"
add_opt hostedZoneId         "$HOSTED_ZONE_ID"
add_opt hostedZoneName       "$HOSTED_ZONE_NAME"
add_opt certificateArn       "$CERTIFICATE_ARN"
add_opt kiroApiKeySecretArn  "$KIRO_API_KEY_SECRET_ARN"

# synth and diff cover every stack by default (synth rejects --all); deploy
# needs --all.
case "$MODE" in
  synth) CDK_COMMAND=( synth --quiet ) ;;
  diff)  CDK_COMMAND=( diff ) ;;
  *)     CDK_COMMAND=( deploy --all ) ;;
esac

cdk_cmd_display() {
  printf 'pnpm --filter %s exec cdk' "$CDK_PACKAGE"
  local a
  for a in "${CDK_COMMAND[@]}" ${CDK_ARGS[@]+"${CDK_ARGS[@]}"} ${EXTRA_CDK_ARGS[@]+"${EXTRA_CDK_ARGS[@]}"}; do
    printf ' %q' "$a"
  done
  printf '\n'
}

# ---------------------------------------------------------------------------
# Tool checks.
# ---------------------------------------------------------------------------
require_tool aws "Install the AWS CLI v2: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
require_tool node "Run 'mise install' (Node 26 is pinned in .mise.toml)."
require_tool pnpm "Run 'mise install' (pnpm is pinned in .mise.toml)."
if [ "$MODE" = "deploy" ]; then
  require_tool docker "Docker is needed to build the linux/arm64 bridge image."
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 26 ] || die "Node >= 26 is required (found $(node --version)). Run 'mise install'."

# ---------------------------------------------------------------------------
# Account + region guards.
# ---------------------------------------------------------------------------
log "Verifying AWS profile '$AWS_PROFILE' -> account $AWS_ACCOUNT_ID, region $AWS_REGION"
if ! ACTUAL_ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" \
    || [ -z "$ACTUAL_ACCOUNT" ] || [ "$ACTUAL_ACCOUNT" = "None" ]; then
  die "could not verify AWS identity for profile '$AWS_PROFILE'. Try:
    aws sso login --profile $AWS_PROFILE"
fi
[ "$ACTUAL_ACCOUNT" = "$AWS_ACCOUNT_ID" ] || die "wrong AWS account: expected $AWS_ACCOUNT_ID but profile '$AWS_PROFILE' resolves to $ACTUAL_ACCOUNT."
info "verified account: $ACTUAL_ACCOUNT"

STACK_STATUS="$(aws cloudformation describe-stacks --stack-name "$APP_STACK" \
  --query 'Stacks[0].StackStatus' --output text 2>/dev/null || true)"
if [ -z "$STACK_STATUS" ] || [ "$STACK_STATUS" = "None" ]; then
  if [ "$FIRST_DEPLOY" = true ]; then
    info "$APP_STACK does not exist in $AWS_REGION yet (--first-deploy: creating it)"
  else
    die "$APP_STACK does not exist in $AWS_REGION.
If AWS_REGION is wrong, fix it in $CONFIG_FILE. If this really is a brand-new
environment, re-run with --first-deploy."
  fi
else
  info "$APP_STACK in $AWS_REGION: $STACK_STATUS"
fi

# Synth and diff only stage the image build context; the image is built at
# deploy.
if [ "$MODE" = "deploy" ] && ! docker info >/dev/null 2>&1; then
  die "the Docker daemon is not reachable. Start Docker and re-run."
fi

# ---------------------------------------------------------------------------
# Plan.
# ---------------------------------------------------------------------------
log "kiro-remote $MODE plan"
info "config file:          $CONFIG_FILE"
info "AWS profile:          $AWS_PROFILE"
info "account / region:     $AWS_ACCOUNT_ID / $AWS_REGION"
info "kiro-cli version:     $KIRO_CLI_VERSION"
info "bridge mode:          $BRIDGE_MODE"
info "public base URL:      $PUBLIC_BASE_URL"
info "custom domain:        ${CUSTOM_DOMAIN_NAME:-<none, execute-api domain>}"
info "DNS zone / zone id:   ${DNS_ZONE_NAME:-<none>} / ${HOSTED_ZONE_ID:-<none>}"
info "skip install:         $SKIP_INSTALL"
log "cdk command"
info "$(cdk_cmd_display)"

if [ "$DRY_RUN" = true ]; then
  log "DRY RUN: nothing was run."
  exit 0
fi

# ---------------------------------------------------------------------------
# Install + synth/diff/deploy.
# ---------------------------------------------------------------------------
if [ "$SKIP_INSTALL" = false ]; then
  log "Step 1/2: pnpm install --frozen-lockfile"
  ( cd "$REPO_ROOT" && pnpm install --frozen-lockfile )
else
  log "Step 1/2: pnpm install SKIPPED (--skip-install)"
fi

log "Step 2/2: cdk ${CDK_COMMAND[*]} ($AWS_REGION)"
(
  cd "$REPO_ROOT"
  pnpm --filter "$CDK_PACKAGE" exec cdk "${CDK_COMMAND[@]}" \
    ${CDK_ARGS[@]+"${CDK_ARGS[@]}"} ${EXTRA_CDK_ARGS[@]+"${EXTRA_CDK_ARGS[@]}"}
)

case "$MODE" in
  synth) log "Done. Synthesized for $AWS_ACCOUNT_ID / $AWS_REGION (nothing deployed)" ;;
  diff)  log "Done. Diffed against $AWS_ACCOUNT_ID / $AWS_REGION (nothing deployed)" ;;
  *)     log "Done. Deployed to $AWS_ACCOUNT_ID / $AWS_REGION" ;;
esac
