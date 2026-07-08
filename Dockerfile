# syntax=docker/dockerfile:1.7
# Bun-based production image for etteum-pool. Mirrors the reference proxy's multi-stage
# pattern, adapted from Next.js/node to Bun.
ARG BUN_IMAGE=oven/bun:1.2-alpine

FROM ${BUN_IMAGE} AS base
WORKDIR /app

FROM base AS builder
# Native deps for any build-time requirements (better-sqlite3 fallback, etc.)
RUN apk --no-cache upgrade && apk --no-cache add python3 make g++ linux-headers

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY . ./
# Build the Vite dashboard to static assets
RUN bun run build

FROM ${BUN_IMAGE} AS runner
WORKDIR /app

LABEL org.opencontainers.image.title="etteum-pool"
LABEL org.opencontainers.image.description="AI Proxy Pool for Multiple Providers"

ENV NODE_ENV=production
ENV PORT=1930
ENV DASHBOARD_PORT=1931
ENV DATA_DIR=/app/data

# Bun runtime + production deps only
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/dashboard/dist ./dashboard/dist
COPY --from=builder /app/package.json ./package.json

# Camoufox stealth browser needs a writable HOME for its profile + font cache.
RUN mkdir -p /app/data /app/data-home && \
  addgroup -S app && adduser -S app -G app && \
  chown -R app:app /app

USER app

EXPOSE 1930 1931

# Run migrations on every start, then start the production server.
CMD ["sh", "-c", "bun src/db/migrate.ts && bun scripts/production.ts --skip-build"]
