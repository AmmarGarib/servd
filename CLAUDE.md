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
  storefront is on `--servd-*` tokens. **servd storefront colours (owner,
  2026-10-05): bone `#f3e7cd` background, green `#87c540` primary, purple
  `#5a2156` secondary (bands, purple buttons; deep shade `#3f1640`) and
  `#3d1f3b` as the ink/text colour.** Text on green is purple (never white);
  green as text on bone is `#4f7a1c`. Legacy token names stay
  (`--servd-green` holds the primary). The brand microsites keep their own
  palettes.
  **Admin/ERP colours (owner, 2026-10-12): deep vibrant purple on white, with
  the servd logo green as the accent** — primary `#6a0dad` (buttons, links,
  selected; white text on it), sidebar `#3b0764`, page `#f9f7fc`, cards
  white, ink `#261038`, muted `#6b5b7c`; servd green `#87c540`
  (`--erp-accent`: the logo, accents, the sidebar's active item — purple text
  on green, never body text on white) and `#4f7a1c` (`--erp-success`,
  `text-success`, `s-badge-green`: profit / on target / paid — green vs red
  for good vs bad). **Green rule (owner, 2026-10-12: "more servd green"):**
  purple = actions and identity (buttons, links, focus); green = state and
  good news — switches when on, the active tab's underline, selected chips,
  progress bars, live/available dots, done/paid/on-target/positive values,
  the small eyebrow label above a page title (`text-success`), checkboxes
  (accent-color). Legacy `s-teal` / `s-badge-teal` ARE the green accent;
  `s-badge-purple` is the purple tint. The top-left is the logo
  (`/brand/servd-logo.png`), not a wordmark. ONE definition: channel variables (`--x-rgb` + `--x`) in
  `frontend/admin/src/app/globals.css`, read by `tailwind.config.ts`
  (`rgb(var(--x-rgb) / <alpha-value>)`), so opacity modifiers work. Tailwind
  `white` = the area's foreground (`--fg-rgb`), so `text-white/40` is ink on
  white; `--ink-rgb` is ink everywhere. Areas redefine colours by setting
  BOTH channel and colour: the sidebar is `.erp-on-secondary` (white on deep
  purple, primary = servd green inside it), a light card popping out of it
  is `.erp-on-surface`, and KDS, expo and the POS till stay dark with their
  green "go" accent (`.erp-kitchen-dark` / `kds-*`). Never hard-code a colour
  in a page — use the tokens (`var(--erp-primary)`, `rgb(var(--erp-primary-rgb)
  / 0.1)`, `color-mix(in srgb, <token> 10%, transparent)` for tints of a
  variable colour; never append hex alpha to a colour string).
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

Six workspaces replace the old 18-module catalogue: **CEO** (role `admin`
only — the approvals inbox, companies, logins & module access, company-wide
rules; owner decision D2, 2026-10-11), **Operations** (owned by
`fnb_manager` — all BOH and FOH, menu, stock, buying, the till; the CEO still
holds every module), **Finance**, **Marketing**, **HR**, **Dev** (IT role
`it` — integrations, backups, webhooks, the user audit log, the API
connectors). `backend/src/lib/workspaces.ts` is the ONE
definition (sections, module ids, owner/member roles, `childRoles`); every
module id belongs to exactly one workspace (tested). The admin sidebar,
`/w/<id>` homes and `/modules` read it from `GET /permissions/me` /
`GET /permissions/workspaces` — never keep a copy in the frontend. A new
module id must be placed in a workspace in the same change.

- **Team = the HR reporting line** (`HrEmployee.managerId`). `GET /hr/team`
  returns the whole tree under the caller. Don't build another hierarchy.
- **Owners add logins only for roles under them** (`childRoles`;
  `POST /auth/staff/invite`), always `pending` until the CEO approves on
  /workforce or in the approvals inbox. The CEO's own `POST /auth/users`
  needs no approval. A login with no company can't be approved
  (422 `LOGIN_NEEDS_COMPANY`) — pick its company on /workforce first.
- **One approvals inbox** (`/ceo/approvals`, `GET /approvals` +
  `/approvals/counts`, `backend/src/modules/approvals/`; owner decision D3).
  It READS each module's own queue as the caller (new logins, website
  publishes, POs over the limit, recipes, HR steps, payroll, tip pools, stock
  transfers) and every button calls the module's EXISTING approve/reject
  route, whose own guard decides — never add a second approval engine. A new
  approval type is a provider in that module. `/hr/approvals` ("My
  approvals") redirects to `/ceo/approvals?type=hr_request`. Hand-over of
  approval types to head-office HODs comes with head office (after Monday).
- **The sidebar and the server agree (wave 3, 2026-10-11).** A role whose
  modules include M can use M's pages (every read 200, the workspace's normal
  writes work); a role without M is refused server-side, not just hidden.
  Server: `GATED_PREFIXES` in `backend/src/lib/moduleAccess.ts` — each rule's
  `anyOf` lists EVERY module whose pages (admin, tablet, till) call that path
  (`/orders`, `/expo`, `/dispatch`, `/riders`, `/crm`, finance and HR
  prefixes…); `readAnyOf` widens GET/HEAD only (finance reads payables under
  `/procurement`). A new caller of a gated path adds its page's module to
  that rule in the same change. Some modules gate inside their route files
  (`requireModule` / `moduleGateForNewRoles` in marketing, finance, Dev
  routes). Admin: `canOpenPath` / `modulesForPath` in
  `frontend/admin/src/lib/moduleCatalog.ts` drive the AppShell page guard
  ("You don't have access to this page"), the hubs' cards and cross-links.
  The brand picker reads `GET /concepts?view=picker` (any staff role, own
  companies' active brands); plain `/concepts` stays managers/till. Line
  cooks and finance never get costs/codes they don't need (`costsHidden`,
  masked gift-card codes).
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

- Everything is a `SiteLayout` row keyed by slug: `servd:<page>` (`home`,
  `header` = top bar, `footer`, `feedback` = the feedback button (layout kind
  `widget`), `waitlist`, `press`, `reserve`, `location` =
  the template for every /locations page), `brand:<slug>` (home),
  `brand:<slug>:header|footer|about|visit|menu`, `brand:<slug>:<page>` (the
  owner's own brand pages — /brand/<slug>/pages/<page>, and `/pages/<page>` on
  the brand's domain), `page:<slug>` (servd custom pages, `/pages/<slug>`),
  `popup:<key>`. `blocks`/`settings` are LIVE; `draftBlocks`/`draftSettings`
  are the working copy.
- **Every storefront page is editable (owner, 2026-10-07): "every element in
  the storefront module, all pages, and I can add elements and pages".**
  Bespoke designs are broken into SECTIONS: one block type `section` with a
  `variant` (`stackd.hero`, `servd.nav`, `brand.footer`, …) and `fields`
  (every word, image, link, colour, list). The storefront owns them in
  `frontend/storefront/src/sections/<group>/` (catalog.ts = specs + each
  page's default sections; renderers.tsx = components; README.md = the
  contract) and serves the catalogue at `/api/storefront-sections`; the admin
  builds its palette and forms from it (`frontend/admin/src/lib/sections.ts`
  — no second copy). Routes render pages through `ManagedPage` (live layout,
  else the page's default sections = its design with today's content). **A new
  page or design element on the storefront is a section, never hard-coded
  copy.** Fields go through `sections/safe.ts` (safeHref/safeSrc/color). The
  old one-off types (`signature`, `scrollHero`, `brandFooter`, `siteLogo`) and
  the `servd:hero` slug are retired.
- **Nothing publishes without the CEO (role `admin`).** Draft → submit →
  approve (now, or "publish at" → `scheduled`, published by the
  `sitePublish` worker or lazily on the next public read) / reject with a
  note. Every publish writes a `SiteLayoutVersion`; rollback republishes an
  old version as a new one. There is no publish-on-save endpoint — don't add
  one. Drafting needs module `storefront`.
- A/B: `settings.ab = { splitPct, blocks }`; the visitor's variant is a hash of
  the `sv_vid` cookie + slug + version; `SiteLayoutStat` counts views and
  conversions (first click inside the page / pop-up submit).
- The mobile app renders the same block JSON natively
  (`mobile/src/content/`). Keep the block schema in step across
  `frontend/storefront/src/lib/blocks.ts`, `frontend/admin/src/lib/blocks.ts`
  and `mobile/src/content/types.ts`.
- **The live page in the editor (D4 stage 1, 2026-10-12).** The builder is
  Layers | Add, the live page, and the inspector. The centre is an iframe of
  the storefront route **`/editor-frame`**: the admin posts the UNSAVED draft
  with `postMessage`, and the frame renders it through the real renderer via
  a server action. The frame never fetches a draft, never counts
  `SiteLayoutStat`, is noindex, and is framable ONLY by `ADMIN_ORIGINS`
  (`frontend/storefront/src/lib/adminOrigins.ts` is the one definition; the
  CSP is set in the middleware for that route only, `X-Frame-Options
  SAMEORIGIN` everywhere else). The admin posts only to and accepts only from
  `STOREFRONT_ORIGIN` (`NEXT_PUBLIC_STOREFRONT_URL`; prod default
  `https://servd.pk`). The two protocol files must stay byte-identical:
  `frontend/storefront/src/editor/protocol.ts` and
  `frontend/admin/src/lib/editorProtocol.ts`. The storefront image must be
  built with `NEXT_PUBLIC_SITE_URL=https://servd.pk` (server-action origin
  check). Cloudflare must not add its own frame headers to `/editor-frame`.
- **Scroll effects:** `block.motion = { preset, intensity }` (parallax, fade,
  grow, pin-reveal, sticky-stack, side-pan, text-reveal × subtle/medium/strong),
  independent of the one-shot entrance `animation`. FOUR copies stay in step:
  storefront `lib/blocks.ts` (+ the one value table `lib/motion.ts`), admin
  `lib/blocks.ts`, mobile `content/types.ts` (+ `content/motion.ts`, which maps
  motion to an entrance animation for now), and the backend zod in
  `modules/siteLayouts/schemas.ts`. Web uses CSS scroll-driven animations with
  a small JS fallback; reduced motion = no effect. Offered on pages and
  footers only; footers exclude pin-reveal and sticky-stack; Simmer pages
  exclude text-reveal. No animation library.

## servd home is /home (owner, 2026-10-07)

The landing page and the old `/browse` brand picker were merged into ONE
Apple-style page at **`servd.pk/home`** (`app/home/page.tsx` +
`components/HomeClient.tsx`). `/` redirects there in the middleware (servd
host only — brand hosts still rewrite `/` to their microsite); `/browse` and
`/order` redirect in `next.config.js`. The hero is the scroll-expansion
hero (`LandingScrollHero` → `ui/scroll-expansion-hero.tsx`) — keep it; a jump
far down the page (an `Order` link to `#kitchens`) finishes the expansion
instead of snapping back to the top. Search is the nav's `SearchSheet`
(`openSearch()`), not a page. Link to `/home` or `/home#kitchens`, never
`/browse`. The hero is the `servd.scrollHero` section on `servd:home`: a
background SLIDESHOW behind it (`bgSlides`, 1-10 photos the owner adds in
Admin -> Storefront, `bgSlideSeconds` 3-15; empty = the single `bgImageSrc`,
default the dining-room photo `/brand/servd-hero-bg.webp`; only the current
and next photo load; reduced motion = first photo only) and NO words over
the media (owner, 2026-10-12) — `showTitle` off keeps the title only as an
`sr-only` h1; eyebrow and scroll hint are empty. The nav shows the logo
(`/brand/servd-logo.png`), not the text wordmark.

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

  **Brand names use normal capitalization: Stackd, Simmer, Flipd** (owner,
  2026-10-06 — this REVERSES the old all-lowercase rule). Every user-visible
  brand name goes through `formatBrandName()` (storefront `lib/concept.ts`),
  which returns the canonical capitalised name; don't hard-code a lowercase
  name in copy. Logos/wordmarks (image assets, and lettering set in a brand
  font) are design, not running text — leave them as designed unless the
  owner says otherwise. `/stax*` paths redirect permanently.
  **Not renamed:** `stax-padel` (separate padel business, and it IS a burger
  concept). The old `eatstax.com` / `eatsimmer.com` / `eatflipd.com` domains
  are retired (owner, 2026-10-07; migration `20261007120000`) — the brands
  live on `stackd.pk`, `simmer.pk`, `flipd.pk`.

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
- `frontend/storefront/` — Next.js consumer ordering site (`servd.pk`; brand sites `simmer.pk`, `stackd.pk`, `flipd.pk`)
- `frontend/admin/` — Next.js operator UI (`admin.servd.pk`)
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
| `PUBLIC_API_URL` | Public API hostname baked into client bundles | `https://api.servd.pk` |
| `PUBLIC_WS_URL` | Public WebSocket URL | `wss://api.servd.pk` |
| `SENTRY_DSN_STOREFRONT` | (optional) Sentry DSN for storefront | |
| `SENTRY_DSN_ADMIN` | (optional) Sentry DSN for admin | |
| `GOOGLE_MAPS_API_KEY` | (optional) Maps JavaScript API key — switches the admin location pin picker from OpenStreetMap to Google tiles. Public/build-time: restrict it to the admin origin in Google Cloud. Without it the picker still works (OSM tiles + paste-a-Maps-link resolver). | `AIza…` |
| `SERVD_SECRET_KEY` | **Box env, NOT a GitHub secret** — set it in the API container's environment on the box. AES-256-GCM key for stored integration secrets (POS connector API keys + webhook secrets, the WhatsApp gateway key), base64 of 32 bytes (`openssl rand -base64 32`). Never in the repo or the image. Without it no connector/WhatsApp key can be saved (503 `SECRET_KEY_MISSING`) and `/health` warns; losing it makes stored secrets unreadable (re-enter them). Once set, the WhatsApp key is encrypted on first read, so rolling the API back to a pre-connector image needs the WhatsApp key re-entered. | `q3J…=` |

### Manual fallback

If CI is broken or you need to push out of band:

```bash
docker login -u <username>                            # use a PAT, not password
docker build -t ammargarib/servd:storefront \
  --build-arg NEXT_PUBLIC_API_URL=https://api.servd.pk \
  --build-arg NEXT_PUBLIC_WS_URL=wss://api.servd.pk \
  frontend/storefront/
docker push ammargarib/servd:storefront
# Then trigger the box to pull:
curl -X POST 'https://servd-deploy.garibsons.app/deploy?secret=...'
```

## Public URLs

| Surface | URL |
|---|---|
| Consumer storefront (live, owner 2026-10-07) | https://servd.pk — brands at https://simmer.pk, https://stackd.pk, https://flipd.pk |
| Operator admin | https://admin.servd.pk |
| API | https://api.servd.pk |
| Deploy webhook (the only host still on the old domain) | https://servd-deploy.garibsons.app/deploy?secret=... |
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
  Bound to the canonical `simmer-brand` SKILL.md: lowercase wordmark (the
  logo only — the name in text is "Simmer", owner 2026-10-06),
  Amarante + Times, no white, no gradients, no exclamation marks,
  no emojis, banned-word list, single orange signal per viewport,
  tagline `simmer down.` always below the wordmark, never above.
- **stackd** — Industrial plum (Pantone 19-2025 Red Plum `#7C2946` + Pantone
  9180 cream `#FCE8CE`, Pantone 635 `#9BD3DD` as the one cool accent). Was
  "stax" / navy-grey; see the 2026-09-09 note above.
- **flipd** — the servd purple / white / green (owner, 2026-10-12, replacing
  the mustard `#FED561` / Flipd Blue `#294375` / bone book palette): marks
  `#6A0DAD`, dark bands `#3B0764` with servd-green `#87C540` type, white
  field, lavender `#F3EEFA` quiet surface, ink `#261038`, a purple + green
  checker. The `--flipd-*` token NAMES stay as roles (`--flipd-blue` = the
  mark colour, `--flipd-mustard` = the field). The logo artwork is being
  redrawn in these colours by the owner's designer.

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

### Own-fleet delivery — rider app v1 (2026-10-10)

**docs/rider-app.md is the contract.** Riders sign in with phone + a
WhatsApp code (`/rider-auth/*`, token types `rider` / `rider_refresh` — a
rider is NOT a `User`, so no staff route ever accepts a rider token and vice
versa). Rider API at `/rider/*`: shift on/off, jobs (offered → accepted →
picked up → arrived → delivered with the customer's 4-digit code), live
location. Two clients: the Expo app in `rider/` (background location) and
the web version at **servd.pk/rider** (`frontend/storefront/src/app/rider/`,
noindex, no servd chrome / feedback / pop-ups).

- **Shared fleet (owner):** GS Foods runs shared staff for every company, like
  head office. A rider belongs to one company; it carries another company's
  orders only under an active `FleetAgreement` (provider → client), managed in
  admin → Riders → Fleet by an operator in both companies. Every
  `RiderJobEvent` carries the order's company (`tenantId`) and the rider's
  (`riderTenantId`) — the future cost split reads those.
- **The hand-over code** is shown to the customer (tracker + WhatsApp at
  pick-up) and to admin/management only; never in staff order lists. The
  staff "Delivered" override is managers-only and only when the code locked
  or the rider never accepted.
- **Not built yet:** earnings/payouts, push notifications for offers (the app
  polls), store release (EAS, icons, Play background-location declaration),
  KYC, route optimisation.

### POS connector + pre-bills (2026-10-10, owner amendments binding)

**The external fiscal POS is the ONLY FBR/SRB filer.** servd is the
order-taking software; it never talks to FBR PRAL or SRB. The direct
adapters, workers, queues, `/integrations/tax/status` and every `FBR_*` /
`SRB_*` env var are removed — **never add a direct authority client.**
Everything goes through `backend/src/connectors/` (README there; vendor
contract `docs/pos-connector-api.md`; operator runbook `docs/TAX_SETUP.md`).

- **The connector:** one `PosConnector` row per company per kind — `fiscal`
  (the fiscal POS) and `terminal` (the card machine), so they can be
  different vendors. Drivers: `none`, `test` (built in, deterministic, no
  network, `TEST-…` numbers, receipts say `TEST — NOT A FISCAL INVOICE`) and
  `http` ("servd connector API v1"). A real vendor is one file in
  `connectors/drivers/` + one line in `registry.ts`. Secrets go through
  `lib/secretBox.ts` (`SERVD_SECRET_KEY`); responses carry hints only.
- **Transactional outbox:** the sale `FiscalDocument` is inserted inside
  `completeOrder`'s claim transaction — **any new path that completes an
  order goes through `completeOrder`**, never files on its own. A refund
  after completion inserts a refund document in the refund's transaction.
  Single flight via a DB lease, DB-driven retries, `unknown` → lookup before
  any resubmit, a 30 s sweeper that works without Redis.
- **Pre-bill vs full & final (FnF) bill:** a pre-bill (open order, before
  payment; `PRE-BILL — NOT A TAX INVOICE`, `PB-<n>` per company) **never**
  creates a fiscal document and is never sent to the POS. Only the FnF bill
  (completion) files — exactly once per order. Cancel/void before FnF sends
  nothing. Receipt routes answer 409 `PRE_BILL_REQUIRED` for a non-final
  order. Every pre-bill print is a permanent `PreBill` row
  (`modules/prebills/`) — no delete/hide/edit endpoint, never revenue, never
  the ledger.
- **Finance → Voided pre bills** (`/finance/voided-pre-bills`, API
  `GET /pre-bills`, module `voided_prebills`; admin, owner, management,
  finance): every pre-bill, flagged `ORPHANED` / `FINAL_LOWER` /
  `LINE_VOIDS_AFTER`. Only `/pre-bills` is module-gated — the till's
  `/pos/orders/:id/pre-bill` and `/pos/pre-bills/:id/html` never are.
- **Manager-only voids:** every item void and every whole-order cancel/void
  of a rung-up order needs a manager — the manager's own login or a valid
  same-company manager PIN (`MANAGER_OVERRIDE_REQUIRED` /
  `INVALID_MANAGER_PIN`, 403); `approverId` always recorded. A cashier or
  server can never void alone.
- **No skip of real sales.** There is no per-document Skip, no date-range
  skip and no "skip held" at go-live. `skipped` is automatic only
  (prefiled_direct, zero_value per setting, zero_value_unsupported,
  no_sale_document). Until a company goes live its sales are `held`
  (visible, in /health, never auto-sent); the CEO goes live and releases ALL
  held (per company or per brand). "Record manual filing" stays.
- **Per-company "Fiscal reporting required"** (default ON; stored on the
  company's fiscal connector settings, read via `fiscalReportingRequired()`):
  OFF for a test company or a non-commercial kitchen → no fiscal documents,
  no held backlog, no alerts, receipts say "Not a tax invoice". CEO only,
  reason required, audited, whole company — never per sale/brand/date.
- **API section = Dev workspace → API = exactly two modules:**
  `api_whatsapp` (`/connectors/whatsapp`, Hasham's gateway — ONE
  platform-wide gateway, routes `/auth/integrations/whatsapp*`, module-gated
  so the CEO's Module Access really closes it — whoever sets its URL
  receives every company's OTPs) and
  `api_pos` (`/connectors/pos`, module-gates `/connectors`). Configured by
  `CONNECTOR_ADMINS` (`admin`, `it`; `lib/connectorRoles.ts`); management
  reads the POS connector; go-live, switch-off, release and the reporting
  switch are CEO only. Pages live under `/connectors/*`, never `/api/*`
  (the admin rewrites `/api/:path*` to the backend).
- `Concept.fbrPosId` / `srbPosId` stay the one store of brand POS ids (edited
  only on the POS connector page); `srbPosId` still routes Sindh tax to 2032
  in the ledger. Fiscal payloads use STORED order figures only — never
  `concept.taxRate`.
- **New default modules reach saved Module Access rows ONCE.** A saved
  `RoleModuleAccess` row replaces the role's defaults, so a module added to
  a role's defaults is listed in `MODULE_GRANTS` (`lib/moduleAccess.ts`);
  `applyModuleGrants()` appends it to saved rows of the roles whose defaults
  hold it, once (marker `settings.moduleAccess.grantsApplied`), at boot and
  before the first override read. A later CEO untick sticks.
- **Rollback below this release breaks WhatsApp until the key is re-entered:**
  a server with `SERVD_SECRET_KEY` encrypts the stored gateway key on first
  read (spec D15), and the old image sends that ciphertext as the API key —
  signup, staff code sign-in, reset and 2FA codes stop. After any such
  rollback re-enter the key in the old `/configuration/whatsapp` screen.

### Round 5 rules (2026-10-12, after Monday onboarding)

- **One order reference everywhere:** the LAST 8 characters of the order id,
  uppercased — `orderRefOf` in `backend/src/lib/orderRef.ts` (admin and
  tablet keep the same rule in their own `lib/orderRef.ts`). Receipts,
  pre-bills, staff screens, ledger memos, customer/rider messages all use it.
  Never `id.slice(0, 8)` for an order. Ledger lookups match the FULL order id
  in memos, never the short reference.
- **One managers list in the admin:** `lib/roles.ts` (server copy sent as
  `roles.managers` from `GET /permissions/role-modules`). Don't keep a local
  role list in a page. Override approvers (`useIsManager`) are a different list.
- **Tip pools are company data:** `TipPool.tenantId` decides scope, ledger
  postings and flags — never the operator's company. Members are a login
  (`userId`) OR an HR employee with no login (`employeeId`), exactly one
  (CHECK); per-pool uniqueness is two partial unique indexes in SQL that
  Prisma can't express — don't re-declare them in schema.prisma.
- **Tax invoices are per company:** `TaxInvoice.tenantId`, unique
  `(tenantId, invoiceNumber)`, numbered per (company, prefix, Karachi year,
  invoice/credit note) from `tax_invoice_series` under an advisory lock.
  `invoice_counters` is no longer read.
- **Alert kinds:** tip-pool outliers are `tip_pool_outlier`, CapEx overruns
  `capex_over_budget` — `high_value_void` is for voids only.
- **SMTP password at rest** goes through `lib/secretBox.ts` like the WhatsApp
  key (encrypted when `SERVD_SECRET_KEY` is set, plain otherwise — saving is
  never blocked; `/health` `smtpPassAtRest`). Same rollback caveat: after
  rolling back below this release, re-enter the SMTP password.
- **Card refunds on a cancelled ticket** may go back on the card machine, capped
  at what the ticket still owes back (in-flight machine refunds counted),
  booked as the LEDGER-R5 hand-back, never a sale refund and never a fiscal
  document sent to the POS.
- **WhatsApp ordering (owner, 2026-10-12):** one shared GS Foods number; a
  conversation starts with a BRAND MENU across companies (brands that are
  active, not deleted, storefront-visible, open now and have a priced dish —
  `LIVE_BRAND` + `orderingState`); one open brand skips the menu; a cart never
  mixes brands; the order lands in the chosen brand's company at its cash GST;
  no loyalty/wallet/promo redemption on WhatsApp. Typed replies (numbers or
  titles) work for the text-only gateway. `WHATSAPP_DEFAULT_CONCEPT` is
  optional (listed first / fallback). Contract: `backend/src/adapters/whatsapp/README.md`.
- **Money columns: BIGINT where a group outgrows INT4** (BOOKS-06, migration
  `20261012140000_money_bigint`). The ledger, AP, AR, bank lines and
  balances, exception amounts, allocation runs, fixed assets, capex/opex and
  `Customer.totalSpentCents` are BIGINT paisa. Per-ticket (orders, payments,
  till), per-unit stock cost and per-person HR amounts stay INT4.
  `lib/money.ts` is the one boundary: `moneyAsNumbers`, on the base client
  under the RLS extension, returns every BIGINT as a JS number on `prisma`,
  `serviceClient` and every tx, so JSON stays numbers. Prisma still TYPES
  them `bigint`: convert with `toCents`/`sumCents` where tsc asks. Never use
  bigint literals, `BigInt()` or bigint math in src (tested). Raw SQL is not
  converted: raw SQL that returns a BIGINT column — including `SELECT *` /
  `t.*` of a widened table — comes back as bigint; select ids and re-read
  through the model API, and cast sums `::bigint` and `toCents` them (a
  numeric reaches JSON as a string). One BIGINT amount ≤ `MAX_MONEY_CENTS`
  (PKR 900bn) via `zMoneyCents`/`assertMoneyFits`; INT4 columns ≤
  `INT4_MAX_CENTS` via `zInt4Cents`/`assertInt4Fits` or the till's
  `assertAmountsFit`; above either is 422 `AMOUNT_TOO_LARGE`. A supplier
  bill's NON-stock lines stay ≤ INT4 (each and in total): `postSupplierBill`
  books every bill to 1210 Inventory – Food, so fit-out/equipment goes
  through CapEx (→ 1340 → fixed-asset register), never a bill.
  `TenantContribution.monthlyCents` stays INT4 behind `zInt4Cents`. A new
  company-level money column is BIGINT from its first commit. If the
  migration ever fails on deploy, run `prisma migrate resolve --rolled-back
  20261012140000_money_bigint` in the api image before redeploying either
  image (P3009 blocks both) — runbook in the migration's header.

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
  for the enforced version. (The old "capital S is a bug" rule is retired:
  the name is "Simmer" in text; only the wordmark logo stays lowercase.)
- **Never use emoji as structural icons** in storefront UI. SVG or text
  labels only.
