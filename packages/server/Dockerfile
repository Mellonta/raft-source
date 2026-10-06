ARG NODE_VERSION=24.21.0
FROM node:${NODE_VERSION}-bookworm-slim

RUN corepack enable

# Sharp rasterizes download-only SVG attachments through libvips/librsvg.
# The slim Node image contains neither fontconfig nor fonts, so otherwise even
# ordinary Mermaid `font-family="sans-serif"` labels become tofu/blank pixels
# while shapes still render. Keep small Latin and CJK baseline fonts and fail
# the image build if the generic family cannot actually resolve them.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    fontconfig \
    fonts-dejavu-core \
    fonts-wqy-zenhei \
  && fc-match sans-serif | grep -q "DejaVu Sans" \
  && for language in zh-cn ja ko; do \
    fc-match -f '%{family}\n' "sans-serif:lang=${language}" | grep -q "WenQuanYi Zen Hei"; \
  done \
  && rm -rf /var/lib/apt/lists/*

ARG RAFT_RELEASE_SHA=""
ARG RAFT_BUILD_AT=""
ARG RAFT_RELEASE_BRANCH=""
# Repository the image was built from; passed by the build scripts.
ARG RAFT_IMAGE_SOURCE=""
ARG SLOCK_RELEASE_SHA=""
ARG SLOCK_BUILD_AT=""
ARG SLOCK_RELEASE_BRANCH=""
# RAFT_* is the canonical release identity; SLOCK_* remains a compatibility alias.
ENV RAFT_RELEASE_SHA=$RAFT_RELEASE_SHA
ENV RAFT_BUILD_AT=$RAFT_BUILD_AT
ENV RAFT_RELEASE_BRANCH=$RAFT_RELEASE_BRANCH
ENV SLOCK_RELEASE_SHA=$SLOCK_RELEASE_SHA
ENV SLOCK_BUILD_AT=$SLOCK_BUILD_AT
ENV SLOCK_RELEASE_BRANCH=$SLOCK_RELEASE_BRANCH

WORKDIR /app

# Copy workspace root files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./

# Copy package manifests
COPY packages/sync-core/package.json packages/sync-core/
COPY packages/runtime-form/package.json packages/runtime-form/
COPY packages/shared/package.json packages/shared/
COPY packages/trace-client/package.json packages/trace-client/
COPY packages/server/package.json packages/server/

# Install all dependencies (@oxc-node/core loads TypeScript source at runtime)
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN pnpm install --frozen-lockfile

# Copy source
COPY packages/sync-core/ packages/sync-core/
COPY packages/runtime-form/ packages/runtime-form/
COPY packages/shared/ packages/shared/
COPY packages/trace-client/ packages/trace-client/
COPY packages/server/ packages/server/
COPY manual/ manual/

LABEL org.opencontainers.image.title="slock-server" \
  org.opencontainers.image.source="${RAFT_IMAGE_SOURCE}" \
  org.opencontainers.image.revision="${RAFT_RELEASE_SHA}" \
  org.opencontainers.image.created="${RAFT_BUILD_AT}" \
  org.opencontainers.image.version="${RAFT_RELEASE_BRANCH}"

EXPOSE 3001

# Entrypoint: push DB schema then start server
RUN chmod +x packages/server/entrypoint.sh
CMD ["packages/server/entrypoint.sh"]
