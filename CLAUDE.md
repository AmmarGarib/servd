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
- **Customer-facing:** gift cards, loyalty, promos and segments stay
  inside the company that issued them. **Exception (owner decision
  2026-10-15): customer strikes, bans and ban appeals are SERVD-WIDE** — they
  are the customer's account standing, so strikes from every company count
  together (3 → one auto ban) and an active ban blocks the customer at every
  brand of every company (`lib/strikes.ts`). Each strike / ban still records
  the company whose incident it is (`tenantId`); only that company's managers
  may reverse its strike, lift its ban or decide its appeal (a legacy
  NULL-company ban: the CEO only), and other companies see its details only as
  "Another servd kitchen" (standing yes, reason / order / staff no).
- **Tests:** every new route ships with a two-company test — company B gets
  404 on company A's rows, and creates bind to the active company.

A change that skips any of this is not done, however well the feature works.

## ⚠️ Corrections (2026-06-11 audit) — read before trusting older sections

Parts of this file have drifted from reality. Until the relevant sections are
rewritten, trust these corrections:

- **Storefront visual migration is DONE**, not "in progress." The legacy
  "premium" system (`#00D4B1` teal → `#6366F1` indigo, `#18160f` ink,
  `PremiumInput`) is fully removed from `frontend/storefront/src`. The whole
  storefront is on `--servd-*` tokens. **servd.pk colours (owner,
  2026-10-12, same as the ERP): white `#ffffff` background, green `#87c540`
  primary (Order buttons), deep vibrant purple `#6a0dad` secondary (bands,
  purple buttons; deep shade `#3b0764`), ink `#261038`, lavender `#f3eefa`
  surface.** Text on green is deep purple (never white); green as text on
  white is `#4f7a1c`. Brand pages and brand ordering skins pin the previous
  bone/plum values (`.servd-brand-scope` in the /brand/<slug> layout and the
  `*-ordering` skins in globals.css) so brands never change. Legacy token names stay
  (`--servd-green` holds the primary). The brand microsites keep their own
  palettes: the servd ERP and servd.pk colours are NEVER applied to a brand
  (owner, 2026-10-12: "Only on servd erp and servds storefront. Brands remain
  as they are"), except inside a section that is about servd on a brand page.
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
only — the approvals inbox, companies, logins and per-person module access,
company-wide rules; owner decision D2, 2026-10-11; Role presets moved to HR
→ "Role presets" on 2026-10-16), **Operations** (owned by
`fnb_manager` — all BOH and FOH, menu, stock, buying, the till; the CEO still
holds every module), **Finance**, **Marketing**, **HR**, **Dev** (IT role
`it` — integrations, backups, webhooks, the user audit log, the API
connectors). `backend/src/lib/workspaces.ts` is the ONE
definition (sections, module ids, owner/member roles, `childRoles`); every
module id belongs to exactly one workspace (tested). The admin sidebar,
`/w/<id>` homes and `/modules` read it from `GET /permissions/me` /
`GET /permissions/workspaces` — never keep a copy in the frontend. A new
module id must be placed in a workspace in the same change.

- **Brands is the CEO's (owner, 2026-10-14).** The brand editor is CEO →
  Brands (`/ceo/brands`; `/marketing/brands` redirects). `brands` is a
  CEO-only module (`CEO_ONLY_MODULES` in `lib/moduleAccess.ts`: dropped from
  every non-admin role, saved row and moduleAllow; one-time revoke
  `MODULE_REVOKES`) and `PATCH /concepts/:id` + `GET ?view=brand` answer 403
  `BRAND_CEO_ONLY` to every other role. Marketing keeps Storefront and the
  Brand kit (CEO-approved). One-setting writers keep their own routes (POS
  ids on `/connectors`, Raast account on `/setup`, the look via the kit).
- **Team = the HR reporting line** (`HrEmployee.managerId`). `GET /hr/team`
  returns the whole tree under the caller. Don't build another hierarchy.
- **Owners add logins only for roles under them** (`childRoles`;
  `POST /auth/staff/invite`), always `pending` until the CEO approves on
  /workforce or in the approvals inbox. The CEO's own `POST /auth/users`
  needs no approval. A login with no company can't be approved
  (422 `LOGIN_NEEDS_COMPANY`) — pick its company on /workforce first.
- **HR onboards and offboards (owner, 2026-10-15).** HR's `childRoles` are
  every assignable role except `admin` and `owner`. A FLOOR login (cashier,
  FOH, BOH, kitchen, expediter) that HR or the CEO invites is ACTIVE at once
  with the same side effects as an approval (`auth/offboarding.ts`
  `activeAtOnce` / `activationSideEffects`: employee linked, password link);
  every other role waits for the CEO (`staff_login`). Managers' invites stay
  pending. `POST /auth/staff/:id/offboard {reason}` / `/reinstate`: HR and the
  CEO only, own companies (404), never an admin login (403
  `CANNOT_OFFBOARD_CEO`), never a co-owner — by anyone, the CEO included, nor
  through the staff editor or the HR leaver sweep (403 `CANNOT_OFFBOARD_OWNER`;
  owner, 2026-10-16), never your own (403 `CANNOT_OFFBOARD_SELF`; the
  staff editor refuses the CEO switching themselves off too). Offboard =
  `switchOffLogin` (suspend + revoke every session), the ONE switch-off the
  HR leaver sweep (`hr/separations.ts`) uses too. HR's reinstate of a manager
  / office login goes back to `pending` for the CEO. UI: the HR employee
  Login tab (Create login, Offboard / Reinstate) and Workforce.
- **HR issues new passwords too (owner, 2026-10-16: "Give this option to HR
  also").** `POST /auth/users/:id/reissue-password` admits HR with `staff_hr`
  (same scope as offboard; never `admin` / `owner` — 403 `REISSUE_CEO_ONLY`,
  never their own — `REISSUE_SELF`, never a floor login — 400
  `NOT_A_PASSWORD_LOGIN`); audit `user.password_reissue` records `actorRole`.
  Button "New password" in `components/hr/OffboardButtons.tsx`.
- **HR sends password reset links (owner, 2026-10-16).**
  `POST /auth/staff/:id/send-password-link` (HR with `staff_hr`, or the CEO;
  button "Send password reset link" in `components/hr/OffboardButtons.tsx`)
  reuses the Forgot-password sender (`passwordReset.ts requestPasswordReset`):
  one-use 30-minute link to the person's OWN email / WhatsApp, kills older
  links, never returned to the caller or written to the audit row (audit
  `user.password_link_sent`). Scope = `findManagedStaff` (other company 404,
  shared login 403; head-office reach 404 / lens 403). HR never for `admin` /
  `owner` (403 `RESET_LINK_CEO_ONLY`); floor logins 400
  `NOT_A_PASSWORD_LOGIN`; no email 422; not active 409; practice copy 503
  `PRACTICE_NO_LINKS`; no channel 503. Cap: 3 links per person an hour
  (counting their own Forgot-password links, plus an atomic bucket for
  parallel clicks) and 20 per sender (429). HR cannot change a login's email
  or phone (`PATCH /auth/users/:id` is ADMIN_ONLY) — keep it that way, or the
  link becomes a takeover path. Tests: `tests/staffResetLink.test.ts`.
- **Module access is per person; only the CEO changes a PERSON's (owner,
  2026-10-15).** Role presets (`PUT /permissions/role-modules`, page
  "Role presets", module `role_modules`) are the base case. **Presets are
  HR's (owner, 2026-10-16: "Give the presets thing to HR"), within safe
  limits** (`PRESET_LIMITS` in `lib/moduleAccess.ts`, served as
  `presetLimits` on `GET /permissions/role-modules`): any HR login holding
  `role_modules` in its effective modules may save or reset a preset, but
  never the `admin` / `owner` / `hr` presets (403 `PRESET_CEO_ONLY`) and never
  add or remove `role_management`, `role_modules`, `tenants` or
  `accounting_audit` on any preset (403 `PRESET_GOVERNANCE_CEO_ONLY`; checked
  against the saved row read live under a per-role advisory lock, never the
  module-access cache); a head-office login with reach is refused. Presets stay ONE servd-wide set
  (`RoleModuleAccess` has no `tenantId`, deliberately). The CEO keeps full
  control. The CEO ticks a person's modules on
  Workforce ("What they can open") through `GET/PUT
  /permissions/users/:id/modules` (`modules: null` = back to the preset),
  stored as `moduleAllow = chosen − preset`, `moduleDeny = preset − chosen`,
  audit `staff.modules`. Admin rows are locked (every module). Every writer of
  a PERSON's module access is ADMIN_ONLY; an invite never carries it (tested
  in `tests/staffOnboarding.test.ts`; presets in `tests/rolePresetsHr.test.ts`).
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

## servd home is servd.pk/ (owner, 2026-10-07; root address 2026-10-14)

The landing page and the old `/browse` brand picker were merged into ONE
Apple-style page, served at the ROOT **`servd.pk/`** (owner, 2026-10-14:
search engines rank a site's root for its name). `app/home/page.tsx` holds it
and `app/page.tsx` re-exports it; the middleware sends `servd.pk/home` to `/`
with a 308 (servd host only — brand hosts still rewrite `/` to their
microsite, and `/home` on a brand host is still the servd page); `/browse` and
`/order` redirect to `/` in `next.config.js`. Canonical, sitemap and JSON-LD
use `https://servd.pk/`. Brand fields keep naming servd's home `/home`;
`servdHref` (sections/brand/util.ts) turns it into servd's root. The hero is the scroll-expansion
hero (`LandingScrollHero` → `ui/scroll-expansion-hero.tsx`) — keep it; a jump
far down the page (an `Order` link to `#kitchens`) finishes the expansion
instead of snapping back to the top. Search is the nav's `SearchSheet`
(`openSearch()`), not a page. On servd's own pages link to `/` or `/#kitchens`
(never `/browse`; `/home` still works but redirects). The hero is the `servd.scrollHero` section on `servd:home`: a
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
  from the DB `Concept.description`** — edit it in admin → CEO → Brands,
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
  or the rider never accepted — and only while the company's code-only
  switch is OFF (see "Delivery money and customers").
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
  bill's NON-stock lines stay ≤ INT4 (each and in total). Stock is received
  at the dock (Dr 12x0 / Cr 2015 GRNI) and billed against that receipt; a
  non-stock bill line names its 6xxx account; fit-out/equipment goes through
  CapEx (→ 1340 → fixed-asset register), never a bill.
  `TenantContribution.monthlyCents` stays INT4 behind `zInt4Cents`. A new
  company-level money column is BIGINT from its first commit. If the
  migration ever fails on deploy, run `prisma migrate resolve --rolled-back
  20261012140000_money_bigint` in the api image before redeploying either
  image (P3009 blocks both) — runbook in the migration's header.

### Raast QR (2026-10-12, owner decisions)

- **Tenders:** tills take exactly Cash, Card – Keenu and Raast QR
  (`backend/src/lib/tenders.ts` is the ONE list; `TILL_TENDERS` is those
  three). **On account** (`ON_ACCOUNT_TENDER`, 2026-10-15) is the fourth way a
  bill is settled, for approved named clients only, through its own route
  (see "On-account clients"), never `POST /pos/payments`. `keenu_qr` is RETIRED:
  kept in the enum, old rows read and refund the way they were paid, new
  payments / settles / splits / intents answer 422 `KEENU_QR_RETIRED`
  (ring-up and quotes map it to `raast` so an old offline ring-up never 400s).
- **Tax:** card + Raast = the one digital group (`lib/pricing.ts`
  CARD_TENDERS → `taxRateCard`). Never `concept.taxRate`.
- **The rule at the till:** money is checked on the COUNTER device (bank SMS
  / merchant app), never the customer's screen; the cashier types the bank
  reference and ticks the attestation (`raastVerified: true`, server
  enforced). A reference is normalised, validated and unique per company
  (`RaastReceipt @@unique([tenantId, bankRef])`) — the same transfer never
  pays two bills; references of dismissed / debit / older / other-account
  credits are refused.
- **Sale vs truth:** a Raast payment completes the sale like card
  (`completeOrder`, one fiscal document, PaymentMode 3 by default — confirm
  with the POS vendor). Its `RaastReceipt` is `provisional` until a
  bank-statement line matches it (`modules/reconciliation/raast.ts`, by
  reference + amount + date, one-sided window — never a credit from before
  the bill); finance matches, fixes references (approvers), writes off
  "not received" (balanced, the receipt's company and bank code) or resolves
  a needs-attention receipt in Finance → Reconciliation → Raast.
- **Ledger:** Raast money debits the receiving BANK's chart code (snapshot
  `RaastReceipt.ledgerCode` from `connectors/raast/accounts.ts` — brand
  override, else the company default; never another company's), never 1030;
  refunds credit it; memo prefix `RAAST_RECEIPTS_MEMO`, which the generic
  bank matcher never pairs. A Raast row with no code refuses the posting.
- **Bank SMS:** the `raast` POS-connector kind (`enabled` = SMS matching ON;
  OFF by default; only the CEO switches it on after the readiness check).
  Counter-phone tokens: sha256 lookup + secretBox, shown once, rotate kills
  the old one. Only listed bank senders are stored; OTPs never. A credit
  settles a bill only when EXACTLY ONE live intent fits — otherwise
  `unmatched` / `ambiguous` for a person: NEVER a guess. Every Raast write
  path takes `lockRaastTx` (connectors/raast/lock.ts) first, then the order
  lock; never hold a transaction across `processPayment`. A future bank /
  aggregator API is a driver feeding `applyBankCredit` (no rework).
- **Gates:** `/pos/raast/*` ungated (till cashiers), `/connectors/raast/*`
  under `api_pos` (no new module — Dev → API stays two), `/reconciliation/raast/*`
  under `reconciliation`, receiving accounts on `/setup` (finance).
  Runbooks: `docs/raast.md` (finance + cashier), `docs/raast-sms-forwarder.md` (IT).

### Cash vouchers (owner 2026-10-15; replaces the H3 HOD flow of 2026-10-14)

- **Flow:** anyone raises (`POST /trustops/cash-vouchers`, kind `request`) →
  status `submitted` at once (no draft step) → **finance** approves
  (`/:id/finance-approve`: role `finance` with the accounting module, or the
  CEO; never its own — 409 `SELF_APPROVE`) → the **CEO** gives the final
  approval (`/:id/approve`; never the raiser/holder, never the finance
  approver — 409 `SAME_SIGNER`) → **finance pays and that books the expense**
  (only role `finance` with `accounting`: 403 `PAY_FINANCE_ONLY`) → the holder
  uploads supporting documents → **finance checks the documents**
  (`/:id/verify-docs`, books nothing) → `posted`.
  Finance or the CEO may **return for correction** (`/:id/return`, note;
  `returnCount`) — the raiser edits and `/:id/resubmit`s — or reject. The HOD
  step is retired (`/sign-hod` → 410); legacy `draft` = waiting for finance,
  legacy `hod_signed` = waiting for the CEO. Finance may also raise kind
  `expense` for an outside payee (`payeeName`, `grossCents` − `discountCents`
  = `amountCents`, CHECK `cash_vouchers_discount_chk`) — straight to the CEO.
  A discount is finance's only.
- **Money — ONE entry at pay (owner, 2026-10-16: "It should pass only one
  entry when booked by finance, either docs are attached or not, if docs are
  attached with voucher after transaction is booked by Finance, it should only
  save the doc and attached it below the system generated voucher").** Finance's
  pay (`CashVoucher.bookedAtPay` true, `expenseOnVerify` stays true for the
  documents flow) books the EXPENSE at once and nothing touches 1357: from a box,
  `recordPettyCashSpendTx` nature `expense` with ONE line `cashRequestPayLine`
  (Dr the voucher's 6xxx / Cr 1011, `pettycash.spend:<movementId>`, the float
  drops); from cash on hand or a bank (`paySource`, account =
  `moneyAccountCode` of the VOUCHER's company), `cashvoucher.pay:<id>` Dr the 6xxx /
  Cr 1010 | bank (`postCashVoucherSourceTx`). Brand = the voucher's. The
  account (6xxx only; a `cogs` category is 422 `USE_STOCK_LINE`) and the
  equipment check on "<number>: <purpose>" (422 `USE_CAPEX` unless finance
  sends `notEquipment` + a reason ≥10, flagged `equipment_override`) run
  BEFORE any cash leaves — stock and equipment never come in through a
  one-entry voucher (box spend stock lines / CapEx Quick buy). Supporting
  documents are stored under the voucher and book nothing; `/:id/spend` is 409
  `EXPENSE_BOOKED_AT_PAY`; finance's `/:id/verify-docs` only marks the documents
  checked (≥1 `supporting` document, else 422 `DOCS_REQUIRED`; → `posted`,
  `settledCents` = amount, posts NOTHING) and refuses lines / change / boxes
  (422 `EXPENSE_BOOKED_AT_PAY`): a change or an overspend is a manual journal
  (Post / Edit / Cancel on the journal page). Close check
  `vouchers_awaiting_docs` is a WARN only (documents not checked; the expense
  is already booked) — `voucher_docs_unchecked` was merged into it.
- **1357 is RETIRED (owner, 2026-10-16: "Don't post any entry in 1357 …
  only book one entry when confirmed by finance").** No code path debits or
  credits 1357 for new activity: the `voucher_hold` spend nature is gone,
  `postCashVoucherSourceTx` posts only the one-entry pay (change / overspend /
  a hold pay → 409 `EXPENSE_BOOKED_AT_PAY`), `postCashVoucherVerifiedTx` only
  READS a verified voucher's existing entry (never re-synced), a `cash_request`
  top-up onto 1357 is 409 `USE_JOURNAL`, the settlement-line reclass of a
  documents-flow voucher is 409 `USE_JOURNAL`, `/:id/spend` is retired.
  Vouchers still HELD on 1357 (paid 2026-10-15 → 2026-10-16 under the hold
  flow: `expenseOnVerify` true, `bookedAtPay` false, not posted) are converted
  ONCE by `trustops/voucherHoldConversion.ts` (at every API boot for every
  company, and by `/:id/verify-docs` for one still held): ONE entry
  `cashvoucher.hold_convert:<voucherId>` Dr its expense account
  (`resolveSpendAccount` of its category) / Cr 1357 for the held amount — read
  from the LIVE hold entry (`pettycash.spend:<movementId>` or
  `cashvoucher.pay:<voucherId>`), which must exist, be un-reversed, sit under
  one brand and equal the voucher's amount (else `HOLD_NOT_BOOKED` /
  `HOLD_AMOUNT_MISMATCH` / `HOLD_SPLIT`, flagged) — under the brand the hold
  debited 1357 with, dated the day it runs, in the voucher's company; in the same
  transaction `bookedAtPay` = true and `postedJournalEntryId` = that entry, so
  the documents check then books nothing (no change / overspend — a manual
  journal). Keyed per voucher + a conditional claim: never twice. No usable
  category (none / a `cogs` key), equipment, stock/CapEx lines recorded, a
  hold not on the books, or a refused posting (period lock, closed books) →
  NOT converted, flag `cash_voucher_hold_unconverted` (high, CEO + finance
  bell) in its company, left held; `/verify-docs` answers 409
  `VOUCHER_STILL_HELD` until finance fixes the cause (finance — never the
  raiser / holder — may set the expense account of a still-held voucher with
  `PATCH /:id {categoryKey | accountCode}` only, conditional on it still being
  held; the "Check the documents & book" panel does it) or corrects it by
  manual journal. An old 1357 hold movement is never re-synced:
  `postPettyCashMovementTx` returns its live entry unchanged (even with a
  backfill date) and refuses one with no entry (409 `HOLD_RETIRED`). Ledger entries are never deleted: the old
  `cashvoucher.post:<id>` / hold entries stay as history; the tie-out still
  compares 1357 with Σ vouchers still held (0 once all converted).
  **"Resolved by journal entry" (owner, 2026-10-16: "add the resolved button,
  and make it block the close"):** a held voucher finance corrected with a
  manual journal (Dr the right account / Cr 1357) is marked done with
  `POST /trustops/cash-vouchers/:id/resolve-by-journal {journalEntryId, note ≥10}`
  (`trustops/voucherHoldResolve.ts`; picker `GET /:id/resolve-candidates`;
  admin panel on the voucher). Finance with `accounting` or the CEO, never
  the raiser / holder (409 `SELF_APPROVE`); another company's voucher or
  entry 404. The entry must be a live `manual:` entry of the VOUCHER's
  company, dated on/after the hold's PKT day, crediting 1357 by exactly the
  live hold, per brand (422 `NOT_A_MANUAL_ENTRY` / `ENTRY_REVERSED` /
  `ENTRY_BEFORE_HOLD` / `ENTRY_AMOUNT_MISMATCH` / `ENTRY_BRAND_MISMATCH`);
  one entry resolves one voucher (`postedJournalEntryId` @unique, 409
  `JOURNAL_ALREADY_USED`); conditional claim (twice → 409 `VOUCHER_NOT_HELD`).
  POSTS NOTHING: `bookedAtPay` = true, `postedJournalEntryId` = the entry (a
  converted voucher's state, so the documents check books nothing), the
  `cash_voucher_hold_unconverted` flag resolves, audit
  `cash_voucher.resolve_by_journal` (+ `cash_voucher.hold_resolved_by_journal`
  on the entry). A resolving entry cannot be reversed or edited (409
  `ENTRY_RESOLVES_VOUCHER`, manualJournal.ts) — correct it with another
  manual entry. **Close check `vouchers_held_on_1357` BLOCKS** (per company,
  paid on/before the lock — or with no pay date — and still held, or cleared
  only by a conversion / resolving entry dated AFTER the lock; CEO-overridable
  with `acknowledge`), separate from the warn-only `vouchers_awaiting_docs`.
- **Legacy H3 rows** (`expenseOnVerify` false, paid before 2026-10-15) keep
  their rules: the pay was the expense (Dr 6xxx / Cr 1011,
  `cashRequestPayLine` / `cashRequestPaidAccountTx`), receipts book nothing,
  settlements reclass out of the paid account, change is Dr 1011 / Cr the
  paid account; `/receipts`, `/settlements`, `/return-change` answer 409
  `USE_DOCUMENTS` on a new-flow voucher. No 1355 in new code. Daily flag
  `cash_request_receipts_overdue` (09:10 PKT; now "supporting documents
  overdue" for the new flow).
- `CashVoucher` / `CashVoucherAttachment` (tenantId; number `CV-00001` per
  company under an advisory lock; files stored as bytes). Supporting
  documents (`/:id/documents`, kind `supporting`, ≤5 MB, ≤20): PDF, images,
  Excel / Word / PowerPoint, CSV / text through `lib/evidenceFile.ts`
  `allowOffice` (extension, mime and magic bytes must agree; Office / text
  download as attachments). Also `GET /dashboard`, `GET /:id/history`,
  `GET /:id/export.pdf|xlsx` (approved or later). Admin
  `/finance/cash-vouchers` is a personal page (open to every login; the API
  scopes the list). Approvals inbox types `cash_request_finance` (finance)
  and `cash_voucher` (CEO), each with Approve / Return / Reject
  (`ApprovalAction.kind` includes `'return'`); `cash_request_hod` is retired
  (the id still parses, no provider).
- **Petty cash is on 1011** (H2): a top-up needs a source (Garibsons → 2210,
  H1; the safe 1010; a bank); a till top-up is a drawer payout keyed
  `pettycash.till_topup:<cashMovementId>`. **`recordPettyCashSpendTx`
  (`trustops/pettyCash.ts`) is THE one way money leaves a box.** The 'cogs'
  payout keys are history picks only; the CEO's history run is
  `/reconciliation/backfill-petty-cash`. Float changes are always relative +
  conditional (`floatCents >= amount`), never "set to what we read".

### Finance gaps, wave A (2026-10-13; owner: "no known gaps in finance")

- **Manual journals need no CEO approval (owner, 2026-10-16: "journal
  entries should not require CEO's approval to be booked … Finance should have
  access to pass new entry / edit / cancel").** `POST /accounting/journal`,
  `/journal/:id/reverse` (cancel) and `/journal/:id/amend` (edit = ONE
  transaction: reverse the original + post the corrected entry in the
  original's company; audit / flags only after the commit) are open to the CEO
  and finance with `accounting` (`JOURNAL_POSTERS`). The ledger never deletes.
  Still the CEO's: a register-account override (403
  `REGISTER_OVERRIDE_CEO_ONLY`) and anything dated in closed or reopened books
  (`closedBooks.ts`). Journal requests (`/journal-requests`) stay for the
  other preparers (owner, management).
- **Trial balance presentation (owner, 2026-10-16):** ONE net balance per
  account — debits − credits in the Debit column when positive, the Credit
  column when negative, never both — and accounts at zero are not listed (a
  cleared account such as 1357 drops off). `accounting/reports.ts
  trialBalance` (API, CSV, admin page and the `trial_balance` close check);
  the computed `3020*` retained-earnings b/f row is unchanged; totals still
  balance.
- **Chart of accounts (owner, 2026-10-16):** finance (with the `accounting`
  module) and the CEO add and rename accounts (`POST` / `PATCH
  /setup/chart-of-accounts`, `CHART_EDITORS`) and switch accounts off or
  back on (owner, 2026-10-16: "Give access to finance also"; the books'
  guards ACCOUNT_IN_USE / ACCOUNT_CONTROLLED still refuse). A duplicate code in the company is 409
  `ACCOUNT_CODE_TAKEN`.
- **Which money account:** `moneyAccountCode(db, tenantId, {method, bankAccountId})`
  in `lib/bankAccounts.ts` is THE answer for every non-till payment (supplier
  payments, receivable receipts/refunds, wallet top-ups, CapEx, OpEx, gift
  cards, tax payments, payroll, F&F, loans, deposit drops): cash→1010,
  card→1030, bank-type→the named live LINKED bank of the SOURCE document's
  company; none named → the company's only bank, 1020 if none, 422
  `BANK_ACCOUNT_REQUIRED` if two or more; a wallet always names its account.
  `bankLedgerCode` is strict (422, never a silent 1020). Admin picker:
  `components/finance/BankAccountSelect.tsx`.
- **Credit notes live in their document's own table:** supplier credit notes
  are `SupplierBill` kind `credit_note` (+ `SupplierCreditApplication`);
  receivable credit notes are `ReceivableInvoice` kind `credit_note`. Still
  due = total − wht − paid − credited (`billDueCents`), everywhere.
- **Tax paid to an authority** is a `SalesTaxPayment` ('salestax.payment:<id>'),
  or a LINK to an entry already posted by hand — never both. The return's
  output excludes payments, so paying never lowers the tax shown.
- **A refused posting is never only logged:** `flagPostingFailed` with the
  document's sourceType, and a re-poster in `reconciliation/backfillOrders.ts`
  REPOSTERS. A new posting that can be refused adds both (and puts
  `metadata.documentDate` on its flag, so the period close dates it).
- **Pending owner/CA decisions** (decisions page
  https://claude.ai/artifact/W8tzVdHxhzYSKJiyzhcLRk): COD never paid (G1),
  rider COD on 1351 (H5), on-account tender (G14) and the on-account tax
  invoice (H14) — resumed 2026-10-15 and BUILT on the defaults, awaiting
  owner/CA confirmation (see "Delivery money and customers" and "On-account
  clients"). Head-office HO-Q1 / HO-Q3 wait for the CA (see "Head office").
  Everything
  else (C*, G2–G13, F*, K*, H1–H31) is answered and built — see "Finance
  wave B" below. Seams still marked `TODO(<id>)` in code — build only on the
  owner's answer.

### Finance wave B (2026-10-14; Hasnain's answers H1–H31 + the owner's)

- **Stock is FIFO lots, costed at the price paid.** `lib/stockLedger.ts` is
  the only writer (every change is a stock movement); counts, waste, prep
  and transfers go through it, and every count difference or transfer
  shortfall carries a reason (≥3 characters). Cost classes come ONLY from
  `lib/inventoryClass.ts`: food 1210 / 5010, drinks 1220 / 5020, packaging
  1230 / 5030. Each company is cut over once (`inventory/fifoCutover.ts`
  `ensureFifoCutover`: at boot, else on its first stock write via
  `ensureFifoReady`, which is called BEFORE opening a transaction).
- **GRNI (H17):** a dock receipt opens a lot — Dr 12x0 / Cr 2015. A bill's
  stock line must link its receipt (or PO) line and clears 2015; "Received,
  not billed" (`/procurement/grni`) lists what is open; a write-off needs
  the CEO.
- **Cost of sales is booked ONCE per order** (its order.complete, or a till
  ticket's home drawer shift.close — `accounting/cogs.ts orderCostBookedAt`).
  A later stock event on the order (return, waste, box, late depletion)
  books its own entry through `orders/stock.ts ORDER_COGS_FIX` /
  `inventory/voidWaste.ts postVoidWaste` — never a bare lot write.
- **Packaging (owner, FINAL):** takeaway and delivery always take the
  recipe's Packaging section; a packaging-vessel brand (Stackd) on every
  order; dine-in at a plate brand only when staff tap "Box given"
  (`POST /pos/orders/:id/items/:itemId/box-given`). `Concept.serviceVessel`
  ('plate' | 'packaging') is required at brand create and snapshotted per
  order line.
- **Opening stock** from a company's first count → 3010 owner's capital
  (H19). **Waste and count differences wait for the CEO (H20):** stock
  leaves at once, the COST waits in 1290 Stock Differences Suspense with its
  reason until the CEO approves it into 5040 / 5050 on Finance → Stock
  differences (`modules/stockDifferences/`, `/accounting/stock-differences`;
  the one switch is `stockDifferenceAccount` in
  `accounting/inventoryPosting.ts`). The close warns while any waits. The CEO
  approves line by line, so cost of sales classes an approved line by its OWN
  1290 line's stock (`reports.ts clearedLineClass`), never the whole entry's.
- **Food cost is ONE report:** `reports/foodCost.ts` at `/reports/food-cost`
  (module `food_cost`). `brandSalesRevenueCents` / `costOfSalesSplit`
  (`accounting/reports.ts`) are the one cost-of-sales denominator and class
  split. 42xx is other income — never brand sales, a sales KPI or a ratio base.
- **Period close:** `accounting/closeChecks.ts` `CLOSE_CHECKS` is the ONE
  checklist; a module adds a CloseCheck, never its own 409 on
  `POST /accounting/period-close`. The CEO closes over overridable blocks with
  `acknowledge {keys, reason ≥10}`; `trial_balance` never. The fiscal year is
  per company (`Tenant.fiscalYearEndMonth`, 30 June — H29) with a virtual
  roll-forward: nothing posts at year end.
- **Fixed assets v2:** classes per company; 1500–1599 and 2012 are
  `controlledBy 'fixed_asset'` (only `fixed_asset.*` / `capex.*` sources post
  there). Assets come in through CapEx capitalisation — the CEO approves every
  one, Quick buys included. Depreciation is AUTOMATIC (worker 03:20 PKT,
  `chargeThrough` the one path, no switch); smallwares are pooled (H21);
  prepayments sit on 1310 and release monthly (`accounting/prepaidReleases.ts`);
  refundable deposits (1360) only through CapEx. No deferred tax anywhere
  (H24). No sales tax on proceeds when used equipment is sold (H41). For
  TAX, smallwares are deducted in full in the year bought (H35) and the 25%
  initial allowance is kitchen and power equipment only (H42; office and IT 0%).
- **Tax:** `accounting/taxAuthorities.ts` is the one authority table; input
  tax is booked by authority (1320 FBR, 1322 SRB — the ONLY two: PRA, KPRA, BRA and their 1321/1323/1324 + 2031/2033/2034 were removed, owner 2026-10-15; brands cannot be set to Punjab, KP or Balochistan). Federal input
  on food, drink and packaging stock (H34) may be set off against SRB output (H8:
  `salesTaxReturn.ts CROSS_SETOFF_ELIGIBLE_CLASSES`; a payment's
  `crossSetOffCents`, never above what is claimable; what is already used is
  read from the LEDGER — `crossSetOffUsedCents`, every Cr 1320 in an entry
  that touches a provincial output account, linked or not — never from
  payment rows). Delivery fee = 4110 +
  GST on top at the brand's rate for the tender (H9; `Order.deliveryFeeCents`
  / `deliveryFeeTaxCents` from `lib/pricing.ts` only). A kept no-show deposit
  is 4210 other income, no output tax (H10). Gift-card breakage → 4200, no tax
  (H11). Keenu card payouts are matched to card days (H12, BOOKS-11 reuse, no
  reposter; unsettled days block the close unless the CEO overrides). Sales
  tax a client withholds → 1335, netted in that authority's return (H13).
- **Withholding and statutory payables:** `lib/withholding.ts` is the one WHT
  resolver; `PUT /accounting/withholding/rates` the only writer of a
  company's rates (confirmed by the accountant, H32; withholding stays OFF per
  company until finance switches it on). A supplier whose filer status is not
  known pays the NON-filer rate until confirmed (H33). Salary tax 2042, EOBI 2043, SESSI / PESSI 2044
  (H7): challans go through the tax-payments register; `/accounting/statutory`
  is the one accrued-vs-paid view. OpEx posts the expense with input tax by
  authority and WHT to 2040; budgets compare the expense.
- **Combining companies (`POST /tenants/merge`):** everything with a
  `tenantId` moves or the merge is refused (422) — never stranded on the
  deleted company. A new company table is added to the merge
  (`tenants/routes.ts`: a repoint list, a per-key twin rule, or a clash in
  `assertMergeable`) in the same change. Exception flags, tax payments,
  Raast / card-machine / bank-SMS rows, gift cards, loyalty and wallets
  (combined per customer), tax invoices and the HR back office move; a
  system supplier both have is absorbed by the target's.
- **Public `/health`:** details are counts and where to look — never an
  amount, a company or item name (it is unauthenticated).
- **Scheduled reports:** a module-gated report type
  (`lib/moduleAccess.ts SCHEDULED_REPORT_MODULES`: food cost, AP aging) needs
  that module to be scheduled and, every run, its creator still holds it.
- **Receivables:** every bad-debt write-off (6160) needs the CEO (G12); no
  doubtful-debt provision. **Raast void:** CEO only, posts nothing, the bank
  reference stays claimed. **Inter-company (H30):** company pairs now
  (1450–1499 / 2150–2199, only `ic.*` sources), head office later; the
  shared fleet is recharged nightly (03:40 PKT) at the CEO's rate (6990).
- **/health** warns, never errors, on `fixedAssets` (register vs ledger, last
  depreciation run), `pettyCash` (boxes vs 1011), `fifoCutover`,
  `chartTemplateTypes`, `statutoryReclass` and `cardPayouts`.
- **Rollback caveat:** once a voided Raast receipt (or any row carrying a
  wave-B enum value) exists, never roll the API image back below this
  release — an older Prisma client throws on the new values.
- **Payment receipts (owner, 2026-10-14):** every back-office money-IN screen
  (receivable payments and write-off recoveries, gift-card sales, paid wallet
  top-ups, inter-company settlements, asset-sale proceeds, CapEx deposit
  returns) takes its method from `lib/bankAccounts.ts RECEIPT_METHODS` (cash,
  card, bank transfer, **bank deposit**, cheque) and REQUIRES a payment
  reference # on EVERY method, cash included (`assertPaymentReference`, 422
  `PAYMENT_REFERENCE_REQUIRED`; ≤100 chars, `zPaymentRef`). The admin uses
  `components/finance/PaymentReceivedFields.tsx`. A reference already used in
  the same company WARNS (`lib/paymentRefs.ts` → `referenceUsedBefore`), never
  blocks; the dedupe key in `journal_entries.reference` is unchanged (the
  reference goes into the description and the money line's memo). Money OUT
  (refunds) keeps its own lists. The till keeps its tenders (`lib/tenders.ts`).
- **Shared equipment names its location:** a fixed asset with no brand
  ("shared across brands") must have a location (outlet) — 422
  `LOCATION_REQUIRED_FOR_SHARED` when it is capitalised, transferred or
  raised; the project's own outlet counts. Checked when raised; a
  capitalisation request carries the outlet / brand it was checked against
  (the CEO's approval applies that, never the project's later edits; an older
  pending request approves as before), and a transfer is checked again when
  it applies, under the asset lock.
- **Void split (TILL-R3):** a line voided on a paid, still-open order stores
  its exact split in the refund row's `gatewayMeta.refund.split` (line value −
  discount, plus that line's own GST and service charge — never fee or tip);
  `order.refund` books exactly that (`orderPosting.ts voidSplitOf`), and every
  other refund, restore, the sales report and the fiscal refund value the
  order net of those voids (`netOfVoidRefunds`; the fiscal payload never puts
  it on the DELIVERY-CHARGE line). Any new writer of a void refund row passes
  `voidSplit`.
- **Stock, after the W3 fixes:** a sub-recipe's stock lines and stations
  belong to the companies of the dishes and add-ons that use it (an unused one
  to the active company); sub-recipes are never shared across companies (422
  `INGREDIENT_NOT_IN_COMPANY`). `PATCH /inventory/:id` re-reads the category
  under the item lock, gives each extra cost class its own reclass key
  (`<audit>:<class>`) and answers 409 `RECLASS_NOT_POSTED` if the ledger did not
  book what moved. An opening count is blocked only by lots and lot-carrying
  movements (a lot-less sale shortfall does not block it). Stock-transfer
  approve / ship / cancel are conditional status moves (409 `BAD_STATE`).
- **Cash requests carry one brand** (`pettyCashPosting.ts cashRequestBrandTx`):
  settlements, the CapEx credit and change returned all take the pay's brand;
  a pay-line reclass locks the request row before the box. The petty-cash
  history backfill expenses an old-flow voucher's spend in its category (H3);
  only rows already booked as advances use 1355.

### Practice copy (owner, 2026-10-14)

- A separate servd where staff try anything, on a COPY of real data: admin
  https://servd-practice.garibsons.app, API
  https://servd-practice-api.garibsons.app (never under servd.pk — the live
  CORS list must not trust it). Its stack is `deploy/sandbox/` (own Neon DB
  branch, Redis, tunnel, secrets, Cloudflare Access on both addresses;
  `SETUP.md`, `update.bat`, `build-admin.sh` for the `admin-sandbox` image).
- `SERVD_SANDBOX=1` on the API blocks every outbound effect through
  `lib/sandbox.ts`: WhatsApp / email / push / webhooks / social resolve with a
  practice result, the fiscal POS and card machine use the TEST drivers,
  uploads go to a practice prefix, and a code is echoed (`practiceCode`) only
  to a caller who already proved who they are (2FA after the password, 2FA
  enrolment). **Any NEW outbound call (a message, a vendor, a gateway, an
  upload) must ask `sandboxBlocks(kind, …)` first.** On live
  (`SERVD_SANDBOX` unset) it is a no-op. `sandboxScrub` runs once per copy
  before the API serves (it also turns copied vendor connectors into the test
  driver with no address or keys). The boot check (`assertSandboxBoot`)
  reads `SERVD_SANDBOX` exactly as `isSandbox()` does (no trimming) and runs
  in `backend/entrypoint.sh` BEFORE any migration — never move a migration
  step above it.
- **Practice logins need only a name and a role (owner, 2026-10-15).** With
  `SERVD_SANDBOX=1`, `POST /auth/staff/invite` and `POST /auth/users` take a
  name + role (email / phone optional; `practiceStaffEmail` makes
  `practice.<name>.<hex>@gsfoods.pk`), the login is ACTIVE at once (no CEO
  approval) and the reply carries `temporaryPassword` once. Floor roles may
  sign in with that password there (`POST /auth/login`), and
  `assertPhoneForRole` is a no-op. Live is unchanged (tested both ways in
  `tests/sandboxMode.test.ts`).

### Head office and approval hand-over (D1/D3, 2026-10-15)

Everything ships OFF: no head office exists until the CEO runs the setup
wizard (`/ceo/head-offices/setup`; module `tenants`, API `/head-offices`, CEO
only, foreign rows 404). Contract: `backend/src/modules/headOffices/README.md`.

- **`Tenant.kind` (`TenantKind`: `company` | `head_office`).** A head office has
  its own HR, payroll and books and serves companies through `HeadOfficeLink`
  rows; it never has brands, menus, orders or a till (422
  `HEAD_OFFICE_HAS_NO_BRANDS`, `lib/headOffice.ts assertTradingCompany`) and
  no fiscal POS. Boot location seeding and `primaryTenantId()` only ever pick
  `kind: 'company'`; `ensureChartOfAccounts` still runs for head offices.
- **Head-office pairs ride the inter-company engine (owner, 2026-10-15: "reuse
  the existing inter-company transfer engine").** No second transfer table, no
  `head_office` due accounts: due from / due to are the pair accounts
  1450–1499 / 2150–2199 (`ensurePairAccounts`, created at link time);
  1400–1449 / 2100–2149 stay reserved and unused. A monthly charge is one
  `IntercompanyTransfer` per run line, `source 'ho_recharge'`,
  `sourceRef 'ho_recharge:<lineId>'`, via `postSystemTransferTx`; settlements
  are ordinary manual transfers. Head office books use 6990 "Costs Recharged to
  Group Companies" (resolved, never 6991+); each company gets "Head office
  charges — <HO>" at the first free code in 6200–6249.
- **The split is owner-set:** 37.5% GS Foods / 62.5% GS x Viva (3750 / 6250
  bps), created only by the setup wizard as "GS Head Office". Versioned per
  month (`splits.ts`); `splitByBps` is the ONE rounding rule (leftover paisa
  to the largest share at exactly 100%; below 100% the rest stays with the
  head office).
- **Recharge posting is OFF per head office** until the CA confirms the
  accounts (`HeadOfficeBooks.accountsConfirmedAt`) and the CEO sets
  `rechargeFromPeriod` (DB CHECK `head_office_books_enable_chk`). Any change
  to accounts, pool or links switches it back off. The worker (under
  `ENABLE_WORKERS`) only PREPARES and SUBMITS a run for approval — it never
  posts. **Still open with the accountant:** HO-Q1 (the cost pool — default =
  the head office's net cost, 5000–6999 at cost, no markup, 6990 excluded)
  and HO-Q3 (6990 contra-expense vs re-mapped to income — default
  contra-expense; the All-companies P&L would show income and cost until
  eliminations exist).
- **Reach and the lens are submit-only** (`lib/headOffice.ts`): a head-office
  login reaches its linked companies and picks one with the lens header
  (`x-servd-active-tenant`); in a reached company it may only SUBMIT (403
  `HEAD_OFFICE_SUBMIT_ONLY` on any other write; a short allow-list such as
  `POST /auth/staff/invite`). Approving is never reach — it needs the role
  path or a hand-over. `COMPANY_HEADER_NOT_ALLOWED` is enforced only for callers
  with reach. A new write route that a head office should be able to submit
  goes on that allow-list in the same change.
- **`APPROVAL_RIGHTS` (`lib/approvalRights.ts`) is the ONE registry of who
  approves what:** every `APPROVAL_TYPES` entry has a section, queue module,
  role path, delegable flag, module a delegate must hold and owner (company /
  head office); providers, approve routes, queue routes and the hand-over
  catalogue all read it. A new approval type is added there (and to
  `approvalSubject`) in the same change; tested. `assertCanApprove` order:
  role path (member of every company the item touches; an item that came
  through a head office goes to the CEO or a delegate, A3) → delegation path →
  separation of duties (403 `SELF_APPROVAL_BLOCKED`) → 403
  `APPROVAL_NOT_YOURS` / 404. Nothing is cached.
- **Delegation (`approvals/delegations.ts`, `/approvals/delegations`):** the
  CEO ONLY hands a SECTION (optionally narrowed to types) of a head office's
  companies to an active non-admin head-office member who holds the module.
  Never the `ceo` section. Rows are never edited — revoke + grant again.
  Checked live on every use (revoked, window, delegate active, still a member,
  module, link live); ending a link revokes that company's hand-overs in the
  same transaction. One head office per (company, section). Head-office-wide
  hand-overs only for `ho_recharge`. `OWN_PAY_IN_RUN`: a delegate (or a
  head-office run) never decides a payroll run carrying their own pay.
- **CEO-only list (never delegable):** `cash_voucher`, `fixed_asset_request`,
  `bad_debt`, `raast_void`, `grni_writeoff`, `stock_difference`,
  `on_account_client`, `cash_request_finance`, every password-role login, a
  journal REVERSAL, a recipe with no company, shared (no-company) servd pages
  and company-to-company inter-company transfers (a delegate decides
  head-office pairs only).
- **Locked by constants (owner has not said yes):** `DELEGATION_ENABLED`
  holds `storefront_publish: false` (Marketing) and `journal_request: false`
  (journal hand-over, A22) — a grant answers 422 `SECTION_NOT_YET_DELEGABLE`.
  Flip a constant only on the owner's word.
- **Head-office logins land on `/head-office`** (`ALWAYS_OPEN_PREFIXES` in
  `frontend/admin/src/lib/moduleCatalog.ts`); the CEO's pages are
  `/ceo/head-offices` and `/ceo/approvals/hand-over`.
- **Staff move to a head office only via `POST /hr/head-office-transfers`**
  (+ `/preview`; CEO only, `hr/transferRoutes.ts`; one transaction, first of a
  month) — never by editing an employee's company by hand. The wizard also
  retires `isHeadOffice` / cost-share / `head_office` contributions, but only
  once `headOfficeSetupApplied()` is true; before that planning, HR and
  contributions behave as today.
- **Closing:** `headOfficeCloseChecks` are in `CLOSE_CHECKS`. Linking, ending
  a link (`lastChargedPeriod`) and switching off follow README guards
  (`HEAD_OFFICE_IN_USE`, `DELEGATIONS_UNANSWERED`, `RUN_AFTER_LAST_CHARGED`).

### Delivery money and customers (resumed 2026-10-15)

Resumed from the 2026-10-13 park; everything here ships behind a switch.
Briefs: `.handoff/parked/2026-10-14/`.

- **Code-only delivery, per company, OFF by default**
  (`lib/deliveryRules.ts`, Setting `delivery.codeOnlyAt:<tenantId>`; CEO only
  on `/emergency-overrides` via `PUT /emergency-overrides/settings`, reason
  10+ characters, audit `delivery.code_only.switch`). ON: a delivery completes
  only with the customer's 4-digit code; the staff "Delivered" override is
  gone. OFF: staff Delivered, the admin/management code read and normal cancel
  of a picked-up delivery behave as before, and the COD flags, COD close check
  and COD tab stay quiet. Brief staff before switching a company on:
  deliveries already on the road lose Delivered.
- **Emergency overrides** (`/emergency-overrides`, module `emergency_overrides`;
  defaults RGM, chef, `fnb_manager`, `management`, CEO; not the co-owner):
  send the code to the rider (new code, WhatsApp to the rider, ONCE per order,
  mandatory reason; a collusion path, so audited and scored) and log
  returned food as waste. Every action answers 409 `CODE_ONLY_OFF` while the
  order's company has the switch off. Thin shell: the rules live in
  `dispatch/service.ts` and `orders/returnedFood.ts`.
- **COD custody (H5):** `lib/cod.ts` is the ONE definition (a cash payment
  still `pending` on a completed non-till order; statuses `with_rider`,
  `overdue` after `COD_PAY_IN_HOURS` = 12, `rider_owes`, `at_counter`).
  Rider debt on 1351 (own rider) or the inter-company `cod` transfer (fleet
  rider; `accounting/codPosting.ts`) is NEVER automatic: finance or the CEO
  books each one. Worker `codCustody` (every 30 min, switched-on companies
  only) flags `cod_cash_overdue` and `delivery_on_road_overdue`, once each,
  and posts nothing. **The month close is BLOCKED while any COD is pending**
  (owner DLV-COD-close, 2026-10-15: no proceeding until approval):
  `reconciliation/codCloseCheck.ts`, key `cod_with_rider`, severity block,
  overridable only by the CEO with `acknowledge {keys, reason ≥ 10}`; runs for
  every company with COD pending, switched on or not. Pickup cash at the
  counter is counted by the check but never flagged as a rider debt.
- **Customer strikes and bans are SERVD-WIDE (owner, 2026-10-15: "if strikes
  and bans is about customers accounts then its ok, let it be across servd" —
  REPLACES the per-company rule of 2026-10-13).** `lib/strikes.ts`: one
  standing per customer across companies (sum of ACTIVE strikes, `BAN_THRESHOLD`
  3, decay 12 months); the auto ban is one `CustomerBan` locking the account,
  email and phone at every brand of every company, enforced through
  `activeBanAtCompany`; at most one active auto ban per customer (unique index
  `customer_bans_one_active_auto_per_customer`, migration
  `20261015150000_bans_servd_wide`). Each strike and ban is stamped with the
  RAISING company: that company's managers (the CEO through membership)
  decide reversals, lifts and appeals; a legacy NULL-company ban is the CEO's.
  Other companies see the standing (count, blocked yes/no) and an anonymised
  "Another servd kitchen" incident — never the details. The mirror columns
  `Customer.strikeCount / bannedAt / isBlacklisted` are not enforced on.
  Customer-facing copy says "your servd account".
- **Ban appeals** are an `OrderComplaint` of kind `ban_appeal` on the existing
  Complaints queue (no second table; `complaints/appeals.ts`; one queue, any
  company in the customer's history sees it). Customer routes
  `GET /storefront/account/blocks`, `POST /storefront/account/ban-appeals`
  (3 a customer an hour). **Switch:** platform Setting `crm.banAppealsEnabled`,
  OFF by default, the CEO's on Complaints (`PUT /complaints/settings/appeals`);
  OFF = storefront routes 404, WhatsApp keeps the BANNED reply, no
  BlockedNotice. `release-contact` clears `Customer.phone` and is audited.
- **Pending owner/CA confirmation:** G1 (COD never paid), H5 (rider COD on
  1351) — built on the defaults above.

### On-account clients (resumed 2026-10-15)

Corporate clients who pay on a monthly statement. API
`/accounting/customer-accounts` (module `accounting`; `CLIENT_VIEWERS` /
`CLIENT_EDITORS` = admin, owner, management, finance — not `fnb_manager`);
till door `/pos/on-account/*`. Docs in the files' headers
(`receivables/customerAccounts.ts`, `pos/onAccountRoutes.ts`).

- **QR card = a bearer secret stored as a hash only** (`lib/onAccountCard.ts`:
  sha256 + last 4; the code is shown ONCE, rotate/revoke kill the old one).
  It never appears in logs, audit rows, errors or URLs — request BODIES only;
  lookup is rate-limited (20/min per login); an unknown or other-company card
  is the same 404.
- **One charge route:** `POST /pos/orders/:id/on-account` — never
  `POST /pos/payments` (it still refuses `on_account`). The WHOLE bill goes to
  the client (no part-pay), on an open shift of the order's company, no manager
  PIN: the card, the credit limit and the signature on the bill are the
  control. Charged at the CASH tax class (`lib/pricing.ts tenderOf`); a refund
  goes back on the account. Lock order everywhere: order → client account →
  invoice.
- **1110 vs 1115:** 1110 Customer receivable = invoiced / statement balances
  and booked on-account charges; 1115 Till clearing = till bills not settled
  on their drawer, money owed back on cancelled tickets, card tenders failed
  after the close, Raast customer-owes write-offs. Until a company is cut over
  both sit on 1110 (`tillClearingCode.ts`). **The cut-over is the CEO's, per
  company, never at boot** (`POST /accounting/till-clearing/cutover`; marker
  Setting `ledger.tillClearingCutoverAt:<tenantId>`; once the CA confirms; one
  balanced `ledger.till_clearing_split` entry per brand). A daily sweep moves
  late till-source lines (cut-over companies only); the 1110 tie-out is
  `GET /accounting/customer-accounts/tie-out`. A client cannot be approved
  (409 `TILL_CLEARING_NOT_SPLIT`) and the till hides the tender
  (`GET /pos/on-account/enabled`) until the cut-over, an active client and the
  CEO's approval all exist.
- **Statements are not tax invoices** ("Statement — not a tax invoice"). The
  sale's tax invoice / fiscal document is filed at completion as for any
  sale; the statement only collects bills for payment.
- **The CEO approves** every new client, every credit-limit INCREASE (a
  decrease or a suspension applies at once; reactivate is CEO only) and every
  bad debt (`bad_debt`, G12/H15). Approval type `on_account_client` is
  CEO-only, never delegable. **A statement write-off suspends the client**
  (`receivables/writeOffs.ts`). Close check `on_account_tieout` (warn,
  overridable, cut-over companies only). Statements, emails and reminders are
  manual (one reminder a Karachi day). **Pending owner/CA confirmation:** G14
  (on-account tender) and H14 (on-account tax invoice) — built on the defaults
  above.

### Trash bin (owner, 2026-10-15)

"Park delete / void / cancelled entries and recover them until deleted from
the Trash." `/trash` (admin page + API `/api/v1/trash`, contract
`backend/src/modules/trash/README.md`). Module id `trash` (CEO workspace,
grants nothing — like `approvals`); every login reaches the page and sees
only the types its modules + roles allow.

- **Every delete route that parks something calls `moveToTrash`
  (`lib/trash.ts`) in the SAME transaction as its delete** and still answers
  204. A new delete route adds a provider (`modules/trash/providers/*`) and a
  two-company test in the same change. Never a second trash table.
- Masters are **restored** (soft: clear `deletedAt`; hard-deleted: from the
  entry's snapshot with the same ids; status flips: `meta.previous`).
  Voided / cancelled **transactions are never restored — "Recover as copy"**
  makes a new draft through the module's own create route or form, in the
  ACTIVE company; the original keeps its status.
- **Only the CEO empties** ("Delete forever", reason ≥10). Money, tax, stock
  and anything the books point at is never erasable (409 `NOT_ERASABLE`) —
  the CEO may archive it from view. Nothing leaves automatically.
- Promo codes and allocation rules are soft-deleted (partial unique over live
  rows); every promo redemption read filters `deletedAt: null`.

### Night audit — sales module only (owner, 2026-10-16)

"It should not proceed for night run / audit until cash / card settlement /
bank transfers or any other payment mode is reconciled and closed" — and
"Night run / audit / day close is only for sales module". Contract:
`backend/src/modules/nightAudit/README.md`; page Finance → Night audit
(`/finance/night-audit`, API `/accounting/night-audit`, module `accounting`).

- **Two steps per company per Karachi business day** (`night_audit_days`):
  the night run (finance or the CEO) needs that day's SALES money settled —
  tills closed and counted, Raast matched, COD handed in, every other tender
  resolved — then the day is `audited` (locked, report saved). It becomes
  `closed` by itself once its card payout and the bank side of its sales money
  (till cash deposits, customer bank transfers) are matched (worker
  `nightAuditSettle`, posts nothing). A block is pushed through only by the
  CEO with a reason ≥10, audited and flagged.
- **The day lock is SALES ONLY** (`nightAudit/lock.ts` `isSalesSource`
  allow-list: order*, pos.*, shift.close, deposit.drop, Raast write-off, COD
  rider debt, loyalty earn/redeem). Supplier, petty cash, OpEx, CapEx,
  payroll, manual journals, receivables, inter-company, tax, fixed assets,
  gift cards and wallets never read it. A new sales posting source goes on
  that list in the same change.
- **Back-dated sales are the CEO's** (`nightAudit/backdate.ts`): voiding,
  comping, cancelling, reversing a card charge or issuing a credit note on a
  sale whose day is before today (final, or its day locked) answers 403
  `CEO_ONLY_BACKDATED` to everyone else; the CEO gives `backdatedReason` (≥10;
  422 `BACKDATED_REASON_REQUIRED`, the admin asks for it). Reopening a day is
  CEO-only. Today's refund of an older bill posts today and is not gated.
- **Month close** has the check `night_audit_days`: every business day of the
  month with sales must be `closed` (CEO-overridable).

### Notification bell (owner, 2026-10-16)

One bell at the top of the admin for every login, fed by what already exists
(it never replaces the approvals inbox or /exceptions; it tells the right
person and links there). Full list: `/me/notifications`. No phone push (owner:
"bell only for now") — any future outbound push asks `sandboxBlocks` first.

- **ONE writer:** `lib/staffNotify.ts` (`notifyStaff`, `notifyStaffMany`,
  `queueStaffNotify`); `StaffNotification` has `tenantId`, RLS, and is in the
  company-merge repoint list. A row's company comes from the ITEM, never the
  actor; recipients outside that company are dropped; the actor is never told.
  Never call it inside a `$transaction` body — queue it after commit; a notice
  can never fail the business action. `lib/notify.ts` is the CUSTOMER
  email/WhatsApp sender — a different thing.
- **Approvals:** "whoever must act next" — `approverIdsFor`
  (`lib/approvalRights.ts`) uses the approve route's own rule + the queue
  module; the CEO is told only for items at the CEO's end; a handed-over item
  tells the delegate AND the CEO. Decided notices go ONLY through
  `auditApproval` (`metadata.waitingUserIds` when the route clears the
  requester before the notice runs). A new approval type adds an
  `APPROVAL_NOTIFY` entry (`modules/approvals/notify.ts`) and a waiting hook
  (`approvalWaiting(type, id, { round })`) in the same change (tested).
- **Unusual activity → the CEO only** (admins of the flag's company), via the
  exception claim-poller (`workers/staffNotifications.ts`,
  `ExceptionFlag.notifiedAt`). Night audit: day audited / closed / not run →
  finance (with accounting) + the CEO. The "still awaiting settlement" warning
  waits for the accountant (H45) — `TODO(H45)`.

### Closed books are the CEO's (owner, 2026-10-16)

`accounting/closedBooks.ts`. A closed month refuses every posting (as
before). Reopening is CEO-only (with a reason); the reopened window
(Setting `ledger.reopenedThrough:<tenantId>`) takes person-made postings from
the CEO only until the CEO closes through it again (403
`CEO_ONLY_CLOSED_BOOKS`; automatic 'system' postings keep their own rules).
Cancelling / reversing an entry DATED in closed or reopened books is the
CEO's only (`reverseJournalEntry` checks it). Open months work as before.

### Parked (owner, 2026-10-13)

Delivery and customers, and corporate clients on account, were PARKED on
2026-10-13 and both RESUMED 2026-10-15 — see "Delivery money and customers"
and "On-account clients (resumed 2026-10-15)". Nothing from that park remains
parked except what each of those sections lists as not built (rider-debt
write-off, automatic COD debt booking, the per-company COD pay-in hours).
The plan, original briefs and generator stay in `.handoff/parked/2026-10-14/`
(start with `PARKED.md`) for reference.

### Rollback caveats (2026-10-15 release: head office, delivery, on account)

Never roll the API image back below this release once ANY of these exists:
a `Tenant` row of kind `head_office` (an older Prisma client throws on the
`TenantKind` enum), an `ho_recharge` transfer / head-office link / delegation,
a till-clearing cut-over marker, or a new enum value. Specifically:
- Below this release the per-company ban index and the old global ban logic
  return, and the unique index `customer_bans_one_active_auto_per_customer`
  (one auto ban per customer) conflicts with older per-company writes.
- Below this release the old image books on-account sales to 1030 and till
  clearing to 1110 again, and the staff Delivered route returns. Suspend every
  on-account client before any rollback, and re-run the cut-over after.
- Migrations `20261015120000_head_office`, `20261015120100_on_account_resume`
  and `20261015150000_bans_servd_wide` must sort after `20261015100000`; if one
  fails on deploy run `prisma migrate resolve --rolled-back <name>` in the api
  image before redeploying any image (P3009 blocks both).

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

**Subagents are tiered by the job (product owner, 2026-10-14 — replaces the
"Opus only" rule of 2026-09-27).** Use the cheapest model that will do the
job right the first time:

- **haiku** — lookups and mechanical work: searching, listing, reading logs,
  renames, copy edits, extracting reports, running a given test command.
- **sonnet** — ordinary building: UI pages and forms, small routes, tests,
  docs, wiring that follows an existing pattern.
- **opus at `effort: "medium"`** — the supervisors. On every large task an
  Opus agent acts as the CEO of that task: it plans and splits the work,
  hands the pieces to sonnet/haiku workers, watches what they hand back,
  reviews and gate-checks it, and sends work back when it is wrong. Opus also
  does the hard building itself: money, tax, ledger, auth/permissions,
  company separation, migrations. Raise the effort above medium only for a
  final gate on money/tax/auth code.
- No Fable for agents. The main session runs on whatever the owner sets with
  `/model` and stays the orchestrator.

Verification of money/tax/auth code is never delegated below Opus.

**Be conservative with tokens (owner, 2026-10-15).** Sub-agent work is
token-heavy, so:

- Default every worker to the LOWEST tier that can do it: haiku for
  look-ups, checks and mechanical edits; sonnet for ordinary building. Opus
  workers only for money, tax, ledger, auth/permissions, company separation
  and migrations.
- Every multi-agent task has ONE Opus agent as its CEO, above the
  lower-tier workers: it plans and splits the work, gives each worker a tight
  brief (files, what to change, how to check), reviews what comes back and
  sends wrong work back. The CEO does not redo workers' work itself.
- Gates scale with risk: one Opus gate (medium effort; high only for the
  final money/tax/auth gate) on critical streams; a sonnet or haiku check, or
  the orchestrator's own spot-check, on UI, docs and copy.
- Brief workers with paths and the exact change, not "read everything";
  don't fan out more agents than the work genuinely splits into; don't
  re-run a full sweep when a targeted check will do; reuse a finished agent
  (SendMessage) instead of briefing a new one.

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
- **Ship when done (owner, 2026-10-14):** once a task is complete AND verified
  (tsc, the affected tests, a production build, a click-through of the changed
  screens, and proof nothing else changed — e.g. a pixel diff of the pages it
  touches), deploy it to live without asking again. Tag the live images as
  rollback first, deploy only the images that changed, never ship unverified
  work that happens to sit on `main`, and smoke-check live afterwards.
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
