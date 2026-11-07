# Deploying the control plane

This guide deploys the single `KiroRemoteStack` into your AWS account with the
AWS CDK. When it finishes you will have a reachable REST API, an MCP endpoint, and
a running bridge.

## Prerequisites

- An AWS account and credentials configured for the AWS CLI / CDK (the stack is
  deployed into the account and region resolved from your environment).
- The pinned toolchain: Node **26.13.0** and pnpm **12.18.0** (see
  [`.mise.toml`](../.mise.toml)). With [mise](https://mise.jdx.dev):

  ```bash
  mise install
  ```

- A container runtime that can build a `linux/arm64` OCI image (Docker or a
  compatible builder). The bridge image
  ([`packages/bridge/Dockerfile`](../packages/bridge/Dockerfile)) is built as part
  of a production deploy. See [Building the bridge image](#building-the-bridge-image).
- Your personal **Kiro API key** (`ksk_...`) from
  [app.kiro.dev](https://app.kiro.dev) → **API Keys**. It becomes the bridge's
  credential for `kiro-cli` and is stored in Secrets Manager, never on the command
  line or in the image.

## 1. Install dependencies

From the repository root:

```bash
mise exec -- pnpm install
```

## 2. Build and sanity-check

TypeScript runs via Node type stripping, so `build` only type-checks; it does not
emit artifacts. Running `synth` confirms the CDK app assembles before you deploy:

```bash
mise exec -- pnpm build
mise exec -- pnpm synth
```

`pnpm synth` runs `cdk synth --app "node bin/app.ts" --quiet` inside
`packages/cdk`. It uses placeholder images/code and the fallback
`publicBaseUrl` so it works without a container build or AWS credentials.

## 3. Choose your deploy context

The CDK app ([`packages/cdk/bin/app.ts`](../packages/cdk/bin/app.ts)) reads three
context values, passed with `-c key=value`:

| Context key           | Default                                             | Meaning                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `publicBaseUrl`       | `https://kiro.example.com` (synth placeholder only) | The canonical `https://<host>` **without** a trailing slash. Use a custom domain fronting the HTTP API, or the API Gateway default domain `https://<api-id>.execute-api.<region>.amazonaws.com`. Used verbatim for the RFC 9728 PRM, the RFC 8414 AS-metadata issuer, the Cognito resource identifier (`<host>/mcp`), and the CIMD allow-list, so for a real deploy it **must** be the real, reachable host. |
| `cognitoDomainPrefix` | `kiro-remote`                                       | The Cognito managed-login domain prefix. The hosted UI is served from `<prefix>.auth.<region>.amazoncognito.com`.                                                                                                                                                                                                                                                                                            |
| `allowedRepos`        | `*/*`                                               | Comma-separated GitHub repo globs the bridge may launch sessions against. Launches outside this list are rejected with 403.                                                                                                                                                                                                                                                                                  |

> **About `publicBaseUrl` and the chicken-and-egg with the API Gateway default
> domain:** if you are not using a custom domain, the default domain only exists
> after the HTTP API is created. A common approach is to deploy once (the synth
> placeholder is fine to create the API), read the generated API Gateway domain,
> and then redeploy with `-c publicBaseUrl=https://<api-id>.execute-api.<region>.amazonaws.com`
> so the PRM/AS-metadata/CIMD values all match the real host. Using a custom
> domain avoids the second deploy.

### Other construct options

Additional options exist on `KiroRemoteProps`
([`packages/cdk/src/construct.ts`](../packages/cdk/src/construct.ts)). The app
entrypoint only wires the three context keys above; to set the rest you edit
`bin/app.ts` (or your own thin app) and pass them to the stack. The most useful:

| Prop                   | Default                                   | Meaning                                                                                                                                        |
| ---------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `cimdAllowedHosts`     | facade host + `claude.ai` always included | Extra hosts permitted as CIMD `client_id` URL hosts.                                                                                           |
| `maxCloudSessions`     | `10`                                      | Concurrent cloud-session cap (includes IDE/Web usage).                                                                                         |
| `eventTtlDays`         | `30`                                      | Event TTL in days.                                                                                                                             |
| `permissionTimeout`    | `24h`                                     | How long a permission request stays answerable.                                                                                                |
| `kiroCliVersion`       | —                                         | The `kiro-cli` version baked into the bridge image via the `KIRO_CLI_VERSION` build arg. Required when building the image from the Dockerfile. |
| `preRegisteredClients` | —                                         | A list of `{ name, callbackUrls }` public OAuth clients (e.g. Claude Code, VS Code) that authorize through the facade.                         |
| `bridgeImage`          | placeholder registry image                | Override the bridge container image. Production deploys pass `ContainerImage.fromAsset(...)` (see below).                                      |
| `apiLambdaCode`        | inline placeholder                        | Override the API Lambda code with your bundled asset.                                                                                          |

> The defaults for `bridgeImage` and `apiLambdaCode` are deliberately
> placeholders so `cdk synth` runs with no Docker build and no bundling step in
> constrained CI/sandboxes. A production deploy must override them (image + Lambda
> code) so the stack actually serves traffic.

## Building the bridge image

The bridge image is `linux/arm64` (ECS Fargate on Graviton). It installs
`kiro-cli` via the official install script pinned by the `KIRO_CLI_VERSION` build
ARG, and runs `bridge serve` via Node type stripping.
`KIRO_API_KEY` is **never** baked into the image; it is injected as an ECS secret
at runtime.

To wire it into the stack, set `bridgeImage` in the construct props to a
`fromAsset` build of the repo root, for example:

```ts
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import { ContainerImage } from "aws-cdk-lib/aws-ecs";

bridgeImage: ContainerImage.fromAsset(repoRoot, {
  file: "packages/bridge/Dockerfile",
  buildArgs: { KIRO_CLI_VERSION: "<version>" },
  platform: Platform.LINUX_ARM64,
}),
```

Building this requires a working container runtime; CDK invokes it during
`cdk deploy`.

## 4. Store the Kiro API key

The stack creates a Secrets Manager secret for `KIRO_API_KEY`. Populate it with
your `ksk_` key so the bridge can authenticate `kiro-cli`. You can set the value
after the stack exists:

```bash
aws secretsmanager put-secret-value \
  --secret-id <kiro-api-key-secret-id> \
  --secret-string 'ksk_xxxxxxxx'
```

Find `<kiro-api-key-secret-id>` from the stack's resources, e.g.:

```bash
aws cloudformation list-stack-resources --stack-name KiroRemoteStack \
  --query "StackResourceSummaries[?ResourceType=='AWS::SecretsManager::Secret']"
```

Never commit or echo the real key; use the placeholder `ksk_xxxxxxxx` in notes.

## 5. Bootstrap and deploy

If the account/region has never been CDK-bootstrapped, bootstrap it once. Run CDK
commands from `packages/cdk` (its `cdk.json` sets `app` to `node bin/app.ts`). The
`aws-cdk` CLI is a dev dependency of that package, so invoke it through pnpm:

```bash
# Bootstrap (once per account/region).
mise exec -- pnpm --filter @kiro-remote/cdk exec cdk bootstrap

# Deploy with your real context values.
mise exec -- pnpm --filter @kiro-remote/cdk exec cdk deploy \
  -c publicBaseUrl=https://<host> \
  -c cognitoDomainPrefix=<prefix> \
  -c allowedRepos=owner/repo1,owner/repo2
```

The account and region come from `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION`
(standard CDK behavior). Kiro cloud sandboxes always run in `us-east-1` regardless
of where the stack is deployed.

> There is no custom `deploy` npm script; `packages/cdk/package.json` defines
> `build`, `test`, and `synth` only. Invoke the local `cdk` binary directly as
> shown (it uses the same `--app "node bin/app.ts"` that `cdk.json` configures).

## 6. Find the resource identifiers you'll need

The stack does **not** publish named CloudFormation outputs for the Cognito IDs.
Read them from the deployed resources. You will need the **user pool id**, the
**facade app client id**, and the **managed-login domain** for the next guides:

```bash
# All stack resources (find the Cognito user pool + user pool clients):
aws cloudformation list-stack-resources --stack-name KiroRemoteStack

# The user pool's details, including its hosted/managed-login domain:
aws cognito-idp describe-user-pool --user-pool-id <user-pool-id>

# The app clients on the pool (the facade client id is here):
aws cognito-idp list-user-pool-clients --user-pool-id <user-pool-id>
```

The managed-login domain is `<cognitoDomainPrefix>.auth.<region>.amazoncognito.com`
with the prefix you passed at deploy time.

## Next

- [Register a user](./users.md)
- [Try the REST API](./rest-api.md)
- [Use the MCP server](./mcp.md)
