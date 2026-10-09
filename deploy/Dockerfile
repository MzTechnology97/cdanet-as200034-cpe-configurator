# CDA Net CPE Configurator - server image (API + Admin/NOC web console).
# Built and published by .github/workflows/server.yml to ghcr.io.
FROM node:24-alpine AS deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24-alpine
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="cdanet-cpe-server" \
      org.opencontainers.image.description="CDA Net AS200034 CPE Configurator control plane" \
      org.opencontainers.image.source="https://github.com/MzTechnology97/cdanet-as200034-cpe-configurator" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
# Network diagnostics used by /api/tools and su-exec to drop root after fixing volume ownership.
RUN apk add --no-cache iputils traceroute iproute2 su-exec tini
WORKDIR /app/server
COPY --from=deps /app/server/node_modules ./node_modules
COPY server/package.json ./
COPY server/src ./src
COPY web /app/web
# Deploy files of this version: the updater applies them after an update (no installer re-run).
COPY deploy/docker-compose.yml deploy/Caddyfile /app/deploy/
COPY deploy/updater/update.sh /app/deploy/updater/
COPY deploy/maps/fetch-basemap.sh /app/deploy/maps/
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh
ENV NODE_ENV=production \
    PORT=8787 \
    STATIC_DIR=/app/web \
    DB_PATH=/data/cdanet.sqlite \
    SECRETS_KEY_FILE=/run/secrets/cdanet_master_key \
    ANDROID_RELEASE_DIR=/opt/cdanet/releases \
    APP_REVISION=${REVISION}
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/api/health >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--", "docker-entrypoint.sh"]
CMD ["node", "src/main.ts"]
