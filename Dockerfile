# syntax=docker/dockerfile:1.7
# Maintenance Monitor API — multi-stage production image.
# For reproducible builds, pin the base image by digest in your registry mirror.
ARG NODE_IMAGE=node:22-alpine

# --- Production dependencies only ------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Install scripts are skipped: argon2 ships prebuilt musl binaries loaded at runtime.
# --omit=optional also drops ts-node/typescript, which TypeORM lists as optional peers (CLI only).
RUN npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

# --- Build (TypeScript -> JavaScript) ---------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- Runtime ------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
RUN apk add --no-cache tini
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# Run as the unprivileged "node" user provided by the base image.
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/v1/health/live').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# tini forwards signals so SIGTERM triggers the graceful shutdown in main.ts.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
