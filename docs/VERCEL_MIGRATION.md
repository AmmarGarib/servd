# Moving servd to Next.js on Vercel — the strangler plan

Goal: everything on Next.js + Vercel, migrated incrementally with zero
big-bang risk. Production keeps running on the current Docker/webhook
flow until each piece is proven on Vercel.

## The three Vercel projects

Import the GitHub repo three times (one project per app). For each, set
**Root Directory** and env vars; leave "Include source files outside of
the Root Directory" ON (default) — the api app reads the Prisma schema
from `backend/`.

| Project | Root Directory | Domain (when cut over) |
|---|---|---|
| `servd-storefront` | `frontend/storefront` | servd-app.garibsons.app |
| `servd-admin` | `frontend/admin` | servd-admin.garibsons.app |
| `servd-api-gateway` | `api` | servd-api.garibsons.app |

Region is pinned to `bom1` (Mumbai — closest to Karachi) via each app's
`vercel.json`.

### Env vars

**storefront**
- `NEXT_PUBLIC_API_URL=https://servd-api.garibsons.app`
- `NEXT_PUBLIC_WS_URL=wss://servd-api.garibsons.app`
- `INTERNAL_API_URL=https://servd-api.garibsons.app`  ← public URL; the
  docker-network `http://api:3001` does not exist on Vercel
- `NEXT_PUBLIC_SITE_URL=https://servd-app.garibsons.app`
- `SENTRY_DSN` (optional)

**admin**
- `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL` — same as storefront
- `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` (optional)
- `SENTRY_DSN` (optional)

**api-gateway**
- `DATABASE_URL` — Neon **pooled** connection string
- `LEGACY_API_URL=https://servd-api.garibsons.app` (until DNS cutover;
  after cutover this must point at the legacy box's direct hostname,
  NOT the gateway's own domain, or unported routes would loop)

## Phases

- **Phase 0 — previews (no risk).** Create the three projects. Every
  branch push gets preview URLs. Prod domains stay on the Docker box.
- **Phase 1 — gateway in front.** Give the legacy API a secondary direct
  hostname (e.g. `servd-api-legacy.garibsons.app` via the existing
  Cloudflare Tunnel), set the gateway's `LEGACY_API_URL` to it, then
  point `servd-api.garibsons.app` at the gateway. All traffic passes
  through; nothing behaves differently. Port modules one route file at a
  time (see `api/README.md`).
- **Phase 2 — workers to Inngest.** Recreate BullMQ workers as Inngest
  functions (they only need Neon + Upstash). Retire `ENABLE_WORKERS` on
  the box once parity is verified — FBR/SRB submission last, after
  watching a full day of successful submissions.
- **Phase 3 — realtime swap.** Replace Socket.IO with Ably/Pusher behind
  a small publish abstraction; update admin KDS/POS/dispatch, storefront
  tracker, tablet app.
- **Phase 4 — retire Fastify.** When the proxy fallback serves ~0
  requests, port stragglers, cut over frontend domains to Vercel, turn
  off the Windows box.

## Cutover cautions

- CORS on the legacy API must allow the Vercel preview + prod origins
  while both stacks coexist.
- Customer auth cookies: if any flow relies on cookies cross-origin,
  verify `SameSite=None; Secure` before frontend domain cutover.
- Vercel Hobby is non-commercial — production traffic needs Pro.
- The GitHub Actions Docker flow stays untouched until Phase 4; it is
  the rollback path.
