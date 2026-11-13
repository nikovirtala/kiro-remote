# Running the tests

kiro-remote has two kinds of checks: fast, fully offline unit/integration tests
(Vitest) run per package, and a live end-to-end harness that needs a deployed
stack. All commands below use the pinned toolchain via `mise exec --`; drop that
prefix if you manage Node/pnpm yourself.

## Everything at once

From the repository root:

```bash
mise exec -- pnpm install   # once
mise exec -- pnpm test      # runs `pnpm -r test` across every package
mise exec -- pnpm build     # type-check all packages (no emit)
mise exec -- pnpm lint      # biome check .
```

`pnpm test` fans out to each package's `test` script (`vitest run`) and covers
core, auth, bridge, api, mcp, cdk, and the e2e harness's own unit tests.

## A single package

Use the workspace filter to run just one package's tests:

```bash
mise exec -- pnpm --filter @nikovirtala/kiro-remote-core test
mise exec -- pnpm --filter @nikovirtala/kiro-remote-auth test
mise exec -- pnpm --filter @nikovirtala/kiro-remote-bridge test
mise exec -- pnpm --filter @nikovirtala/kiro-remote-api test
mise exec -- pnpm --filter @nikovirtala/kiro-remote-mcp test
mise exec -- pnpm --filter @nikovirtala/kiro-remote-cdk test
```

## Synthesizing the CDK stack

The CDK unit tests synthesize the stack with test props and run the cdk-nag
checks, with no Docker and no AWS credentials:

```bash
mise exec -- pnpm --filter @nikovirtala/kiro-remote-cdk test
```

To synthesize exactly what a deploy would produce, run:

```bash
mise exec -- pnpm synth   # ./scripts/deploy.sh --synth
```

It reads `deploy.env`, checks the AWS account and region, bundles the real API
Lambda, stages the bridge image build context, and runs the cdk-nag checks
against the real asset constructs. It needs AWS credentials but not Docker (the
image is built at deploy), and deploys nothing. See
[Bootstrap and deploy](deploy.md#5-bootstrap-and-deploy).

Without `deploy.env` or AWS credentials, synthesize the stack directly from
`packages/cdk` (output goes to `/tmp`, nothing is deployed):

```bash
cd packages/cdk
mise exec -- pnpm exec cdk synth --quiet -o /tmp/kiro-remote-synth \
  -c kiroCliVersion=3.1.0 \
  -c publicBaseUrl=https://kiro-remote.nikovirtala.dev \
  -c cognitoDomainPrefix=kiro-remote -c 'allowedRepos=*/*' \
  -c kiroApiKeySecretArn=arn:aws:secretsmanager:eu-north-1:827333031966:secret:kiro-api-key-AbCdEf
```

`/tmp/kiro-remote-synth/KiroRemoteStack.template.json` then holds the
durable catch-up function (`DurableConfig`), its retained `AWS::Lambda::Version`
and the `live` `AWS::Lambda::Alias`, one `AWS::Lambda::EventSourceMapping`
(the command queue on the consumer, none on the durable function), no `RecursiveLoop: Allow` on any function, and no
`AWS::ECS::*` or `AWS::EC2::*` resources.

## Building the bridge image and the engine smoke

Build the bridge image from the repo root (Docker, `linux/arm64`):

```bash
docker build --platform linux/arm64 --build-arg KIRO_CLI_VERSION=3.1.0 \
  -f packages/bridge/Dockerfile.lambda -t kiro-remote-bridge-lambda:3.1.0 .
```

The Lambda image build fails if unpacking the engine did not produce
`/opt/kiro/node` and `acp-server.js`. To check that the unpacked engine starts
the way the Lambda handlers start it, run this smoke with a dummy key (never a
real one):

```bash
docker run --rm --platform linux/arm64 --entrypoint /bin/sh kiro-remote-bridge-lambda:3.1.0 -c '(printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":1,\"clientCapabilities\":{}}}" "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"session/new\",\"params\":{\"cwd\":\"/tmp\",\"mcpServers\":[],\"_meta\":{\"kiro\":{\"executionTarget\":{\"kind\":\"cloud-sandbox\"},\"sessionSource\":\"remote\",\"repositories\":[\"octo/repo\"]}}}}"; sleep 20) | HOME=/tmp KIRO_HOME=/tmp/.kiro KIRO_API_KEY=dummy CLOUD_CONFIG_ENDPOINT=https://app.kiro.dev KIRO_REMOTE_SESSIONS_ENDPOINT=https://app.kiro.dev NODE_USE_SYSTEM_CA=1 timeout 40 /opt/kiro/node --experimental-wasm-modules /opt/kiro/kas/current/node_modules/@kiro/agent/dist/server/acp-server.js --transport=stdio'
```

Expected: an `"id":1` `initialize` result, and an `"id":2` error on
`session/new` containing `Identity provider is required` (the dummy key is
rejected by Kiro, which proves the engine reached it). Add
`--user 10001:10001` after `--rm` to check that a non-root user, like Lambda's
sandbox user, can run `/opt/kiro`.

## Live-test checklist (Lambda direct engine)

The unit tests drive a fake engine. These checks need a deployed stack
and a real Kiro API key:

- **Launch, follow-up and delete.** `pnpm e2e` (see
  [the live end-to-end harness](#the-live-end-to-end-harness)) covers these
  over MCP and over REST. While it runs, the consumer logs should show
  `session_launched` and no `cloud_turn_failed`.
- **Forced detach.** Ordinary turns finish long before the 90 s margin, so the
  detach path only runs when forced. Set `DETACH_MARGIN_MS` on the consumer
  function (in the Lambda console, so the other env vars stay as they are) to
  `890000`, which detaches about 10 s into a turn on the 15-minute function.
  Send a prompt that runs longer than that, once as a launch and once as a
  follow-up. Expect `turn_detached` and `catch_up_started` on the consumer, which starts
  one durable execution of the catch-up function (alias `live`) named
  `cu-<40 hex chars>`, derived from the session and turn ids. Then, on the
  catch-up function, one or more `catch_up_pending` and finally
  `catch_up_completed`, with the session back to `idle` and the turn's text in
  the event log once, without duplicates. Inspect the execution:

  ```bash
  aws lambda list-durable-executions-by-function \
    --function-name <catch-up function name> --region eu-north-1
  aws lambda get-durable-execution-history \
    --durable-execution-arn <DurableExecutionArn from the list> --region eu-north-1
  ```

  The list covers executions on every version, each with the version it is
  pinned to. The history shows one `catch-up-N` step per round with a `wait-N`
  between rounds, and ends `SUCCEEDED`.

  For a short run, also lower `CATCH_UP_DELAY_SECONDS` (default 60), for
  example to `10`. The consumer invokes the catch-up function through the
  `live` alias, which points at a published version, so changing the variable
  on `$LATEST` has no effect. Change it on `$LATEST`, publish a version
  (`aws lambda publish-version`), point `live` at it (`aws lambda
  update-alias`), and afterwards point `live` back at the version the stack
  deployed, restore the variable and delete the extra version.

  Also check that the `RecursiveInvocationsDropped` metric of the consumer and
  the catch-up function stays 0: no function opts out of recursive loop
  detection. A live run on 2026-11-13 (19 rounds at 10 s) confirmed that
  durable resumptions do not count towards it. The run exercises stopping the
  engine while the cloud turn keeps running, and a remote `session/load`
  replaying a running turn. A `catch_up_segment_mismatch` or a catch-up that
  stays pending after the turn finished in Kiro is a failure to report.
  Remove `DETACH_MARGIN_MS` afterwards.

## The live end-to-end harness

```bash
export KIRO_REMOTE_URL=https://kiro-remote.nikovirtala.dev
export KIRO_API_E2E_REPO=owner/repo
mise exec -- pnpm e2e   # pnpm --filter @nikovirtala/kiro-remote-e2e e2e → node src/run.ts
```

The harness ([`e2e/src/run.ts`](../e2e/src/run.ts)) tests a deployed stack the
way a client uses it: MCP first, then REST. Each step makes real requests and
passes only when its assertions hold. A step that fails or does not run makes
the exit code non-zero.

### Prerequisites

- A deployed stack.
- Node 26 with `npx` and network access. The first run downloads
  `@modelcontextprotocol/inspector@2.14.0`.
- A desktop browser for the sign-ins.
- Port 6276 free on `127.0.0.1`. It is the Inspector CLI's fixed OAuth
  callback.

### Environment variables

- `KIRO_REMOTE_URL` (required): the stack's public base URL. Without it every
  step is skipped.
- `KIRO_API_E2E_REPO` (required for the launch steps): the repo the sessions
  run on, as `owner/repo`. It must be in the stack's `allowedRepos`. The
  harness holds it in memory only, reports just whether it is set, and
  replaces it with `[REDACTED]` in every line it prints.

`KIRO_API_KEY` is not used. It is the bridge's credential, never a REST or MCP
bearer.

### Sign-in

A run asks for up to two browser sign-ins:

1. **The Inspector step** always opens one. The harness runs the Inspector with
   its in-memory secret store and a temporary storage directory that it
   deletes afterwards, so the Inspector's tokens are gone when it exits. By
   default the Inspector would keep them in the OS keychain or
   `~/.mcp-inspector/secrets.json`, and the harness keeps tokens only in the
   `kiro-remote` 0600 token file. Each Inspector run also registers one new
   `mcp_` client through dynamic client registration, as Claude does.
2. **The login step** reuses the `kiro-remote login` token in
   `~/.config/kiro-remote/tokens.json` and refreshes it silently. When the
   file has no token for this host, or the refresh fails, it runs the same
   browser login as `kiro-remote login` and stores the result in that file. To
   skip this sign-in, run `kiro-remote login` beforehand (see
   [`docs/mcp.md`](mcp.md)). The token must carry the `sessions:read`,
   `sessions:write` and `sessions:delete` scopes.

The bearer token is never printed, put on a command line, or written anywhere
other than that token file.

### Steps

- `discovery`: An unauthenticated `POST /mcp` answers 401 with
  `WWW-Authenticate: … resource_metadata="…"`. The protected-resource metadata
  names `<KIRO_REMOTE_URL>/mcp` as the resource and `<KIRO_REMOTE_URL>` as the
  authorization server. The authorization-server metadata has that issuer,
  supports S256, and lists the authorization, token and registration endpoints.
- `mcp-inspector`: The Inspector CLI
  (`--cli <url>/mcp --transport http --method tools/list`) completes
  discovery, registration and the browser sign-in, and lists exactly the 16
  registered tools.
- `login`: A token with the three scopes, from the token file or a browser
  login. `captured.source` says which.
- `mcp-tools`: The MCP SDK client connects over Streamable HTTP with that token.
  `tools/list` returns the 16 tools, and `kiro_capabilities` and
  `kiro_list_models` return their result shapes.
- `mcp-launch`: `kiro_launch_session` on the repo returns a session id.
  `kiro_get_session` returns it and `kiro_list_sessions` lists it.
- `mcp-launch-turn`: `kiro_wait_for_events` until the launch turn settles `idle`
  with no `turn.failed`. `kiro_get_transcript` contains the launch marker.
- `mcp-followup`: `kiro_send_prompt` with `whenBusy: "reject"`, then waits until
  that turn settles. Its transcript turn contains the follow-up marker.
- `mcp-delete`: `kiro_delete_session` returns `deleting`, and `kiro_get_session`
  reports not found within 5 minutes.
- `rest-read`: `GET /v1/capabilities` and `GET /v1/models` return their result
  shapes.
- `rest-launch`: `POST /v1/sessions` returns a session id and
  `GET /v1/sessions/{id}` returns it.
- `rest-launch-turn`: `GET /v1/sessions/{id}/events` until the launch turn
  settles. Its message text contains the launch marker.
- `rest-followup`: `POST /v1/sessions/{id}/turns` with `whenBusy: "reject"`,
  then events until that turn settles with its marker.
- `rest-delete`: `DELETE /v1/sessions/{id}`, then `GET` answers 404 within 5
  minutes.
- `cleanup`: Only present when sessions were left behind (see below).

A step is skipped when a required environment variable is missing, when a step
it depends on did not pass, or after Ctrl-C. The delete steps depend only on
their launch step, so a session whose turn failed is still deleted in the
flow.

Every prompt asks Kiro not to change files, open a pull request, or run
commands, and to reply with one marker line such as
`KIRO_E2E_<run id>_MCP_LAUNCH`. Sessions are titled
`kiro-remote e2e <run id> (mcp|rest)`. A turn has 20 minutes to settle, which
covers a catch-up continuation past the 15-minute consumer. Expect several
minutes per launch.

### The GitHub wake scenario (opt-in)

With `KIRO_API_E2E_GITHUB=1` the harness appends 15 steps in three sessions
(28 in total, plus `cleanup` when sessions were left behind): the single-PR
flow (`gh-launch` to `gh-cleanup`), a chain of two dependent PRs
(`gh-chain-*`), and failing checks plus a PR closed unmerged (`gh-checks-*`,
`gh-close-wake`). They need the GitHub App installed on
the repo and the GitHub CLI logged in as a trusted login. See
[GitHub wake](./github.md#live-end-to-end-scenario-opt-in). Without the flag
they are not in the step list at all, so a normal run has 13 steps and none
skipped.

### Output and exit codes

Progress lines (`▶`, `✔`, `✘`, `–`), the Inspector's output and the login
messages go to stderr. The JSON report goes to stdout: `config` (the URL and
whether the repo is set) and `steps[]`, each with `id`, `name`, `status`
(`passed`, `failed` or `skipped`), `reason`, `durationMs` and `captured`
(ids, statuses, counts and durations only). A summary line follows on stderr:
`e2e: N passed, M failed, K skipped`.

`node e2e/src/run.ts` exits:

- **0**: every step passed;
- **1**: a step failed, or the harness crashed;
- **2**: nothing failed, but some steps were skipped. For example, without
  `KIRO_REMOTE_URL` all 13 steps are skipped with `KIRO_REMOTE_URL is unset`.

`pnpm e2e` reports any non-zero code from the script as 1.

### Cleanup and Ctrl-C

The harness tracks every session it creates. After the steps, it deletes over
REST each session that a delete step did not confirm gone, and waits for a 404.
This also runs after a failed step. When it had something to delete, the
report gets a `cleanup` step: passed when every leftover is gone, failed with
the session ids otherwise. Delete those by hand.

The first Ctrl-C stops the current wait, skips the remaining steps as
`run interrupted.`, and still runs the cleanup. A second Ctrl-C exits at once
with code 130 and may leave sessions behind.

### Not covered

These operations do not apply to cloud sessions, so the harness does not test
them:

- **cancel**: a running cloud turn rejects it as an unsupported operation, and
  it is a no-op on an idle session;
- **set_config** (model, effort, mode): a logged no-op on cloud sessions;
- **permissions** (list and answer): cloud turns never ask;
- **adopt**: rejected by the bridge;
- **steer, and `whenBusy: "queue"` during a turn**: rejected as unsupported.

The claude.ai connector and forced detach / catch-up stay manual checks (see
the [live-test checklist](#live-test-checklist-lambda-direct-engine)).
