ARG NODE_VERSION=24.21.0
FROM node:${NODE_VERSION}-bookworm-slim

RUN corepack enable

ARG SLOCK_RELEASE_SHA=""
ENV SLOCK_RELEASE_SHA=$SLOCK_RELEASE_SHA

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY packages/sync-core/package.json packages/sync-core/
COPY packages/shared/package.json packages/shared/
COPY packages/trace-upload-worker/package.json packages/trace-upload-worker/

ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN pnpm install --frozen-lockfile

COPY packages/sync-core/ packages/sync-core/
COPY packages/shared/ packages/shared/
COPY packages/trace-upload-worker/ packages/trace-upload-worker/

# Declared late so a new build time does not invalidate the install layer.
ARG SLOCK_BUILD_AT=""
ARG SLOCK_RELEASE_BRANCH=""
# Repository the image was built from; passed by the build script.
ARG RAFT_IMAGE_SOURCE=""
LABEL org.opencontainers.image.title="raft-trace-upload" \
  org.opencontainers.image.source="${RAFT_IMAGE_SOURCE}" \
  org.opencontainers.image.revision="${SLOCK_RELEASE_SHA}" \
  org.opencontainers.image.created="${SLOCK_BUILD_AT}" \
  org.opencontainers.image.version="${SLOCK_RELEASE_BRANCH}"

EXPOSE 3000

CMD ["pnpm", "--filter", "@botiverse/raft-trace-upload-worker", "start"]
