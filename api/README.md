# servd api gateway — Fastify → Next.js strangler migration

A Next.js app that will gradually absorb the Fastify backend so the whole
platform can run on Vercel. It is **safe at every stage**: any request that
doesn't match a Route Handler here falls through to the legacy Fastify API
(`next.config.js` fallback rewrite), so pointing `servd-api.garibsons.app`
at this app changes nothing until routes are ported one by one.

## How to port a module

1. Find the Fastify handler in `backend/src/modules/<mod>/routes.ts`.
2. Create `src/app/api/v1/<prefix>/<route>/route.ts` and port the handler
   body. Prisma queries copy over almost verbatim (`@/lib/prisma`).
3. Guard non-DB deploys: `if (!hasDatabase) return proxyToLegacy(req)`.
4. Deploy. The new file shadows the proxy for that path only. To roll
   back a route, delete the file — traffic returns to legacy.

Ported so far:

| Route | Notes |
|---|---|
| `GET /api/v1/storefront/concepts` | Public, read-only. Proof of pattern. |
| `GET /gateway/health` | Gateway's own health (legacy `/health` still proxies). |

## Still living on Fastify — the hard parts

- **Socket.IO** (KDS, POS, dispatch, live tracking) — Vercel can't hold
  WebSockets; requires an Ably/Pusher swap before Fastify can retire.
- **BullMQ workers** (ingestion, FBR/SRB tax submission, social publish,
  cart release) — need re-architecting onto Inngest/Trigger.dev.
- Everything not listed as ported above.

## Environment

| Var | Purpose |
|---|---|
| `DATABASE_URL` | Neon **pooled** connection string. Absent → ported routes proxy to legacy. |
| `LEGACY_API_URL` | The Fastify deployment (default `https://servd-api.garibsons.app`). |

## Prisma

The schema stays in `backend/prisma/schema.prisma` (single source of
truth); `postinstall` (`scripts/prisma-generate.mjs`) copies it to an
untracked local `prisma/` and generates the client into this app's
`node_modules` (a direct `--schema ../backend/...` generate would write
the client into `backend/node_modules` instead). On Vercel, keep
"Include source files outside of the Root Directory" enabled (it is by
default) so `../backend` is present at build time. `binaryTargets`
includes `native`, which resolves correctly on Vercel's build image.

## Local dev

```bash
cd api && npm install
npm run dev          # http://localhost:3005
curl localhost:3005/gateway/health
curl localhost:3005/api/v1/storefront/concepts   # proxies to prod legacy if no DATABASE_URL
```
