# EquixLite — one Node process serving both the API and the UI.
#
# TWO STAGES, FOR ONE REASON: sqlite3 is a native module. If npm cannot find a prebuilt binary
# for this platform it compiles one, which needs python3, make and g++ — about 300MB of toolchain
# that has no business being in the image that runs in production. The builder has them; the
# runtime gets only the compiled result.

# ── build ────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build

# Build tools for the sqlite3 fallback path. If a prebuilt binary is available these go unused,
# and the layer is thrown away either way.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server

# Copy the manifests alone first. Docker caches this layer on the file contents, so a code-only
# change does not reinstall node_modules — which is the difference between a 5-second rebuild
# and a 90-second one.
COPY server/package*.json ./

# `npm ci` when there is a lockfile, `npm install` when there is not. A plain `npm ci` fails
# outright without package-lock.json, and this repo may not carry one yet.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
 && npm cache clean --force

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

# Yahoo and NSE are reached over TLS; without the CA bundle every market request fails
# certificate verification. wget is the healthcheck.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates wget \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=5070 \
    DB_PATH=/data/equixlite.db

WORKDIR /app

COPY --from=build /app/server/node_modules ./server/node_modules
COPY server ./server
COPY web ./web

# Run as the unprivileged `node` user that the base image already provides. The data directory
# is created and chowned here so a fresh named volume is writable — Docker copies the image's
# ownership into an empty volume on first mount, and nowhere else establishes it.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

VOLUME ["/data"]
EXPOSE 5070

# Hits the health route, which deliberately does not touch the database or the market feed —
# a probe that fails when Yahoo is down would restart a perfectly healthy container.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:5070/api/health || exit 1

# Migrations run on every boot. They are versioned, transactional and idempotent, so a restart
# with nothing new to apply is a no-op — and a deploy can never start the app against a schema
# it does not match.
CMD ["sh", "-c", "node server/src/db/migrations/run.js && node server/src/server.js"]
