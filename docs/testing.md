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
mise exec -- pnpm --filter @nikovirtala/core test
mise exec -- pnpm --filter @nikovirtala/auth test
mise exec -- pnpm --filter @nikovirtala/bridge test
mise exec -- pnpm --filter @nikovirtala/api test
mise exec -- pnpm --filter @nikovirtala/mcp test
mise exec -- pnpm --filter @nikovirtala/cdk test
```

## Synthesizing the CDK stack

`synth` is a quick way to confirm the CDK app assembles (and it runs the cdk-nag
checks):

```bash
mise exec -- pnpm synth   # pnpm --filter @nikovirtala/cdk synth
```

It uses placeholder images/code and the fallback `publicBaseUrl`, so it needs no
Docker build and no AWS credentials.

## The live end-to-end harness

```bash
mise exec -- pnpm e2e   # pnpm --filter @nikovirtala/e2e e2e → node src/run.ts
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
