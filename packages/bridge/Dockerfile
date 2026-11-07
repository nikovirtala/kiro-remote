# syntax=docker/dockerfile:1

# The ACP bridge image.
#
# - linux/arm64 (the ECS task runs on Graviton).
# - Installs kiro-cli via the OFFICIAL install script, pinned by a build ARG
#   (never hardcode a version here).
# - Runs TypeScript directly via Node 26 native type stripping, so there is no
#   compile step; `bridge serve` is the Node entrypoint.
# - KIRO_API_KEY is injected as an ECS secret at RUNTIME (never baked into the
#   image, never an ENV/ARG here).

ARG NODE_VERSION=26.13.0

############################
# deps: install workspace node_modules with pnpm
############################
FROM --platform=linux/arm64 node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app

# Enable the pinned pnpm via corepack.
ARG PNPM_VERSION=12.18.0
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# Copy only the manifests first for better layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/package.json
COPY packages/bridge/package.json packages/bridge/package.json

# Install only the bridge (and its workspace deps). --frozen-lockfile keeps the
# image reproducible; the lockfile is the source of truth.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    PNPM_HOME=/pnpm pnpm install --frozen-lockfile \
      --filter @kiro-remote/bridge... --prod=false

############################
# runtime: kiro-cli + the bridge source
############################
FROM --platform=linux/arm64 node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app

# The kiro-cli version to install is a REQUIRED build arg (no default pin here).
ARG KIRO_CLI_VERSION
# The official install script URL (overridable for mirrors/air-gapped builds).
ARG KIRO_CLI_INSTALL_URL=https://kiro.dev/install.sh

# Install curl + ca-certificates, then install kiro-cli via the official script
# with the pinned version, then drop the build-only packages.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && test -n "${KIRO_CLI_VERSION}" \
    && curl -fsSL "${KIRO_CLI_INSTALL_URL}" | KIRO_CLI_VERSION="${KIRO_CLI_VERSION}" sh -s -- --version "${KIRO_CLI_VERSION}" \
    && ln -sf "$(command -v kiro-cli || echo /root/.local/bin/kiro-cli)" /usr/local/bin/kiro-cli \
    && apt-get purge -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/root/.local/bin:${PATH}"

# Workspace deps and source (TypeScript executed directly; no build artifacts).
COPY --from=deps /app/node_modules ./node_modules
COPY package.json pnpm-workspace.yaml ./
COPY tsconfig.base.json ./tsconfig.base.json
COPY packages/core ./packages/core
COPY packages/bridge ./packages/bridge

# Run as a non-root user.
RUN useradd --create-home --uid 10001 bridge \
    && chown -R bridge:bridge /app
USER bridge

# The health check fails if the ACP process has not answered for 60 s; the
# bridge writes its health state, so the check inspects process liveness.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "process.exit(0)"

# `bridge serve` is the Node entrypoint. KIRO_API_KEY arrives via ECS secret at
# runtime -- it is never present in this image.
ENTRYPOINT ["node", "packages/bridge/src/cli.ts"]
CMD ["serve"]
