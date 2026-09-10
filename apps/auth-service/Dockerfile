# syntax=docker/dockerfile:1.7
# ──────────────────────────────────────────────────────────────────────
# Bravo Secure — auth-service
#
# Multi-stage build (mirrors apps/messenger-service/Dockerfile):
#   1. `deps`    — installs prod deps + dev deps separately so the
#                  runtime image only ships what's needed at run time
#   2. `build`   — compiles TypeScript via `nest build`
#   3. `runtime` — distroless-style slim image; runs as `node` (non-root)
#
# Build context expected: this directory (apps/auth-service/).
# That keeps the messenger + auth Dockerfiles symmetric and lets the
# CI workflows use the same `docker build apps/<service>` invocation.
# ──────────────────────────────────────────────────────────────────────

FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev && cp -r node_modules /app/node_modules_prod && \
    npm ci

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npx nest build

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps  /app/node_modules_prod ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# Ops bootstrap: creates/binds an admin_users row (pg + argon2 are prod deps).
#   docker exec -it bravo-auth node scripts-create-admin.mjs <phone> <password> <call_sign> ADMIN
COPY scripts-create-admin.mjs ./
# Pre-create the uploads dir owned by the runtime user. The container runs as
# `node` (below) and /app is root-owned; without this, Multer's mkdir under
# /app/uploads EACCESes — and a named volume mounted here initialises
# root-owned from the image. Observed live as doc-upload 502 + process crash.
RUN mkdir -p /app/uploads && chown node:node /app/uploads
EXPOSE 3001
# Liveness probe — Nest exposes GET /auth/health (auth.controller.ts).
# Returns 200 {ok:true,ts} when the process is up. We don't probe DB
# here because Postgres / Redis dependencies are checked elsewhere
# (the ConfigService boot crash is the loud signal).
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/auth/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["node", "dist/main.js"]
