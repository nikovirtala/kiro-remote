# The deploy pipeline

Every merge to `main` deploys kiro-remote (`KiroRemoteDnsStack` and `KiroRemoteStack`), runs the smoke checks, runs the pending one-off deployment tasks, and on a failure rolls back and freezes itself. A person no longer deploys by hand, except through the break-glass path below.

The run is [`@nikovirtala/deployment`](https://github.com/nikovirtala/ark/tree/main/packages/deployment), an ark member extracted from longplay's platform pipeline ([its design](https://github.com/nikovirtala/ark/blob/main/docs/04-deployment-v1.md)). Here: `deploy.toml` (every name the run uses, and the settings schema), `packages/pipeline` (the pipeline stack, its own CDK app; the smoke checks; the policy simulation), `tasks/` (the deployment tasks), `scripts/pipeline.sh` (the commands).

## What happens on a merge

```text
GitHub (push to main) → CodeConnections → CodePipeline V2 (SUPERSEDED) → one stage, one CodeBuild action
```

| #   | Step                                                                                                                                                                                                                     | As                                          | If it fails                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------ |
| 1   | The pipeline starts on a push to `main`. One run at a time, and a run waiting behind another is replaced by a newer one (SUPERSEDED)                                                                                     | CodePipeline                                |                                                              |
| 2   | **Freeze flag.** If `/kiro-remote/deployment/frozen` exists, or cannot be read, the run stops at once and says `PIPELINE FROZEN`, before anything is installed                                                           | the runner                                  | the run fails, nothing is deployed                           |
| 3   | **Check.** Node and pnpm from `.mise.toml`, `pnpm install --frozen-lockfile`, `pnpm check` (lint, type-check, tests)                                                                                                     | the runner                                  | nothing is deployed, nothing is frozen                       |
| 4   | **Settings and preflight.** The settings from SSM against the schema in `deploy.toml`, then deploy.sh's guards: `KiroRemoteStack` exists in `eu-north-1`, and the Kiro API key and GitHub App secrets exist (names only) | the deploy role                             | refused: nothing deployed, nothing frozen, the topic is told |
| 5   | **Synth** of both stacks with the settings and the provenance (the commit, the repository, the environment)                                                                                                              | the deploy role                             | refused, as above                                            |
| 6   | **Deploy** both stacks (`cdk deploy`, as `deploy.sh` does). Rollback triggers: none yet, because the service has no CloudWatch alarms                                                                                    | the deploy role                             | freeze, roll back, notify                                    |
| 7   | **Smoke.** `packages/pipeline/scripts/smoke.ts --json`                                                                                                                                                                   | the smoke role (read-only, no session data) | freeze, roll back, notify                                    |
| 8   | **Deployment tasks.** Every file in `tasks/` whose id is not in the ledger, in order, each with a dry run first, each as the role it declares                                                                            | the task roles                              | freeze, notify, **no rollback**                              |
| 9   | **Success.** The commit becomes the last good one                                                                                                                                                                        | the runner                                  |                                                              |

On a failed deploy or smoke check the run sets the freeze flag **first**, then deploys the last good commit from a `git worktree` of it with the same settings, then publishes what failed to the topic `kiro-remote-deployment`. Each run that gets past the flag is also a [GitHub deployment](https://github.com/nikovirtala/kiro-remote/deployments) of its commit to `production`: in progress, then success, failure (a failed deploy, smoke check or task) or error (refused); a success marks the earlier ones inactive.

Every function of the service gets `OTEL_RESOURCE_ATTRIBUTES` with `vcs.ref.head.revision`, `vcs.repository.url.full`, `deployment.environment.name` and `service.version`, and the loggers put them on every log line, so a log line says which commit wrote it. A deploy with `deploy.sh` stamps nothing: a smoke run by hand then fails on it, which is how a deploy by hand shows up, and the next pipeline deploy stamps the functions again.

## The settings: copy `deploy.env` into SSM

```sh
./scripts/pipeline.sh settings
```

It copies the settings of `deploy.env` that `deploy.toml` lists (the keys `deploy.sh` maps to `-c` flags) into `/kiro-remote/deployment/settings/` and removes parameters the file no longer sets. It refuses, and writes nothing, when a REQUIRED one is missing: `KIRO_CLI_VERSION`, `KIRO_API_KEY_SECRET_ARN`, `HOSTED_ZONE_ID` (while the DNS zone and the custom domain are on), and `GITHUB_APP_SECRET_ARN`. The last one is REQUIRED only in the pipeline: a deploy without it removes GitHub wake, and the pipeline deploys with no one watching the diff. `AWS_PROFILE`, `AWS_ACCOUNT_ID` and `AWS_REGION` are `deploy.sh`'s own and are not copied.

SSM cannot hold a blank value, so the pipeline cannot turn off what `deploy.sh` turns off with a blank (`CUSTOM_DOMAIN_NAME=`, `DNS_ZONE_NAME=`): it uses the default. Secrets are never settings: a setting names a secret, and the pipeline never reads its value.

## Bootstrap (once) `needs-niko`

**1. Create the connection and finish its handshake.** CloudFormation can only create a connection `PENDING`; the handshake is a click in the console.

```sh
aws codeconnections create-connection --region eu-north-1 --provider-type GitHub \
  --connection-name kiro-remote-github --query ConnectionArn --output text
```

Developer Tools → Settings → Connections → `kiro-remote-github` → **Update pending connection** → install or select the AWS Connector for GitHub app for `nikovirtala/kiro-remote` only → Connect. The status must read **Available**.

**2. The settings,** as above: `./scripts/pipeline.sh settings`.

**3. The GitHub token** for the deployment records: a fine-grained personal access token for `nikovirtala/kiro-remote` only, with the repository permission **Deployments: Read and write** and nothing else.

```sh
aws secretsmanager create-secret --region eu-north-1 --name kiro-remote/deployment/github-token \
  --secret-string '<the token>'
```

Without it the pipeline deploys as usual and records no GitHub deployment, and its log says so.

**4. Check the roles before they exist** (read-only): `./scripts/pipeline.sh simulate`. Expected: `OK: 91 policy decisions and 20 trust decisions match`.

**5. Deploy the pipeline stack.** It checks the connection is `AVAILABLE` and the settings are in SSM first.

```sh
./scripts/pipeline.sh bootstrap --connection-arn arn:aws:codeconnections:eu-north-1:827333031966:connection/<id> \
  --alarm-email <you@example.com>
```

Confirm the topic's email subscription from the mail it sends. Then the roles as deployed: `./scripts/pipeline.sh simulate --deployed`.

**6. The first run.** Merging starts it; if the pipeline was deployed after the merge, press **Release change** on `kiro-remote-deploy`. Read it in the log group `/aws/codebuild/kiro-remote-deploy-run`: the freeze check, `mise install`, `pnpm check`, the settings and preflight, the synth, `rollback triggers ...: none`, the deploy (every function's configuration changes once, for the provenance), the smoke checks, `no deployment task was pending`, `DONE: <commit> is the last good commit`. The GitHub deployment shows as active on the repository page.

What only this first run can show: the connection clones with history; `mise.run` installs Node 26 on the ARM image; Docker builds the arm64 bridge image; the bootstrap roles accept the deploy role's session; the runner can assume each role.

**7. Prove the rollback and the freeze once.** Push a commit to a branch that makes one smoke check fail on purpose, for example in `packages/pipeline/src/smoke/checks.ts`:

```ts
add("stack", "a drill: this check fails on purpose", "FAIL", "remove me");
```

Merge it. The run deploys it, the smoke stage fails on `FAIL stack a drill`, the run sets the freeze flag, deploys the last good commit again (`rolled back: the last good commit <sha> is deployed again`), notifies the topic, and ends `rolled-back`. The GitHub deployment of the drill commit shows **failure**, the one before stays **active**. `./scripts/pipeline.sh status` says `PIPELINE FROZEN` with the reason. Revert the drill commit and merge: that run stops at the flag (`PIPELINE FROZEN: nothing was deployed`). Then:

```sh
./scripts/pipeline.sh unfreeze
```

and press **Release change** (or merge anything): the revert deploys, and its smoke checks pass.

## Freeze and unfreeze

```sh
./scripts/pipeline.sh status                  # frozen or not, the last good commit, the last runs, the tasks
./scripts/pipeline.sh freeze "why"            # stop merges from deploying
./scripts/pipeline.sh unfreeze                # clear it, after you fixed what froze it
./scripts/pipeline.sh dry-run                 # what a run would do now: the flag, the settings, the pending tasks
```

A frozen run fails at once and does not notify again. The alarm `kiro-remote-deploy-pipeline-build-failed` publishes to the same topic when a build fails without having told you (an install that failed, an expired connection).

## Deployment tasks

How to write one is in [tasks/README.md](../tasks/README.md). By hand:

```sh
./scripts/pipeline.sh tasks                     # pending or done
./scripts/pipeline.sh dry-run <id>              # one task's dry run, with your credentials
./scripts/pipeline.sh run <id>                  # dry run first, then the run, recorded in the ledger
./scripts/pipeline.sh forget <id>               # back to pending (after a destroy and redeploy of the service)
```

## Smoke checks

`packages/pipeline/src/smoke/checks.ts`, from this repository's [deploy guide](deploy.md) and README: the stacks are healthy; the named outputs exist; the managed-login domain has its shape and the facade client its branding; `/openapi.json` is the OpenAPI 3.1 contract, the OAuth metadata is served and `/v1/sessions` and `/mcp` refuse a call without a token; every function is on Node 26 (or the bridge image with `TZ=UTC`), with active tracing and Powertools; the Kiro API key is only in Secrets Manager; every function carries the deployed commit; and the GitHub dead-letter queue's depth (INFO).

```sh
node packages/pipeline/scripts/smoke.ts --dry-run    # every check's calls, none made
node packages/pipeline/scripts/smoke.ts              # the checks, with your read-only credentials
```

## Deploy by hand when the pipeline is broken

`scripts/deploy.sh` is unchanged and is the break-glass path: it reads `deploy.env`, refuses without the same required settings, and deploys with your credentials. A deploy by hand does not move the last good commit, so a rollback after it goes to the previous pipeline-approved commit, and it stamps no provenance. Freeze the pipeline first (`./scripts/pipeline.sh freeze "deploying by hand"`) so a merge does not deploy over you, and unfreeze when you are done.

If the pipeline itself is the problem (a bad build spec, a lost connection), fix it and run `./scripts/pipeline.sh bootstrap` again: a plain `cdk deploy` of the pipeline stack, safe to repeat. The ledger table, the log group and the freeze flag survive it.

## The roles

| Role                                        | Trusts                | May                                                                                                                                                                                                                                           |
| ------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kiro-remote-deployment-runner` (the build) | the CodeBuild service | read the settings and the freeze flag, set the flag (not delete it), read and write the ledger (not delete), publish to the topic, read the GitHub token, `sts:AssumeRole` the work roles. No CloudFormation, Lambda, S3, KMS or other secret |
| `kiro-remote-deployment-deploy`             | the runner            | assume the four CDK bootstrap roles of `eu-north-1`, describe the two stacks and kiro-remote's secrets (the preflight)                                                                                                                        |
| `kiro-remote-deployment-smoke`              | the runner            | describe the stacks, read the functions' configuration, describe the branding and the secrets, count a queue. No table item, object, log line, secret value, user, message or key use                                                         |
| `kiro-remote-deployment-task-<name>`        | the runner            | one task's names (`packages/pipeline/src/task-roles.ts`; none yet)                                                                                                                                                                            |

`./scripts/pipeline.sh simulate` evaluates every role with IAM's own engine (`iam simulate-custom-policy`, read-only) on the synthesized template, with a refusal beside every grant. The simulator does not evaluate trust policies, so trust is decided by `trustAllows` in the same script, for the two shapes the stack emits, and `--deployed` compares it with the deployed roles.
