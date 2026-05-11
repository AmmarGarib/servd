# servd — Production deployment handoff

**For:** the in-house dev who's bringing this live on the company server.
**From:** previous build phase. Everything here works locally; the goal is to mirror that on the server.

> Read this whole doc once before touching anything. ~10 minutes.

---

## 1. What you're deploying

A 4-part hospitality OS:

| Part | Tech | What it is |
|---|---|---|
| **Backend** | Fastify + Prisma + Postgres + Redis + Socket.IO + BullMQ | The API. Stateful — needs to stay alive (websockets + queue workers). |
| **Admin web** | Next.js 14 standalone | The operator/staff dashboard. Server-rendered. |
| **Storefront web** | Next.js 14 standalone | Customer ordering + reservations + brand microsites. Server-rendered. |
| **Mobile app** | Expo / React Native | Customer-facing iOS/Android. **Deploys separately** (not part of docker — see §6). |

**External dependencies (all currently free-tier):**
- **Postgres** — Neon (already provisioned, connection string is in `.env.production.example`). Free 0.5GB tier. No action needed.
- **File storage** — Cloudflare R2 (10GB free, $0 egress). Bucket needs to be created — see §3.
- **Email** — Resend (3k/mo free). API key needed — see §3.
- **SMS** — Twilio (paid). Optional for now; SMS triggers no-op if blank.

---

## 2. Architecture summary

```
                Customer's browser / phone
                          │
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
  admin.<domain>    app.<domain>      api.<domain>
        │                 │                 │
        └─────────┬───────┴─────────────────┘
                  ▼
            ONE server (this one)
       Docker compose, 5 containers:
       ┌──────────────────────────────┐
       │  caddy   — TLS + reverse proxy │
       │  api     — Fastify backend    │
       │  admin   — Next.js standalone │
       │  storefront — Next.js standalone │
       │  redis   — self-hosted, AOF persist │
       └──────────────────────────────┘
                  │
                  ▼
          Neon Postgres (cloud, free tier)
          Cloudflare R2 (cloud, free tier)
```

**Brand custom domains** (`eatstax.com`, `eatsimmer.com`, etc.) are also routed through the storefront container — same Next.js app, middleware rewrites a few paths under `/brand/<slug>/*`. CORS allowlist already includes them.

---

## 3. What you need to provision before deploying

### Required

1. **Domain** — at minimum, three subdomains pointing at the server's public IP:
   - `api.<domain>` — backend
   - `admin.<domain>` — staff dashboard
   - `app.<domain>` — customer storefront

   Or any 3 hostnames you want. Update `Caddyfile` with whatever you choose.

2. **Cloudflare R2 bucket** (or any S3-compatible storage). 10GB free.
   - Cloudflare Dashboard → R2 → Create bucket "servd-media" (Asia-Pacific)
   - R2 → Manage R2 API Tokens → Create token (Object Read & Write, scoped to that bucket)
   - Copy: Account ID, Access Key ID, Secret Access Key, public r2.dev subdomain URL
   - Enable "Allow Access" on the R2.dev subdomain in bucket Settings

3. **Resend API key** for email — sign up at resend.com (free 3k/mo).
   - Dashboard → API Keys → Create → copy the `re_...` key

### Optional (deferred until needed)

- **Sentry DSN** — for error monitoring. Sign up at sentry.io, create projects for `admin` and `storefront`, copy each DSN. Without these, error capture is silently disabled.
- **Twilio** — SMS sending. Without these, SMS triggers log but don't send.
- **Payment gateways** (Keenu, JazzCash, EasyPaisa) — fill before any real-money transactions.

---

## 4. Server requirements

| Resource | Minimum | Recommended |
|---|---|---|
| **OS** | Ubuntu 22.04 LTS (or any modern Linux) | Ubuntu 22.04 |
| **RAM** | 1 GB (with 1 GB swap) | 2 GB |
| **Disk** | 20 GB | 30 GB |
| **CPU** | 1 vCPU | 2 vCPU |
| **Network** | Public IPv4, ports 80/443/22 open | Same |

If RAM ≤ 1 GB, add a swap file before deploying — see `ec2-bootstrap.sh` for the snippet (`fallocate -l 1G /swapfile && ...`).

**Pre-installed software needed:**
- Docker Engine 20.10+
- Docker Compose plugin (v2)
- git
- curl

`ec2-bootstrap.sh` in this directory installs everything if you're starting from a vanilla Ubuntu box (paste it into "user data" at instance creation, OR run as root).

---

## 5. Deployment — step by step

### 5a. Get the code on the server

```bash
# Either git clone (if you have a remote)
sudo mkdir -p /opt/servd && sudo chown $USER /opt/servd
cd /opt/servd
git clone <your-remote-url> .

# OR scp the tarball up (no git needed)
# From your laptop:
#   tar czf servd.tgz --exclude=node_modules --exclude=.next --exclude=.turbo --exclude=dist --exclude=.git -C c:/Dev servd
#   scp servd.tgz user@server:/tmp/
# Then on the server:
#   sudo mkdir -p /opt/servd && sudo chown $USER /opt/servd
#   tar xzf /tmp/servd.tgz -C /opt
```

### 5b. Configure environment

```bash
cd /opt/servd/infra

# Backend env (runtime):
cp .env.production.example .env.production
nano .env.production
# REGENERATE JWT secrets:  openssl rand -base64 48   (do it twice)
# Fill in: R2_*, SMTP_PASS (Resend key), API_URL/WEB_URL/STOREFRONT_URL (your domain)

# Compose-level env (build args for Next.js):
cp .env.example .env
nano .env
# Set PUBLIC_API_URL, PUBLIC_WS_URL to your domain (e.g. https://api.your.domain)
# Optionally set SENTRY_DSN_ADMIN and SENTRY_DSN_STOREFRONT

# Caddy site definitions:
nano Caddyfile
# Replace api.servd.pk / admin.servd.pk / app.servd.pk with your real domains
```

### 5c. DNS

Point three A records at the server's public IP:
```
A  api    → <server IP>   (DNS-only, NOT proxied if using Cloudflare)
A  admin  → <server IP>
A  app    → <server IP>
```

> ⚠️ If using Cloudflare DNS: set the records to **DNS only (grey cloud)** for the initial cert issuance. Caddy needs port 80 unproxied for the Let's Encrypt HTTP-01 challenge. After certs are issued you can flip to Proxied if you want.

Verify with `dig +short api.your.domain` from anywhere — must return the server IP within a minute.

### 5d. Bring it up

```bash
cd /opt/servd/infra
docker compose up -d --build

# Watch the API boot — runs `prisma migrate deploy` then starts Fastify
docker compose logs -f api

# Watch caddy issue certs (first run only, ~30 sec each subdomain)
docker compose logs -f caddy
```

You'll know it's healthy when:
- `curl -I https://api.your.domain/health` returns `HTTP/2 200`
- `curl -I https://admin.your.domain` returns `HTTP/2 200`
- `curl -I https://app.your.domain` returns `HTTP/2 200`

### 5e. Seed demo data (optional but recommended for first-time testing)

```bash
docker compose exec api npm run seed:customer
```

Creates 4 demo customers (`demo.power@servd.pk`, `demo.new@`, `demo.lapsed@`, `demo.resolver@`) so the storefront `/account` page is never empty during testing.

### 5f. Create the first admin user

The schema seeds with no staff. To create one:

```bash
docker compose exec api npx tsx scripts/create-admin.ts
# OR run the existing seed:
docker compose exec api npm run db:seed
```

(If `scripts/create-admin.ts` doesn't exist, the main seed `prisma/seed.ts` creates a default admin.)

Login at `https://admin.your.domain`.

---

## 6. Mobile app deployment (separate from docker)

The mobile app at `mobile/` (inside this repo) is **Expo / React Native**. It does NOT deploy via docker. Two options:

### Option A — Expo Go (testing, no app store)
- Customer installs Expo Go from app store
- Run `npx expo start --tunnel` from the mobile project
- Customer scans QR
- App runs in Expo Go shell

Good for internal testing right now — your kitchen staff can install Expo Go and test against your live API in 5 minutes.

### Option B — EAS Build (real app store builds)
- Sign up at expo.dev (free for hobby tier)
- `npm install -g eas-cli`
- `eas login` then `eas build:configure`
- `eas build --platform ios` and `eas build --platform android`
- Submit to App Store Connect / Google Play Console

**Before either option:** edit `mobile/app.json` → `extra.apiUrl` to point at your production backend (`https://api.your.domain`).

---

## 7. Day-2 operations

### Update deployed code

```bash
cd /opt/servd
git pull           # or scp the new tarball up
cd infra
docker compose up -d --build
# Migrations run automatically on api container start
```

### View logs

```bash
docker compose logs -f api          # backend
docker compose logs -f admin        # staff dashboard
docker compose logs -f storefront   # customer site
docker compose logs -f caddy        # TLS / reverse proxy
docker compose logs -f redis
```

### Restart a single service

```bash
docker compose restart api
```

### Manual database access

```bash
docker compose exec api npx prisma studio
# Tunnel port 5555 to your laptop:  ssh -L 5555:localhost:5555 user@server
# Open http://localhost:5555 in your browser
```

### Backup Redis

```bash
docker compose exec redis redis-cli BGSAVE
# Files land in the named volume `redis_data` — back that up periodically
```

### Disk + memory check

```bash
df -h
free -h
docker system df
docker stats
```

---

## 8. What's already built (for context)

If you're curious what you're shipping:

- **50+ admin modules** — POS, KDS, accounting, payroll, inventory, finance, CRM, complaints, reviews, reservations, scheduling, supplier chat, content calendar, etc.
- **Customer storefront** — 7 brand microsites + cross-brand cart + checkout + reservations + post-order rating + loyalty + favorites + NPS feedback widget
- **Race-proof reservations** — postgres exclusion constraint prevents double-booking at the DB layer
- **8 lifecycle workers** — birthday, winback, welcome, complaint follow-up, spend milestones, etc. (run hourly)
- **Real-time websocket sync** — admins see new bookings/orders flash in instantly
- **Cross-module customer rollups** — `noShowCount`, `complaintCount`, `avgReviewRating`, `lastVisitAt` denormalized on Customer for fast host-stand views

Smoke test (`npm run --prefix backend smoke`) currently passes 27/27 against the local DB.

Test files at `backend/tests/` cover the high-leverage invariants (orders, loyalty, customer rollups, reservations exclusion). Run with `TEST_DATABASE_URL=... npm test --prefix backend`.

---

## 9. Files in this directory

| File | Purpose |
|---|---|
| **`DEV-HANDOFF.md`** | This file — read first |
| `docker-compose.yml` | The 5-service orchestration |
| `Caddyfile` | TLS + reverse proxy config (3 subdomains) |
| `.env.example` | Compose-level env (build args) — copy to `.env` |
| `.env.production.example` | Backend runtime env — copy to `.env.production` |
| `ec2-bootstrap.sh` | One-shot Ubuntu installer (Docker + git + swap). Idempotent. |
| `boot.sh` | Helper: extract tarball + build + up |
| `BABY-STEPS.md` | Older click-by-click for AWS console (ignore unless deploying to AWS) |
| `DEPLOY.md` | Older long-form runbook |
| `main.tf` / `*.tfvars.example` | Pre-existing Terraform setup (separate path, ignore unless using IaC) |

---

## 10. Common issues + fixes

**"Cannot reach database server" on first boot**
Neon free tier sleeps when idle. The Docker container retries automatically. Wait 10s, check logs again.

**Caddy can't get a cert**
- DNS not propagated — `dig +short api.your.domain` should print the server IP
- Cloudflare DNS is **Proxied** (orange cloud) — set to **DNS only** (grey)
- Port 80 not reachable from internet — check firewall / security group

**`docker compose build` fails on `npm ci`**
Network issue inside the container. `docker compose build --no-cache api` to force a clean retry.

**Workers logging "out of limit"**
That's the old Upstash Redis warning — should not happen now since Redis is self-hosted in the docker network. If it does, confirm `REDIS_URL` inside the container:
```bash
docker compose exec api printenv REDIS_URL
# Should print: redis://redis:6379
```

**Site loads but API calls fail with CORS errors**
Origin not in allowlist. Add it to `BRAND_HOSTS` env in `.env.production` and `docker compose restart api`.

**Want to disable a flaky worker temporarily**
Set `ENABLE_WORKERS=false` in `.env.production`, `docker compose restart api`. The HTTP API keeps running.

---

## 11. Contact / questions

- All code commentary is inline in the source — search for `// ──` headers
- Schema is at `backend/prisma/schema.prisma`
- Memory of decisions is at `c:/Users/agari/.claude/projects/c--Dev/memory/` on the original dev's machine

Good luck. Ship it.
