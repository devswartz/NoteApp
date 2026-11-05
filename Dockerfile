# syntax=docker/dockerfile:1
# NoteApp: one image running the API, collab server, web app and reminder worker.
# Contract: docs/DEPLOY_CONTRACT.md

ARG NODE_VERSION=22

# ---- base: build toolchain -----------------------------------------------------
# better-sqlite3 compiles from source (node-gyp). The full node image already
# ships python3/make/g++ and the same Debian/glibc as the slim runtime below,
# so the compiled module is ABI-compatible and no apt step is needed.
FROM node:${NODE_VERSION}-bookworm AS base
WORKDIR /app
COPY package.json package-lock.json ./

# ---- build: full install, build the web app into dist/ -----------------------
FROM base AS build
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ---- prod-deps: production dependencies only ---------------------------------
FROM base AS prod-deps
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund \
 && cd node_modules/better-sqlite3 \
 && rm -rf deps src build/Release/obj build/Release/obj.target build/Release/.deps build/Release/test_extension.node \
 && cd /app && node -e "new (require('better-sqlite3'))(':memory:').prepare('select 1').get()"

# ---- runtime -----------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG GIT_SHA=unknown
ENV NODE_ENV=production \
    PORT=3001 \
    DATA_DIR=/data \
    GIT_SHA=${GIT_SHA}
# Interim: point the current server's DB/upload paths into /data until it reads
# DATA_DIR itself. Same locations the contract specifies, so harmless after.
ENV DB_FILE=/data/noteapp.db \
    UPLOAD_DIR=/data/files
LABEL org.opencontainers.image.source="https://github.com/devswartz/NoteApp" \
      org.opencontainers.image.revision="${GIT_SHA}"

WORKDIR /app
COPY --from=prod-deps --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/dist ./dist
COPY --chown=1000:1000 package.json tsconfig.json ./
COPY --chown=1000:1000 server ./server
COPY --chown=1000:1000 shared ./shared

# The base image's `node` user is UID/GID 1000.
RUN mkdir -p /data/files && chown -R 1000:1000 /data
USER 1000:1000
VOLUME /data
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# Run node directly (not via npm) so SIGTERM reaches the app.
CMD ["node", "--import", "tsx", "server/index.ts"]
