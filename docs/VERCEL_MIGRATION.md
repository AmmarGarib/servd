# Moving servd to Vercel

Branch: `vercel-nextjs`. Nothing here changes the Docker deployment: the same
code still runs on the box exactly as before. Vercel is an additional way to
run it, switched on by environment variables.

## What runs where

| Piece | Today (Docker box) | On Vercel |
|---|---|---|
| Storefront (Next.js) | container | Vercel project, root `frontend/storefront` |
| Admin (Next.js) | container | Vercel project, root `frontend/admin` |
| API (Fastify) | container, always on | one serverless function (`backend/api/index.js`), root `backend` |
| Live updates | socket.io in the API process | Supabase Realtime (private broadcast channels) |
| Background jobs | BullMQ workers + node-cron in the API process | Postgres job table drained by a scheduler tick |
| Redis | local Redis container | Upstash (free tier) |
| Postgres | Neon | Neon (pooled URL) |

The switches are `REALTIME_DRIVER` (`socketio` | `supabase` | `both`) and
`JOBS_DRIVER` (`bullmq` | `db`). On Vercel both are forced to the serverless
choice; on Docker the defaults keep today's behaviour.

## One-time setup

### 1. Supabase project (realtime only — the database stays on Neon)
1. Create a free project at supabase.com.
2. SQL editor → run `backend/supabase/realtime-policy.sql`.
3. Realtime → Settings → turn **off** "Allow public access".
4. Copy Project URL, anon key, service role key, and JWT secret
   (Settings → API → JWT Settings) into the API env (see below).

Free tier: 200 concurrent connections, 2M messages/month — a few kitchens'
tablets and admin screens use a fraction of that. Free projects pause after a
week with no activity; daily orders keep it awake.

### 2. Upstash Redis
Create a free Redis database, copy the `rediss://` URL into `REDIS_URL`.

### 3. Vercel projects
Import the GitHub repo three times, one project per app:

| Project | Root directory | Framework | Domain at cutover |
|---|---|---|---|
| servd-storefront | `frontend/storefront` | Next.js (auto) | servd.pk + brand domains |
| servd-admin | `frontend/admin` | Next.js (auto) | servd-admin.garibsons.app |
| servd-api | `backend` | Other | servd-api.garibsons.app |

Each app has a `vercel.json` pinning region `bom1` (Mumbai). The API's
`vercel.json` also routes every path to the function, sets 60s/1GB, and
includes the Prisma engine in the bundle.

Env vars — API: see `backend/.env.vercel.example` (all of them).
Storefront: `NEXT_PUBLIC_API_URL`, `INTERNAL_API_URL` (same public API URL —
there is no docker network on Vercel), `NEXT_PUBLIC_SITE_URL`, optional Sentry.
Admin: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL` (only for the socket.io
fallback), `NEXT_PUBLIC_STOREFRONT_URL`, optional `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`.

Set `CORS`: the API allowlist (`lib/corsAllowlist.ts`) must include the Vercel
preview and production origins; add them to `BRAND_HOSTS`/`WEB_URL`/`STOREFRONT_URL`
as appropriate while both stacks coexist.

### 4. Scheduler for background jobs
`POST https://<api>/api/v1/internal/cron/tick` with header
`Authorization: Bearer <CRON_SECRET>` runs every due task and drains the job
queues (45s budget). It must be called **every minute**.

- Vercel Pro: add `{ "path": "/api/v1/internal/cron/tick", "schedule": "* * * * *" }`
  to `backend/vercel.json` `crons`.
- Vercel Hobby only allows daily crons (the daily one is already there as a
  safety net), so use a free external scheduler — cron-job.org (free, every
  minute) — pointed at the URL above with the bearer header.

`GET /api/v1/internal/cron/status` shows last-run times and pending job counts.
Individual tasks can be run with `POST /api/v1/internal/cron/<name>`.

### 5. Database migration
Run `npx prisma migrate deploy` once against Neon (adds `background_jobs` and
`cron_runs`). Safe for the Docker deployment: it never writes those tables.

## How live updates work now

1. A staff client calls `GET /api/v1/auth/realtime-token?stationId=&conceptId=`.
2. The API re-reads the person's live role and companies, computes the exact
   list of channels they may hear (`lib/realtimeTopics.ts` — the same code that
   decides socket.io rooms), and signs a 55-minute Supabase JWT whose
   `servd_topics` claim holds that list.
3. The client subscribes to those private channels; Supabase checks the claim
   against the policy in `realtime-policy.sql` on join. Clients cannot publish
   (no INSERT policy).
4. The API publishes with `publish(topic, event, payload)` in `lib/realtime.ts`
   over Supabase's REST broadcast endpoint (batched; on Vercel flushed before
   each response leaves). Event names and payloads are unchanged from
   socket.io.
5. Clients refresh the token two minutes before expiry and re-fetch it when
   the staff session token rotates. Admin pages keep their 15–30s polling as a
   safety net.

The kitchen "bump/hold/recall" socket messages were dropped: nothing listened
to them, and the HTTP item-status update already broadcasts `item:updated`.

## Cutover order

1. Deploy all three projects; use the preview URLs against the live API on
   the box (with `REALTIME_DRIVER=both` and Supabase env set on the box, admin
   previews already get live updates through Supabase).
2. Point the API domain at Vercel; keep the box running one more day as
   rollback.
3. Point storefront + admin domains at Vercel; add the brand domains to the
   storefront project.
4. Retire the box: stop the containers and the Cloudflare tunnel.

Rollback at any step is a DNS change back to the tunnel.

## Known limits on Vercel
- No socket.io; `REALTIME_DRIVER=supabase` is required.
- Cold starts: the first request after idle takes ~1–3s (Prisma + 60 route
  modules). Fluid compute keeps instances warm under normal traffic.
- Function timeout 60s: long report exports should stream or be split later.
- `@fastify/rate-limit` counts per instance; login lockouts still use Redis.
- Vercel Hobby is for non-commercial use; production traffic needs Pro.
