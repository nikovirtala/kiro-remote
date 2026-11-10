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

Without `deploy.env` or AWS credentials, synthesize the Lambda bridge mode
directly from `packages/cdk` (output goes to `/tmp`, nothing is deployed):

```bash
cd packages/cdk
mise exec -- pnpm exec cdk synth --quiet -o /tmp/kiro-remote-synth \
  -c kiroCliVersion=3.1.0 -c bridgeMode=lambda \
  -c publicBaseUrl=https://kiro-remote.nikovirtala.dev \
  -c cognitoDomainPrefix=kiro-remote -c 'allowedRepos=*/*' \
  -c kiroApiKeySecretArn=arn:aws:secretsmanager:eu-north-1:827333031966:secret:kiro-api-key-AbCdEf
```

`/tmp/kiro-remote-synth/KiroRemoteStack.template.json` then holds the
`CatchUpQueue` and two `AWS::Lambda::EventSourceMapping` resources.

## Building the bridge images and the engine smoke

Build both bridge images from the repo root (Docker, `linux/arm64`):

```bash
docker build --platform linux/arm64 --build-arg KIRO_CLI_VERSION=3.1.0 \
  -f packages/bridge/Dockerfile -t kiro-remote-bridge:3.1.0 .
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

The Fargate bridge starts `kiro-cli acp --agent-engine=v3` at boot, which
unpacks the engine into `$HOME/.local/share/kiro-cli` before it answers. The
same smoke against the Fargate image, as the `bridge` user (uid 10001):

```bash
docker run --rm --platform linux/arm64 --user 10001:10001 --entrypoint /bin/sh kiro-remote-bridge:3.1.0 -c '(printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":1,\"clientCapabilities\":{}}}" "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"session/new\",\"params\":{\"cwd\":\"/tmp\",\"mcpServers\":[],\"_meta\":{\"kiro\":{\"executionTarget\":{\"kind\":\"cloud-sandbox\"},\"sessionSource\":\"remote\",\"repositories\":[\"octo/repo\"]}}}}"; sleep 40) | KIRO_API_KEY=dummy timeout 90 kiro-cli acp --agent-engine=v3 2>/dev/null'
```

Expected: the same `"id":1` result and `"id":2` `Identity provider is required`
error.

## Live-test checklist (Lambda direct engine)

The unit tests drive a fake engine. These checks need a deployed `lambda`
stack and a real Kiro API key:

- **Launch and follow-up.** Launch a session, then send a follow-up. Both
  settle `idle`, and the consumer logs `session_launched` and no
  `cloud_turn_failed`.
- **Forced detach.** Ordinary turns finish long before the 90 s margin, so the
  detach path only runs when forced. Set `DETACH_MARGIN_MS` on the consumer
  function (in the Lambda console, so the other env vars stay as they are) to
  `890000`, which detaches about 10 s into a turn on the 15-minute function.
  Send a prompt that runs longer than that, once as a launch and once as a
  follow-up. Expect `turn_detached`, then one or more `catch_up_pending`, then
  `catch_up_completed`, with the session back to `idle` and the turn's text in
  the event log once, without duplicates. This shows whether stopping the
  engine leaves the cloud turn running and whether a remote `session/load`
  replays a running turn. A `catch_up_segment_mismatch` or a catch-up that
  stays pending after the turn finished in Kiro is a failure to report.
  Remove the variable afterwards.
- **Fargate on 3.1.0** (only before deploying `fargate` or `both` with
  `KIRO_CLI_VERSION=3.1.0`). `headless.ts` parses `[cloud] session <uuid>` from
  `kiro-cli chat --cloud` stderr. Confirm a real 3.1.0 cloud chat still prints
  that line.

## The live end-to-end harness

```bash
mise exec -- pnpm e2e   # pnpm --filter @nikovirtala/kiro-remote-e2e e2e → node src/run.ts
```

The harness ([`e2e/src/run.ts`](../e2e/src/run.ts)) drives the **full live flow**
against a real deployment. It needs:

- a **deployed stack**, with `KIRO_REMOTE_URL` set to the canonical `https://<host>`,
- the `kiro-cli` binary on `PATH`,
- a browser (for the interactive login), and
- optionally MCP Inspector.

Two secrets are read **from the environment only** (never from disk, logs, or the
report): `KIRO_API_KEY` (`ksk_...`) and `KIRO_API_E2E_REPO` (the GitHub repo the
live run targets). They are surfaced to the report only as presence booleans,
never their values.

### Exit codes (by design)

The harness never fabricates results. Each step either runs for real or records a
precise `blocked: <reason>`:

- **exit 0** — at least one live step actually ran.
- **exit 2** — nothing live could run; every live step is recorded as `blocked`
  with its exact reason. This is the **expected** outcome with no deployed stack
  (for example in a fresh sandbox where `KIRO_REMOTE_URL` is unset): the harness
  did its job, but the live e2e did not execute, so CI sees a non-zero code rather
  than a false green.

So a non-zero `pnpm e2e` in an environment with no deployment is normal; read the
printed report to see which prerequisites were missing.
