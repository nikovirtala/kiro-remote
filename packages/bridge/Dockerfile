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
# - KIRO_API_KEY is injected as an ECS secret at RUNTIME (never baked into the
#   image, never an ENV/ARG here).

ARG NODE_VERSION=26.13.0

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
# `--version` (strict semver), NOT an env var. `--no-modify-path` skips the
# script's shell-rc edits since we relocate the binary ourselves.
#
# The script installs the single kiro-cli binary into HOME's `.local/bin`
# (HOME=/root during this root RUN -> /root/.local/bin/kiro-cli). The container
# runs as the non-root `bridge` user (below), and /root is mode 0700 -- a
# non-root process cannot traverse it, so leaving kiro-cli only under /root
# resolves to EACCES at exec time (the bridge crashed with
# `spawn kiro-cli EACCES`). We therefore copy the REAL binary out to a
# world-executable system path (/usr/local/bin, already on the default PATH) as
# a 0755 file so the non-root user can read+execute it. `cp -L` dereferences, so
# we copy the actual executable even if KIRO_BIN resolves a symlink. The script
# edits shell rc files (not the current shell's PATH), so `command -v kiro-cli`
# right after the pipe may miss it; we resolve the known install dir directly
# first and fall back to `command -v`.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates unzip \
    && test -n "${KIRO_CLI_VERSION}" \
    && curl -fsSL "${KIRO_CLI_INSTALL_URL}" | bash -s -- --version "${KIRO_CLI_VERSION}" --no-modify-path \
    && KIRO_BIN=/root/.local/bin/kiro-cli \
    && { [ -x "${KIRO_BIN}" ] || KIRO_BIN="$(command -v kiro-cli || true)"; } \
    && { [ -n "${KIRO_BIN}" ] || { echo "kiro-cli not found after install" >&2; exit 1; }; } \
    && cp -L "${KIRO_BIN}" /usr/local/bin/kiro-cli \
    && chmod 0755 /usr/local/bin/kiro-cli \
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
# kiro-cli from the system PATH (not just that the file exists). This exec runs
# as the bridge uid via runuser (provided by util-linux in bookworm-slim) and
# fails the image build loudly if a future change reintroduces the EACCES /
# /root-only regression -- `--version` is a local, offline exec that needs no
# network or auth.
RUN runuser -u bridge -- kiro-cli --version

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
