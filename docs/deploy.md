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
emit artifacts. The CDK unit tests synthesize the stack with test props and run
the cdk-nag checks, with no Docker and no AWS credentials:

```bash
mise exec -- pnpm build
mise exec -- pnpm --filter @nikovirtala/kiro-remote-cdk test
```

`pnpm synth` runs `./scripts/deploy.sh --synth`: a `cdk synth` with exactly the
settings a deploy would use (your `deploy.env`, region, and account checks). It
bundles the real API Lambda, stages the bridge image's Docker build context in
`cdk.out`, and runs the cdk-nag checks against the real asset constructs. It
needs AWS credentials but not Docker (the image is built at deploy), and it
deploys nothing. Set up `deploy.env` first (see
[Bootstrap and deploy](#5-bootstrap-and-deploy)).

The CDK app has **no defaults** for its deploy context. It refuses to synthesize
(so `cdk deploy`/`cdk diff` refuse to run) unless `publicBaseUrl`,
`cognitoDomainPrefix`, `allowedRepos`, `kiroApiKeySecretArn` and `kiroCliVersion`
are all set. This stops a context-free `cdk deploy` from replacing a live stack
with placeholders.

### Lambda runtime: Node 26 (public preview)

The stack targets **Node 26** on every Lambda, matching the Node 26.13.0
toolchain pinned in [`.mise.toml`](../.mise.toml):

- The managed (zip) API and OAuth Lambdas run on the `nodejs26.x` managed
  runtime. aws-cdk-lib does not yet expose a `Runtime.NODEJS_26_X` constant
  ([aws/aws-cdk#39021](https://github.com/aws/aws-cdk/issues/39021)), so the
  construct uses a small shim (`new Runtime("nodejs26.x", RuntimeFamily.NODEJS,
  { supportsInlineCode: true })`) until that constant ships.
- The serverless bridge image
  ([`packages/bridge/Dockerfile.lambda`](../packages/bridge/Dockerfile.lambda))
  is built on the `public.ecr.aws/lambda/nodejs:26` Lambda base, and the ECS
  bridge image ([`packages/bridge/Dockerfile`](../packages/bridge/Dockerfile))
  on `node:26-bookworm-slim` (a GA Docker Hub tag).

> **Preview caveat.** AWS lists `nodejs26.x` (and its `public.ecr.aws/lambda/nodejs:26`
> base image) as a **PUBLIC PREVIEW** runtime: it is **not covered by the AWS
> Lambda SLA or AWS Support**, is **not recommended for production**, and GA is
> targeted for around **November 2026** (see the
> [AWS Lambda runtimes docs](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtimes.html)).
> Node 26 is the default here because the repo pins 26.13.0 and is built to run
> on Node 26, but a production operator should weigh the preview status before
> deploying. The ECS image's `node:26-bookworm-slim` base is GA and unaffected;
> the preview distinction applies only to the Lambda base image and the
> `nodejs26.x` managed runtime. There is no Docker in CI here, so a Docker host
> must confirm the `public.ecr.aws/lambda/nodejs:26` tag resolves before a real
> `-c kiroCliVersion` deploy.

## 3. Choose your deploy context

The CDK app ([`packages/cdk/bin/app.ts`](../packages/cdk/bin/app.ts)) reads three
context values, passed with `-c key=value`:

> **Real assets, `-c kiroCliVersion=<ver>` (required).** This flag drives BOTH
> real production assets: the bridge Dockerfile's `KIRO_CLI_VERSION` build arg
> has **no default**, so without a concrete version there is nothing to build
> the real image from. With it:
>
> - the app **builds the real bridge container image locally** from
>   [`packages/bridge/Dockerfile`](../packages/bridge/Dockerfile) via
>   `ContainerImage.fromAsset` with the repo root as the build context,
>   `platform: linux/arm64` (Graviton) and `buildArgs: { KIRO_CLI_VERSION }`.
>   This **needs a working Docker/container runtime** on the machine running
>   `cdk deploy` (synth only stages the build context), and it builds
>   `linux/arm64`; and
> - the app **bundles the real API Lambda** (`src/lambda/entry.ts`) in-process
>   with esbuild and passes it as `apiLambdaCode`. The bundle is **headless, no
>   Docker** (esbuild is a workspace dev dependency).
>
> This repo's CDK app refuses to synthesize without it. The `KiroRemote`
> construct itself still falls back to a placeholder bridge image and an inline
> placeholder API Lambda when no real assets are passed; that is what the CDK
> unit tests use. The kiro-cli version is **operator-supplied** (`KIRO_CLI_VERSION`
> in `deploy.env`) and never hardcoded in the CDK code.
>
> The real bridge image build is the only step that needs Docker; run the
> deploy on a machine that has it (the API Lambda bundle itself runs anywhere
> esbuild does). A blank/empty `kiroCliVersion` is rejected with a clear error.
>
> Example real deploy (combining the version with this repo's custom-domain
> context):
>
> ```bash
> pnpm --filter @nikovirtala/kiro-remote-cdk deploy -- \
>   -c kiroCliVersion=1.2.3 \
>   -c publicBaseUrl=https://kiro-remote.nikovirtala.dev \
>   -c customDomainName=kiro-remote.nikovirtala.dev \
>   -c hostedZoneId=<HostedZoneId output>
> ```
>
> **CONFIG#CAPS caveat:** until the bridge first initializes and writes its
> `CONFIG#CAPS` item, `GET /capabilities` and `GET /models` return the
> empty-capabilities fallback. This is expected right after a fresh deploy and
> resolves once the bridge task is healthy and has published its capabilities.

| Context key           | Default      | Meaning                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `publicBaseUrl`       | — (required) | The canonical `https://<host>` **without** a trailing slash. Use a custom domain fronting the HTTP API, or the API Gateway default domain `https://<api-id>.execute-api.<region>.amazonaws.com`. Used verbatim for the RFC 9728 PRM, the RFC 8414 AS-metadata issuer, the Cognito resource identifier (`<host>/mcp`), and the CIMD allow-list, so for a real deploy it **must** be the real, reachable host. |
| `cognitoDomainPrefix` | — (required) | The Cognito managed-login domain prefix. The hosted UI is served from `<prefix>.auth.<region>.amazoncognito.com`.                                                                                                                                                                                                                                                                                            |
| `allowedRepos`        | — (required) | Comma-separated GitHub repo globs the bridge may launch sessions against. Launches outside this list are rejected with 403.                                                                                                                                                                                                                                                                                  |
| `bridgeMode`          | `fargate`    | Which host(s) drive the cloud command path: `fargate` (default), `lambda`, or `both`. Pass with `-c bridgeMode=lambda\|fargate\|both`. See [Choosing the bridge mode](#choosing-the-bridge-mode). The default reproduces the Fargate-only stack exactly.                                                                                                                                                     |

Three more context keys drive the optional custom domain (unset in the CDK app;
`scripts/deploy.sh` defaults `customDomainName`/`dnsZoneName` to the scoped
subdomain `kiro-remote.nikovirtala.dev`):

| Context key        | Default                        | Meaning                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customDomainName` | — (default execute-api domain) | The custom host fronting the HTTP API. When set, the stack creates (or imports) a regional ACM cert and an API Gateway v2 custom domain. See [Option B](#option-b--a-custom-domain-recommended).                                                                                                                                             |
| `dnsZoneName`      | — (no DNS stack)               | When set, `bin/app.ts` also synthesizes `KiroRemoteDnsStack`: a Route 53 **public hosted zone** for a delegated subdomain. Only needed for the automated Route 53 alternative; harmless otherwise (the zone is a separate stack you deploy or ignore). See [the Route 53 alternative](#automated-alternative--route-53-delegated-subdomain). |
| `hostedZoneId`     | — (zone-less manual CNAME)     | Id of a Route 53 public hosted zone owning `customDomainName` (typically the `HostedZoneId` output of `KiroRemoteDnsStack`). When set, the app stack validates the cert against that zone **and** creates the alias records in it — no manual DNS. Omit for the manual-Cloudflare path. Account-specific; set it in `deploy.env`.            |

> **About `publicBaseUrl` and the chicken-and-egg with the API Gateway default
> domain:** if you are not using a custom domain, the default domain only exists
> after the HTTP API is created. A common approach is to deploy once with any
> placeholder `PUBLIC_BASE_URL` to create the API, read the generated API Gateway domain,
> and then redeploy with `-c publicBaseUrl=https://<api-id>.execute-api.<region>.amazonaws.com`
> so the PRM/AS-metadata/CIMD values all match the real host. Using a custom
> domain avoids the second deploy. The two paths are laid out in full in
> [Pointing `publicBaseUrl` at the API](#pointing-publicbaseurl-at-the-api).

[`packages/cdk/cdk.json`](../packages/cdk/cdk.json) holds only CDK feature
flags, no deploy values. Set the values in a gitignored `deploy.env` at the repo
root and deploy with [`scripts/deploy.sh`](../scripts/deploy.sh), which maps each
`deploy.env` key to its `-c` flag (see [Bootstrap and deploy](#5-bootstrap-and-deploy)).
You can still pass `-c key=value` directly to the CDK CLI for one-off synths.

| `deploy.env` key          | Context key           |
| ------------------------- | --------------------- |
| `KIRO_CLI_VERSION`        | `kiroCliVersion`      |
| `BRIDGE_MODE`             | `bridgeMode`          |
| `PUBLIC_BASE_URL`         | `publicBaseUrl`       |
| `COGNITO_DOMAIN_PREFIX`   | `cognitoDomainPrefix` |
| `ALLOWED_REPOS`           | `allowedRepos`        |
| `CUSTOM_DOMAIN_NAME`      | `customDomainName`    |
| `DNS_ZONE_NAME`           | `dnsZoneName`         |
| `HOSTED_ZONE_ID`          | `hostedZoneId`        |
| `HOSTED_ZONE_NAME`        | `hostedZoneName`      |
| `CERTIFICATE_ARN`         | `certificateArn`      |
| `KIRO_API_KEY_SECRET_ARN` | `kiroApiKeySecretArn` |

> **Allow-list glob gotcha:** repos are matched as `owner/name`, where a single
> `*` matches any run of characters **except** `/`, and `**` matches across `/`.
> So `*` on its own matches nothing of the form `owner/name` and would reject
> every launch with a 403 — use `*/*` (any owner, any name) or `**` to allow all.
> To scope to your own repos, use e.g. `nikovirtala/*`, or a comma-separated list
> like `nikovirtala/kiro-remote,nikovirtala/other` (no spaces).

### Other construct options

Additional options exist on `KiroRemoteProps`
([`packages/cdk/src/construct.ts`](../packages/cdk/src/construct.ts)). The app
entrypoint only wires the three context keys above; to set the rest you edit
`bin/app.ts` (or your own thin app) and pass them to the stack. The most useful:

| Prop                   | Default                                   | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bridgeMode`           | `fargate`                                 | Which host(s) drive the cloud command path: `fargate` (default, the persistent ECS bridge and the ONLY host for the ACP adopt/session-load path), `lambda` (the serverless cloud path; adopt unsupported), or `both`. Also wired from the `bridgeMode` context key. See [Choosing the bridge mode](#choosing-the-bridge-mode).                                                                                                                                                                                             |
| `cimdAllowedHosts`     | facade host + `claude.ai` always included | Extra hosts permitted as CIMD `client_id` URL hosts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `maxCloudSessions`     | `10`                                      | Concurrent cloud-session cap (includes IDE/Web usage).                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `eventTtlDays`         | `30`                                      | Event TTL in days.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `permissionTimeout`    | `24h`                                     | How long a permission request stays answerable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `kiroCliVersion`       | —                                         | The `kiro-cli` version baked into the bridge image via the `KIRO_CLI_VERSION` build arg (which has no default). Also the single opt-in trigger for the real assets (see the [real-asset opt-in callout](#3-choose-your-deploy-context)). Operator-supplied, never hardcoded; required for a real deploy.                                                                                                                                                                                                                   |
| `preRegisteredClients` | —                                         | A list of `{ name, callbackUrls }` public OAuth clients (e.g. Claude Code, VS Code) that authorize through the facade without a CIMD document. Each client presents its `name` as the `client_id` at `/oauth/authorize` and may only use the listed `callbackUrls` as `redirect_uri`. The stack provisions a Cognito app client for each and propagates the id + redirect URIs into the API Lambda so the facade accepts them at runtime.                                                                                  |
| `kiroApiKeySecretArn`  | — (construct creates an empty secret)     | Full ARN of a **pre-existing** Secrets Manager secret holding the `ksk_` key. **Recommended for real deploys:** the construct imports it, grants the bridge read, and wires it as the `KIRO_API_KEY` ECS secret, and because it is external it **survives a stack rollback**. Omit it and the construct creates an empty secret (synth/dev only) that you must populate and that is destroyed on rollback. Also wired from the `kiroApiKeySecretArn` context key. See [Store the Kiro API key](#4-store-the-kiro-api-key). |
| `customDomain`         | — (default execute-api domain only)       | `{ domainName, certificateArn?, hostedZoneId?, zoneName? }`. When set, the stack creates (or imports) a regional ACM cert and an API Gateway v2 custom domain mapped to the HTTP API. Supply `hostedZoneId` + `zoneName` to validate the cert against a Route 53 zone and create alias `A`/`AAAA` records in it (no manual DNS); omit them for the zone-less manual-CNAME path. See [Pointing `publicBaseUrl` at the API](#pointing-publicbaseurl-at-the-api).                                                             |
| `bridgeImage`          | placeholder registry image                | Override the ECS/Fargate bridge container image. Production deploys pass `ContainerImage.fromAsset(...)` (see below).                                                                                                                                                                                                                                                                                                                                                                                                      |
| `lambdaImage`          | placeholder ECR image                     | Override the serverless (Lambda) bridge container image used in `lambda`/`both` modes. A factory `(cmd) => DockerImageCode` called once per function (consumer + caps-publisher) so each runs its own handler from the one image. Production deploys pass a factory wrapping `DockerImageCode.fromImageAsset(repoRoot, { file: "packages/bridge/Dockerfile.lambda", buildArgs: { KIRO_CLI_VERSION }, platform: linux/arm64, cmd })`. Gated behind `-c kiroCliVersion` like `bridgeImage`.                                  |
| `apiLambdaCode`        | inline placeholder                        | Override the API Lambda code with your bundled asset.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

> The defaults for `bridgeImage`, `lambdaImage`, and `apiLambdaCode` are
> placeholders so the construct synthesizes with no Docker build and no
> bundling step (the CDK unit tests rely on this). A production deploy must
> override them (image + Lambda code) so the stack actually serves traffic; this
> repo's app always does, from the required `kiroCliVersion`.

## Choosing the bridge mode

The cloud command path can be driven by two different hosts, selected per deploy
with `bridgeMode` (the `bridgeMode` context key, or the `KiroRemoteProps` prop).
The default is `fargate`, so an existing deploy that passes nothing is unchanged.

| Mode                | What is provisioned                                                                                                                                        | Notes                                                                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fargate` (default) | The persistent ECS Fargate ACP bridge (VPC, cluster, task, service). No Lambda bridge.                                                                     | The ONLY host for the ACP `adopt`/session-load path, so it is retained deliberately. Backward compatible: omitting `bridgeMode` reproduces today's stack.                                |
| `lambda`            | A container-image Lambda (arm64) that consumes the SQS FIFO command queue, plus a second function that publishes `CONFIG#CAPS`. No Fargate service or VPC. | The serverless cloud path. `adopt`/session-load is NOT supported in this mode (there is no live ACP child); use `fargate` or `both` if you need adopt.                                   |
| `both`              | The Fargate service AND the Lambda consumer + caps-publisher.                                                                                              | Run both side by side (e.g. to migrate). `adopt` is routed to Fargate and the Lambda consumer handles the headless cloud turns (see [adopt routing](#adopt-routing-in-both-mode) below). |

Enable a mode on the command line, for example the serverless path:

```bash
pnpm --filter @nikovirtala/kiro-remote-cdk deploy -- \
  -c kiroCliVersion=1.2.3 \
  -c bridgeMode=lambda \
  -c publicBaseUrl=https://kiro-remote.nikovirtala.dev
```

A few operational details for the `lambda` and `both` modes:

- **Image.** The serverless functions run the container image built from
  [`packages/bridge/Dockerfile.lambda`](../packages/bridge/Dockerfile.lambda)
  (arm64, `kiro-cli` on PATH, both the consumer and caps-publisher handler
  bundles). Like the Fargate image, it is built from the required
  `-c kiroCliVersion=<ver>`, so deploy needs Docker.
- **Concurrency.** `maxCloudSessions` maps to the consumer function's RESERVED
  CONCURRENCY. Because the queue is FIFO and the producer sets
  `MessageGroupId = sessionId`, SQS already serializes work per session; the
  reserved concurrency caps how many DISTINCT sessions run in parallel to the
  same global cap the Fargate host enforces in-process.
- **Visibility timeout.** When the Lambda path is enabled the command queue's
  visibility timeout is raised to 15 minutes (the consumer's timeout) so a long
  cloud turn is not redelivered mid-flight. In `fargate`-only mode it stays at
  60 seconds.
- **Capabilities publish.** The caps-publisher writes `CONFIG#CAPS` on a 6-hour
  schedule and is also invoked once right after deploy (a CDK Trigger custom
  resource). Until the first publish succeeds, `GET /capabilities` and
  `GET /models` return the empty-capabilities fallback, exactly like the
  Fargate bridge's boot-time publish (see the CONFIG#CAPS caveat above). A
  transient failure self-heals on the next scheduled run.
- **Secret.** The functions resolve `KIRO_API_KEY` at runtime from Secrets
  Manager via the `KIRO_API_KEY_SECRET_ARN` environment variable (there is no
  ECS-style secret injection on Lambda); the function roles are granted read on
  that exact secret. `AWS_REGION` is a reserved Lambda variable and is never set
  by the construct.

### adopt routing in `both` mode

Both hosts consume the SAME SQS FIFO command queue, and SQS delivers each
message to exactly one consumer. Fargate is retained as the only host for the
ACP `adopt`/session-load path, so in `both` mode the Lambda consumer's
event-source mapping carries a filter that excludes `adopt`
(`kind` is anything but `"adopt"`). A filtered-out `adopt` command is never
delivered to the Lambda, stays on the queue, and is therefore picked up by the
Fargate intake loop, which honors it via the ACP gateway. This makes the "adopt
goes to Fargate" guarantee hold deterministically rather than depending on which
consumer polls first.

Every other command kind (`launch`, `prompt`, `steer`, `cancel`,
`answerPermission`, `setConfig`, `delete`) is handled correctly by either host,
so those are left unfiltered and go to whichever consumer SQS delivers them to.

In `lambda`-only mode there is no Fargate to serve a filtered-out `adopt`, so
the consumer is deliberately NOT filtered: it still receives `adopt` and rejects
it loudly with a client-visible rejection event, rather than letting the message
sit unconsumed and silently expire. `lambda`-only still does not support
`adopt`; it just fails it visibly instead of silently.

## Pointing `publicBaseUrl` at the API

`publicBaseUrl` is the one canonical `https://<host>` the facade advertises
everywhere (RFC 9728 PRM, RFC 8414 AS-metadata issuer, the Cognito resource
identifier `<host>/mcp`, and the CIMD allow-list). It has to be the real,
reachable host. There are two ways to get there.

### Option A — the API Gateway default domain

If you do not want a custom domain, point `publicBaseUrl` at the API Gateway
default domain
`https://<api-id>.execute-api.<region>.amazonaws.com`. That domain only exists
once the HTTP API is created, so this is a **two-pass deploy**:

1. Deploy once with any placeholder `PUBLIC_BASE_URL` (for example
   `https://kiro.example.com`) to create the API.
2. Read the generated host from the `ApiUrl` CloudFormation output (see
   [Find the resource identifiers you'll need](#6-find-the-resource-identifiers-youll-need)).
3. Redeploy with
   `-c publicBaseUrl=https://<api-id>.execute-api.<region>.amazonaws.com` so the
   PRM / AS-metadata / Cognito resource identifier / CIMD values all match the
   real host.

No DNS and no certificate are involved: API Gateway serves the default domain
with its own AWS certificate. Do **not** set `customDomain` for this path.

### Option B — a custom domain (recommended)

A custom domain lets `publicBaseUrl` be a stable host you own, e.g.
`https://kiro-remote.nikovirtala.dev`, and avoids the two-pass deploy. The
construct can create the custom domain for you: set the `customDomain` prop
(or the `customDomainName` context key — see below) and the stack provisions:

1. a **regional ACM certificate** for the host, **DNS-validated**, and
2. an **API Gateway v2 custom `DomainName` + `ApiMapping`** to the HTTP API's
   default stage.

There are two DNS flavours of this, both selected by the same `customDomain`
prop:

- **Manual Cloudflare CNAMEs (the path this repo uses).** The cert is validated
  with no Route 53 hosted zone — ACM emits a validation `CNAME` you add at
  Cloudflare, and you point a service `CNAME` at the regional target yourself.
  No Route 53 resources are created. This is the default for `kiro-remote` — a
  **scoped subdomain** (`kiro-remote.nikovirtala.dev`) whose parent zone
  (`nikovirtala.dev`) lives on Cloudflare — and the steps below describe it.
- **Automated Route 53 (optional alternative).** If you would rather have ACM
  validation and the alias record fully CDK-managed, delegate the scoped
  subdomain to a Route 53 zone once; see
  [the Route 53 alternative](#automated-alternative--route-53-delegated-subdomain)
  at the end of this section.

> **The ACM certificate must be in the SAME region as the HTTP API** (API
> Gateway v2 regional custom domains require a regional cert). The construct
> creates the cert in the stack's region automatically, so deploy the stack in
> the region you want — for this deploy that is `eu-north-1` (see
> [the region note](#5-bootstrap-and-deploy)).

[`scripts/deploy.sh`](../scripts/deploy.sh) defaults both `PUBLIC_BASE_URL`
**and** `CUSTOM_DOMAIN_NAME` to `kiro-remote.nikovirtala.dev`, so a plain
`./scripts/deploy.sh` creates the custom domain. The app also accepts them as
context flags:

```bash
mise exec -- pnpm --filter @nikovirtala/kiro-remote-cdk deploy -- \
  -c publicBaseUrl=https://kiro-remote.nikovirtala.dev \
  -c customDomainName=kiro-remote.nikovirtala.dev
```

Because the certificate is DNS-validated, **CloudFormation blocks on the deploy
until you complete validation** (see the Cloudflare steps below). If you would
rather not have the deploy wait, pre-create the certificate in the same region
and pass its ARN so it is imported instead of created:

```bash
mise exec -- pnpm --filter @nikovirtala/kiro-remote-cdk deploy -- \
  -c publicBaseUrl=https://kiro-remote.nikovirtala.dev \
  -c customDomainName=kiro-remote.nikovirtala.dev \
  -c certificateArn=arn:aws:acm:eu-north-1:<account>:certificate/<id>
```

The certificate ARN is not secret, but it is account-specific: set it as
`CERTIFICATE_ARN` in `deploy.env` (or set `customDomain.certificateArn` in your
own thin app).

#### DNS records to create at Cloudflare

`nikovirtala.dev` is hosted on **Cloudflare** (nameservers `erin.ns.cloudflare.com`
and `duke.ns.cloudflare.com`), **not** Route 53, so the stack does **not** create
any DNS records — you add them in the Cloudflare dashboard. There are two:

1. **ACM validation `CNAME`** (only when the stack creates the cert, i.e. you did
   not pass `certificateArn`). After you start the deploy, the ACM certificate
   enters _Pending validation_. Read the validation record's name and value from
   the ACM console, or with:

   ```bash
   aws acm describe-certificate --certificate-arn <arn> \
     --query 'Certificate.DomainValidationOptions[].ResourceRecord'
   ```

   Add that `CNAME` in Cloudflare. **It must be set to "DNS only" (grey cloud,
   un-proxied)** — if it is proxied (orange cloud) Cloudflare rewrites the answer
   and ACM validation can fail. Once the record propagates, ACM issues the cert
   and the stuck CloudFormation deploy continues.

2. **Service `CNAME` `kiro-remote` → the regional target.** After the deploy
   finishes it prints a `CustomDomainTarget` output (the API Gateway _regional
   domain name_, e.g. `d-xxxx.execute-api.eu-north-1.amazonaws.com`). Read it
   from the deploy output or with
   `aws cloudformation describe-stacks --stack-name KiroRemoteStack --query 'Stacks[0].Outputs'`.
   Create a `CNAME` in Cloudflare: name `kiro-remote`, target the
   `CustomDomainTarget` value.

   **Recommended: set this `CNAME` to "DNS only" (grey cloud) too.** With DNS-only
   the client connects straight to API Gateway, which terminates TLS using the
   ACM certificate for `kiro-remote.nikovirtala.dev` — nothing else to configure,
   and `publicBaseUrl` works immediately.

   > **Advanced (orange cloud / proxied):** if you proxy the service record
   > through Cloudflare, **Cloudflare** terminates TLS at its edge and must have
   > its own certificate for `kiro-remote.nikovirtala.dev` (Cloudflare's
   > Universal SSL usually covers this), with its origin pointing at the API
   > Gateway regional domain. This adds a second TLS hop and more moving parts;
   > start with DNS-only and only proxy later if you specifically want
   > Cloudflare's edge features.
#### After the records resolve

Once both records resolve, `https://kiro-remote.nikovirtala.dev` serves the API
and the facade's PRM / AS-metadata / `McpResourceIdentifier` all line up with
`publicBaseUrl` with no second deploy.

### Automated alternative — Route 53 delegated subdomain

If you prefer ACM validation **and** the service record to be fully CDK-managed
(no manual CNAMEs after a one-time delegation), delegate the scoped subdomain
`kiro-remote.nikovirtala.dev` to its own Route 53 **public hosted zone**. The
repo ships a second stack, `KiroRemoteDnsStack`
([`packages/cdk/src/dns-stack.ts`](../packages/cdk/src/dns-stack.ts)), for exactly
this. Because the delegation at Cloudflare has to happen **between** the two
deploys, this is a **two-stack** flow — a single `cdk deploy --all` cannot
complete first-time setup.

> Everything stays scoped to the `kiro-remote` subdomain: only that label is
> delegated to Route 53; the apex `nikovirtala.dev` and all its other records
> stay on Cloudflare.

1. **Deploy the DNS stack first.** It is synthesized whenever `dnsZoneName` is
   set (`scripts/deploy.sh` defaults `DNS_ZONE_NAME` to `kiro-remote.nikovirtala.dev`):

   ```bash
   mise exec -- pnpm --filter @nikovirtala/kiro-remote-cdk exec cdk deploy KiroRemoteDnsStack
   ```

   Read its `NameServers` output (four Route 53 nameservers) and the
   `HostedZoneId` output when it finishes:

   ```bash
   aws cloudformation describe-stacks --stack-name KiroRemoteDnsStack \
     --query 'Stacks[0].Outputs'
   ```

2. **Delegate the subdomain at Cloudflare.** In the Cloudflare dashboard for
   `nikovirtala.dev`, create four `NS` records for the **`kiro-remote`** name,
   each pointing at one of the Route 53 nameservers from step 1, all **"DNS
   only" (grey cloud)**. Wait for propagation, then confirm the delegation
   resolves to the Route 53 nameservers:

   ```bash
   dig NS kiro-remote.nikovirtala.dev +short
   ```

3. **Deploy the app stack with the zone imported.** Pass the DNS stack's
   `HostedZoneId` as the `hostedZoneId` context key. It is account-specific,
   so set it as `HOSTED_ZONE_ID` in `deploy.env`, then deploy:

   ```bash
   ./scripts/deploy.sh
   ```

   Now the ACM certificate is DNS-validated **against the Route 53 zone**
   (an automatic validation record — no manual CNAME) and alias `A`/`AAAA`
   records are created in the zone pointing at the API Gateway custom domain.
   There is **no further manual DNS**: once ACM issues the cert the deploy
   finishes and `https://kiro-remote.nikovirtala.dev` is live.

The same region rule applies: the cert is created in the stack's region, so
deploy the app stack in the API's region (`eu-north-1` — see
[the region note](#5-bootstrap-and-deploy)). The DNS stack's `NameServers`,
`HostedZoneId`, and `HostedZoneName` outputs are the only values you move
between the two steps.

## Building the bridge image

The bridge image is `linux/arm64` (ECS Fargate on Graviton). It installs
`kiro-cli` via the official install script pinned by the `KIRO_CLI_VERSION` build
ARG.

At **build time** the image esbuild-bundles the bridge CLI
([`packages/bridge/src/cli.ts`](../packages/bridge/src/cli.ts)) into a single
self-contained CommonJS file (`dist/bridge.cjs`) and the container then runs
`node dist/bridge.cjs serve`. The bundle inlines the `@nikovirtala/*` workspace
code **and** `@aws-sdk/*`, so the runtime image carries no `node_modules` and no
raw `.ts` source. This mirrors the API Lambda's build-time bundling in
[`packages/cdk/src/api-asset.ts`](../packages/cdk/src/api-asset.ts).

Why bundle instead of running the TypeScript source directly? Node refuses to
type-strip `.ts` files that resolve under a `node_modules` path (see the Node
["Type stripping in dependencies"](https://nodejs.org/api/typescript.html)
docs). The bridge's entry imports `@nikovirtala/kiro-remote-core`, whose
package.json exports a raw `./src/index.ts` reached through pnpm's `node_modules`
symlink, so running `node packages/bridge/src/cli.ts` crashed the container at
module load (exit 1, before any log). Bundling inlines that code, so there is no
bare `@nikovirtala` import and no `.ts` under `node_modules` at runtime. The
container `HEALTHCHECK` is a cheap `node -e "process.exit(0)"` liveness probe
(the same intent as the ECS container health check), not an invocation of the
bridge CLI.

`KIRO_API_KEY` is **never** baked into the image; it is injected as an ECS secret
at runtime. The `kiro-cli` child process is spawned as a runtime PATH binary via
`child_process`, so it is neither bundled nor externalized.

### How the bridge drives cloud sessions (chat-only == cloud-only)

The bridge provisions **and** drives cloud sessions **entirely** through
`kiro-cli chat --cloud` subprocesses. There is no ACP cloud-session path:
chat-only is the only cloud path for now.

- **Launch (first turn).** `POST /v1/sessions` enqueues a `launch` command; the
  bridge runs
  `kiro-cli chat --cloud --repo <r> [--repo <r2> …] --no-interactive "<prompt>"`.
  The subprocess output is **plain text** (there is no JSON/stream-json output
  mode for `--cloud`): interleaved `[INFO] …`, `[cloud] session <uuid>`,
  `[tool] …`, `[tool] status: Completed`, `[sandbox] …` lines, then the
  assistant's free-text answer. The bridge parses the **real cloud session id**
  from the `[cloud] session <uuid>` line, persists the assistant text + tool
  activity as normalized events (so `GET /v1/sessions/{id}/events` returns the
  turn), and drives the session to `idle`.
- **Loud failure.** If the subprocess emits **no** `[cloud] session` line, or it
  exits **non-zero** (and a `null` exit code — signal-killed, e.g. OOM mid-turn —
  counts as a failure, **not** a truncated success), the bridge drives the
  session to `failed`, logs `cloud_launch_failed`, and emits the
  `CloudLaunchFailed` metric. It never leaves a silent/idle session.
- **Follow-up turns.** A `POST /v1/sessions/{id}/turns` on an idle cloud session
  runs `kiro-cli chat --cloud --resume-id <cloudSessionId> --no-interactive
  "<prompt>"` (the CLI help documents `--resume-id <SESSION_ID>`, "Resume a
  specific conversation by session ID"), targeting the **same** cloud id, and
  persists its output as events the same way. A follow-up is **idempotent** on
  its `turnId`: a redelivered `prompt` command (SQS at-least-once) is a logged
  no-op (`prompt_idempotent_skip`), never a second resume turn and never a
  mid-turn re-dispatch. A **failed** resume turn is just as loud as a failed
  launch: it emits the `CloudTurnFailed` metric, logs `cloud_turn_failed`, and
  persists a client-visible `turn.failed` event before the session returns to
  `idle` — so a client polling events sees the failure, not a silent missing
  answer.
- **Mid-turn steer / cancel are rejected (not silently dropped).** Because a
  cloud turn runs in a detached `chat --cloud` subprocess and ACP cannot drive a
  cloud session, there is no way to steer or cancel a cloud turn in flight.
  Rather than issuing a doomed ACP `_session/steer`/`session/cancel` that the
  agent silently ignores, the bridge **rejects** a mid-turn steer or a cancel on
  a cloud session with a clear error (`steer_unsupported_cloud` /
  `cancel_unsupported_cloud`); the in-flight turn runs to completion, then the
  caller can send a new prompt. (An idle-session "steer" is still just a new
  prompt turn, unchanged.)

  The rejection is a **permanent** condition, so it is handled as a _loud but
  terminal_ command: `SessionManager` throws an `UnsupportedCloudOperationError`
  and the SQS intake catches that sentinel, logs `command_unsupported_cloud`,
  persists a client-visible `turn.failed` rejection event
  (`rawType: "operation_rejected"`, with the rejected `operation` in the
  payload), and then **deletes** the command message. This is deliberate: the
  command queue is a DLQ-less FIFO keyed by `MessageGroupId = sessionId`, so if
  the message were left for redelivery (the policy for a genuine _transient_
  dispatch failure) it would redeliver every visibility timeout **and**
  head-of-line-block every later command for that session (next prompt,
  answerPermission, even delete) until the turn happened to settle. Deleting the
  message keeps the FIFO group moving while a polling client still sees _why_ the
  steer/cancel did nothing via `GET /v1/sessions/{id}/events`. Genuine transient
  failures (e.g. an un-advertised `setConfig`) still throw a plain error and are
  left for redelivery.
- **`whenBusy=queue` is rejected the same way (for now).** A busy `prompt` with
  `whenBusy=queue` cannot be honored on the cloud path either: there is no
  queue-drain mechanism, and a cloud turn runs in a detached subprocess the
  bridge cannot interleave with, so a "queued" turn would never actually run.
  Rather than tell the caller the turn is `queued` and then never drain it, the
  bridge rejects it the same visible, non-state-mutating way as a mid-turn steer
  (`steer_queue_unsupported_cloud` + the same deleted-message + rejection-event
  contract). Draining queued turns after the active one settles is a possible
  future enhancement.
- **Delete.** `kiro-cli chat --delete-session <cloudSessionId>` (unchanged).

**Why not ACP?** The ACP child (`kiro-cli acp --agent-engine=v3`) **cannot drive
a cloud session**. Confirmed empirically: `initialize` + `session/load` +
`session/prompt` against a real cloud id
(`08047063-f7b4-4ce5-b79a-2aea9a7a1d29`) returns
`{"error":{"code":-32000,"message":"Session '08047063-…' not found"}}` on
`session/prompt`. The earlier `session/new` `executionTarget`/`sessionSource`
approach was likewise rejected by the live agent and has been reverted. The ACP
child remains only for non-cloud concerns (capability negotiation, session
discovery, reconnect/adopt); it never launches or prompts a cloud session.

**Permissions.** `--no-interactive` governs tool-permission behavior on the chat
path: the subprocess auto-proceeds or refuses rather than prompting. The
interactive ACP `answerPermission` flow does **not** apply to `chat --cloud`, so
the bridge does not wire ACP permissions into the chat path. (`kiro-cli chat
--help` was not re-checkable in the build sandbox for an explicit
auto-approve/trust flag; if a future `--trust-all-tools`-style flag is confirmed
it can be added, otherwise the documented `--no-interactive` behavior stands.)

**Operational guarantees (preserved).** The `chat --cloud` subprocess is long
(~30–40 s), so the bridge runs it as **background work**: `launch()` returns
promptly and intake deletes the SQS message **on dispatch**, so a slow
subprocess never head-of-line-blocks other sessions (ack-on-dispatch). A
**redelivered** launch is idempotent — it never spawns a second `chat --cloud`
or a second Space. All subprocess stdout/stderr is routed through the redacting
logger, so a `ksk_`/`KIRO_API_KEY`/bearer token never appears in logs; the
numeric exit is logged under `exitCode` (not `code`, which core `redact()`
scrubs as the OAuth code).

**Redeploy scope.** This behavior lives entirely in the **bridge image**
(`packages/bridge`). No CDK/infrastructure change is required — redeploy the
bridge image only. After redeploy, watch the live bridge logs for
`launch_path_decision` (path `headless`), `session_launched`
(`kiroSessionId=<uuid>`), and the absence of `cloud_launch_failed`; and confirm
the new session appears as a Space in **app.kiro.dev**. A `cloud_launch_failed`
log + `CloudLaunchFailed` metric means the subprocess did not emit a
`[cloud] session` line (or exited non-zero) — inspect the redacted
`headless_launch_failed` record for the child output.

`bin/app.ts` wires this image automatically on the real-asset path: passing
`-c kiroCliVersion=<ver>` makes the app set the construct's `bridgeImage` prop to
a `fromAsset` build of the repo root (the build context is the repo root because
the Dockerfile COPYs `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
`tsconfig.base.json` and the `packages/core` + `packages/bridge` trees). The call
it makes is:

```ts
import { Platform } from "aws-cdk-lib/aws-ecr-assets";
import { ContainerImage } from "aws-cdk-lib/aws-ecs";

bridgeImage: ContainerImage.fromAsset(repoRoot, {
  file: "packages/bridge/Dockerfile",
  buildArgs: { KIRO_CLI_VERSION: "<version>" },
  platform: Platform.LINUX_ARM64,
}),
```

Building this requires a working container runtime (Docker) that can produce a
`linux/arm64` image; CDK builds it during `cdk deploy` on the operator's
machine (`cdk synth` only stages the build context). The app requires
`-c kiroCliVersion`, so every deploy builds the image. The `KIRO_CLI_VERSION` value is operator-supplied (in
`deploy.env`) and never hardcoded in the CDK code.

## 4. Store the Kiro API key

The bridge needs a **valid** `ksk_` key in Secrets Manager to start. The
recommended flow is to create and populate that secret **once, out of band**,
and point the deploy at it by its **full ARN** (`-c kiroApiKeySecretArn=...`).
The stack then **imports** the secret, grants the bridge read access, and
injects it as the `KIRO_API_KEY` ECS secret. Because the secret is external, it
**survives a stack rollback**, so iterating on a failed deploy never destroys
your key.

> **Why this matters.** If the stack _creates_ the secret itself (the fallback
> below), a failed deploy rolls back and **deletes** that secret before you have
> any window to populate it: a chicken-and-egg where a first deploy can never
> succeed. Referencing a pre-existing secret removes that trap.

1. **Create and populate the secret once** (capture the returned full ARN):

   ```bash
   aws secretsmanager create-secret \
     --name kiro-remote/kiro-api-key \
     --secret-string 'ksk_xxxxxxxx' \
     --region eu-north-1
   ```

   The response includes the full ARN, e.g.
   `arn:aws:secretsmanager:eu-north-1:<account>:secret:kiro-remote/kiro-api-key-<suffix>`
   (the trailing `-<suffix>` is the random 6-char suffix Secrets Manager adds,
   and it is part of the ARN the deploy expects).

2. **Deploy pointing at the ARN.** Set it in `deploy.env`:

   ```bash
   KIRO_API_KEY_SECRET_ARN=arn:aws:secretsmanager:eu-north-1:<account>:secret:kiro-remote/kiro-api-key-<suffix>
   ```

   The ARN is not a secret value, but it is account/region-specific, so it
   stays in the gitignored `deploy.env`. This repo's CDK app refuses to
   synthesize without it, and `scripts/deploy.sh` also refuses an ARN from a
   different region or account.

> **Fallback for your own thin app (NOT recommended for real deploys).** The
> `KiroRemote` construct still accepts no `kiroApiKeySecretArn`; it then creates
> an **empty** secret for `KIRO_API_KEY`. You then have to populate it, and it is
> **destroyed on rollback** (the exact chicken-and-egg above). If you go this
> route anyway, set the value after the stack exists:
>
> ```bash
> aws secretsmanager put-secret-value \
>   --secret-id <kiro-api-key-secret-id> \
>   --secret-string 'ksk_xxxxxxxx'
> ```
>
> and find `<kiro-api-key-secret-id>` from the stack's resources:
>
> ```bash
> aws cloudformation list-stack-resources --stack-name KiroRemoteStack \
>   --query "StackResourceSummaries[?ResourceType=='AWS::SecretsManager::Secret']"
> ```

Never commit or echo the real key; use the placeholder `ksk_xxxxxxxx` in notes.

## 5. Bootstrap and deploy

If the account/region has never been CDK-bootstrapped, bootstrap it once. The
`aws-cdk` CLI is a dev dependency of `packages/cdk`, so invoke it through pnpm:

```bash
# Bootstrap (once per account/region).
AWS_REGION=eu-north-1 mise exec -- pnpm --filter @nikovirtala/kiro-remote-cdk exec cdk bootstrap
```

Then deploy with [`scripts/deploy.sh`](../scripts/deploy.sh). It reads a
gitignored `deploy.env` at the repo root (template:
[`deploy.env.example`](../deploy.env.example)):

```bash
cp deploy.env.example deploy.env
$EDITOR deploy.env                 # AWS_PROFILE, KIRO_API_KEY_SECRET_ARN, HOSTED_ZONE_ID, ...
./scripts/deploy.sh --dry-run      # verify profile, account, region and the cdk command
./scripts/deploy.sh --diff         # cdk diff against the deployed stacks (or: pnpm run diff)
./scripts/deploy.sh                # or: mise exec -- pnpm run deploy
```

Before building anything the script:

- checks that the AWS profile resolves to `AWS_ACCOUNT_ID`;
- pins every aws/cdk call to `AWS_REGION` (default `eu-north-1`), so the
  profile's own default region is never used;
- refuses to deploy if `KiroRemoteStack` does not already exist in that region,
  unless you pass `--first-deploy` for a brand-new environment;
- refuses a `KIRO_API_KEY_SECRET_ARN` from another region or account, a missing
  `KIRO_CLI_VERSION`, and `DNS_ZONE_NAME` without `HOSTED_ZONE_ID`.

It then runs `pnpm install --frozen-lockfile` (skip with `--skip-install`) and
`cdk deploy --all` with the mapped `-c` flags. `--diff` runs `cdk diff` with the
same flags instead: CDK creates a read-only change set per stack and prints what
a deploy would change, without deploying or building the bridge image.
`--synth` does the same for `cdk synth`. Arguments after `--` go to
`cdk deploy` verbatim, e.g. `./scripts/deploy.sh -- --require-approval never`.
Run `./scripts/deploy.sh --help` for all flags.

The CDK app itself hardcodes no account or region: they come from
`CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION`, which the CDK CLI derives from the
active AWS profile / `AWS_REGION`. If you run `cdk deploy` directly instead of the
script, export `AWS_REGION` yourself and pass every `-c` flag the script would.
Without `publicBaseUrl` and `kiroCliVersion` the app refuses to synthesize.

The region you deploy to is stamped into region-scoped resource names — notably
the Cognito managed-login host becomes `<cognitoDomainPrefix>.auth.<region>.amazoncognito.com`
(e.g. `kiro-remote.auth.eu-north-1.amazoncognito.com` for an `eu-north-1` deploy).

**Kiro cloud sandboxes always run in `us-east-1` regardless of where this stack is
deployed** — that is Kiro's side (the `kiro-cli` in the bridge talks to Kiro's
`us-east-1` sandboxes no matter your stack region). Deploying the stack in
`us-east-1` as well minimizes latency between the bridge and Kiro, but any region
works.

> The root `deploy` script runs `./scripts/deploy.sh`, so
> `mise exec -- pnpm run deploy --dry-run` works too. Use `pnpm run deploy`
> rather than bare `pnpm deploy`, which is pnpm's own built-in command.

## 6. Find the resource identifiers you'll need

The stack publishes named CloudFormation outputs for everything the next guides
reference, so you do not have to hunt through the resource list. `cdk deploy`
prints them when it finishes; you can also read them back at any time:

```bash
aws cloudformation describe-stacks --stack-name KiroRemoteStack \
  --query 'Stacks[0].Outputs'
```

| Output logical id       | What it is                                                                       |
| ----------------------- | -------------------------------------------------------------------------------- |
| `UserPoolId`            | The Cognito user pool id (used to register users and inspect app clients).       |
| `FacadeClientId`        | The public, no-secret facade app client id used by OAuth clients.                |
| `ApiUrl`                | The HTTP API default endpoint (the facade base host when no custom domain).      |
| `ManagedLoginDomainUrl` | The Cognito managed-login domain base URL (`https://<prefix>.auth.<region>...`). |
| `McpResourceIdentifier` | The RFC 8707 MCP resource identifier (`<host>/mcp` audience).                    |

When a `customDomain` is configured, two more outputs appear (used to create the
Cloudflare service `CNAME` — see [Option B](#option-b--a-custom-domain-recommended)):

| Output logical id          | What it is                                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| `CustomDomainTarget`       | The API Gateway regional domain name — the `CNAME` target for your custom host at your DNS provider.     |
| `CustomDomainHostedZoneId` | The region-specific hosted zone id of the custom domain's regional endpoint (for Route 53 alias setups). |

When you use the [Route 53 alternative](#automated-alternative--route-53-delegated-subdomain),
the separate `KiroRemoteDnsStack` publishes its own outputs (read them with
`aws cloudformation describe-stacks --stack-name KiroRemoteDnsStack`):

| Output logical id | What it is                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `NameServers`     | The four Route 53 nameservers for the delegated zone — paste these as `NS` records for `kiro-remote` at Cloudflare.         |
| `HostedZoneId`    | The hosted zone id — pass it to the app stack as `-c hostedZoneId=<id>` so it imports the zone for cert validation + alias. |
| `HostedZoneName`  | The delegated zone name (the custom-domain host / zone apex).                                                               |

The managed-login domain is `<cognitoDomainPrefix>.auth.<region>.amazoncognito.com`
with the prefix you passed at deploy time.

> Managed Login v2 only renders the hosted login page when a branding style
> exists for the app client; without one the page shows "Login pages
> unavailable". The stack provisions a default (Cognito-provided) branding for
> the facade client and every pre-registered client, so the hosted login page
> renders out of the box.

## Next

- [Register a user](./users.md)
- [Try the REST API](./rest-api.md)
- [Use the MCP server](./mcp.md)
