# CLAUDE.md — Context for future Claude Code sessions

This file is read automatically by Claude Code when working on this repo.
It captures the deploy flow, common pitfalls, and project conventions
that aren't obvious from the code itself.

## ⚠️ Standing rule: flag duplicates BEFORE building (product owner, 2026-09-25)

Many module bugs came from a new build duplicating something an older build
already had (two payrolls, two P&Ls, two refund engines, two period-lock
paths…), leaving two sources of truth that disagree. So:

- **Before building any feature, module, page, model or route, search for an
  existing one that does the same job** (grep routes, Prisma models, admin
  pages, `lib/moduleCatalog.ts`, the sidebar in `components/ui/AppShell.tsx`).
- **If one exists, STOP and flag it to the owner before writing code**: say
  what already exists (paths), how it overlaps, and the options (extend the
  old one / replace it and remove the old one / keep both and why). Let the
  owner decide the reconciliation at that moment — do not silently build a
  second one.
- When a replacement is agreed, the old one is removed in the same piece of
  work (API, pages, sidebar links, catalogue entries), with anything it fed
  (ledger postings, reports, dashboards) moved to the new one first. Keep the
  old tables unless the owner says to drop the data.

## ⚠️ Standing rule: every new line of code follows company separation (product owner, 2026-09-28)

servd runs several companies (tenants) side by side. Company separation was
retrofitted across 683 routes once; it must never need doing again. Every new
model, route, worker, report, socket room, upload or admin page is
company-scoped FROM THE FIRST COMMIT — not "added later":

- **Models:** a new table that holds company data gets `tenantId` (indexed).
  Unique keys are per company (`@@unique([tenantId, …])`), never global.
  "Global"/singleton rows are one per company. Only genuinely shared
  platform data (e.g. the `servd:*` storefront pages) may have a null
  tenant, and that must be deliberate and commented.
- **Routes:** use `lib/tenantScope.ts` — `scopeTenantWhere(req, mode)`,
  `assertConceptOwned`, `conceptIdsInScope`, `conceptWhere`,
  `activeTenantId`. `read` for lists, `write` for editing an existing row,
  `create` for binding a new row to the ACTIVE company. Never trust an id
  from the client (`conceptId`, `locationId`, `shiftId`, `supplierId`, …):
  resolve it to its company first. Foreign rows → 404; cross-company
  attach on create → 422. Never `tenantFilter ?? undefined` (that is "no
  filter"); an empty scope must DENY (`{ tenantId: { in: [] } }`).
- **Money:** ledger postings take the company from the source document
  (`postJournalEntry` requires `tenantId`); reports take
  `resolveTenantScope(req)`.
- **Workers, sockets, notifications:** loop per company; socket rooms are
  per company; messages and webhooks fan out only to the owning company.
- **Customer-facing:** gift cards, loyalty, promos, bans and segments stay
  inside the company that issued them.
- **Tests:** every new route ships with a two-company test — company B gets
  404 on company A's rows, and creates bind to the active company.

A change that skips any of this is not done, however well the feature works.

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
    payroll/procurement/reconciliation/gift-cards prefixes and the HR back
    office (`/hr/employees`, `/hr/payroll`, … — not the ESS/HOD paths).
    Role→module defaults live ONLY in `moduleAccess.ts`; the admin reads them
    (and the role lists from `lib/roles.ts`) from `GET /permissions/role-modules`,
    and the signed-in user's effective modules from `GET /permissions/me`.
    The per-action permission matrix (`/configuration/roles`) is gone
    (decision 34); `User.conceptIds` is no longer read (decision 35).
  - Tenant scoping in `/reports/*`, `/management/*`, and accounting P&L is
    done (all queries filter via `req.staffUser.tenantFilter`;
    menu-engineering + demand-forecast validate `conceptId` ownership).
  - Storefront lockfile drift resolved (`three`/`framer-motion` are in
    `package-lock.json`).
  - Aggregator code (Foodpanda/Careem adapters, `FoodpandaSettlement`) is
    fully removed; only historical comments remain.
- **Locations are company master data (2026-09-07).** `Location.tenantId` is
  set on every row (migration `20260907120000_location_tenant_scope` backfills
  from linked brands and drops cross-company brand links). `/locations` reads
  are scoped via `resolveTenantScope`, writes pin to the active company, and a
  location may only link brands of its own company (`BRAND_NOT_IN_COMPANY`).
  There is no boot-time PIN reconcile any more — staff choose their own PIN.
- **Company-scope rules for every route (2026-09-07 sweep).** Helpers live in
  `backend/src/lib/tenantScope.ts`: `scopeTenantWhere(req, mode)`,
  `assertConceptOwned(req, conceptId, mode)`, `conceptIdsInScope(req, mode)`,
  `conceptWhere(req, conceptId?, mode)`. Modes: `read` = view-aware (portfolio
  header expands), `write` = editing an existing row → every company the
  operator belongs to, `create` = binding a new row → the ACTIVE company only.
  Never trust a client `conceptId`/`tableId`/`floorId`/`stationId`/`shiftId`/
  `locationId`; resolve it through the owning brand's `tenantId` first. Foreign
  rows are 404, cross-company attaches on create are 422. WebSocket fan-out is
  per company (`tenant:{id}:orders`, `tenant:{id}:reservations`); `station:` /
  `concept:` rooms are ownership-checked at join. `bank_accounts`,
  `modifier_templates`, `webhook_subscriptions` and the four singleton config
  tables carry `tenantId` (migration `20260907130000`); singleton "global"
  rows are one per company.
  `delivery_zones`, `notification_templates`, `scheduled_reports`,
  `custom_field_definitions` and `shifts` carry `tenantId` too (migration
  `20260907140000`) — "All brands" rows are the owning company's defaults,
  never shared. `lib/setup-config.ts` readers take a `tenantId`
  (`tenantForConcept()` / `primaryTenantId()` resolve it); never read a
  company-less singleton row.
- **The ledger is per company (2026-09-08).** Migration `20260908120000`:
  `accounts.code` is unique per company (`@@unique([tenantId, code])`, not
  globally), and `journal_entries` / `period_locks` carry `tenantId`.
  `postJournalEntry` REQUIRES `tenantId` — resolve it from the source document
  (order → concept.tenantId, shift → shift.tenantId, bill → supplier.tenantId,
  manual entry → the operator's active company); account codes resolve inside
  that company's chart, the period-lock check reads that company's close, and
  the entry is stamped with it. `reverseJournalEntry(tenantId, …)` likewise.
  Every report (trial balance, balance sheet, P&L, cash flow, GL, labour %)
  takes `tenantIds: string[]` from `resolveTenantScope(req)`; the sales-tax
  return takes a single company. New companies get a chart automatically:
  `lib/chartOfAccounts.ts` holds the canonical list and `ensureChartOfAccounts`
  runs at boot for every company (and only adds codes that are missing, so
  operator edits survive). `/health` checks the required codes per company.

## Workspaces — servd is organised by owner (2026-10-04, owner decision 47)

Five workspaces replace the old 18-module catalogue: **Operations** (the CEO —
all BOH and FOH, menu, stock, buying, the till, company setup), **Finance**,
**Marketing**, **HR**, **Dev** (IT role `it` — integrations, backups,
webhooks, the user audit log). `backend/src/lib/workspaces.ts` is the ONE
definition (sections, module ids, owner/member roles, `childRoles`); every
module id belongs to exactly one workspace (tested). The admin sidebar,
`/w/<id>` homes and `/modules` read it from `GET /permissions/me` /
`GET /permissions/workspaces` — never keep a copy in the frontend. A new
module id must be placed in a workspace in the same change.

- **Team = the HR reporting line** (`HrEmployee.managerId`). `GET /hr/team`
  returns the whole tree under the caller. Don't build another hierarchy.
- **Owners add logins only for roles under them** (`childRoles`;
  `POST /auth/staff/invite`), always `pending` until the CEO approves on
  /workforce. The CEO's own `POST /auth/users` needs no approval.
- **User audit log** (`/configuration/audit-log`, module `audit_log`):
  identity trail incl. `auth.login`, `auth.login_failed`, `auth.otp_login`,
  `auth.2fa_failed`, `auth.logout`. The books' trail
  (`/accounting/audit-log`) stays CEO + management only.

## Storefront content module (2026-09-28, owner decision 41)

**Admin → Storefront (`/storefront`) is the ONLY place storefront content is
edited.** It replaced Visual Layout (`Concept.storefrontLayout`, no longer
read), the Content editor (`/content`), `/storefront-hero`,
`/storefront-footer` and the `/media` page (now the Library tab). Tabs: Pages
(page builder, drag-and-drop elements incl. columns/video), Pop-ups (a page +
display rules), Library (`MediaAsset` kinds image/video/font/copy), Approvals.

- Everything is a `SiteLayout` row keyed by slug: `servd:home`, `servd:hero`,
  `brand:<slug>`, `brand:<slug>:footer`, `page:<slug>` (served at
  `/pages/<slug>`), `popup:<key>`. `blocks`/`settings` are LIVE;
  `draftBlocks`/`draftSettings` are the working copy.
- **Nothing publishes without the CEO (role `admin`).** Draft → submit →
  approve (now, or "publish at" → `scheduled`, published by the
  `sitePublish` worker or lazily on the next public read) / reject with a
  note. Every publish writes a `SiteLayoutVersion`; rollback republishes an
  old version as a new one. There is no publish-on-save endpoint — don't add
  one. Drafting needs module `storefront`.
- A/B: `settings.ab = { splitPct, blocks }`; the visitor's variant is a hash of
  the `sv_vid` cookie + slug + version; `SiteLayoutStat` counts views and
  conversions (first click inside the page / pop-up submit).
- The `signature` element renders the page's built-in design (the bespoke
  brand layout, or HomeClient on home), so the owner can build around it.
- The mobile app renders the same block JSON natively
  (`mobile/src/content/`). Keep the block schema in step across
  `frontend/storefront/src/lib/blocks.ts`, `frontend/admin/src/lib/blocks.ts`
  and `mobile/src/content/types.ts`.

## Recent additions (2026-09-09)

- **`stackd` (formerly `stax`) is a café and market, NOT a burger brand.**
  A 20-seat scratch-cooking café doing sandwiches, pastries, light bites and
  craft mocktails, with a small market integrated into the cashier/barista bar
  (display chiller for grab-and-go + drinks, case for pastries). Its signature
  is that **packaging is the service vessel, not plates** — branded vessels
  built per menu item, not disposables. Any "smash burger / dry-aged / brioche"
  copy is stale and wrong; that is Flipd's territory. Storefront copy lives in
  `BRAND_STORIES` in `frontend/storefront/src/lib/concept.ts`, but the
  **`description` shown in page titles, JSON-LD and cross-brand cards comes
  from the DB `Concept.description`** — edit it in admin → Marketing → Brands,
  not in code (the code string is only an API-down fallback).

  Palette is Pantone 19-2025 Red Plum (`#7C2946`) + Pantone 9180 cream
  (`#FCE8CE`), with Pantone 635 pale blue (`#9BD3DD`) as a single cool accent.
  Tokens are `--stackd-*` in `globals.css`; the layout is `StackdLayout.tsx`.
  The hero uses the real wordmark asset
  (`/brand/stackd-wordmark-tagline.png`, cream on transparent), not a webfont.
  The hand-drawn mascot (`/brand/stackd-mascot.png`) gets its own full band —
  he goes on the cups, wrappers and pastry bags, so he is shown at size, never
  as a corner thumbnail. Cards are **stickers**, never rectangles: rounded
  lozenges in cream/butter/sky, set slightly off-square. **No grid anywhere** —
  the blueprint grid was a stax hangover and is gone.

  Lowercase everywhere user-visible — capital-S "Stackd" is a bug, same rule as
  simmer. Both brands are in `LOWERCASE_BRANDS` and every user-visible name
  must go through `formatBrandName()`; hardcoding the string bypasses the rule,
  which is how it regressed once already. `/stax*` paths redirect permanently.
  **Not renamed:** `stax-padel` (separate padel business, and it IS a burger
  concept) and the registered domain `eatstax.com` (which now maps to the
  `stackd` slug).

- **Staff 2FA over WhatsApp OTP.** `POST /auth/login` returns
  `{ twoFactorRequired, challengeToken, phoneHint }` instead of a session when
  the account is enrolled; `POST /auth/2fa/verify` trades the challenge + code
  for tokens. Enrol via `/auth/2fa/start` then `/auth/2fa/enable` (two steps so
  a mistyped number can't lock anyone out); `/auth/2fa/disable` requires the
  password. **2FA is per-account, never by role** — enforcing by role would
  lock out every owner on deploy. The challenge is a `type: 'mfa'` JWT and is
  rejected everywhere an access token is expected.

- **The login rate limiter no longer fails open.** It falls back to per-process
  in-memory counters when Redis is unreachable, and `/health` reports
  `loginRateLimit: warn`. Anything on a request path that must degrade rather
  than block should use the `redisFast` connection from `lib/redis.ts` — the
  shared `redis` client carries BullMQ's `maxRetriesPerRequest: null`, so a
  command issued while Redis is down never rejects, it hangs forever.

- **Customer order rollups are written now.** `firstOrderAt`, `lastOrderAt` and
  `totalSpentCents` were read all over the system and written by nothing, so
  referral rewards never paid out, the first-order welcome never fired, the
  "place your first order" nag targeted everyone forever, and the lapsed CRM
  segments were always empty. `recomputeCustomerRollups` computes them from
  completed orders. **Any new path that completes an order must call
  `bumpCustomerRollups`** — the POS till didn't, which was most orders.

- **Referral payouts are guarded**: the referee's phone must be verified, the
  first order must be at least PKR 500, and a referrer is capped at 10 payouts
  per 30 days. Held-back referrals stay unstamped so they can pay later.

- **Zero known dependency vulnerabilities.** The API is on Fastify 5. Don't
  re-add `@fastify/jwt` (auth uses `jsonwebtoken`), `@fastify/multipart`
  (uploads go via the S3 presigner) or `@fastify/websocket` (realtime is
  socket.io) — they were removed as unused, and `@fastify/jwt` was the source
  of the one critical finding.

- **The public storefront spans companies.** `/storefront/concepts` returns
  every company's brands and now includes `tenantId`. Anything that claims
  brands are related ("same kitchen group", shared cart) must filter on it.

## Second-pass audit findings, all fixed (2026-09-09)

31 findings, adversarially verified, then fixed and tested. The patterns worth
remembering, because most of them recurred:

- **A guard that never ran.** `type: 'reversal' as never` — the enum value did
  not exist, Postgres rejected the insert, and the shared transaction rolled the
  whole claw-back back. Refunds had never reversed a loyalty point. **An `as
  never` or `as unknown` cast on a DB write is a bug until proven otherwise.**
- **A comment describing a flag that was never added.** The gift-card refund
  said it was idempotent "on a flag we add (reversedAt)"; the column did not
  exist and the code re-credited unconditionally. Both `GiftCardRedemption` and
  `LoyaltyTransaction` now really carry `reversedAt`, claimed before the money
  moves.
- **Money applied to the order before the money was taken.** Checkout discounted
  the order, created it, then tried the deduction — and on failure only zeroed
  local variables. Restore the ORDER (and the pending payment), the way the
  wallet path does. Gift cards had the mirror bug: card drained, bill unchanged.
- **Idempotency keyed on the wrong thing.** Per order rather than per
  transaction (loyalty reversal), or a server-generated `Date.now()` used as an
  external id — two checkouts in the same millisecond deduped onto ONE order, so
  a customer got a stranger's order back. Storefront order ids are UUIDs now.
- **Unauthenticated endpoints that send messages.** Public booking, and
  `/cart/abandon`, both accepted an attacker-chosen phone/email and later texted
  or emailed it on GS Foods' account. Contact details must come from the
  session; cap per phone, not per IP.
- **Scope helpers that fail open.** `tenantId: (tenantFilter ?? undefined)` is
  "no filter" in Prisma. Always use `lib/tenantScope.ts`, which returns
  `{ tenantId: { in: [] } }` and denies. Staff CAN have a null tenant.
- **Fallbacks OR'd instead of chained.** `{ OR: [where, {location: where},
  {user: where}] }` let a cashier's other company override the shift's own
  company. A fallback for legacy rows must be gated on the real column being
  NULL.
- **One-sided journal lines.** The cash-variance line had no counterpart, so any
  drawer that didn't reconcile made the entry unbalanced, `postJournalEntry`
  threw, the caller logged it, and the ENTIRE shift never reached the ledger.
  Assert debits == credits before posting, and log the source id when it fails.
- **GST.** `Order.taxCents` was never written by `ingestOrder`, so storefront
  GST filed as zero. Group orders billed the legacy `concept.taxRate` (17%)
  instead of the tender split (`taxRateCash` 15% / `taxRateCard` 8%). Both
  fixed — never use `concept.taxRate` in new code.

Regression suites live in the session scratchpad, not the repo: login/smoke,
2FA, rate limiter, reservations, group orders, referrals, and five audit
batches. Reproduce them against a local Postgres + Redis before touching auth,
checkout or the ledger.

## What this is

`servd` is the in-house restaurant management system for **GS Foods** — a
Karachi-based multi-brand F&B operator running three live consumer brands
(Simmer, Stax, Flipd). The repo is a monorepo with:

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
| `GOOGLE_MAPS_API_KEY` | (optional) Maps JavaScript API key — switches the admin location pin picker from OpenStreetMap to Google tiles. Public/build-time: restrict it to the admin origin in Google Cloud. Without it the picker still works (OSM tiles + paste-a-Maps-link resolver). | `AIza…` |

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

- **simmer** — Night-mode editorial (forest green "tiber" `#06392F` + bone
  `#EDE6D3` + fiery orange `#E94E1B`).
  Bound to the canonical `simmer-brand` SKILL.md: lowercase wordmark,
  Amarante + Times, no white, no gradients, no exclamation marks,
  no emojis, banned-word list, single orange signal per viewport,
  tagline `simmer down.` always below the wordmark, never above.
- **stackd** — Industrial plum (Pantone 19-2025 Red Plum `#7C2946` + Pantone
  9180 cream `#FCE8CE`, Pantone 635 `#9BD3DD` as the one cool accent). Was
  "stax" / navy-grey; see the 2026-09-09 note above.
- **flipd** — Cool diner (curious blue `#2092E9` + bone `#EDE6D3` + midnight-oil ink `#090D17`)

CSS tokens for all three are defined in
`frontend/storefront/src/app/globals.css` under `:root` (search
`--simmer-*`, `--stackd-*`, `--flipd-*`).

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

## Claude Code operating policy — model routing & parallel agents

Per the product owner (2026-09-27): optimize for **speed AND efficiency
together**. Claude decides the split — route each unit of work to the
cheapest model that will do it right the first time, and spawn as many
parallel subagents as the task genuinely benefits from. Do not ask
permission to parallelize; do not serialize work that is independent.

### Model routing

The main session runs on **Fable** and stays the orchestrator: it owns
design and architecture decisions, cross-cutting integration, the final
review, and it personally handles anything correctness-critical —
payments, FBR/SRB tax submission, auth/permissions, RLS/tenant
isolation, order money math.

**Subagents run on Opus 5.5 (product owner, 2026-09-27, revised the same
day).** Pass `model: "opus"` on every Agent call — no tiering to sonnet or
haiku, and no Fable for agents (tried it for a day; the owner prefers Opus).
The main session runs on whatever the owner sets with `/model`.

### Parallel agents

- Fan out independent work — per-module, per-page, per-brand — as
  multiple Agent calls in a **single message** so they run concurrently.
  No fixed cap on agent count; use as many as the work decomposes into.
- Give each agent a **disjoint file set**. Two agents must never edit
  the same file; shared files (globals.css, schema.prisma, index.ts
  registrations) are integrated by the orchestrator afterward.
- Agents run in the background by default — keep working while they do.
  Reuse a finished agent via SendMessage instead of re-briefing a new one.
- Keep serial what is serial: design decisions, schema changes, and ONE
  verification pass (typecheck → build → screenshots) run by the
  orchestrator after merging agent output. Agents do not run builds or
  dev servers — a prod build and the dev server share `.next/` and
  clobber each other (this has bitten us).
- Don't spawn an agent for what a single tool call does; batch
  independent tool calls in one message instead.
- The orchestrator spot-checks all agent output on the critical path;
  verification of money/tax/auth code is never delegated below `opus`.

## What NOT to do

- **Never commit credentials to this repo.** Use GitHub Actions Secrets.
- **Never `git push --force` to main.**
- **Work directly on `main` — no feature branches, no PRs.** Per the product
  owner: commit and push straight to `main`. Do not create a branch "to be
  safe" and do not open a pull request unless explicitly asked. (Ordinary
  non-force pushes to `main` are the expected workflow here.)
- **Never add a third-party delivery aggregator integration.**
- **Never bypass the simmer-brand SKILL.md rules** on the Simmer
  microsite — see `frontend/storefront/src/components/brand/layouts/SimmerLayout.tsx`
  for the enforced version. Capital `S` in "Simmer" anywhere user-visible
  is a bug.
- **Never use emoji as structural icons** in storefront UI. SVG or text
  labels only.
