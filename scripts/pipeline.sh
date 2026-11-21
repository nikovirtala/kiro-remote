#!/usr/bin/env bash
#
# The deploy pipeline's commands, for a person (docs/pipeline.md). Agents do not run these: an
# agent's AWS access is read-only, and `deploy` refuses run, unfreeze, forget and settings when
# ARK_AGENT is set.
#
#   ./scripts/pipeline.sh bootstrap --connection-arn ARN [--alarm-email EMAIL]
#                                                       deploy the pipeline stack, once (needs the settings in SSM)
#   ./scripts/pipeline.sh settings                      copy deploy.env's settings into SSM
#   ./scripts/pipeline.sh status                        frozen or not, the last good commit, the last runs, the tasks
#   ./scripts/pipeline.sh freeze "<why>"                stop merges from deploying
#   ./scripts/pipeline.sh unfreeze                      clear the freeze flag (after fixing what froze it)
#   ./scripts/pipeline.sh tasks                         the deployment tasks and which are done
#   ./scripts/pipeline.sh dry-run [<task>]              what a run would do now, or one task's dry run
#   ./scripts/pipeline.sh run <task>                    one task by hand, with YOUR credentials
#   ./scripts/pipeline.sh forget <task>                 put a done task back to pending
#   ./scripts/pipeline.sh simulate [--deployed]         the policy simulation of the pipeline's roles (read-only)
#
# Like deploy.sh it needs a named AWS profile (--profile, AWS_PROFILE in deploy.env, or exported) and
# refuses to run against another account than AWS_ACCOUNT_ID. deploy.sh stays the break-glass way to
# deploy the service.
#
set -euo pipefail

SCRIPT_SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SCRIPT_SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SCRIPT_SOURCE")" >/dev/null 2>&1 && pwd)"
  SCRIPT_SOURCE="$(readlink "$SCRIPT_SOURCE")"
  [[ $SCRIPT_SOURCE != /* ]] && SCRIPT_SOURCE="$DIR/$SCRIPT_SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_SOURCE")" >/dev/null 2>&1 && pwd)"
REPO_ROOT="$(cd -P "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"
CONFIG_FILE="$REPO_ROOT/deploy.env"
DEFAULT_AWS_ACCOUNT_ID="827333031966"
PIPELINE_PACKAGE="@nikovirtala/kiro-remote-pipeline"
PIPELINE_STACK="KiroRemotePipelineStack"
# The pipeline's region is fixed (packages/pipeline/src/names.ts, deploy.toml).
REGION="eu-north-1"

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '\n==> %s\n' "$*"; }
usage() { sed -n '3,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

AWS_PROFILE_FLAG=""
CONNECTION_ARN=""
ALARM_EMAIL=""
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) shift; [ $# -gt 0 ] || die "--profile needs an argument"; AWS_PROFILE_FLAG="$1" ;;
    --profile=*) AWS_PROFILE_FLAG="${1#--profile=}" ;;
    --connection-arn) shift; [ $# -gt 0 ] || die "--connection-arn needs an argument"; CONNECTION_ARN="$1" ;;
    --connection-arn=*) CONNECTION_ARN="${1#--connection-arn=}" ;;
    --alarm-email) shift; [ $# -gt 0 ] || die "--alarm-email needs an argument"; ALARM_EMAIL="$1" ;;
    --alarm-email=*) ALARM_EMAIL="${1#--alarm-email=}" ;;
    -h|--help) usage; exit 0 ;;
    *) ARGS+=( "$1" ) ;;
  esac
  shift
done
[ "${#ARGS[@]}" -gt 0 ] || { usage >&2; exit 2; }
COMMAND="${ARGS[0]}"

[ -z "${ARK_AGENT:-}" ] || case "$COMMAND" in
  bootstrap|settings|unfreeze|run|forget) die "$COMMAND is for people: agents read the pipeline (status, tasks, dry-run) and never deploy, unfreeze or forget." ;;
esac

# deploy.env is read for AWS_PROFILE and AWS_ACCOUNT_ID, and by `settings`.
EXPORTED_PROFILE="${AWS_PROFILE:-${AWS_DEFAULT_PROFILE:-}}"
if [ -f "$CONFIG_FILE" ]; then
  unset AWS_PROFILE
  set -a
  # shellcheck disable=SC1090
  . "$CONFIG_FILE"
  set +a
fi

RESOLVED_PROFILE="${AWS_PROFILE_FLAG:-${AWS_PROFILE:-$EXPORTED_PROFILE}}"
[ -n "$RESOLVED_PROFILE" ] || die "no AWS profile set: use --profile NAME, AWS_PROFILE in deploy.env, or export AWS_PROFILE."
export AWS_PROFILE="$RESOLVED_PROFILE" AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
EXPECTED_ACCOUNT="${AWS_ACCOUNT_ID:-$DEFAULT_AWS_ACCOUNT_ID}"

command -v aws >/dev/null 2>&1 || die "'aws' not found on PATH (AWS CLI v2)."
command -v pnpm >/dev/null 2>&1 || die "'pnpm' not found on PATH (mise install)."
ACTUAL_ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" \
  || die "could not verify AWS identity for profile '$AWS_PROFILE' (aws sso login --profile $AWS_PROFILE)."
[ "$ACTUAL_ACCOUNT" = "$EXPECTED_ACCOUNT" ] \
  || die "wrong AWS account: expected $EXPECTED_ACCOUNT but profile '$AWS_PROFILE' resolves to $ACTUAL_ACCOUNT."

deploy() { ( cd "$REPO_ROOT" && pnpm --filter "$PIPELINE_PACKAGE" exec deploy "$@" ); }

case "$COMMAND" in
  settings)
    [ -f "$CONFIG_FILE" ] || die "no $CONFIG_FILE: copy deploy.env.example and fill it in first."
    ( cd "$REPO_ROOT" && pnpm install --frozen-lockfile )
    deploy settings --env-file "$CONFIG_FILE"
    ;;
  bootstrap)
    # The connection is made by hand (console handshake; CloudFormation cannot finish it): docs/pipeline.md, step 1.
    [ -n "$CONNECTION_ARN" ] || die "pass the connection: --connection-arn arn:aws:codeconnections:$REGION:$ACTUAL_ACCOUNT:connection/<id>
(create it and finish its handshake first: docs/pipeline.md, step 1)."
    [[ "$CONNECTION_ARN" =~ ^arn:aws:(codeconnections|codestar-connections):$REGION:$ACTUAL_ACCOUNT:connection/[0-9a-f-]{36}$ ]] \
      || die "not a connection ARN of this account in $REGION: $CONNECTION_ARN"
    STATUS="$(aws codeconnections get-connection --connection-arn "$CONNECTION_ARN" --query Connection.ConnectionStatus --output text 2>/dev/null || true)"
    [ "$STATUS" = "AVAILABLE" ] \
      || die "the connection is '${STATUS:-not found}', not AVAILABLE: finish its handshake in the console (Developer Tools > Settings > Connections > Update pending connection)."
    # The pipeline refuses to deploy without the REQUIRED settings, so check they are in SSM before it can run once.
    COUNT="$(aws ssm get-parameters-by-path --path /kiro-remote/deployment/settings/ --query 'length(Parameters)' --output text)"
    [ "$COUNT" != "0" ] || die "no settings in SSM yet: run ./scripts/pipeline.sh settings first."
    CONTEXT=( -c "pipelineConnectionArn=$CONNECTION_ARN" )
    [ -z "$ALARM_EMAIL" ] || CONTEXT+=( -c "pipelineAlarmEmail=$ALARM_EMAIL" )
    log "deploy $PIPELINE_STACK ($REGION, account $ACTUAL_ACCOUNT)"
    ( cd "$REPO_ROOT" && pnpm install --frozen-lockfile )
    ( cd "$REPO_ROOT" && CDK_DEFAULT_ACCOUNT="$ACTUAL_ACCOUNT" pnpm --filter "$PIPELINE_PACKAGE" exec cdk deploy "$PIPELINE_STACK" --require-approval never "${CONTEXT[@]}" )
    log "Done. A merge to main (or Release change in the console) starts the first run."
    ;;
  status|unfreeze|tasks)
    deploy "$COMMAND"
    ;;
  freeze)
    [ "${#ARGS[@]}" -ge 2 ] || die 'say why: ./scripts/pipeline.sh freeze "<reason>"'
    deploy freeze "${ARGS[@]:1}"
    ;;
  dry-run)
    deploy dry-run "${ARGS[@]:1}"
    ;;
  run|forget)
    [ "${#ARGS[@]}" -ge 2 ] || die "$COMMAND needs a task id (see: ./scripts/pipeline.sh tasks)"
    deploy "$COMMAND" "${ARGS[1]}"
    ;;
  simulate)
    ( cd "$REPO_ROOT" && pnpm --filter "$PIPELINE_PACKAGE" synth >/dev/null && node packages/pipeline/scripts/simulate-pipeline-policy.ts "${ARGS[@]:1}" )
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
