# Running servd locally on your laptop

Use this when you want the whole app running on your own machine — for
example while the office production box is offline. It runs **everything
locally with hot reload**: edit a file, see it live on localhost in seconds.
Nothing here touches Docker Hub or production.

## How this fits the bigger picture

- **Production** runs prebuilt Docker Hub images on the office Windows box,
  behind a Cloudflare Tunnel. The **database (Neon)** and **cache (Upstash)**
  are in the cloud — *not* on that box.
- When the office box loses power, the public URLs
  (`servd-app/admin/api.garibsons.app`) go dark because the tunnel lives on
  that box. Your data is still safe in the cloud.
- This local setup is **independent** of all that. Your normal deploy flow
  (merge to `main` → GitHub Actions builds + pushes images → deploy webhook →
  box pulls) is untouched and resumes automatically once the box is back.

So you can keep coding, keep pushing to GitHub and Docker, and preview
everything locally in the meantime.

---

## Option A — One command (Docker, recommended)

Bundles its own Postgres + Redis, seeds your real Simmer / Stax / Flipd data,
and runs all three apps with hot reload.

```bash
# from the repo root
docker compose -f docker-compose.local.yml up
```

First boot installs dependencies, runs migrations, and seeds the database —
this takes a few minutes. Subsequent boots are fast. When you see the API
"listening" line and both Next.js "Ready" lines, open:

| Surface    | URL                          |
|------------|------------------------------|
| Storefront | http://localhost:3002        |
| Admin      | http://localhost:3000        |
| API        | http://localhost:3001/health |

Brand microsites work via `*.localhost` (already in the CORS allowlist), e.g.
`http://simmer.localhost:3002`.

Stop with `Ctrl-C`, or in another terminal:

```bash
docker compose -f docker-compose.local.yml down          # stop, keep data
docker compose -f docker-compose.local.yml down -v       # stop, WIPE local db/seed
```

### Hot reload

`backend/`, `frontend/admin/`, and `frontend/storefront/` are bind-mounted into
the containers. Save a file and it reloads live — no rebuild, no `up` again.
(File-watch polling is enabled so this works on macOS and Windows too.)

### Re-seeding / extra seed data

The first boot seeds once (guarded by a marker volume). To reseed or load the
fuller GS Foods catalog later:

```bash
# canonical seed (Simmer/Stax/Flipd concepts + admin user)
docker compose -f docker-compose.local.yml exec api npm run db:seed

# optional richer datasets
docker compose -f docker-compose.local.yml exec api npm run seed:gs
docker compose -f docker-compose.local.yml exec api npm run seed:gs-components
docker compose -f docker-compose.local.yml exec api npm run seed:customer

# open Prisma Studio against the local db
docker compose -f docker-compose.local.yml exec api npm run db:studio
```

To force a full re-seed on next boot: `down -v` (wipes the local db), then `up`.

### Use the live cloud database instead

If you'd rather see real production data, create a `.env.local` file in the
repo root (it's git-ignored):

```dotenv
DATABASE_URL=postgresql://...your Neon connection string...
REDIS_URL=rediss://...your Upstash connection string...
```

Then `docker compose -f docker-compose.local.yml up` as usual. The bundled
db/redis still start but are ignored.

> ⚠️ This is **live production data**. Writes persist and
> `prisma migrate` / seed commands will alter the real schema/data. Prefer the
> bundled local db for day-to-day development.

---

## Option B — No Docker (fastest reload)

If you have Node 20 + a local Postgres and Redis already, you can skip Docker
entirely. This is the snappiest edit loop.

```bash
npm run install:all          # one-time: installs all workspaces
cp .env.example .env         # fill DATABASE_URL, REDIS_URL, JWT secrets
npm run db:migrate --prefix backend
npm run db:seed   --prefix backend
npm run dev                  # API :3001 · admin :3000 · storefront :3002
```

`npm run dev` runs all three with hot reload via `concurrently`.

---

## What about pushing to GitHub / Docker?

Keep doing it exactly as before — but know what each is for:

- **Push to GitHub** → source of truth + triggers CI to build new images.
- **Docker Hub images** → how the **office box** deploys, *not* how you preview
  locally. Building + pushing images is a multi-minute CI round-trip; don't use
  it as your local feedback loop. Use Option A/B above for live local preview.
- When the office box has power again, nothing changes: merge to `main`, let CI
  build + push, then the deploy webhook makes the box pull and restart.

## Troubleshooting

- **Ports already in use (3000/3001/3002/5432/6379):** stop whatever's using
  them, or edit the `ports:` mappings in `docker-compose.local.yml`.
- **Storefront/admin can't reach the API:** the API takes longest on first
  boot (install + migrate + seed). Give it a minute; the Next.js apps retry.
- **Changes not reloading:** polling is on by default; if it's still sluggish,
  a `down` + `up` of just that service forces a clean start, e.g.
  `docker compose -f docker-compose.local.yml restart storefront`.
- **Deps look stale after a package.json change:** the install runs on every
  `up`, but you can force it: `docker compose -f docker-compose.local.yml run --rm api npm install`.
