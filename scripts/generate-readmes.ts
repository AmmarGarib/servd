/**
 * Walk every directory in the repo and generate a README.md describing what
 * lives there. Uses lightweight heuristics on path + immediate file list so
 * each README has at least minimal context for a first-time reader.
 *
 * Skips: node_modules, .next, dist, .git, .turbo, coverage, _legacy, prisma/migrations.
 * Existing READMEs are preserved unless --force is passed.
 *
 * Run: tsx scripts/generate-readmes.ts [--force]
 */

import { readdir, stat, writeFile, readFile } from 'node:fs/promises'
import { join, basename, relative } from 'node:path'

const ROOT = 'c:/Dev/servd'
const FORCE = process.argv.includes('--force')

const EXCLUDED_DIRS = new Set([
  'node_modules', '.next', 'dist', '.git', '.turbo', 'coverage',
  '_legacy', 'migrations',  // migrations have generated SQL — no value adding READMEs
])

// Hand-curated descriptions for the directories that matter most.
// The script falls back to a heuristic for everything else.
const CURATED: Record<string, string> = {
  '': topLevelReadme(),
  'backend': backendReadme(),
  'backend/src': backendSrcReadme(),
  'backend/src/modules': modulesReadme(),
  'backend/src/lib': libReadme(),
  'backend/src/adapters': adaptersReadme(),
  'backend/src/workers': workersReadme(),
  'backend/prisma': prismaReadme(),
  'backend/scripts': backendScriptsReadme(),
  'backend/tests': testsReadme(),

  'frontend': frontendReadme(),
  'frontend/admin': adminReadme(),
  'frontend/admin/src': adminSrcReadme(),
  'frontend/admin/src/app': adminAppReadme(),
  'frontend/admin/src/app/configuration': configurationReadme(),
  'frontend/admin/src/components': componentsReadme(),
  'frontend/admin/src/hooks': hooksReadme(),
  'frontend/admin/src/lib': adminLibReadme(),
  'frontend/admin/src/store': storeReadme(),
  'frontend/admin/src/i18n': i18nReadme(),
  'frontend/admin/messages': messagesReadme(),
  'frontend/admin/public': publicReadme(),

  'frontend/storefront': storefrontReadme(),
  'frontend/storefront/src': storefrontSrcReadme(),
  'frontend/storefront/src/app': storefrontAppReadme(),
  'frontend/storefront/src/components': storefrontComponentsReadme(),

  'packages': packagesReadme(),
  'packages/types': typesReadme(),
  'infra': infraReadme(),
  'scripts': rootScriptsReadme(),
}

interface DirInfo {
  files: string[]
  subdirs: string[]
}

async function inspect(dir: string): Promise<DirInfo> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  const subdirs: string[] = []
  for (const e of entries) {
    if (EXCLUDED_DIRS.has(e.name)) continue
    if (e.isDirectory()) subdirs.push(e.name)
    else files.push(e.name)
  }
  files.sort()
  subdirs.sort()
  return { files, subdirs }
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true } catch { return false }
}

async function walkAndWrite(dir: string) {
  const rel = relative(ROOT, dir).replace(/\\/g, '/')
  const info = await inspect(dir)
  const readmePath = join(dir, 'README.md')

  const body = CURATED[rel] ?? autoReadme(rel, info)

  if (!FORCE && await exists(readmePath)) {
    // Don't overwrite existing READMEs (e.g. project-level docs)
    if (rel !== '') {
      console.log(`  ↪ skip ${rel}/README.md (exists, use --force)`)
    }
  } else {
    await writeFile(readmePath, body, 'utf-8')
    console.log(`  ✓ ${rel || '.'}/README.md`)
  }

  for (const sub of info.subdirs) {
    await walkAndWrite(join(dir, sub))
  }
}

// ─── Heuristic fallback for unrecognised directories ──────────────────────────

function autoReadme(rel: string, info: DirInfo): string {
  const name = rel === '' ? 'servd' : basename(rel)
  const titleParts = rel.split('/').filter(Boolean)
  const title = titleParts.length > 0 ? titleParts[titleParts.length - 1] : 'servd'

  const lines: string[] = []
  lines.push(`# ${title}`)
  lines.push('')
  lines.push(describePath(rel))
  lines.push('')

  if (info.files.length > 0) {
    lines.push('## Files')
    lines.push('')
    for (const f of info.files) {
      if (f === 'README.md') continue
      lines.push(`- \`${f}\` — ${describeFile(f, rel)}`)
    }
    lines.push('')
  }

  if (info.subdirs.length > 0) {
    lines.push('## Subdirectories')
    lines.push('')
    for (const d of info.subdirs) {
      lines.push(`- [\`${d}/\`](./${d}/) — ${describeSubdir(d, rel)}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

function describePath(rel: string): string {
  if (rel.startsWith('backend/src/modules/')) {
    const mod = basename(rel)
    return `Backend module: **${mod}**. HTTP routes + business logic for the ${humanise(mod)} domain. Registered into Fastify by \`src/index.ts\` under the \`/${mod}\` URL prefix.`
  }
  if (rel.startsWith('backend/src/adapters/')) {
    const adapter = basename(rel)
    return `Integration adapter for **${humanise(adapter)}**. Translates the third-party payload shape into our canonical \`OrderDTO\` (or equivalent) before handing it off to the ingestion worker.`
  }
  if (rel.startsWith('frontend/admin/src/app/configuration/')) {
    const tab = basename(rel)
    return `Configuration sub-page: **${humanise(tab)}**. One of the tiles surfaced from the Configuration Hub at \`/configuration\`. Edits here change platform-wide settings for this concern.`
  }
  if (rel.startsWith('frontend/admin/src/app/')) {
    const route = basename(rel)
    return `Admin route: **/${route}**. Next.js App Router page module — \`page.tsx\` is the entry, any sibling \`layout.tsx\` wraps it.`
  }
  if (rel.startsWith('frontend/storefront/src/app/')) {
    const route = basename(rel)
    return `Storefront route: **/${route}**. Customer-facing page rendered via Next.js App Router.`
  }
  return `Source files for \`${rel}\`.`
}

function describeFile(name: string, rel: string): string {
  if (name === 'page.tsx')   return 'Next.js page component (server or client)'
  if (name === 'layout.tsx') return 'Next.js layout — wraps every page in this route segment'
  if (name === 'route.ts')   return 'Next.js API route handler'
  if (name === 'middleware.ts') return 'Request middleware (Fastify pre-handler or Next.js middleware)'
  if (name === 'service.ts') return 'Business-logic functions invoked by route handlers'
  if (name === 'routes.ts')  return 'Fastify route registrations for this module'
  if (name === 'index.ts')   return 'Module entry point'
  if (name === 'README.md')  return 'This file'
  if (name.endsWith('.test.ts') || name.endsWith('.spec.ts')) return 'Vitest test file'
  if (name.endsWith('.tsx')) return 'React component'
  if (name.endsWith('.ts'))  return 'TypeScript module'
  if (name.endsWith('.json')) return 'JSON config / data'
  if (name.endsWith('.md'))  return 'Markdown doc'
  if (name.endsWith('.sql')) return 'SQL script'
  if (name.endsWith('.css')) return 'Stylesheet'
  return ''
}

function describeSubdir(name: string, _parent: string): string {
  return `see [\`${name}/README.md\`](./${name}/README.md)`
}

function humanise(slug: string): string {
  return slug
    .replace(/[-_]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

// ─── Curated content for top-level / important folders ────────────────────────

function topLevelReadme(): string {
  return `# servd

Hospitality operations platform — POS, KDS, storefront, accounting, procurement — built for Pakistani restaurant groups running multiple brands out of shared kitchens.

## Layout

- [\`backend/\`](./backend/) — Fastify + Prisma + BullMQ. Owns orders, menu, inventory, accounting, and the POS connector (fiscal POS for FBR/SRB + card machine).
- [\`frontend/admin/\`](./frontend/admin/) — Next.js admin portal: dashboard, KDS, POS, configuration hub.
- [\`frontend/storefront/\`](./frontend/storefront/) — Next.js customer-facing storefront with brand microsites.
- [\`packages/\`](./packages/) — Shared TypeScript packages (\`@servd/types\` for the canonical \`OrderDTO\`).
- [\`infra/\`](./infra/) — Deployment + infra config (Docker, deploy scripts, CDN).
- [\`scripts/\`](./scripts/) — Repo-wide tooling (e.g. this README generator).

## Architecture (one-liner)

Every order — from POS, the storefront, Foodpanda, Careem, or WhatsApp — is normalised into a single \`OrderDTO\`, ingested via \`POST /webhooks/*\`, persisted, and broadcast to the kitchen via WebSocket. Inventory deducts atomically per recipe; auto-86 disables menu items across all channels when stock hits zero.

## Local dev

\`\`\`
cd backend  && npm run dev    # Fastify on :3001
cd frontend/admin && npm run dev    # admin portal on :3000
cd frontend/storefront && npm run dev    # storefront on :3002
\`\`\`

\`npm run smoke\` (in \`backend/\`) runs the order-pipeline smoke test — 27 assertions covering ingestion, station routing, course pacing, inventory deduction, auto-86, lifecycle transitions, concurrency, and idempotency.

## Documentation

Every folder in this repo has a \`README.md\` describing what's in it — generated by [\`scripts/generate-readmes.ts\`](./scripts/generate-readmes.ts) and hand-curated where it matters most. Start at any directory you're curious about.
`
}

function backendReadme(): string {
  return `# backend

Fastify HTTP API + WebSocket server. The single source of truth for orders, menu, inventory, accounting, and external integrations.

## Stack

- **Fastify 4** — HTTP framework (built for high-throughput webhooks)
- **Prisma 5** — type-safe ORM, PostgreSQL on Neon
- **BullMQ + Redis** — background workers (order ingestion, fiscal connector outbox, daily digest)
- **Socket.IO** — real-time fan-out to KDS and storefront clients
- **Zod** — runtime validation for every route input

## Layout

- [\`src/\`](./src/) — TypeScript source. Organised into \`modules/\` (HTTP surface) and \`lib/\` (cross-cutting infra).
- [\`prisma/\`](./prisma/) — Schema + migrations + seed.
- [\`scripts/\`](./scripts/) — One-off scripts (\`smoke-test.ts\`, etc).
- [\`tests/\`](./tests/) — Vitest suite.

## Common commands

\`\`\`
npm run dev          # tsx watch — hot-reload server on :3001
npm run smoke        # end-to-end order pipeline smoke test
npm run db:generate  # prisma generate (run after schema edits)
npm run db:migrate   # prisma migrate dev (creates a migration)
npm run db:seed      # populate concepts + sample data
npm run test         # vitest run
\`\`\`

## Environment

Required env vars in \`.env\`:
- \`DATABASE_URL\` — Postgres connection string (Neon).
- \`REDIS_URL\` — Redis connection string (BullMQ + WebSocket adapter).
- \`JWT_SECRET\` — staff token signing key.

Optional but recommended:
- \`R2_ACCOUNT_ID\`, \`R2_ACCESS_KEY_ID\`, \`R2_SECRET_ACCESS_KEY\`, \`R2_BUCKET_NAME\`, \`R2_PUBLIC_URL\` — Cloudflare R2 for media uploads.
- \`SMTP_USER\`, \`SMTP_PASS\` — outgoing email.
- \`TWILIO_SID\`, \`TWILIO_TOKEN\`, \`TWILIO_FROM\` — SMS.
- \`FOODPANDA_WEBHOOK_SECRET\`, \`CAREEM_WEBHOOK_SECRET\` — HMAC verification.
- \`SERVD_SECRET_KEY\` — base64 32-byte key that encrypts stored integration secrets (POS connector keys, the WhatsApp key). \`openssl rand -base64 32\`; never in the repo. FBR/SRB filing has no env vars: the external fiscal POS files, configured per company in admin → Dev → API → POS connector (docs/TAX_SETUP.md).
- \`ENABLE_WORKERS=true\` — turn on BullMQ workers in dev (default off).
`
}

function backendSrcReadme(): string {
  return `# backend/src

The TypeScript source tree, registered into Fastify by \`index.ts\`.

## Top-level files

- \`index.ts\` — Fastify bootstrap, CORS/helmet/rate-limit setup, route registration, worker startup.
- \`config.ts\` — Centralised env-var parsing.

## Subdirectories

- [\`modules/\`](./modules/README.md) — HTTP surface, organised by domain (orders, menu, accounting, procurement, etc.).
- [\`lib/\`](./lib/README.md) — Cross-cutting infrastructure (Prisma client, errors, ws, storage, permissions).
- [\`adapters/\`](./adapters/README.md) — Third-party integration adapters (WhatsApp, payment gateways).
- [\`connectors/\`](./connectors/README.md) — The POS connector: the ONLY path to FBR/SRB filing (through an external fiscal POS) and to the card machine.
- [\`workers/\`](./workers/README.md) — Background workers (BullMQ-driven and timer-driven).
`
}

function modulesReadme(): string {
  return `# backend/src/modules

Every module is \`routes.ts\` (HTTP handlers) optionally with \`service.ts\` (business logic). Each is registered in \`src/index.ts\` under a URL prefix.

| Module | URL prefix | Purpose |
|---|---|---|
| \`auth\` | \`/auth\` | Login, PIN, JWT verification, clock-in/out |
| \`concepts\` | \`/concepts\` | Brand / multi-tenant configuration |
| \`menu\` | \`/menu\` | Categories, items, modifiers, allergens |
| \`orders\` | \`/orders\`, \`/order-items\` | Order CRUD, status transitions, course pacing, auto-86 |
| \`pos\` | \`/pos\` | Point-of-sale: takings, shifts, payments, receipts |
| \`kds\` | (consumes WS) | Kitchen Display System events |
| \`stations\` | \`/stations\` | Kitchen station definitions for KDS routing |
| \`storefront\` | \`/storefront\` | Customer-facing menu/order endpoints |
| \`webhooks\` | \`/webhooks\` | Inbound webhooks from Foodpanda, Careem, WhatsApp, payment providers |
| \`inventory\` | \`/inventory\` | Stock items, par levels, alerts, waste log |
| \`recipes\` | \`/recipes\` | Recipe costing, ingredient mappings, kitchen instructions |
| \`procurement\` | \`/procurement\` | Suppliers, POs, bills, vendor payments, supplier chat |
| \`reports\` | \`/reports\` | Sales, top items, station times, menu engineering, demand forecast |
| \`accounting\` | \`/accounting\` | Journal entries, trial balance, P&L, sales tax return |
| \`finance\` | \`/finance\` | Read-only financial summaries |
| \`crm\` | \`/crm\` | Customer profiles, segments, smart segments, campaigns |
| \`loyalty\` | \`/loyalty\` | Points, tiers, redemption |
| \`wallet\` | \`/wallet\` | Customer wallet credit, transactions |
| \`promos\` | \`/promos\` | Promo codes, usage limits |
| \`discounts\` | \`/discounts\` | Discount rules + application |
| \`giftCards\` | \`/gift-cards\` | Gift card issuance + redemption |
| \`reviews\` | \`/reviews\` | Customer reviews of orders |
| \`complaints\` | \`/complaints\` | Customer complaint intake + resolution |
| \`riders\` | \`/riders\` | Delivery rider assignments + payouts |
| \`dispatch\` | \`/dispatch\` | Order → rider matching |
| \`tables\` | \`/tables\` | Floor plan tables for in-store dining |
| \`floors\` | \`/floors\` | Floor plan layout |
| \`reservations\` | \`/reservations\` | Booking + capacity management |
| \`scheduling\` | \`/scheduling\` | Staff shift scheduling |
| \`payroll\` | \`/payroll\` | Wage runs, deductions, tip distribution |
| \`tipPools\` | \`/tip-pools\` | Tip pooling rules |
| \`checkSplit\` | \`/check-split\` | Split-the-bill at POS |
| \`groupOrders\` | \`/group-orders\` | Shared cart for groups |
| \`siteLayouts\` | \`/site-layouts\` | Brand microsite layouts |
| \`reconciliation\` | \`/reconciliation\` | Cash drawer reconciliation, payment-platform settlement matching |
| \`allocations\` | \`/allocations\` | Cost allocation across concepts |
| \`invoices\` | \`/invoices\` | servd tax invoice (TaxInvoice) issuance — the fiscal number comes from the POS connector |
| \`qrcodes\` | \`/qrcodes\` | Per-table scan-to-order QR generation |
| \`media\` | \`/media\` | R2-backed media library |
| \`apiTokens\` | \`/api-tokens\` | Long-lived bearer tokens for partners + mobile app |
| \`permissions\` | \`/permissions\` | Editable role × permission matrix |
| \`analytics\` | \`/analytics\` | Storefront event analytics + funnels |
| \`calendar\` | \`/calendar\` | Content calendar (marketing) |
`
}

function libReadme(): string {
  return `# backend/src/lib

Cross-cutting infrastructure used by every module.

## Files

- \`prisma.ts\` — Singleton Prisma client.
- \`redis.ts\` — Singleton Redis client.
- \`ws.ts\` — Socket.IO server + safe emitters (never throw if WS is uninitialised).
- \`errors.ts\` — \`AppError\`, \`UnauthorizedError\`, \`ForbiddenError\`, \`NotFoundError\` + Fastify error formatter.
- \`storage.ts\` — Cloudflare R2 presigned-URL generator.
- \`permissions.ts\` — Role × permission catalogue + \`userCan()\` cache.
- \`audit.ts\` — Audit log helpers (used by refunds, voids, comps, config edits).
- \`notify.ts\` — Email + SMS dispatchers (no-op when SMTP/Twilio aren't configured).
- \`whatsapp.ts\` — Hasham's WhatsApp gateway client (one platform-wide gateway; key encrypted at rest).
- \`secretBox.ts\` — AES-256-GCM encryption at rest for integration secrets (\`SERVD_SECRET_KEY\`).
- \`connectorRoles.ts\` — \`CONNECTOR_ADMINS\` (admin, it): who configures Dev → API.
- \`reservation.ts\` — Background cart-release worker for abandoned reservations.
- \`hmac.ts\` — Constant-time HMAC verification for webhooks.
- \`conceptAccess.ts\` — Multi-tenant access control (which concepts a staff user can see).
`
}

function adaptersReadme(): string {
  return `# backend/src/adapters

Each adapter normalises a third-party payload into our canonical types (\`OrderDTO\` for order sources, \`PaymentDTO\` for gateways).

## Order sources

- [\`foodpanda/\`](./foodpanda/) — Foodpanda webhook adapter.
- [\`careem/\`](./careem/) — Careem aggregator (mirrors Foodpanda's pattern).
- [\`whatsapp/\`](./whatsapp/) — WhatsApp Cloud API → conversational order builder.

## Payments

- [\`payment/\`](./payment/) — Generic payment adapter interface.
- [\`keenu/\`](./keenu/) — Keenu card processor.
- [\`jazzcash/\`](./jazzcash/) — JazzCash mobile wallet.
- [\`easypaisa/\`](./easypaisa/) — EasyPaisa wallet.

## Compliance

There is no FBR/SRB adapter here: filing goes through the external fiscal POS
via [\`../connectors/\`](../connectors/README.md). Never add a direct
authority client.
`
}

function workersReadme(): string {
  return `# backend/src/workers

Background workers. Most are BullMQ-driven (Redis-backed queues) — a few are simple \`setInterval\` pollers. All gated by \`ENABLE_WORKERS=true\` (default off in dev, on in production).

## Workers

- \`orderIngestion.ts\` — Processes \`order:ingest\` jobs from webhook queues.
- \`coursePacing.ts\` — Polls for items past their \`scheduledFireAt\` and auto-fires them.
- \`loyaltyTriggers.ts\` — Birthday bonuses, tier promotions, expiring-points alerts.
- \`loyaltyExpiration.ts\` — Expires unused loyalty points after the configured TTL.
- \`reservationReminders.ts\` — 24h + 2h SMS reminders for upcoming reservations.
- \`scheduledReports.ts\` — Per-company scheduled report emails (daily sales, shift summary, low stock, AP aging), configured in Configuration → Scheduled reports.
- \`fiscalConnector.ts\` — Sends fiscal documents (FnF sales and refunds) to the fiscal POS; a 30 s sweeper re-drives anything due, even with Redis down.
- \`terminalConnector.ts\` — Reconciles card-machine charges every 10 s (status, record approved, reverse, 24 h unknowns).
- \`segmentComputation.ts\` — Recomputes behavioural CRM segments nightly.
- \`socialPublish.ts\` — Polls scheduled Meta/Instagram posts and publishes them.
`
}

function prismaReadme(): string {
  return `# backend/prisma

Database schema + migration history.

## Files

- \`schema.prisma\` — Single source of truth for the database. Hot-reload friendly: edit, then \`npm run db:migrate\` (or \`npx prisma db push\` for local-only changes).
- \`seed.ts\` — Seeds default concepts (Stax, Strata, Flipd, Simmer) + sample staff.
- [\`migrations/\`](./migrations/) — Prisma-managed migration history (do not edit by hand).

## Conventions

- Column names stay **camelCase** (e.g. \`scheduledFireAt\`, not \`scheduled_fire_at\`) — this matches the Prisma field name. If you write a hand-rolled migration, follow this convention or add \`@map("snake_case")\` to the field.
- Every model has a \`@@map("snake_case_table")\` directive at the bottom. Tables are snake_case in the DB, models are PascalCase in code.
- \`createdAt\`, \`updatedAt\`, \`deletedAt\` (soft-delete) are present on most user-facing entities.
`
}

function backendScriptsReadme(): string {
  return `# backend/scripts

One-off utility scripts run via \`tsx\`.

## Files

- \`smoke-test.ts\` — End-to-end order pipeline smoke test. Run with \`npm run smoke\`. Sets up a "Smoke Test Cafe" concept, places orders through \`ingestOrder()\` (the same path POS / storefront / aggregators use), and asserts station routing, course pacing, inventory deduction, auto-86, lifecycle transitions, concurrency safety, and webhook idempotency. 27 checks total. Cleans up its own data.
- \`seed-test-data.ts\` — Older seeding helper; superseded by \`prisma/seed.ts\` for most cases.
`
}

function testsReadme(): string {
  return `# backend/tests

Vitest test suite. Run with \`npm run test\` (single shot) or \`npm run test:watch\`.

Coverage focuses on:
- Adapter normalisation (Foodpanda / Careem / WhatsApp payloads → canonical \`OrderDTO\`).
- Service-level business rules (order status transitions, price overrides, refund authorisation).
- HMAC verification of webhooks.

For end-to-end pipeline coverage, prefer the smoke test (\`npm run smoke\`) which exercises real DB writes.
`
}

function frontendReadme(): string {
  return `# frontend

Two Next.js applications.

- [\`admin/\`](./admin/) — Operations portal (staff-facing). Dashboard, POS, KDS, configuration, reports.
- [\`storefront/\`](./storefront/) — Customer-facing storefront with brand microsites (Stax, Strata, Flipd).

Both share a \`@servd/types\` package for canonical types, both consume the backend at \`http://localhost:3001\` in dev (configurable via \`NEXT_PUBLIC_API_URL\`).
`
}

function adminReadme(): string {
  return `# frontend/admin

Operations portal — Next.js 14 (App Router) + Tailwind + React Query + Zustand.

## Stack

- Next.js App Router (server components by default, \`'use client'\` opt-in).
- Tailwind for styling. Custom palette in \`tailwind.config.ts\` — see the \`s-*\` (general) and \`kds-*\` (Kitchen Display) colour tokens.
- TanStack Query for server state, Zustand for client state (cart, KDS lang, POS shift).
- next-intl for English / اردو bilingual UI.
- Sentry for error tracking.

## Layout

- [\`src/app/\`](./src/app/) — App Router pages. One folder per route segment.
- [\`src/components/\`](./src/components/) — Shared React components (KDS ticket card, AppShell sidebar, dashboard widgets).
- [\`src/hooks/\`](./src/hooks/) — Custom hooks (\`useKdsSocket\`, \`useCan\`, \`useKdsVoice\`).
- [\`src/lib/\`](./src/lib/) — API client, formatting helpers, socket factory.
- [\`src/store/\`](./src/store/) — Zustand stores (auth, KDS prefs, POS cart).
- [\`src/i18n/\`](./src/i18n/) — next-intl request configuration.
- [\`messages/\`](./messages/) — Translation JSON (\`en.json\`, \`ur.json\`).
- [\`public/\`](./public/) — Static assets + service worker (\`sw.js\`).

## Run

\`\`\`
npm run dev      # http://localhost:3000
npm run build
npm run lint
\`\`\`

## Backend dependency

Set \`NEXT_PUBLIC_API_URL=http://localhost:3001\` in \`.env.local\`. The backend must be running before staff can sign in.
`
}

function adminSrcReadme(): string {
  return `# frontend/admin/src

The Next.js source tree.

## Layout

- [\`app/\`](./app/) — Routes. Each folder is a URL segment; \`page.tsx\` is the entry.
- [\`components/\`](./components/) — Reusable React components grouped by area (ui, kds, pos, dashboard, onboarding, floorplan).
- [\`hooks/\`](./hooks/) — Custom React hooks.
- [\`lib/\`](./lib/) — Plain-TS helpers (no React).
- [\`store/\`](./store/) — Zustand stores for cross-component client state.
- [\`i18n/\`](./i18n/) — next-intl request config.
`
}

function adminAppReadme(): string {
  return `# frontend/admin/src/app

Next.js App Router. Each subdirectory is a URL segment.

## Top-level routes

- [\`dashboard/\`](./dashboard/) — Live operations cockpit (loaded for any signed-in user).
- [\`kds/\`](./kds/) — Kitchen Display System (per-station + expediter).
- [\`pos/\`](./pos/) — Point of Sale (cashier + waiter modes).
- [\`orders/\`](./orders/) — Order list + detail + courses + bill split.
- [\`menu/\`](./menu/) — Menu editor (categories, items, photos, instructions).
- [\`inventory/\`](./inventory/) — Stock + low-stock alerts.
- [\`procurement/\`](./procurement/) — Suppliers, POs, bills, payments, supplier chat.
- [\`accounting/\`](./accounting/) — P&L, food cost, recipe costing, sales tax return, audit log.
- [\`crm/\`](./crm/) — Customer list, segments, campaigns.
- [\`reports/\`](./reports/) — Sales reports, demand forecast, menu engineering.
- [\`finance/\`](./finance/) — Financial summaries.
- [\`riders/\`](./riders/) — Delivery rider management.
- [\`scheduling/\`](./scheduling/) — Weekly staff roster.
- [\`tables/\`](./tables/) — Floor plan + table assignments.
- [\`reservations/\`](./reservations/) — Bookings.
- [\`storefront/\`](./storefront/) — Storefront layout editor.
- [\`media/\`](./media/) — Image library (R2-backed).
- [\`promos/\`](./promos/), [\`discounts/\`](./discounts/), [\`gift-cards/\`](./gift-cards/), [\`qrcodes/\`](./qrcodes/) — Marketing/incentives.
- [\`reviews/\`](./reviews/), [\`complaints/\`](./complaints/) — Customer feedback.
- [\`payroll/\`](./payroll/), [\`tip-pools/\`](./tip-pools/) — People + comp.
- [\`reconciliation/\`](./reconciliation/), [\`refunds/\`](./refunds/) — Money operations.
- [\`dispatch/\`](./dispatch/) — Order → rider routing.
- [\`floorplan/\`](./floorplan/) — Visual floor plan editor.
- [\`allocations/\`](./allocations/) — Cost allocation across concepts.
- [\`live/\`](./live/) — Real-time event stream debug page.
- [\`chain/\`](./chain/) — Multi-brand chain rollup.
- [\`configuration/\`](./configuration/) — Configuration Hub (single page that surfaces every editable setting).
- [\`settings/\`](./settings/) — Concept / station / staff editor (older settings UI).
- [\`help/\`](./help/) — Help centre with FAQ + WhatsApp support shortcut.
- [\`supplier/\`](./supplier/) — Public supplier portal (token-auth, no login).
- [\`login/\`](./login/) — Staff sign-in.
- [\`calendar/\`](./calendar/) — Content calendar.
- [\`content/\`](./content/) — CMS-ish content blocks.
- [\`analytics/\`](./analytics/) — Storefront analytics dashboard.
- [\`customers/\`](./customers/) — Customer detail pages.
`
}

function configurationReadme(): string {
  return `# Configuration Hub

A single page (\`/configuration\`) listing every editable setting in the platform as a tile. Each tile shows a "ready / needs setup / optional" status pill so operators can see at a glance what's still left to wire up.

## Sub-pages (one per tile)

- [\`api-tokens/\`](./api-tokens/) — Issue / revoke long-lived bearer tokens.
- [\`audit-log/\`](./audit-log/) — Audit log retention + scope viewer.
- [\`backup/\`](./backup/) — Backup + data export defaults.
- [\`billing/\`](./billing/) — Subscription plan + invoices.
- [\`hours/\`](./hours/) — Hours of operation per concept.
- [\`language/\`](./language/) — i18n + currency + date format.
- [\`loyalty/\`](./loyalty/) — Points earn rate, redemption, tier thresholds.
- [\`notifications/\`](./notifications/) — Customer + manager notification cadence.
- [\`payment-methods/\`](./payment-methods/) — Cash/Keenu/JazzCash/EasyPaisa toggles + fees.
- [\`printer/\`](./printer/) — Receipt printer / ESC-POS settings.
- [\`roles/\`](./roles/) — **Role × permission matrix editor** (admin-only). Source of truth for the \`useCan()\` hook.
- [\`tax/\`](./tax/) — Redirects to the POS connector (admin → Dev → API → POS connector).

## How tiles get their status

Each tile in \`/configuration\` runs a small react-query against the related entity count (e.g. concepts, stations, suppliers) and renders Ready / Needs setup / Optional based on what it sees. Wire status into a new tile by adding a \`useQuery\` in the hub page and computing the \`status\` field for that tile.
`
}

function componentsReadme(): string {
  return `# frontend/admin/src/components

Reusable React components, grouped by area.

- [\`ui/\`](./ui/) — Cross-cutting UI: \`AppShell\`, \`AuthGuard\`, \`Providers\`, \`EmptyStateGuide\`.
- [\`kds/\`](./kds/) — Kitchen Display System: \`TicketCard\`, \`KdsHeader\`, \`NewOrderFlash\`, \`PhotoBumpModal\`.
- [\`pos/\`](./pos/) — POS-specific components.
- [\`dashboard/\`](./dashboard/) — Dashboard widgets (\`OnboardingChecklist\`).
- [\`onboarding/\`](./onboarding/) — First-run experience (\`FirstRunTour\`).
- [\`floorplan/\`](./floorplan/) — Floor plan editor canvas.
`
}

function hooksReadme(): string {
  return `# frontend/admin/src/hooks

Custom React hooks. Each is a single \`use*.ts\` file.

- \`useKdsSocket.ts\` — Subscribes to KDS WebSocket events; wires up sound + flash on new orders.
- \`useKdsVoice.ts\` — Web Speech API integration for voice-controlled KDS ("bump 47").
- \`useCan.ts\` — Permission check (\`useCan('orders:refund')\`) backed by GET /permissions/me.
`
}

function adminLibReadme(): string {
  return `# frontend/admin/src/lib

Plain-TS helpers (no React).

- \`api.ts\` — Centralised fetch client + typed endpoint helpers (\`api.get<T>\`, \`ordersApi.list\`, \`menuApi.getMenu\`).
- \`socket.ts\` — Socket.IO client factory (room joining + reconnect).
- \`format.ts\` — Currency, date, duration formatters.
- \`auth.ts\` — Token storage + refresh helpers.
`
}

function storeReadme(): string {
  return `# frontend/admin/src/store

Zustand stores for cross-component client state.

- \`auth.ts\` — Logged-in staff user + JWT.
- \`kds.ts\` — KDS preferences (lang, sound, voice, image visibility) + the live order list.
- \`pos.ts\` — POS cart, current shift, payment state.
- \`floorplan.ts\` — Floor plan editor state.
`
}

function i18nReadme(): string {
  return `# frontend/admin/src/i18n

next-intl request config.

- \`request.ts\` — Reads the \`NEXT_LOCALE\` cookie (falls back to \`'en'\`), loads the matching JSON from \`messages/\`.

Translation strings live in [\`../../messages/\`](../../messages/) — see that folder for the EN / UR JSON.
`
}

function messagesReadme(): string {
  return `# frontend/admin/messages

Translation JSON files used by next-intl.

- \`en.json\` — English (default).
- \`ur.json\` — Urdu (اردو).

Strings are namespaced (\`kds.*\`, \`pos.*\`, \`common.*\`). To add a new key, add it to **both** files — the build fails if a key is missing.

KDS staff-facing strings are the priority — that's where Urdu support is most valuable.
`
}

function publicReadme(): string {
  return `# frontend/admin/public

Static assets served at the web root.

- \`sw.js\` — Service worker. Caches KDS pages for offline use.
- \`manifest.json\` — PWA manifest (Android home-screen install).
- \`favicon.ico\`, icons, etc.
`
}

function storefrontReadme(): string {
  return `# frontend/storefront

Customer-facing online ordering. Next.js + Tailwind. Hosts the main "all brands" site and the per-brand microsites (Stax, Strata, Flipd).

## Layout

- [\`src/app/\`](./src/app/) — App Router pages. \`/[concept]\` is the primary order flow; \`/brand/[slug]\` is the brand-specific microsite; \`/brands/<name>\` are hand-built static brand pages.
- [\`src/components/\`](./src/components/) — Shared components (cart drawer, menu grids, brand layouts).
- [\`src/lib/\`](./src/lib/) — API client, analytics tracker, formatters.
- [\`src/store/\`](./src/store/) — Zustand stores (cart, customer auth).

## Run

\`\`\`
npm run dev    # http://localhost:3002
\`\`\`
`
}

function storefrontSrcReadme(): string {
  return `# frontend/storefront/src

Storefront source.

- [\`app/\`](./app/) — Routes (one folder per URL segment).
- [\`components/\`](./components/) — Reusable components grouped by area.
- [\`lib/\`](./lib/) — Plain-TS utilities.
- [\`store/\`](./store/) — Zustand stores.
`
}

function storefrontAppReadme(): string {
  return `# frontend/storefront/src/app

Customer-facing routes.

- \`page.tsx\` — Landing page (browse all brands).
- [\`browse/\`](./browse/) — Combined-menu browse view.
- [\`[concept]/\`](./[concept]/) — Per-concept ordering flow (menu → cart → checkout → order tracking).
- [\`brand/[slug]/\`](./brand/) — Brand microsite (about, menu, visit pages).
- [\`brands/\`](./brands/) — Static brand homepages (Stax, Strata, Flipd).
- [\`account/\`](./account/) — Logged-in customer portal (profile, addresses, orders, loyalty, complaints).
- [\`auth/\`](./auth/), [\`login/\`](./login/), [\`signup/\`](./signup/) — Authentication.
- [\`order/\`](./order/), [\`orders/\`](./orders/) — Order tracking.
- [\`reserve/\`](./reserve/) — Table reservations.
- [\`group-order/\`](./group-order/) — Shared cart for groups.
- [\`supplier/\`](./supplier/) — (Note: real supplier portal is in admin/src/app/supplier).
`
}

function storefrontComponentsReadme(): string {
  return `# frontend/storefront/src/components

Reusable storefront components.

- [\`menu/\`](./menu/) — Menu grid, item card, modifier picker.
- [\`checkout/\`](./checkout/) — Cart, payment selection, address picker.
- [\`brand/\`](./brand/) — Brand microsite layouts (\`layouts/\`) + parts (\`parts/\`).
- [\`blocks/\`](./blocks/) — Generic block-style content blocks (hero, gallery, CTA).
`
}

function packagesReadme(): string {
  return `# packages

Shared TypeScript packages. Imported by both backend and frontend.

- [\`types/\`](./types/) — \`@servd/types\`. Canonical \`OrderDTO\`, \`MenuItemDTO\`, \`CustomerDTO\`. Single source of truth between adapters and consumers.
`
}

function typesReadme(): string {
  return `# packages/types

\`@servd/types\` — canonical TypeScript types shared across backend + frontend.

The most important type is \`OrderDTO\` — every adapter (Foodpanda, Careem, POS, storefront, WhatsApp) normalises its incoming payload into this shape before \`ingestOrder()\` persists it. Keeping this contract stable is what lets us add new order sources without touching the order pipeline.
`
}

function infraReadme(): string {
  return `# infra

Deployment + infrastructure config.

- Docker / docker-compose definitions.
- Deploy scripts (Render, Fly.io, or whichever target).
- CDN / DNS notes.

(See files at this level for specifics.)
`
}

function rootScriptsReadme(): string {
  return `# scripts

Repo-wide tooling.

- \`generate-readmes.ts\` — Walks every directory and writes a README.md (the script that produced these). Run with \`tsx scripts/generate-readmes.ts\`. Pass \`--force\` to overwrite hand-edited READMEs.
`
}

// ─── Run ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Generating READMEs under ${ROOT}${FORCE ? ' (force)' : ''}…`)
  await walkAndWrite(ROOT)
  console.log('Done.')
}

main().catch((e) => { console.error(e); process.exit(1) })
