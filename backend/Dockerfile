FROM node:20-alpine AS base

# ── deps: production-only node_modules ───────────────────────────────────────
FROM base AS deps
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

# ── builder: full install + compile ──────────────────────────────────────────
FROM base AS builder
# Mirror project root structure so backend/tsconfig.json can extend ../tsconfig.json
WORKDIR /app
COPY tsconfig.json ./
COPY packages/ ./packages/

WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/src/ ./src/
COPY backend/tsconfig.json ./tsconfig.json
COPY backend/prisma/ ./prisma/

# Prisma MUST be generated before TypeScript sees @prisma/client types
RUN npx prisma generate
RUN npm run build

# ── runner: lean production image ─────────────────────────────────────────────
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 servd

COPY --from=builder /app/backend/dist ./dist
COPY --from=builder /app/backend/prisma ./prisma
COPY --from=builder /app/backend/node_modules/.prisma ./node_modules/.prisma
COPY --from=deps    /app/backend/node_modules ./node_modules
COPY backend/package.json ./

USER servd
EXPOSE 3001
# rootDir ".." makes tsc output to dist/backend/src/
CMD ["node", "dist/backend/src/index.js"]
