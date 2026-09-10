# syntax=docker/dockerfile:1.7
# ──────────────────────────────────────────────────────────────────────
# Bravo Secure — messenger-service
# Multi-stage build. `deps` resolves npm deps once; `build` compiles
# TypeScript; the final runtime image is distroless-style slim.
# ──────────────────────────────────────────────────────────────────────

FROM node:20-bookworm-slim AS deps
WORKDIR /app
# mediasoup's postinstall downloads a prebuilt worker binary; when that
# fetch fails (or no asset matches the host kernel) it falls back to
# BUILDING the worker from C++ source, which needs python3 + a toolchain.
# node:20-bookworm-slim ships none of these, so the build died at
# `"python" -m pip install ... invoke`. Install the build deps and alias
# python→python3 so the source-build fallback always succeeds. Kept in the
# deps stage only — the slim runtime image is unaffected.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip build-essential ca-certificates \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*
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
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3100/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["node", "dist/main.js"]
