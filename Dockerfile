# syntax=docker/dockerfile:1
#
# Multi-stage build for Swenlly Share (System 2) — single deployable, single
# Node process (architecture.md §1, §12.3). No native adapters need a compiler
# toolchain, so `node:22-alpine` is sufficient at every stage.

ARG NODE_IMAGE=node:22-alpine
ARG PNPM_VERSION=10.33.0

# ---------------------------------------------------------------------------
# deps — install the full dependency tree (incl. devDependencies) once, from
# the frozen lockfile, so `build` and any future test stage can share it.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
ARG PNPM_VERSION
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# build — compile TypeScript to dist/, then prune devDependencies out of this
# stage's node_modules so only the production tree gets copied to `runtime`.
# ---------------------------------------------------------------------------
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

# ---------------------------------------------------------------------------
# runtime — minimal image: production node_modules + compiled dist only, run
# as a non-root user, staging disk exposed as a volume per architecture §1/§12.3
# (single stateful node — local-disk staging until BlobStagingPort gets an
# object-store adapter).
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG PNPM_VERSION
ENV NODE_ENV=production \
    PORT=3000 \
    STAGING_DIR=/data/staging
WORKDIR /app

# corepack is kept only so `pnpm` is available for one-off operational
# commands (e.g. `pnpm db:migrate`) run via `docker exec`; the app itself is
# started with plain `node`, no pnpm on the hot path.
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate \
    && addgroup -g 10001 -S app && adduser -u 10001 -S app -G app \
    && mkdir -p "$STAGING_DIR" && chown -R app:app "$STAGING_DIR" /app

COPY --chown=app:app --from=build /app/node_modules ./node_modules
COPY --chown=app:app --from=build /app/dist ./dist
COPY --chown=app:app package.json ./package.json

# Numeric form (not "app") so a k8s runAsNonRoot/runAsUser check can resolve
# the UID without reading /etc/passwd inside the image.
USER 10001:10001
VOLUME ["/data/staging"]
EXPOSE 3000

# server.ts runs migrations at boot (src/server.ts), so /healthz only reports
# ready once migration + listen have both succeeded. Uses Node's native fetch
# instead of curl/wget, which alpine doesn't ship by default. JSON form calling
# `sh -c` (rather than shell-form CMD) so hadolint's exec-form check is happy
# while `$PORT` still gets expanded.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["sh", "-c", "node -e \"fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))\""]

CMD ["node", "dist/server.js"]
