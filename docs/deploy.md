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

> **Real-asset opt-in, `-c kiroCliVersion=<ver>`.** This single flag is the
> trigger for BOTH real production assets and is **required for a real deploy**:
> the bridge Dockerfile's `KIRO_CLI_VERSION` build arg has **no default**, so
> without a concrete version there is nothing to build the real image from. When
> you pass it:
>
> - the app **builds the real bridge container image locally** from
>   [`packages/bridge/Dockerfile`](../packages/bridge/Dockerfile) via
>   `ContainerImage.fromAsset` with the repo root as the build context,
>   `platform: linux/arm64` (Graviton) and `buildArgs: { KIRO_CLI_VERSION }`.
>   This **needs a working Docker/container runtime** on the machine running
>   `cdk synth`/`cdk deploy`, and it builds `linux/arm64`; and
> - the app **bundles the real API Lambda** (`src/lambda/entry.ts`) in-process
>   with esbuild and passes it as `apiLambdaCode`. The bundle is **headless, no
>   Docker** (esbuild is a workspace dev dependency).
>
> Omitting the flag is the **override seam**: the stack ships a lightweight
> placeholder bridge image and an inline placeholder API Lambda, so
> `cdk synth`/`cdk deploy` run with **no Docker build and no Node bundler**,
> which is what lets `cdk synth` run in constrained CI/sandboxes. The kiro-cli
> version is **operator-supplied and never hardcoded** anywhere in the repo.
>
> The real bridge image build is the only step that needs Docker; run the
> real-asset deploy on a machine that has it (the API Lambda bundle itself runs
> anywhere esbuild does). A blank/empty `kiroCliVersion` is rejected with a
> clear error rather than silently falling back to placeholders.
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

| Context key           | Default                                             | Meaning                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `publicBaseUrl`       | `https://kiro.example.com` (synth placeholder only) | The canonical `https://<host>` **without** a trailing slash. Use a custom domain fronting the HTTP API, or the API Gateway default domain `https://<api-id>.execute-api.<region>.amazonaws.com`. Used verbatim for the RFC 9728 PRM, the RFC 8414 AS-metadata issuer, the Cognito resource identifier (`<host>/mcp`), and the CIMD allow-list, so for a real deploy it **must** be the real, reachable host. |
| `cognitoDomainPrefix` | `kiro-remote`                                       | The Cognito managed-login domain prefix. The hosted UI is served from `<prefix>.auth.<region>.amazoncognito.com`.                                                                                                                                                                                                                                                                                            |
| `allowedRepos`        | `*/*`                                               | Comma-separated GitHub repo globs the bridge may launch sessions against. Launches outside this list are rejected with 403.                                                                                                                                                                                                                                                                                  |

Three more context keys drive the optional custom domain (all unset by default
except `customDomainName`/`dnsZoneName`, which this repo's `cdk.json` sets to the
scoped subdomain `kiro-remote.nikovirtala.dev`):

| Context key        | Default                        | Meaning                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customDomainName` | — (default execute-api domain) | The custom host fronting the HTTP API. When set, the stack creates (or imports) a regional ACM cert and an API Gateway v2 custom domain. See [Option B](#option-b--a-custom-domain-recommended).                                                                                                                                             |
| `dnsZoneName`      | — (no DNS stack)               | When set, `bin/app.ts` also synthesizes `KiroRemoteDnsStack`: a Route 53 **public hosted zone** for a delegated subdomain. Only needed for the automated Route 53 alternative; harmless otherwise (the zone is a separate stack you deploy or ignore). See [the Route 53 alternative](#automated-alternative--route-53-delegated-subdomain). |
| `hostedZoneId`     | — (zone-less manual CNAME)     | Id of a Route 53 public hosted zone owning `customDomainName` (typically the `HostedZoneId` output of `KiroRemoteDnsStack`). When set, the app stack validates the cert against that zone **and** creates the alias records in it — no manual DNS. Omit for the manual-Cloudflare path. Account-specific; **not** committed to `cdk.json`.   |

> **About `publicBaseUrl` and the chicken-and-egg with the API Gateway default
> domain:** if you are not using a custom domain, the default domain only exists
> after the HTTP API is created. A common approach is to deploy once (the synth
> placeholder is fine to create the API), read the generated API Gateway domain,
> and then redeploy with `-c publicBaseUrl=https://<api-id>.execute-api.<region>.amazonaws.com`
> so the PRM/AS-metadata/CIMD values all match the real host. Using a custom
> domain avoids the second deploy. The two paths are laid out in full in
> [Pointing `publicBaseUrl` at the API](#pointing-publicbaseurl-at-the-api).

You can pass these on the command line with `-c`, or save them once in the
`context` block of [`packages/cdk/cdk.json`](../packages/cdk/cdk.json) so every
`synth`/`deploy` picks them up without flags (a `-c` flag still overrides the
file for a one-off). That file is version-controlled, so the values travel with
the repo — do **not** put them in `cdk.context.json`, which is gitignored and
owned by the CDK CLI for cached environment lookups. Example:

```json
{
  "context": {
    "publicBaseUrl": "https://kiro-remote.nikovirtala.dev",
    "cognitoDomainPrefix": "kiro-remote",
    "allowedRepos": "*/*",
    "@aws-cdk/core:checkSecretUsage": true
  }
}
```

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
| `cimdAllowedHosts`     | facade host + `claude.ai` always included | Extra hosts permitted as CIMD `client_id` URL hosts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `maxCloudSessions`     | `10`                                      | Concurrent cloud-session cap (includes IDE/Web usage).                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `eventTtlDays`         | `30`                                      | Event TTL in days.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `permissionTimeout`    | `24h`                                     | How long a permission request stays answerable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `kiroCliVersion`       | —                                         | The `kiro-cli` version baked into the bridge image via the `KIRO_CLI_VERSION` build arg (which has no default). Also the single opt-in trigger for the real assets (see the [real-asset opt-in callout](#3-choose-your-deploy-context)). Operator-supplied, never hardcoded; required for a real deploy.                                                                                                                                                                                                                   |
| `preRegisteredClients` | —                                         | A list of `{ name, callbackUrls }` public OAuth clients (e.g. Claude Code, VS Code) that authorize through the facade without a CIMD document. Each client presents its `name` as the `client_id` at `/oauth/authorize` and may only use the listed `callbackUrls` as `redirect_uri`. The stack provisions a Cognito app client for each and propagates the id + redirect URIs into the API Lambda so the facade accepts them at runtime.                                                                                  |
| `kiroApiKeySecretArn`  | — (construct creates an empty secret)     | Full ARN of a **pre-existing** Secrets Manager secret holding the `ksk_` key. **Recommended for real deploys:** the construct imports it, grants the bridge read, and wires it as the `KIRO_API_KEY` ECS secret, and because it is external it **survives a stack rollback**. Omit it and the construct creates an empty secret (synth/dev only) that you must populate and that is destroyed on rollback. Also wired from the `kiroApiKeySecretArn` context key. See [Store the Kiro API key](#4-store-the-kiro-api-key). |
| `customDomain`         | — (default execute-api domain only)       | `{ domainName, certificateArn?, hostedZoneId?, zoneName? }`. When set, the stack creates (or imports) a regional ACM cert and an API Gateway v2 custom domain mapped to the HTTP API. Supply `hostedZoneId` + `zoneName` to validate the cert against a Route 53 zone and create alias `A`/`AAAA` records in it (no manual DNS); omit them for the zone-less manual-CNAME path. See [Pointing `publicBaseUrl` at the API](#pointing-publicbaseurl-at-the-api).                                                             |
| `bridgeImage`          | placeholder registry image                | Override the bridge container image. Production deploys pass `ContainerImage.fromAsset(...)` (see below).                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `apiLambdaCode`        | inline placeholder                        | Override the API Lambda code with your bundled asset.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

> The defaults for `bridgeImage` and `apiLambdaCode` are deliberately
> placeholders so `cdk synth` runs with no Docker build and no bundling step in
> constrained CI/sandboxes. A production deploy must override them (image + Lambda
> code) so the stack actually serves traffic.

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

1. Deploy once with any placeholder `publicBaseUrl` (the synth placeholder is
   fine) to create the API.
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

This repo's [`cdk.json`](../packages/cdk/cdk.json) already sets both
`publicBaseUrl` **and** `customDomainName` to `kiro-remote.nikovirtala.dev`, so a
plain `deploy` creates the custom domain. The app also accepts them as context
flags:

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

The certificate ARN is not secret, but it is account-specific — it is **not**
stored in `cdk.json`; pass it at deploy time (or set `customDomain.certificateArn`
in your own thin app).

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
   set (this repo's `cdk.json` sets it to `kiro-remote.nikovirtala.dev`):

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
   `HostedZoneId` as the `hostedZoneId` context key (set it in `cdk.json`
   context or pass `-c hostedZoneId=...` — it is account-specific, so this repo
   leaves it **unset** in `cdk.json`):

   ```bash
   mise exec -- pnpm --filter @nikovirtala/kiro-remote-cdk deploy -- \
     -c hostedZoneId=<HostedZoneId output>
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
`linux/arm64` image; CDK invokes it during `cdk synth`/`cdk deploy` on the
operator's machine. Omit `-c kiroCliVersion` and the construct keeps its
lightweight placeholder image so `cdk synth` runs with no container build (the
constrained CI/sandbox path). The `KIRO_CLI_VERSION` value is operator-supplied
and never hardcoded in the repo.

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

2. **Deploy pointing at the ARN.** Pass it with `-c kiroApiKeySecretArn=...`
   (or set it in your local `cdk.json` context):

   ```bash
   -c kiroApiKeySecretArn=arn:aws:secretsmanager:eu-north-1:<account>:secret:kiro-remote/kiro-api-key-<suffix>
   ```

   The ARN is not a secret value, but it is account/region-specific, so it is
   **not** committed to this repo's `cdk.json`; pass it at deploy time or keep
   it in your own local context.

> **Fallback (NOT recommended for real deploys).** If you omit
> `kiroApiKeySecretArn`, the stack creates an **empty** secret for `KIRO_API_KEY`
> (fine for `synth`/dev). You then have to populate it, and it is **destroyed on
> rollback** (the exact chicken-and-egg above). If you go this route anyway, set
> the value after the stack exists:
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

If the account/region has never been CDK-bootstrapped, bootstrap it once. Run CDK
commands from `packages/cdk` (its `cdk.json` sets `app` to `node bin/app.ts`). The
`aws-cdk` CLI is a dev dependency of that package, so invoke it through pnpm:

```bash
# Bootstrap (once per account/region).
mise exec -- pnpm --filter @nikovirtala/kiro-remote-cdk exec cdk bootstrap

# Deploy. With the context values saved in cdk.json you need no flags:
mise exec -- pnpm --filter @nikovirtala/kiro-remote-cdk deploy

# Or pass/override them on the command line (a -c flag wins over cdk.json):
mise exec -- pnpm --filter @nikovirtala/kiro-remote-cdk deploy -- \
  -c publicBaseUrl=https://<host> \
  -c cognitoDomainPrefix=<prefix> \
  -c allowedRepos=owner/repo1,owner/repo2
```

The account and region are **not hardcoded**: they come from `CDK_DEFAULT_ACCOUNT`
/ `CDK_DEFAULT_REGION` (standard CDK behavior), which the CDK CLI derives from your
active AWS profile / `AWS_REGION`. If neither is set the stack is region-agnostic
and deploys to wherever the CLI points. To pin the region, set it in your profile
or export it before deploying, e.g. `export AWS_REGION=eu-north-1` (Stockholm,
the default region used here).

The region you deploy to is stamped into region-scoped resource names — notably
the Cognito managed-login host becomes `<cognitoDomainPrefix>.auth.<region>.amazoncognito.com`
(e.g. `kiro-remote.auth.eu-north-1.amazoncognito.com` for an `eu-north-1` deploy).

**Kiro cloud sandboxes always run in `us-east-1` regardless of where this stack is
deployed** — that is Kiro's side (the `kiro-cli` in the bridge talks to Kiro's
`us-east-1` sandboxes no matter your stack region). Deploying the stack in
`us-east-1` as well minimizes latency between the bridge and Kiro, but any region
works.

> The `deploy` script runs `cdk deploy --app "node bin/app.ts"` inside
> `packages/cdk` (the same `--app` invocation as `synth`). The `--` passes the
> `-c key=value` context args through pnpm to the CDK CLI. A root convenience
> script mirrors it, so from the repository root you can also run
> `mise exec -- pnpm run deploy -- -c publicBaseUrl=https://<host> ...`
> (use `pnpm run deploy` rather than bare `pnpm deploy`, which is pnpm's own
> built-in command).

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
