# syntax=docker/dockerfile:1

# The ACP bridge image.
#
# - linux/arm64 (the ECS task runs on Graviton).
# - Installs kiro-cli via the OFFICIAL install script, pinned by a build ARG
#   (never hardcode a version here).
# - esbuild-bundles the bridge CLI (packages/bridge/src/cli.ts) into a single
#   self-contained CommonJS file at IMAGE-BUILD time and runs that bundle, so
#   there is no bare `@nikovirtala/*` import and no raw `.ts` under node_modules
#   at runtime. (Node refuses to type-strip `.ts` files resolved under a
#   node_modules path, which is why running the raw source crashed the
#   container at module load; bundling inlines the workspace code and sidesteps
#   that entirely, mirroring the API Lambda in packages/cdk/src/api-asset.ts.)
#
# NODE_VERSION pins the Node base image. It is a REAL, published Docker tag
# (node:<version>-bookworm-slim on Docker Hub), which is a DIFFERENT concern
# from the Node the repo's .mise.toml pins for local type-stripping. The esbuild
# bundle below targets node22, the API Lambda runtime is NODEJS_22_X, and the
# serverless image (Dockerfile.lambda) uses the Node 22 Lambda base, so the
# build+runtime toolchain is uniformly Node 22 here; pin a real Node 22 tag (not
# an unpublished 26.x, which would fail the build at `FROM`).
#
# LAMBDA-PATH ENTRYPOINTS (FEAT-003 source; FEAT-004 wires the image).
#   The serverless bridge adds two more entry shapes that this image's bundle
#   pattern extends 1:1 (same esbuild invocation, different entry file):
#     - packages/bridge/src/lambda-consumer.ts exports `handler` (an
#       SQSEvent -> SQSBatchResponse handler) for the cloud command consumer;
#     - packages/bridge/src/caps-publisher.ts exports `handler` (the one-shot
#       CONFIG#CAPS publisher) AND is also reachable as the `caps-publish` CLI
#       subcommand of this same cli.ts bundle.
#   FEAT-004 builds the container-image Lambda that runs these: it either bundles
#   each entry to its own `dist/<name>.cjs` (mirroring this `bridge.cjs` step) or
#   points the image at the `handler` export, keeping one consistent bundle
#   story across the ECS image and the Lambda image. This Dockerfile is NOT
#   changed by FEAT-003 (it remains the ECS `serve` image).
# - KIRO_API_KEY is injected as an ECS secret at RUNTIME (never baked into the
#   image, never an ENV/ARG here).

ARG NODE_VERSION=22

############################
# deps: install workspace node_modules with pnpm and bundle the bridge
############################
# CDK passes platform: Platform.LINUX_ARM64 to ContainerImage.fromAsset, so
# buildkit already sets the target platform from the build-level --platform
# flag; a per-FROM --platform would be redundant (RedundantTargetPlatform).
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app

# Install the pinned pnpm via npm (the node slim image ships npm but not
# corepack, which was unbundled from recent Node distributions).
ARG PNPM_VERSION=12.18.0
RUN npm install -g pnpm@${PNPM_VERSION}

# Copy only the manifests first for better layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/package.json
COPY packages/bridge/package.json packages/bridge/package.json
COPY packages/cdk/package.json packages/cdk/package.json

# Install the bridge (and its workspace deps) plus the cdk package, whose dev
# dependency esbuild performs the bundling below. --frozen-lockfile keeps the
# image reproducible; --prod=false pulls in the esbuild devDependency.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    PNPM_HOME=/pnpm pnpm install --frozen-lockfile \
      --filter @nikovirtala/kiro-remote-bridge... \
      --filter @nikovirtala/kiro-remote-cdk --prod=false

# The sources that get bundled (the workspace .ts entry + its imports).
COPY tsconfig.base.json ./tsconfig.base.json
COPY packages/core ./packages/core
COPY packages/bridge ./packages/bridge

# Bundle the bridge CLI to a SINGLE self-contained CommonJS file. Settings
# mirror packages/cdk/src/api-asset.ts, except @aws-sdk/* is BUNDLED IN (no
# --external) so the runtime image needs no node_modules at all:
#   - --format=cjs with a `.cjs` extension: the repo-root package.json is
#     "type": "module", so a `.js` CommonJS bundle would be mis-read as ESM and
#     `require` would throw; `.cjs` forces CommonJS regardless.
#   - --resolve-extensions includes `.ts` so esbuild resolves the repo's
#     explicit `.ts` import specifiers (allowImportingTsExtensions +
#     rewriteRelativeImportExtensions in tsconfig) without a custom plugin.
# The kiro-cli child process is a runtime PATH binary spawned via
# child_process, not an import, so it is neither bundled nor externalized.
#
# esbuild is a devDependency of @nikovirtala/kiro-remote-cdk. Under pnpm's
# default isolated node_modules layout its bin is linked ONLY into the owning
# package's node_modules/.bin (packages/cdk/node_modules/.bin/esbuild), NOT the
# workspace-root node_modules/.bin. We therefore invoke the owning package's
# bin by its explicit path, which resolves under the filtered install above and
# keeps the working directory at /app so the relative entry path below (and its
# .ts resolution) stays correct.
RUN packages/cdk/node_modules/.bin/esbuild packages/bridge/src/cli.ts \
      --bundle \
      --platform=node \
      --target=node22 \
      --format=cjs \
      --resolve-extensions=.ts,.js,.mjs,.json \
      --outfile=/app/dist/bridge.cjs

############################
# runtime: kiro-cli + the self-contained bridge bundle
############################
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app

# The kiro-cli version to install is a REQUIRED build arg (no default pin here).
ARG KIRO_CLI_VERSION
# The official install script URL (overridable for mirrors/air-gapped builds).
# Per the Kiro headless docs the canonical command is
# `curl -fsSL https://cli.kiro.dev/install | bash` (note: no `.sh` suffix).
ARG KIRO_CLI_INSTALL_URL=https://cli.kiro.dev/install

# Install the build-only deps the official script needs on Linux, then install
# kiro-cli via that script with the pinned version, then drop the build-only
# packages.
#
# The script's shebang is `#!/bin/bash` and it uses bash-only features
# (`[[ ]]`, arrays, BASH_REMATCH), so it MUST be piped to `bash` -- piping to
# `sh` (dash on Debian) would break it. Its `check_dependencies` requires a
# downloader (curl), `unzip`, and `sha256sum` (coreutils, already present); so
# `unzip` is added alongside curl + ca-certificates. The version is passed via
# `--version` (strict semver), NOT an env var.
#
# CRITICAL: the CLI ships TWO binaries -- `kiro-cli` (the entrypoint) and
# `kiro-cli-chat` (the headless chat/ACP engine that `kiro-cli acp` internally
# exec's). The official script's inner install.sh writes to `$HOME/.local/bin`
# by default, OR to `/usr/local/bin` ($GLOBAL_INSTALL_DIR) when its env carries
# `KIRO_CLI_INSTALL_GLOBAL=1`; the OUTER script forwards that flag when it sees
# `Q_INSTALL_GLOBAL` set (see `install_zip()` / `zip_install_dir()`). Our
# earlier approach installed into /root/.local/bin and then cherry-picked ONLY
# `kiro-cli` into /usr/local/bin, leaving `kiro-cli-chat` behind -- so
# `kiro-cli acp` failed with `failed to launch kiro-cli-chat: No such file or
# directory (os error 2)`. We therefore set `Q_INSTALL_GLOBAL=1` so BOTH
# binaries land in /usr/local/bin (on the default PATH and siblings of each
# other, satisfying either kiro-cli resolution strategy) and are reachable by
# the non-root `bridge` user. `--no-modify-path` skips the shell-rc edits we do
# not need.
#
# Fallback: if a future script change ignored Q_INSTALL_GLOBAL and still used
# /root/.local/bin, copy the ENTIRE dir (BOTH binaries + any support files),
# not just one, into /usr/local/bin. Then explicitly make both 0755 and ASSERT
# `kiro-cli-chat` is present+executable so a standalone zip (which ships no
# kiro-cli-chat) fails the build LOUDLY here instead of deploying a broken image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates unzip \
    && test -n "${KIRO_CLI_VERSION}" \
    && curl -fsSL "${KIRO_CLI_INSTALL_URL}" | Q_INSTALL_GLOBAL=1 bash -s -- --version "${KIRO_CLI_VERSION}" --no-modify-path \
    && { [ -x /usr/local/bin/kiro-cli ] || { [ -d /root/.local/bin ] && cp -a /root/.local/bin/. /usr/local/bin/; }; } \
    && { [ -x /usr/local/bin/kiro-cli ] || { echo "kiro-cli not found after install" >&2; exit 1; }; } \
    && command -v kiro-cli-chat >/dev/null 2>&1 \
      || { echo "kiro-cli-chat not found after install (need the bundle zip that ships it)" >&2; exit 1; } \
    && chmod 0755 /usr/local/bin/kiro-cli /usr/local/bin/kiro-cli-chat \
    && apt-get purge -y curl unzip \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# The self-contained bundle is the ONLY app artifact needed at runtime: it
# inlines the @nikovirtala/* workspace code AND @aws-sdk/*, so there is no
# node_modules and no raw .ts source in the runtime image. The `.cjs` extension
# forces CommonJS, so no package.json "type" shim is copied.
COPY --from=deps /app/dist/bridge.cjs ./dist/bridge.cjs

# Run as a non-root user. `--create-home` makes /home/bridge owned by the
# bridge user.
RUN useradd --create-home --uid 10001 bridge \
    && chown -R bridge:bridge /app /home/bridge

# kiro-cli needs a WRITABLE HOME/KIRO_HOME as the non-root user for its config,
# sign-ins, permissions, sessions, settings and agent state. ECS/Fargate may
# launch the ENTRYPOINT with HOME unset (or HOME=/, which uid 10001 cannot
# write) -- a classic exit-1-on-startup. Pin HOME to the created, bridge-owned
# home and point KIRO_HOME at a writable dir under it so the ACP child can
# persist its state. (kiro-cli writes logs under $XDG_RUNTIME_DIR or
# /tmp/kiro-log, both writable, so only HOME/KIRO_HOME needed pinning here.)
ENV HOME=/home/bridge \
    KIRO_HOME=/home/bridge/.kiro

# Build-time proof that the non-root `bridge` user can actually EXECUTE
# kiro-cli from the system PATH (not just that the file exists), AND can
# SEE+reach its `kiro-cli-chat` sibling (which `kiro-cli acp` exec's). These
# run as the bridge uid via runuser (provided by util-linux in bookworm-slim)
# and fail the image build loudly if a future change reintroduces the EACCES /
# /root-only regression or drops kiro-cli-chat. `kiro-cli --version` is a
# local, offline exec that needs no network or auth; kiro-cli-chat is asserted
# reachable+executable rather than run, since it takes ACP args, not
# `--version`. The kiro-cli-chat check runs via `runuser ... sh -c '...'`
# because `command -v` (and `test`) are shell builtins -- `runuser -- <args>`
# exec's a binary directly and does NOT spawn a shell, so a bare
# `runuser -u bridge -- command ...` would try to exec a program literally
# named `command` and fail. kiro-cli is a real binary, so it stays a direct exec.
RUN runuser -u bridge -- kiro-cli --version \
    && runuser -u bridge -- sh -c 'command -v kiro-cli-chat >/dev/null 2>&1 && test -x "$(command -v kiro-cli-chat)"'

USER bridge

# Cheap liveness probe: a bare Node exec that cannot re-trigger the old
# type-strip crash and does not depend on an unimplemented subcommand. It only
# proves the Node runtime in the container is responsive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=2 \
    CMD node -e "process.exit(0)"

# Run the bundled bridge. `serve` is the only implemented subcommand.
# KIRO_API_KEY arrives via ECS secret at runtime -- never present in this image.
ENTRYPOINT ["node", "dist/bridge.cjs"]
CMD ["serve"]
