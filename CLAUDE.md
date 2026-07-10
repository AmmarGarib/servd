# CLAUDE.md — Context for future Claude Code sessions

This file is read automatically by Claude Code when working on this repo.
It captures the deploy flow, common pitfalls, and project conventions
that aren't obvious from the code itself.

## ⚠️ Corrections (2026-06-11 audit) — read before trusting older sections

Parts of this file have drifted from reality. Until the relevant sections are
rewritten, trust these corrections:

- **Storefront visual migration is DONE**, not "in progress." The legacy
  "premium" system (`#00D4B1` teal → `#6366F1` indigo, `#18160f` ink,
  `PremiumInput`) is fully removed from `frontend/storefront/src`. The whole
  storefront is on `--servd-*` tokens. **The servd storefront brand is
  "obsidian plum" (`#4E2A4F` plum / `#2D1E2F` obsidian)** — note `--servd-green`
  holds this plum value (legacy var name). The admin app is still teal→indigo.
- **The three "404 routes" are fixed** (`/<concept>/menu`, `/<concept>/order`,
  `/reserve` all exist/redirect).
- **Deploy reality is unsettled.** A `.github/workflows/build-and-push.yml` and
  a `deploy/` dir both exist, but the in-repo `deploy/webhook-server.js` builds
  from source on the box while observed prod deploys this cycle updated purely
  via Docker Hub image pushes (`ammargarib/servd:{api,admin,storefront}`) +
  the webhook. Treat the deploy mechanism as "verify against the box," not as
  documented below.
- **Stax** brand palette is a cool **navy-grey** set (oceanic noir `#142834`
  base + greys: astroscopus `#B0B2B8`, tulle `#8D8F97`, adept `#293B47`).
- **All audit risks are now closed (2026-07-06 sweep):**
  - Role/module permissions are server-enforced: `RoleModuleAccess` model +
    `GET/PUT /permissions/role-modules`, enforced in the auth middleware
    (`backend/src/lib/moduleAccess.ts`) on the finance/reports/management/
    payroll/procurement/reconciliation/gift-cards prefixes. Role→module
    defaults are duplicated in `moduleAccess.ts` and
    `frontend/admin/src/lib/appRoles.ts` — keep them in sync.
  - Tenant scoping in `/reports/*`, `/management/*`, and accounting P&L is
    done (all queries filter via `req.staffUser.tenantFilter`;
    menu-engineering + demand-forecast validate `conceptId` ownership).
  - Storefront lockfile drift resolved (`three`/`framer-motion` are in
    `package-lock.json`).
  - Aggregator code (Foodpanda/Careem adapters, `FoodpandaSettlement`) is
    fully removed; only historical comments remain.

## What this is

`servd` is the in-house restaurant management system for **GS Foods** — a
Karachi-based multi-brand F&B operator running two live consumer brands
(Stax, Flipd). The Simmer brand was retired on 2026-07-09: all Simmer-specific
code was removed and the concept is hidden (isActive/storefrontVisible=false);
its historical data (orders, menu, revenue account 4001) is preserved in the
DB for reporting. Do NOT reintroduce Simmer-specific code. The repo is a
monorepo with:

- `backend/` — Fastify + Prisma API
- `frontend/storefront/` — Next.js consumer ordering site (`servd-app.garibsons.app`)
- `frontend/admin/` — Next.js operator UI (`servd-admin.garibsons.app`)
- `tablet/` — Expo tablet app for in-restaurant ops
- `mobile/` — Expo customer mobile app (not yet shipped to stores)
- `packages/types/` — shared TypeScript types
- `infra/` — EC2-based deploy compose (alternate path, not currently used in prod)
- `deploy/` — Windows-based prod deploy with webhook server + Cloudflare Tunnel

## Production deploy flow — important

**Production runs prebuilt Docker Hub images, not source builds.** Images
live at:

- `ammargarib/servd:storefront`
- `ammargarib/servd:admin`
- `ammargarib/servd:api`

The Windows production box runs `docker compose pull && docker compose up -d`
against a compose file that uses `image:` references (not `build:`). So:

**A `git push` to `main` does NOT deploy by itself.** New images must be
built and pushed to Docker Hub first, then the box pulls them.

### The automated flow (after first-time secret setup)

`.github/workflows/build-and-push.yml` handles this automatically:

1. On merge to `main`, GitHub Actions builds all three images
2. Pushes them to Docker Hub
3. Triggers the deploy webhook at `https://servd-deploy.garibsons.app/deploy?secret=...`
4. The webhook runs `docker compose pull && docker compose up -d` on the box

### Required GitHub repo secrets

Settings → Secrets and variables → Actions:

| Secret | What | Example |
|---|---|---|
| `DOCKERHUB_USERNAME` | Docker Hub username | `ammargarib` |
| `DOCKERHUB_TOKEN` | Personal access token (NOT password) — generate at https://app.docker.com/settings/personal-access-tokens with Read/Write scope | `dckr_pat_xxxxx` |
| `DEPLOY_WEBHOOK_URL` | Full deploy webhook URL including `?secret=` | `https://servd-deploy.garibsons.app/deploy?secret=23f4...` |
| `PUBLIC_API_URL` | Public API hostname baked into client bundles | `https://servd-api.garibsons.app` |
| `PUBLIC_WS_URL` | Public WebSocket URL | `wss://servd-api.garibsons.app` |
| `SENTRY_DSN_STOREFRONT` | (optional) Sentry DSN for storefront | |
| `SENTRY_DSN_ADMIN` | (optional) Sentry DSN for admin | |

### Manual fallback

If CI is broken or you need to push out of band:

```bash
docker login -u <username>                            # use a PAT, not password
docker build -t ammargarib/servd:storefront \
  --build-arg NEXT_PUBLIC_API_URL=https://servd-api.garibsons.app \
  --build-arg NEXT_PUBLIC_WS_URL=wss://servd-api.garibsons.app \
  frontend/storefront/
docker push ammargarib/servd:storefront
# Then trigger the box to pull:
curl -X POST 'https://servd-deploy.garibsons.app/deploy?secret=...'
```

## Public URLs

| Surface | URL |
|---|---|
| Consumer storefront | https://servd-app.garibsons.app |
| Operator admin | https://servd-admin.garibsons.app |
| API | https://servd-api.garibsons.app |
| Deploy webhook | https://servd-deploy.garibsons.app/deploy?secret=... |
| Deploy health | https://servd-deploy.garibsons.app/health |

## Key conventions

### Brand microsite design system

Per-brand pages at `/brand/<slug>` use `BRAND_ACCENT_OVERRIDES` in
`frontend/storefront/src/lib/concept.ts` — this lets a brand run its own
visual language without depending on the DB `primaryColor` field.

Brand-specific layouts in `frontend/storefront/src/components/brand/layouts/`
are switched on in `BrandFallback.tsx`. Live brands:

- **stax** — Industrial navy-grey (oceanic noir `#142834` + greys, palettepoint set)
- **flipd** — Cool diner (curious blue `#2092E9` + bone `#EDE6D3` + midnight-oil ink `#090D17`)

CSS tokens for the brands are defined in
`frontend/storefront/src/app/globals.css` under `:root` (search
`--stax-*`, `--flipd-*`).

### Two visual systems exist in the storefront

- **New system (preferred):** `--servd-*` tokens + Bricolage Grotesque
  display. Used on home, browse, brand pages, orders list, group-order,
  reserve.
- **Legacy "premium" system:** hardcoded `#00D4B1` teal → `#6366F1`
  indigo gradients, warm `#c1bfbb` header, `#18160f` ink, emoji icons,
  `PremiumInput`/`PremiumTextarea` helpers. Still on `/checkout`,
  `/login`, `/signup`, `/account`, `/[concept]/order/[id]`.
  **Migrating these to the new system is in-progress.**

When restyling: replace `#18160f` → `var(--servd-ink)`, `rgba(24,22,15,X)`
→ `var(--servd-mute)`, `#00D4B1` and `#6366F1` → `var(--servd-green)`,
emoji structural icons → SVG or text labels.

### Fetch caching gotcha

Server-side fetches in App Router with `next: { revalidate: N }` will
cache a failed result if the API is down when the first request hits.
That cache survives indefinitely and breaks the page until container
restart. For low-traffic surfaces (brand pages, browse), prefer
`export const dynamic = 'force-dynamic'` + `cache: 'no-store'`.

### Routes that don't exist (404)

These are linked from other pages but the route file hasn't been
created yet:

- `/<concept>/menu` — link target from `/brand/<slug>/menu` and elsewhere
- `/<concept>/order` (the index, not `/[id]`)
- `/reserve` (index — only `/reserve/<slug>` exists)

### Aggregator removal — DO NOT add new third-party delivery code

Per product owner: servd will never use Foodpanda, Careem, Uber Eats,
DoorDash, or any other third-party delivery aggregator. The remaining
references in the codebase (`backend/src/adapters/foodpanda/`,
`backend/src/adapters/careem/`, `FoodpandaSettlement` model, etc.)
are being removed. Do not add new aggregator integrations under any
circumstances. GS Foods will run their own delivery fleet.

### Own-fleet delivery — partially built

Schema + dispatch API + admin riders portal + tablet dispatch board +
customer live tracker all exist and work today. The biggest missing
piece is the **rider-facing mobile app** — the API expects POSTs from
riders but no app is wired to call it. Future work in this order:

1. Rider Expo app (auth, location ingest, OTP verify, accept jobs)
2. Earnings/payouts models + nightly payout worker + admin dashboard
3. KYC, push notifications, route optimization

## What NOT to do

- **Never commit credentials to this repo.** Use GitHub Actions Secrets.
- **Never `git push --force` to main.** Squash-merge PRs only.
- **Never add a third-party delivery aggregator integration.**
- **Never use emoji as structural icons** in storefront UI. SVG or text
  labels only.
