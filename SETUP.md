# servd — Setup Guide

## Prerequisites

Install these before doing anything else:

| Tool | Version | Install |
|---|---|---|
| Node.js | ≥ 20 | https://nodejs.org (use LTS) |
| pnpm | ≥ 9 | `npm install -g pnpm` |
| Docker Desktop | Latest | https://www.docker.com/products/docker-desktop |

---

## 1. Environment

```bash
# Copy the example env file
cp .env.example .env
```

The defaults in `.env.example` work for local development — no changes needed to get started. Fill in the gateway/platform keys when you reach those phases.

---

## 2. Start the database and Redis

```bash
docker compose up postgres redis -d
```

Wait a few seconds for both to become healthy.

---

## 3. Install dependencies

```bash
pnpm install
```

---

## 4. Generate Prisma client & run migrations

```bash
pnpm db:migrate
```

First run creates all tables. Subsequent runs apply new migrations.

---

## 5. Seed the database

The seed creates concepts, kitchen stations, the chart of accounts (~55
FBR-aligned accounts), and sample menu data. **Admin users are no longer
auto-created with a known password** — set the env vars below to provision the
first admin securely:

```bash
SEED_ADMIN_EMAIL=you@servd.pk \
SEED_ADMIN_PASSWORD='at-least-12-chars' \
SEED_ADMIN_PIN=1234 \
pnpm db:seed
```

Without those vars the seed runs everything except admin creation. To populate
realistic UAT activity (sample staff, orders, supplier bills, allocation rule)
on top, also run:

```bash
pnpm --filter @servd/api exec tsx scripts/seed-test-data.ts
```

For deployments where the user table already has staff predating the
`User.conceptIds` migration, run the backfill once:

```bash
pnpm --filter @servd/api exec tsx scripts/backfill-concept-access.ts
```

Then see [RUN_BEFORE_DEPLOY.md](RUN_BEFORE_DEPLOY.md) for the full pre-flight
checklist before pointing the system at a real database.

---

## 6. Start development servers

### Option A — all services via Docker Compose
```bash
docker compose up
```
Starts Postgres, Redis, API (port 3001), Web ops (port 3000), Storefront (port 3002).

### Option B — local Node (faster HMR)
Open three terminals:

```bash
# Terminal 1 — API
cd apps/api && pnpm dev

# Terminal 2 — Ops frontend
cd apps/web && pnpm dev

# Terminal 3 — Storefront
cd apps/storefront && pnpm dev
```

---

## 7. Verify it's working

| Check | URL / Command |
|---|---|
| API health | http://localhost:3001/health |
| API docs (Swagger) | http://localhost:3001/docs |
| Ops dashboard | http://localhost:3000/dashboard |
| KDS — all orders | http://localhost:3000/kds/all |
| POS | http://localhost:3000/pos |
| Storefront | http://localhost:3002 |
| DB studio | `pnpm db:studio` |

**Login:** `admin@servd.pk` / `admin123!`
**PIN login:** `1234`

---

## 8. First-time configuration

After logging in as admin:

1. **Settings → Concepts** — confirm slugs match your actual brand URLs
2. **Settings → Stations** — map kitchen stations to the right screens
3. **Menu Editor** — add your full menu for each concept
4. **Tables** — set up Simmer's floor plan
5. **POS → Shift** — open a shift before taking any POS orders

---

## Development workflow

### Run tests
```bash
pnpm test
```

### Add a new Prisma migration
```bash
cd apps/api
npx prisma migrate dev --name describe_your_change
```

### Inspect the database
```bash
pnpm db:studio
# Opens Prisma Studio at http://localhost:5555
```

### Start the order ingestion worker (for delivery platforms)
```bash
cd apps/api
tsx src/workers/orderIngestion.ts
```

---

## Phase blockers (before going live)

These items are required before specific features will work:

| Phase | Blocker | Action |
|---|---|---|
| Phase 4 (card payments) | Keenu credentials | Contact keenu.com.pk, complete merchant onboarding |
| Phase 5 (delivery aggregation) | Platform developer accounts | Uber Eats for Business, DoorDash Merchant API, Deliveroo partnership |
| Phase 6 (accounting) | Tax rate confirmation | Confirm FBR GST % with accountant; update `DEFAULT_TAX_RATE` in `.env` |
| Phase 5 (platform mapping) | Store ID → concept mapping | After dev accounts obtained, add settings: `ubereats_store_{ID}` = concept UUID |

---

## Environment variables reference

See `.env.example` for the full list. Critical ones:

```
JWT_SECRET          — change before production (min 32 chars)
JWT_REFRESH_SECRET  — change before production (min 32 chars)
DATABASE_URL        — PostgreSQL connection string
REDIS_URL           — Redis connection string
DEFAULT_TAX_RATE    — FBR GST percentage (e.g. 17)
```

Payment gateway keys, delivery platform secrets, and R2 credentials are all optional during development — features will fail gracefully until configured.

---

## Production deployment (Render.com)

1. Push code to GitHub
2. Create a new **Web Service** on Render, point to `apps/api`, set build command: `pnpm build && pnpm db:migrate:deploy`
3. Create **PostgreSQL** and **Redis** resources on Render; copy connection strings to env vars
4. Create two more Web Services for `apps/web` and `apps/storefront` (Next.js)
5. Set all env vars in Render dashboard
6. Every push to `main` auto-deploys

Estimated Render cost: **~$25–50/month** for starter plan.

---

## Architecture quick reference

```
servd/
├── apps/
│   ├── api/            Fastify REST + WebSocket server (port 3001)
│   │   ├── src/modules/    Feature modules (auth, orders, menu, pos, …)
│   │   ├── src/adapters/   Delivery platform + payment adapters
│   │   ├── src/workers/    BullMQ workers (order ingestion)
│   │   └── prisma/         Schema + migrations + seed
│   ├── web/            Next.js ops frontend (port 3000)
│   │   └── src/app/    KDS (/kds/…), POS (/pos), Dashboard, Menu, Finance, CRM…
│   └── storefront/     Next.js consumer ordering (port 3002)
│       └── src/app/    Per-concept pages, checkout, order status, account
└── packages/
    └── types/          Shared TypeScript types (OrderDTO, WebSocket events)
```

**Data flow:** Order arrives → adapter normalises to `OrderDTO` → `ingestOrder()` persists to DB → WebSocket emits `order:new` → KDS displays ticket → staff bumps → `updateItemStatus()` → financial entry created → P&L updated.
