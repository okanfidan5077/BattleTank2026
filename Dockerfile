# syntax=docker/dockerfile:1

# =============================================================================
# Stage 1 — builder: install everything, build shared + server + client bundle.
# =============================================================================
FROM node:20-alpine AS builder
WORKDIR /app

# Manifests + lockfile first, so `npm ci` is cached until dependencies change.
# Every workspace's package.json is needed for the workspace graph to resolve.
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/client/package.json ./packages/client/

RUN npm ci

# Now the sources (node_modules and dist are kept out by .dockerignore).
COPY . .

# Compile the server (TS -> dist) and bundle the client (Vite -> dist). Each
# script builds the shared package first via TypeScript project references.
RUN npm run build:server && npm run build:client

# Strip devDependencies so only what the server needs at runtime is carried
# forward. Workspace symlinks (@battletank/*) survive the prune.
RUN npm prune --omit=dev

# =============================================================================
# Stage 2 — runner: just the compiled output and production dependencies.
# =============================================================================
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
# Bind all interfaces so the server is reachable from outside the container.
ENV HOST=0.0.0.0
# A local default only. A PaaS injects its own PORT at runtime, which overrides
# this image-level value; the server reads $PORT and listens on whatever it gets.
ENV PORT=2567

# Hoisted production dependencies, including the @battletank/* workspace symlinks
# that point back into ./packages/*.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

# Compiled shared + server, and the static client the server serves. Raw source
# and build tooling are deliberately left behind in the builder stage.
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/server/package.json ./packages/server/package.json
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/client/package.json ./packages/client/package.json
COPY --from=builder /app/packages/client/dist ./packages/client/dist

# Drop root privileges; the `node` image ships a non-root `node` user.
USER node

# Documentation only — Docker does not publish this, and the app honours $PORT
# regardless. PaaS platforms route to whatever port they assign; this is just
# the local default.
EXPOSE 2567

# Simple liveness probe against the HTTP health endpoint (no curl in alpine).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||2567)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/dist/index.js"]
