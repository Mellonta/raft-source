ARG NODE_VERSION=24.21.0
FROM node:${NODE_VERSION}-bookworm-slim AS source
WORKDIR /app
RUN npm install --global pnpm@10.29.3
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/runtime-form/package.json packages/runtime-form/
COPY packages/trace-client/package.json packages/trace-client/
COPY packages/sync-core/package.json packages/sync-core/
COPY packages/shared/package.json packages/shared/
COPY packages/desktop-contract/package.json packages/desktop-contract/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN pnpm --filter @botiverse/raft-server... --filter @botiverse/raft-web... install --frozen-lockfile
COPY packages/runtime-form/ packages/runtime-form/
COPY packages/trace-client/ packages/trace-client/
COPY packages/sync-core/ packages/sync-core/
COPY packages/shared/ packages/shared/
COPY packages/desktop-contract/ packages/desktop-contract/
COPY packages/server/ packages/server/
COPY packages/web/ packages/web/
COPY packages/visual-testing/shared/ packages/visual-testing/shared/
COPY manual/ manual/
RUN pnpm --filter @botiverse/raft-server exec vitest run src/services/mellontaPostgresReads.test.ts src/services/conversationUnread.test.ts src/services/jointMentionV6.test.ts src/services/channelService.risingwaveNoFallback.test.ts --maxWorkers=2
# Setup uses umask 077. Image code must remain readable when the API runs as
# the host account's UID, which need not equal the image's node UID.
RUN chmod -R a+rX /app

FROM source AS server
RUN apt-get update && apt-get install -y --no-install-recommends \
    fontconfig fonts-dejavu-core fonts-wqy-zenhei && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
# Match the upstream server image: execute TypeScript once, without a watcher.
# Its shared workspace packages export TypeScript, and its tsc config is noEmit.
CMD ["node", "--import", "@oxc-node/core/register", "packages/server/src/server.ts"]

FROM source AS web-build
ARG PUBLIC_URL
ARG RELEASE_SHA
ENV VITE_API_URL=$PUBLIC_URL \
    VITE_DEPLOYMENT_ENV=production \
    VITE_COMMIT_SHA=$RELEASE_SHA \
    VITE_FRONTEND_RELEASE_ID=$RELEASE_SHA \
    VITE_WEB_TRACE_URL="" \
    VITE_FEEDBACK_EXPORT_URL=""
RUN pnpm --filter @botiverse/raft-web build

FROM nginx:1.28-alpine AS web
COPY --from=web-build /app/packages/web/dist /usr/share/nginx/html
COPY scripts/mellonta/prod-nginx.conf /etc/nginx/conf.d/default.conf
COPY scripts/mellonta/prod-security-headers.conf /etc/nginx/raft-security-headers.conf
RUN manifest_sha="$(sha256sum /usr/share/nginx/html/desktop-manifest.json | cut -d' ' -f1)" \
    && printf 'add_header ETag "\\"sha256-%s\\"" always;\n' "$manifest_sha" \
      > /etc/nginx/desktop-manifest-etag.conf
EXPOSE 80
