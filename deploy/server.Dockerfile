# Polyptic — single control-plane image (console + player + server).
#
# ONE artifact = the operator console (Vue SPA) + the player (Vue SPA) + the
# Fastify control plane. The server serves both SPAs SAME-ORIGIN on :8080, so the
# auth cookie "just works" with no cross-origin CORS dance.
#
# Multi-stage:
#   stage 1 (build)   — oven/bun:1: `bun install`, build @polyptic/protocol, then
#                       `vite build` the console AND the player into their dist/.
#   stage 2 (runtime) — oven/bun:1-slim: server source + protocol + the two dist
#                       dirs only. CONSOLE_DIR / PLAYER_DIR point the server at the
#                       built SPAs. Runs the TS entrypoint with bun (no JS build).
#
# Build context is the REPO ROOT (docker-compose sets build.context = ..), so all
# paths below are relative to the monorepo root.
#
# Build standalone:
#     docker build -f deploy/server.Dockerfile -t polyptic-server .
# Or via compose:
#     docker compose -f deploy/docker-compose.yml --profile full up --build
#
# NOTE: `vite build` runs HERE, inside the image — never in the sandbox workflow.

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — build: install deps, compile the protocol, build both SPAs.
# ─────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1 AS build
WORKDIR /app

# Copy the whole bun workspace. (.dockerignore + deploy/server.Dockerfile.dockerignore
# keep host node_modules / dist / .git / media out of the build context, so
# `bun install` regenerates linux-native deps inside the image.)
COPY . .

# Install all workspace dependencies (incl. vite + vue-tsc needed to build the SPAs).
RUN bun install --frozen-lockfile

# Build the shared contract first so @polyptic/protocol resolves to its compiled
# dist/ (its package.json exports point at ./dist) before anything imports it.
RUN cd packages/protocol && bun run build

# Production builds of both SPAs. Vite emits to packages/<app>/dist by default.
RUN cd packages/console && bun run build
RUN cd packages/player && bun run build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — runtime: slim image with just what the server needs at run time.
# ─────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1-slim AS runtime
WORKDIR /app

# Optional provenance, surfaced by the server at /api/v1 + /metrics.
ARG POLYPTIC_VERSION=0.0.0
ARG POLYPTIC_REVISION=dev

# node_modules is built linux-native in stage 1 — copy it rather than reinstalling
# (bun hoists the workspace deps to the root node_modules).
COPY --from=build /app/node_modules ./node_modules

# Workspace + server manifests and the TS config the server tsconfig extends.
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/bun.lock ./bun.lock
COPY --from=build /app/tsconfig.base.json ./tsconfig.base.json

# The shared contract (compiled dist + its manifest) and the server source.
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/server ./packages/server

# The two built SPAs — the only thing the runtime needs from console/player.
COPY --from=build /app/packages/console/dist ./packages/console/dist
COPY --from=build /app/packages/player/dist ./packages/player/dist

# ── Runtime env ──────────────────────────────────────────────────────────────
# The server binds HOST:PORT and serves the console + player from these dirs,
# same-origin on :8080. STORE / DATABASE_URL / MEDIA_* come from compose or
# `docker run -e` (defaults below keep a bare `docker run` bootable).
ENV PORT=8080 \
    HOST=0.0.0.0 \
    CONSOLE_DIR=/app/packages/console/dist \
    PLAYER_DIR=/app/packages/player/dist \
    MEDIA_DIR=/var/lib/polyptic/media \
    POLYPTIC_VERSION=${POLYPTIC_VERSION} \
    POLYPTIC_REVISION=${POLYPTIC_REVISION}

EXPOSE 8080

# Healthcheck hits the public /healthz. bun is always present, so we avoid relying
# on curl/wget being installed in the slim base.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Bun runs the TypeScript entrypoint natively — no separate build step for the server.
CMD ["bun", "packages/server/src/index.ts"]
