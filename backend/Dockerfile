FROM node:22-alpine AS base
# OpenSSL in EVERY stage, not just the runner: the Prisma CLI picks its engine
# by detecting OpenSSL when npm installs it. Without it the builder fetched the
# plain linux-musl schema engine, the runner (which has OpenSSL 3) wanted
# linux-musl-openssl-3.0.x, and `prisma migrate deploy` tried to download it at
# every boot — so the API could not start without reaching binaries.prisma.sh.
RUN apk add --no-cache openssl

# ── deps: production-only node_modules ───────────────────────────────────────
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ── builder: full install + compile ──────────────────────────────────────────
FROM base AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY src/ ./src/
COPY tsconfig.json ./
COPY prisma/ ./prisma/
# Generate Prisma client with Alpine musl binary included
RUN npx prisma generate
RUN npm run build

# ── runner: lean production image ─────────────────────────────────────────────
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 servd

# Weekly database backup (owner S13, 2026-10-26): the API runs pg_dump. Its
# major version must be >= the database server's (Neon: check with
# `SHOW server_version;`) — pass --build-arg PG_CLIENT=postgresql18-client
# when the server is newer. /app/backups is the backup volume
# (deploy/docker-compose.yml servd_backups); a named volume takes this
# directory's owner on first mount, so it must exist here, owned by servd.
ARG PG_CLIENT=postgresql17-client
RUN apk add --no-cache ${PG_CLIENT} && mkdir -p /app/backups && chown servd:nodejs /app/backups && chmod 700 /app/backups

# Production node_modules from deps stage
COPY --chown=servd:nodejs --from=deps    /app/node_modules              ./node_modules

# Overlay Prisma-specific directories from builder (contains correct Alpine binaries)
COPY --chown=servd:nodejs --from=builder /app/node_modules/.prisma      ./node_modules/.prisma
COPY --chown=servd:nodejs --from=builder /app/node_modules/@prisma      ./node_modules/@prisma

# Prisma CLI from builder (it's a devDep, not in deps stage)
COPY --chown=servd:nodejs --from=builder /app/node_modules/.bin/prisma  ./node_modules/.bin/prisma
COPY --chown=servd:nodejs --from=builder /app/node_modules/prisma       ./node_modules/prisma

COPY --chown=servd:nodejs --from=builder /app/dist   ./dist
COPY --chown=servd:nodejs --from=builder /app/prisma ./prisma
# The backup opener the CEO downloads from CEO → Backups (GET /backups/opener).
COPY --chown=servd:nodejs scripts/decrypt-backup.mjs ./scripts/decrypt-backup.mjs

COPY package.json ./
COPY --chown=servd:nodejs entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh

USER servd
EXPOSE 3001
ENTRYPOINT ["./entrypoint.sh"]
