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
# TARGETPLATFORM is provided by buildkit from the build-level --platform flag
# (CDK passes platform: Platform.LINUX_ARM64 to ContainerImage.fromAsset), so
# the image is still arm64 without a constant --platform on FROM.
ARG TARGETPLATFORM
FROM --platform=$TARGETPLATFORM node:${NODE_VERSION}-bookworm-slim AS deps
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
FROM --platform=$TARGETPLATFORM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app

# The kiro-cli version to install is a REQUIRED build arg (no default pin here).
ARG KIRO_CLI_VERSION
# The official install script URL (overridable for mirrors/air-gapped builds).
ARG KIRO_CLI_INSTALL_URL=https://kiro.dev/install.sh

# Install curl + ca-certificates, then install kiro-cli via the official script
# with the pinned version, then drop the build-only packages.
#
# The official script installs the single kiro-cli binary into ROOT's home
# (/root/.local/bin/kiro-cli). The container runs as the non-root `bridge` user
# (below), and /root is mode 0700 -- a non-root process cannot traverse it, so
# a symlink pointing INTO /root/.local/bin resolves to EACCES at exec time
# (the bridge crashed with `spawn kiro-cli EACCES`). We therefore copy the REAL
# binary out to a world-executable system path (/usr/local/bin, already on the
# default PATH) as a 0755 file so the non-root user can read+execute it. `cp -L`
# dereferences, so we copy the actual executable even if `command -v` resolves a
# symlink. Nothing kiro-cli needs at runtime is left reachable only via /root.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && test -n "${KIRO_CLI_VERSION}" \
    && curl -fsSL "${KIRO_CLI_INSTALL_URL}" | KIRO_CLI_VERSION="${KIRO_CLI_VERSION}" sh -s -- --version "${KIRO_CLI_VERSION}" \
    && KIRO_BIN="$(command -v kiro-cli || true)" \
    && { [ -n "${KIRO_BIN}" ] || KIRO_BIN=/root/.local/bin/kiro-cli; } \
    && cp -L "${KIRO_BIN}" /usr/local/bin/kiro-cli \
    && chmod 0755 /usr/local/bin/kiro-cli \
    && apt-get purge -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# The self-contained bundle is the ONLY app artifact needed at runtime: it
# inlines the @nikovirtala/* workspace code AND @aws-sdk/*, so there is no
# node_modules and no raw .ts source in the runtime image. The `.cjs` extension
# forces CommonJS, so no package.json "type" shim is copied.
COPY --from=deps /app/dist/bridge.cjs ./dist/bridge.cjs

# Run as a non-root user.
RUN useradd --create-home --uid 10001 bridge \
    && chown -R bridge:bridge /app

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
