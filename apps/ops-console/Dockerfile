# syntax=docker/dockerfile:1.7
# ──────────────────────────────────────────────────────────────────────
# Bravo Secure — ops-console (Next.js 15, App Router)
#
# Multi-stage build, Next.js standalone output. Build context MUST be
# the repo root (NOT apps/ops-console) because the app imports
# @bravo/messenger-core via the tsconfig path alias pointing at
# ../../packages/messenger-core/src — webpack resolves that at build
# time, so the package source has to be present in the build context.
#
# Build: `docker build -f apps/ops-console/Dockerfile -t bravo/ops-console:staging .` from repo root.
#
# Runtime: serves on :3002, behind Caddy at ops.94-136-184-52.sslip.io.
# ──────────────────────────────────────────────────────────────────────

FROM node:20-bookworm-slim AS deps
WORKDIR /app
# Copy the package manifest for the app + the package it depends on.
COPY apps/ops-console/package.json apps/ops-console/package-lock.json* ./apps/ops-console/
COPY packages/messenger-core/package.json ./packages/messenger-core/
# Install ops-console deps.
WORKDIR /app/apps/ops-console
RUN --mount=type=cache,target=/root/.npm \
    npm ci
# Install messenger-core's deps + the peer deps its source imports but
# doesn't declare (socket.io-client, async-storage). We place these at
# /app/node_modules so webpack's path-aliased resolution walks up from
# packages/messenger-core/src and finds them — matching the local
# monorepo layout where the repo-root node_modules hoists everything.
WORKDIR /app
RUN echo '{"name":"bravo-build-root","private":true}' > package.json && \
    npm install --no-package-lock --no-save \
      @privacyresearch/libsignal-protocol-typescript@^0.0.16 \
      @noble/hashes@^2.2.0 \
      socket.io-client@^4.8.3 \
      @react-native-async-storage/async-storage@^1.24.0

FROM node:20-bookworm-slim AS build
WORKDIR /app
# Bring in node_modules from both layers:
#   - root /app/node_modules holds the peer deps that messenger-core's
#     source imports without declaring them (socket.io-client,
#     async-storage, libsignal, noble/hashes). Webpack walks up from
#     packages/messenger-core/src and finds them here.
#   - apps/ops-console/node_modules holds the app's own deps (next,
#     react, mapbox-gl, swr, etc).
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/ops-console/node_modules ./apps/ops-console/node_modules
# Source files for both the app and the path-aliased package.
COPY apps/ops-console ./apps/ops-console
COPY packages/messenger-core ./packages/messenger-core
# Build-time public env (baked into the bundle). These are PUBLIC by
# the NEXT_PUBLIC_ contract; no secrets here.
ARG NEXT_PUBLIC_API_BASE_URL
ARG NEXT_PUBLIC_MSG_BASE_URL
ARG NEXT_PUBLIC_MAPBOX_TOKEN
ARG NEXT_PUBLIC_MAPBOX_STYLE
ARG NEXT_PUBLIC_DASHBOARD_POLL_MS
ARG NEXT_PUBLIC_MISSION_POLL_MS
ARG NEXT_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL \
    NEXT_PUBLIC_MSG_BASE_URL=$NEXT_PUBLIC_MSG_BASE_URL \
    NEXT_PUBLIC_MAPBOX_TOKEN=$NEXT_PUBLIC_MAPBOX_TOKEN \
    NEXT_PUBLIC_MAPBOX_STYLE=$NEXT_PUBLIC_MAPBOX_STYLE \
    NEXT_PUBLIC_DASHBOARD_POLL_MS=$NEXT_PUBLIC_DASHBOARD_POLL_MS \
    NEXT_PUBLIC_MISSION_POLL_MS=$NEXT_PUBLIC_MISSION_POLL_MS \
    NEXT_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64=$NEXT_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64
WORKDIR /app/apps/ops-console
RUN npm run build

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Next.js standalone output bundles the minimal runtime + a server.js.
# The standalone tree is rooted at .next/standalone with a nested
# apps/ops-console/ path matching the build layout.
COPY --from=build /app/apps/ops-console/.next/standalone ./
# Static assets must sit next to the standalone server.js — the
# standalone bundler hoists server.js to the root of the output tree,
# so /.next/static must also be at /app/.next/static (not nested under
# apps/ops-console/.next/static).
COPY --from=build /app/apps/ops-console/.next/static ./.next/static
# (No public/ directory in this project; skip the optional copy.)
EXPOSE 3002
ENV PORT=3002 HOSTNAME=0.0.0.0
# OC-05 — probe the real health route (a login redirect on `/` also passed
# `<500`, so the old probe could not distinguish healthy from broken-page).
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3002/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["node", "server.js"]
