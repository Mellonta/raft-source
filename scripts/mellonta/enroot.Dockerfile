# Built in GitHub Actions. The deployment machine uses only Enroot.
ARG NODE_VERSION=24.15.0
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@10.29.3
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
COPY packages/sync-core/package.json packages/sync-core/
COPY packages/shared/package.json packages/shared/
COPY packages/desktop-contract/package.json packages/desktop-contract/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN pnpm --filter @botiverse/raft-server... --filter @botiverse/raft-web... install --frozen-lockfile
COPY packages/sync-core/ packages/sync-core/
COPY packages/shared/ packages/shared/
COPY packages/desktop-contract/ packages/desktop-contract/
COPY packages/server/ packages/server/
COPY packages/web/ packages/web/
COPY packages/visual-testing/shared/ packages/visual-testing/shared/
COPY manual/ manual/
ARG RELEASE_SHA
# An empty compiled API origin uses the browser's origin, so one image works
# with any --url, without building software on the cluster.
ENV VITE_API_URL="" VITE_DEPLOYMENT_ENV=production VITE_COMMIT_SHA=$RELEASE_SHA \
    VITE_FRONTEND_RELEASE_ID=$RELEASE_SHA VITE_WEB_TRACE_URL="" VITE_FEEDBACK_EXPORT_URL=""
RUN pnpm --filter @botiverse/raft-web build && chmod -R a+rX /app

FROM postgres:16-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 redis-server nginx fontconfig fonts-dejavu-core fonts-wqy-zenhei \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/ /usr/local/
COPY --from=build /app /app
COPY scripts/mellonta/enroot-runtime.py scripts/mellonta/enroot-nginx.conf /opt/raft/
COPY scripts/mellonta/prod-security-headers.conf /opt/raft/security-headers.conf
ARG RELEASE_SHA
RUN printf '%s\n' "$RELEASE_SHA" > /opt/raft/revision \
    && mkdir -p /raft/state && chmod -R a+rX /opt/raft
ENV NODE_ENV=production
WORKDIR /app
ENTRYPOINT []
CMD ["python3", "/opt/raft/enroot-runtime.py"]
