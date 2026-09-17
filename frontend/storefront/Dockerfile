FROM node:22-alpine AS base

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --no-audit/--no-fund: the post-install audit request is non-essential and,
# when the registry audit endpoint is unreachable, npm 10.8.x aborts the whole
# install ("Exit handler never called!") leaving node_modules without .bin —
# which surfaced as `next: not found` at build time. Skipping it makes the
# build resilient and faster.
RUN npm install --legacy-peer-deps --no-audit --no-fund

FROM base AS builder
WORKDIR /app
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_WS_URL
ARG NEXT_PUBLIC_SENTRY_DSN
# The canonical public host, and the ordering host a brand domain hands off to.
# Both are NEXT_PUBLIC_, so they are inlined into the client bundle at BUILD
# time — unset at build means unset forever, however the container is run.
# NEXT_PUBLIC_SERVD_HOST being unset is what kept checkout on the brand domain.
ARG NEXT_PUBLIC_SITE_URL
ARG NEXT_PUBLIC_SERVD_HOST
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_SERVD_HOST=$NEXT_PUBLIC_SERVD_HOST
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV BUILD_STANDALONE=true
RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
ENV PORT=3000
CMD ["node", "server.js"]
