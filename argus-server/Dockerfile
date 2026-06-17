# Argus server — headless Pi agent + reconciler + REST API + WebSocket, and it ALSO serves
# the built UI single-origin (app + /api + /ws all on :3000). Serving the UI from the server
# avoids a dev-server WebSocket proxy, so the live chat connects instantly under Docker.
#
# Build context is the REPO ROOT (the server reads sibling dirs .pi/agent and runbooks/ at
# runtime, and the UI is built here from argus-ui/):
#
#   docker build -f argus-server/Dockerfile .

# ── Stage 1: build the React UI into static assets ──
FROM oven/bun:1.3.6 AS ui
WORKDIR /ui
COPY argus-ui/package.json argus-ui/bun.lock ./
RUN bun install --frozen-lockfile
COPY argus-ui ./
RUN bun run build   # → /ui/dist

# ── Stage 2: server runtime ──
FROM oven/bun:1.3.6
WORKDIR /app/argus-server

# Install deps first so the layer caches independently of source changes.
COPY argus-server/package.json argus-server/bun.lock ./
RUN bun install --frozen-lockfile

# Server source + the sibling dirs it reads at runtime.
COPY argus-server ./
COPY .pi /app/.pi
COPY runbooks /app/runbooks

# Built UI — server.ts serves this from DIST_DIR (= /app/argus-server/dist) with SPA fallback.
COPY --from=ui /ui/dist ./dist

# SQLite lives on a mounted volume so incident history survives `docker compose down`.
ENV DB_PATH=/data/argus.db
RUN mkdir -p /data

EXPOSE 3000
CMD ["bun", "run", "server.ts"]
