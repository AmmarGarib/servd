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

- **Brand info is Marketing's; companies are the CEO's (owner, 2026-10-20:
  "create a company can lie with CEO, but adding brand info etc can go to
  marketing manager" — REPLACES the CEO-only rule of 2026-10-14).** The
  brand editor (`/ceo/brands`, module `brands`, Marketing → Brand & site) is
  open to whoever holds `brands`: marketing and brand_manager by default
  (MODULE_GRANTS), anyone the CEO ticks on Workforce. `PATCH /concepts/:id` +
  `GET ?view=brand` check the module (403 `BRAND_EDITOR_ONLY`); a CHANGE to a
  CEO field (`BRAND_CEO_FIELDS` in `concepts/routes.ts`: tax rates, province,
  STRN / NTN / invoice details, POS ids, active, service vessel, portion
  forecast, the kit's look) by anyone but the CEO is 403
  `BRAND_FIELD_CEO_ONLY` (an unchanged value in a full save passes). Creating
  and deleting brands, and creating companies, stay the CEO's (CEO →
  Companies). `CEO_ONLY_MODULES` is `['backups']` only (2026-10-26). **Module access per person is the
  CEO's** (CEO → Logins & access → Logins & module access, `/workforce`; the
  "What they can open" panel shows to the CEO only); HR keeps only the role
  presets. The Configuration hub stays the CEO's (CEO → Company rules).
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
- **A request HR raised skips its own HR step (owner, 2026-10-21: "Request
  generated by HR is asking for approval by HR, HR should get approval option
  when request is generated by others").** `hr/routes.ts signHrStepRaisedByHr`
  (create, submit, after each decision, and a boot sweep): an `hr` step that a
  non-HR step follows, on a record raised by an active `hr` login holding
  `staff_hr`, is signed in the raiser's name (`ApprovalEntry.auto`, "Raised by
  HR") and the record moves to the next approver. Never the LAST step: **the
  last `hr` step of a request an `hr` login raised is the CEO's (owner,
  2026-10-22: "Send last-step HR requests to the CEO")** — `decideRight` treats
  it as a CEO step (`subject.raisedByHr`, read in `approvalSubject` and
  `hrStepApprovers`), so no HR login, management included, gives the final
  sign-off on what HR raised. Never a request about the raiser (its HR step
  waits as usual). `actedOnBy` ignores
  `auto` entries, so the raiser can still edit / cancel / recalculate.
  **The CEO always sees it (owner, 2026-10-30: "keep ceo for ALL … needs to
  show up on my approval page"):** a CEO step is never an "override" for the
  CEO, even when the CEO signed an earlier step (`logic.ts canActOnStep`; e.g.
  someone who reports to the CEO), and `/hr/approvals` lists for the CEO any
  step nobody else can take (`approvalRights.ts hrStepApprovers`, the bell's
  rule — no manager login, only the raising HR login, …); it reads up to 5,000
  waiting records. **Re-raise:** `POST /hr/records/:section/:id/reraise
  {data?, note?}` (HR_BACK_OFFICE; the record's own company, else 404) raises a
  rejected / cancelled request again as a new record (`_reraisedFrom`; one live
  copy, 409 `ALREADY_RERAISED`; approved → 409 `CANCEL_FIRST`; attendance → edit
  it); admin "Re-raise" on the record. Tests: `tests/hrRaisedCeoInbox.test.ts`.
- **HODs raise manpower requisitions for their own department (owner,
  2026-10-22: "Give manpower requisition option on screen of all HODs, for
  their own department only").** An HOD = a login whose own active employee
  record has a department and ≥1 active direct report (`hr/routes.ts
  hodDepartmentOf`). `/hr/me` lists `requisition` in `canRequest` (+
  `hodDepartment`) for them only; `GET /hr/me/forms/requisition` hides the
  Department field and `POST /hr/me/records/requisition` sets it to the HOD's
  own department whatever is sent (403 for anyone else), files it in the HOD's
  company, and signs the HOD step by raising (`auto`) — it waits on HR, then
  management. Tests: `tests/hodRequisition.test.ts`.
- **HR letters from Word files (owner, 2026-10-22: "It should give option to
  HR to add letter in word file … employee details should be picked through
  selected employee field on auto basis"; "We don't know HTML language").**
  The ONE letters store stays `HrLetterTemplate` (per company): a letter is
  the built-in wording, HR's typed wording (a normal text editor on HR →
  Letters — never an HTML box) or HR's own Word file (`wordFile`, ≤700 KB,
  so the Trash snapshot fits). HR may add its own letters (`custom`, key
  `custom_<hex>`). Fields are typed in plain words — `{{Employee Name}}`
  (`letters.ts LETTER_FIELDS`; a request's fields by their form label; the
  old `{{employee.fullName}}` form still works). `lib/docx.ts` (no library)
  fills a Word file across split runs in body, headers and footers and keeps
  everything else byte-for-byte; it also makes the print copy and turns a
  typed letter into Word. Routes: `POST /hr/letters`, `PUT|DELETE
  /hr/letters/:key/word`, `GET /hr/letters/:key/word?employeeId|recordId`
  (filled; none = the blank file), `GET /:key/preview`, `GET /letters/fields`.
  Tests: `tests/hrLetterWord.test.ts`.
- **Every staff login is an @gsfoods.pk email + password — WhatsApp code sign-in is RETIRED (owner, 2026-10-28: "No
  WhatsApp code for anyone anymore. Gsfoods.pk email and Password for everyone"; REPLACES C14 of 2026-10-26).**
  `auth/middleware.ts`: `OTP_LOGIN_ROLES` is empty and `usesOtpLogin()` is false for every role; `FLOOR_ROLES` /
  `isFloorRole` keep the floor CATEGORY (HR's floor invites active at once — `offboarding.ts activeAtOnce`; HR approves
  them — `approvalRights.ts`). `POST /auth/staff/otp/request|verify` and `/auth/staff/:id/sign-in-code` answer 410
  `STAFF_CODE_LOGIN_RETIRED`; every invite needs an @gsfoods.pk email (400 `EMAIL_REQUIRED`), no role needs a phone;
  activation sends every login a password link; HR's "New password" / "Send password reset link" work for floor
  logins. Customers and riders keep their own phone codes. `/hr/me*` (My HR) is unchanged. Tests:
  `tests/staffOtpLogin.test.ts` (the retirement), `tests/ownerAuthAnswers.test.ts`.
  **Kiosk PIN clock-in is REMOVED (owner, 2026-10-27: "this is redundant now, we will give all staff proper
  logins").** Every staff member clocks in with their OWN login (floor staff by WhatsApp code). Gone:
  `POST /time-clock/kiosk/punch`, `POST|DELETE /hr/employees/:id/kiosk-pin`, `hr/kioskPin.ts`, `kioskPinSet` on
  the employee profile, the admin / tablet kiosk modes (404, no shim). `HrEmployee.kioskPinHash` stays (unread).
  Old attendance days with `_source` / punch source `kiosk` still count everywhere (attendanceDays, payroll, today
  board, punch log, tip pools, reports; shown as "Kiosk (old)"). HR's list to finish before 1 Nov (no punch =
  absent): `GET /hr/staff-without-login` (HR_BACK_OFFICE, companies in view) → HR → Attendance → "Staff without a
  login". Tests: `tests/staffWithoutLogin.test.ts`.
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
- **Privacy / Terms hidden from the website (owner S8, 2026-10-26: "hide from website … we'll add later for app").** No footer, brand-footer, cookie-notice, sitemap or llms link to `/privacy` / `/terms`; the pages stay (noindex). `sections/safe.ts isHiddenLegalHref` makes the servd and brand footers and the cookie notice skip such links, so saved layouts hide them too. The approvals inbox filter is ONE drop-down (U9c).
- **One approvals inbox** (`/ceo/approvals`, `GET /approvals` +
  `/approvals/counts`, `backend/src/modules/approvals/`; owner decision D3).
  It READS each module's own queue as the caller (new logins, website
  publishes, POs over the limit, recipes, HR steps, payroll, tip pools, stock
  transfers) and every button calls the module's EXISTING approve/reject
  route, whose own guard decides — never add a second approval engine. A new
  approval type is a provider in that module. **Each item shows only to
  whoever must act on it NOW (owner, 2026-10-30: "The CEO's Approval tab
  should display only those requests that have been specifically forwarded to
  the CEO").** Where the CEO is only an override of someone else's step
  (`APPROVAL_RIGHTS[type].overrideRoles: ['admin']` — `payroll_finance_review`,
  `cash_request_finance`, `stock_transfer`) the CEO's inbox, counts and bell
  list an item only at the CEO's end (section ceo, no company, through a head
  office) or when nobody else may decide it (stranded: no active designated
  login of that company holding the queue module who is not its submitter) —
  `lib/approvalRights.ts ceoMustSee`, the same rule as `approverIdsFor`; HR
  steps via `hrStepApprovers`. A handed-over item counts only for the
  delegate (the CEO keeps the collapsed "handed over" summary; the bell still
  tells both). A new type where the CEO merely overrides adds `overrideRoles`.
  Tests: `tests/approvalsInboxHierarchy.test.ts`. `/hr/approvals` ("My
  approvals") redirects to `/ceo/approvals?type=hr_request`. Hand-over of
  approval types to head-office HODs comes with head office (after Monday).
- **Module Access binds managers too (owner C2, 2026-10-26: "Make my Module Access ticks apply to managers
  too").** `opex/moduleGate.ts moduleGateForNewRoles` exempts nobody (the CEO holds every module): OpEx
  ('capital'), Positions ('staff_directory' | 'capital'), petty cash + deposit drops ('accounting'), the
  staff-meal log; stock counts are a GATED_PREFIXES rule (`/crosschecks/physical-counts`: inventory |
  accounting). No MODULE_GRANTS: defaults are unchanged, and a saved row lacking the module was the CEO's
  untick (those managers were already refused the page). Box custodians keep their own paths.
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
- **Bulk approve (owner, 2026-10-22: "It should go for approval in bulk, not
  individually").** The inbox has a tick per item, "Select all N" per type and
  "Approve N selected". HR requests go in ONE call per company to `POST
  /hr/records/decide-many {items:[{section,id}] ≤200, decision, note?}`, which
  runs each through `decideOne` — the single decide route's own body (company,
  step, right, separation of duties, claim) — and answers per item (one refusal
  never stops the rest; a loan is never in bulk, `LOAN_NOT_IN_BULK`). Every
  other type calls its own approve route item by item. An item whose approve
  needs input, options, a payment classification or is disabled is never
  selectable. Tests: `tests/hrBulkDecide.test.ts`.
- **Wage changes and guest-list downloads go to the CEO (owner, 2026-10-27: "through the manager channel first,
  and the CEO gives FINAL approval").** Approval types `wage_change` and `customer_export` (section ceo, NOT
  delegable for now — the owner will hand them over later; flip `delegable` AND `decideRight`'s 'ceo' step
  together). Wage: no new store — a salary revision (or a promotion carrying a new gross) in the HR request
  engine whose steps always END with the CEO (`hr/service.ts workflowOf` / `isWageChange` / `wageAtCeoStep`);
  a non-CEO salary edit on `PATCH /hr/employees/:id` answers 202 `{ pendingApproval, request, employee }`
  (other fields save at once; 409 `WAGE_CHANGE_PENDING` while one waits) and raises it effective today; at its
  CEO step it is `wage_change` in the inbox / bell / audit (reject note ≥10, 422 `NOTE_REQUIRED`), never
  `hr_request`; withdraw = the record's cancel route; the CEO's own edit applies at once; payroll reads the
  master + APPROVED revisions only. Guest list: `modules/crm/customerExports.ts` (`CustomerExportRequest`,
  tenantId, RLS, merge repoint) — every download with phones / emails (`GET /crm/customers/export`,
  `GET /waitlist/signups.csv`) is the CEO's at once (403 `EXPORT_NEEDS_CEO` for anyone else); others `POST
  /crm/exports {kind, filters, reason ≥10}` → CEO approves → ONE download by the requester within 24 h (409
  `EXPORT_ALREADY_DOWNLOADED`, 410 `EXPORT_EXPIRED`). A new export carrying customer phones / emails goes
  through this, never its own route. Tests: `tests/wageExportApproval.test.ts`.
- **User audit log** (`/configuration/audit-log`, module `audit_log`):
  identity trail incl. `auth.login`, `auth.login_failed`, `auth.otp_login`,
  `auth.2fa_failed`, `auth.logout`. The books' trail
  (`/accounting/audit-log`) stays CEO + management only.
- **Social pages are PER BRAND; Marketing connects, the CEO approves (owner
  C18, 2026-10-26: "Approval goes thru me, marketing can connect").**
  `SocialConnection` (`social_connections`, tenantId = the brand's company, RLS,
  merge repoint; one `approved` + one `pending` per brand, partial uniques).
  `modules/socialConnections/`: `GET /social-connections`, `POST
  /:conceptId/connect` (MARKETING_TEAM holding `calendar` or `brands`; another
  company's brand 404), the CEO's queue `GET /requests?status=pending`, `POST
  /requests/:id/approve | reject {pageId}` (ADMIN_ONLY, 409
  `CONNECTION_CHANGED` / `CONNECTION_NOT_PENDING`); approval type
  `social_connection` (section ceo, never delegable). The OAuth callback keeps
  its registered address `/integrations/social/callback`; a CEO's own connect is
  the approval. ONLY an approved row posts (`approvedConnectionFor`, read by
  `workers/socialPublish.ts` from the event's brand); until approval the brand's
  previous approved page keeps posting. The page token is sealed with
  `lib/secretBox.ts` (plain while no key; encrypted on the next read) — /health
  `socialTokensAtRest`; responses carry `tokenHint` only. The old global
  `fb_page_*` settings move once at boot to a `legacy` row used for NO brand
  (the CEO gets a bell notice to reconnect per brand) — or, if servd has exactly
  one live brand, to that brand's PENDING connection. Admin: Calendar → Social
  pages (`/calendar/social`). Tests: `tests/socialCampaigns.test.ts`.
- **Scheduled campaigns send; WhatsApp campaigns are off (owner B9 / C19,
  2026-10-26: "I'll add per brand numbers as we scale ops").** `POST
  /crm/campaigns/:id/schedule {scheduledAt}` / `/:id/cancel-schedule` (or
  `scheduledAt` on create; ≥1 min ahead, ≤1 year; company-scoped 404).
  `workers/campaignSchedule.ts` (every minute, per company, ≤5 a company a
  tick) sends due ones through `modules/crm/campaignBroadcast.ts
  claimAndBroadcast` — THE one sender, also behind "Send now": claim first
  (exactly once, 409 `CAMPAIGN_ALREADY_SENT`), audience = the segment inside the
  campaign's company (opt-outs / bans out), one `CampaignSend` per recipient,
  email through `lib/notify.ts`, paced (`CAMPAIGN_SEND_PAUSE_MS`), practice copy
  sends nothing. WhatsApp (and legacy 'sms') campaigns are refused to schedule
  or send — 422 `WHATSAPP_CAMPAIGN_NEEDS_OWN_NUMBER` — and a due one is marked
  failed: never on the shared sign-in-code number. Re-open only with a separate
  campaign number.

## Director logins (owner, 2026-10-18)

"A new category of login, 'Director'. For Yusuf and Ali, partners in Flipd, to
be able to see how business is doing." A director sees ONLY the brands on its
login (`User.directorConceptIds`), everything for those brands, strictly
read-only (CSV downloads OK). Migration `20261018100000_director_role`.

- **Secure by default:** the auth middleware refuses role `director` on EVERY
  route outside `DIRECTOR_ROUTES` (`auth/middleware.ts`: GET `/director/*`,
  `/permissions/me`, `/auth/account`, refresh / logout / change password /
  2FA) with 403 `DIRECTOR_READ_ONLY` — whatever the route's own role list says
  (a bare `requireAuth()` included). `ALL_STAFF` excludes director
  (`EVERY_LOGIN` = all roles, only for a login's own session routes); sockets
  refuse it at the handshake. Never add director to a role list; a new
  director screen is a GET under `/director` and nothing else.
- **ONE API:** `GET /director/*` (`modules/director/`, `requireAuth('director',
  'admin')` — the CEO previews any brand of their companies). The brand list
  comes from the LOGIN, read live (`director/access.ts`), never the client: a
  conceptId outside it is 404; no brands = empty, never everything. Every
  figure reuses the existing function with the brand filter (sales
  `reports/service.ts`, P&L `brandPnl` → the brand's own row only, food cost
  `foodCostSummary`, menu `getMenuEngineering`); reviews / complaints select no
  customer and mask phones / emails in free text. Nothing names another brand
  or a company total.
- **Modules fixed:** a director holds exactly `director_view` (Director
  workspace, `lib/workspaces.ts`); no preset row, per-person tick or
  moduleAllow changes it (`DIRECTOR_PRESET_FIXED` / `DIRECTOR_MODULES_FIXED`
  422; HR 403 `PRESET_CEO_ONLY`); nobody else but the CEO holds it.
- **Only the CEO makes one:** `POST /auth/users` / `PATCH /auth/users/:id`
  with `directorConceptIds` (≥1, each a live brand of a company the CEO is a
  member of — 422 `DIRECTOR_NEEDS_BRAND` / `BRAND_NOT_IN_COMPANY`); the
  director's companies are exactly its brands' companies. Never invited (no
  `CHILD_ROLES` entry has it); HR cannot reissue its password or send it a
  reset link. Admin: Workforce → Directors (brand picker); a director lands on
  `/director` in its own shell (`components/ui/DirectorShell.tsx`) and every
  other page is refused (`canOpenPath`). Tests: `tests/directorRole.test.ts`.

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

- **Staff 2FA is RETIRED (owner, 2026-10-26: "remove two-step sign-in; nobody
  has it on today").** `POST /auth/login` always returns a session (no
  `twoFactorRequired`); every `/auth/2fa/*` route and `/auth/users/:id/2fa/reset`
  answer 410 `TWO_STEP_RETIRED`; migration `20261027110000` cleared every
  enrolment (columns kept, read by nothing); `type: 'mfa'` tokens are refused
  everywhere. The admin login has no code step. Never re-add a second factor
  without the owner.
- **A staff sign-in lasts ONE SHIFT (owner B1, 2026-10-26: "Signin can last 1
  shift … at shift close servd should auto sign u out no matter who u are.
  However people can login to servd outside the office").**
  `auth/sessionEnd.ts staffSessionEndsAt` is THE rule, computed once at
  sign-in (`service.ts issueShiftSession` — password, WhatsApp code, change
  password): the nearest end of the person's shift today per `hr/rota.ts
  rotaFor` (roster / swap / /scheduling / the company default rota; yesterday's
  overnight shift still running counts), else — no HR record (CEO, IT), day
  off, leave, or signing in after the shift — midnight PKT; never over 24 h.
  The refresh token's exp and claim `se` ARE that end; access tokens never
  outlive it; refresh after it → 401 `SESSION_ENDED` (a pre-release refresh
  token with no `se` too: everyone signs in once after deploy); the admin then
  shows "Your shift ended — sign in again" (`lib/api.ts signInPath`,
  `/login?ended=shift`). Closing a till drawer (`POST /pos/shifts/:id/close`)
  stamps the drawer's cashier `User.sessionsEndedAt`; every session issued
  before it is refused (401 `SESSION_ENDED`, middleware + refresh) once
  `SHIFT_CLOSE_GRACE_MS` (5 min, for the Z-report) has passed; worker
  `shiftSessions` (every 5 min) stamps drawers closed by any other path.
  `issueStaffSession(user)` without an end (tests, tooling) = 24 h. Customers
  and riders are unchanged. Landing after sign-in stays `/w` → the person's
  own workspace (owner 2026-10-16). Tests: `tests/shiftSessions.test.ts`.

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

- **Dependencies (2026-10-23; Next 15 on 2026-10-26, owner F12):** both Next.js apps are on
  **Next 15.5.28 + React 19.2.8** (pinned exactly; report and rollback in docs/NEXT15_UPGRADE.md —
  `params` / `searchParams` / `cookies()` / `headers()` are async). The image optimizer stays OFF in
  both apps (`images: { unoptimized: true }`, nothing uses `next/image`; `/_next/image` answers 404) —
  never re-add a wildcard `remotePatterns` such as `*.r2.cloudflarestorage.com`; re-enable only for
  our own media host. The API is on Fastify 5. Don't
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
| `GA_MEASUREMENT_ID` | (optional, owner 2026-10-26) The storefront's GA4 id (`G-XXXXXXXXXX`), a repo variable or secret; the workflow passes it as the `NEXT_PUBLIC_GA4_ID` build-arg. Unset = dark: no analytics script, no consent notice. Manual fallback: add `--build-arg NEXT_PUBLIC_GA4_ID=G-…` to the storefront build. | `G-ABC123XYZ9` |
| `SENTRY_DSN_API` | **Box env, NOT a GitHub secret** (owner 2026-10-26) — put it in the box's `deploy/.env.production` (the API's env_file; not in compose `environment`, an empty value there would override it). Turns on Sentry error tracking in the API (`lib/errorTracking.ts`): 5xx from the Fastify error handler, unhandled rejections / uncaught exceptions; never 4xx, bodies, headers, cookies, phones or emails. Unset = off; never sent from a practice copy. | `https://…@o0.ingest.sentry.io/0` |
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

**docs/rider-app.md is the contract.** Riders sign in like staff (owner,
2026-10-28: "Riders same as staff — Gsfoods email + password"): an @gsfoods.pk
`Rider.email` (required on add, unique, never a staff login's — 409
`EMAIL_TAKEN`) + a password the manager issues on Riders (`POST
/riders/:id/new-password`, shown once, ends older sessions); `POST
/rider-auth/login {email, password}`; the WhatsApp code routes answer 410
`RIDER_CODE_LOGIN_RETIRED`. Rider rows never carry `passwordHash` in a
response (`withoutSecret`, `hasPassword`). **Customers verify a code
only at sign-up and to reset a forgotten password** (owner, 2026-10-28;
`/auth/customer/password/forgot|reset` — one code to the account's OWN phone +
email); everyday sign-in is email + password; the emailed sign-in link
(`/auth/customer/request|verify`) answers 410 `CUSTOMER_LINK_LOGIN_RETIRED`.
Riders' tokens are their own (`/rider-auth/*`, token types `rider` / `rider_refresh` — a
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
- **Rider documents are private (owner C16, 2026-10-27).** CNIC, licence and bike papers are files on the ONE
  record-files store, owner type `rider_document` (a `Rider` row; images + PDF; no new table, no URL fields).
  Read + attach = `MANAGERS` behind the `riders` module gate (`gateAs('/riders')`), scoped to the RIDER's company
  (foreign rider 404), files stamped with the rider's `tenantId`; rider tokens never reach `/record-files`. Admin:
  Riders -> Roster -> "Documents (private)" (`RecordFiles`). Tests: `tests/recordFiles.test.ts`.
- **Not built yet:** earnings/payouts, push notifications for offers (the app
  polls), store release (EAS, icons, Play background-location declaration),
  KYC, route optimisation.

### POS connector + pre-bills (2026-10-10, owner amendments binding)

**SRB direct (owner, 2026-10-30 — REVERSES "never add a direct authority
client" for SRB only): "servd files sales tax invoices DIRECTLY with SRB from
its own till."** SRB only — FBR is not used; Keenu is no longer the fiscal POS
(it may stay as a card machine, the terminal connector, unchanged). The filer
is ONE driver inside the connector framework: `connectors/drivers/srb.ts`
(driver `srb`, "SRB direct (servd files itself)", in `FISCAL_DRIVERS`; needs
an API key = SRB's `pos_pass`, sealed by secretBox; `settings.srb = {posUser,
live}` — live off = SRB transType "Test", a dry run is always Test). Flat
JSON `toSrbInvoiceFields` + credentials to
`https://pos.srb.gos.pk/ePOSGateway/v1/SalesInvoiceService.api`; resCode
"00" → filed with `srbInvoiceId` and the QRCodeLink as `qrPayload` +
`verifyUrl` (printed as a QR); refunds = invoiceType 2; no lookup (an unknown
outcome is resent with the SAME deterministic invoiceId; a duplicate refusal
→ rejected + alert, recorded by hand); zeroValue false; no pushBill. The POS
user / Live switch cannot change while live (409 `SWITCH_OFF_FIRST`); go-live
needs them set and Live. Never a second filer, queue or table, and no other
authority client. The old external-fiscal-POS path (`http`) still works.
No `FBR_*` / `SRB_*` env vars (credentials are per company on the page).
Everything goes through `backend/src/connectors/` (README there; vendor
contract `docs/pos-connector-api.md`; operator runbook `docs/TAX_SETUP.md`
§4A). Tests: `tests/srbDirectDriver.test.ts`.

- **The connector:** one `PosConnector` row per company per kind — `fiscal`
  (the fiscal POS) and `terminal` (the card machine), so they can be
  different vendors. Drivers: `none`, `test` (built in, deterministic, no
  network, `TEST-…` numbers, receipts say `TEST — NOT A FISCAL INVOICE`),
  `http` ("servd connector API v1") and `srb` (SRB direct, 2026-10-30;
  `registry.ts DIRECT_FISCAL_DRIVERS`). A real vendor is one file in
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
- **A credit note on a completed, unrefunded bill (owner, 2026-10-17: "Allow
  it, owed back")** is a sales return: one entry `order.credit_note:<cnId>`
  (revenue to the account the sale credited, service, tips, delivery fee and
  output tax back) with the money OWED BACK on till clearing (1110 / 1115,
  memo REFUND DUE) — never cash/card; one `void:<orderId>` fiscal refund; the
  order goes `refunded`. The till pays it out through `refundOrder`
  (`payOutCreditNote`: Dr till clearing / Cr the tender, no fiscal document,
  rows marked `gatewayMeta.refund.creditNoteId`, never revenue) or on the
  card machine (`POST /pos/terminal/refunds`; `assertRefundAllowed` admits a
  `refunded` order only while its credit note still owes back — minus pay-outs
  and in-flight machine refunds; booked on confirmation as the same hand-back
  Dr till clearing / Cr 1030, once per `terminalChargeId`). 422 `CASH_NOT_PAID_IN` (COD still with a rider),
  `ON_ACCOUNT_USE_REFUND`; second credit note 409 `CREDIT_NOTE_EXISTS`.
- **Manager-only voids:** every item void and every whole-order cancel/void
  of a rung-up order needs a manager — the manager's own login or a valid
  same-company manager PIN (`MANAGER_OVERRIDE_REQUIRED` /
  `INVALID_MANAGER_PIN`, 403); `approverId` always recorded. A cashier or
  server can never void alone. **Finance approves a whole-ticket cancel too** (owner, 2026-10-24: "Hasnain should also have manager pin to cancel ticket with reason"): `lib/roles.ts TICKET_CANCEL_APPROVERS` (override approvers + finance) on `POST /orders/:id/cancel` only — signed in or by PIN; finance approves no line void, refund, comp, discount or pay-out. Finance may set its own PIN (`canHoldOverridePin`).
- **Manager PINs are 6–8 digits (owner C1, 2026-10-26: "Managers and CEO need at least 6 digits (short PINs
  changed at next use)").** Every new override PIN (`managerPin.ts preparePin`: CEO create / edit,
  `/auth/pin/change`) is 6–8 digits — 422 `PIN_TOO_SHORT`. A stored 4–5 digit PIN still approves: its first use
  stamps `User.pinChangeRequiredAt` and tells the holder on the bell; `/auth/account` returns
  `pinChangeRequired` / `pinChangeBy` (account page banner); `SHORT_PIN_GRACE_HOURS` (72) after that first
  use it is refused (403 `PIN_CHANGE_REQUIRED`) until a new PIN is set. The 5-tries / 15-minute lock is
  unchanged. There are no kiosk PINs any more: kiosk PIN clock-in was removed (owner, 2026-10-27) — see "Floor
  staff sign in with a code".
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
  **A request raised by a finance login skips the finance step** (owner, 2026-10-24: "request raised by Hasnain should go to CEO directly, no need for finance approval"): raise / resubmit → `finance_approved` signed by the raiser; a boot step (`forwardFinanceRaisedRequests`) moves ones still waiting.
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
- **Deposit slips are files, not a URL (owner, 2026-10-16: "it should ask
  for attachment instead of URL for supporting docs").** A deposit drop's
  slips live in the ONE evidence store — `CashVoucherAttachment` kind
  `deposit_slip`, `depositDropId` (migration `20261016200000`; the owner CHECK
  takes it), stamped with the DROP's company; never a second attachment table.
  `POST /trustops/deposit-drops` takes `files` (0–5, JPEG / PNG / WebP / PDF
  through `lib/evidenceFile.ts`, all checked before anything is written, saved
  with the drop in one transaction); `POST /deposit-drops/:id/files` adds them
  later (≤5 per drop, 409 `TOO_MANY_FILES`) and resolves that drop's "without a
  deposit slip" flag (raised only at ≥ PKR 1,000 with no file and no legacy
  `receiptUrl`, which is still accepted); `GET /deposit-drops/:id/files/:fileId`
  serves it; the list carries file metadata only, never bytes. Tests:
  `tests/depositDropFiles.test.ts`.
- **Split bank bags (owner, 2026-10-16):** a deposit drop may be split across
  several shifts (`DepositDropShift`, `tenantId`, RLS, merge repoint; shares
  add up to the drop's amount): `POST /trustops/deposit-drops
  {shifts:[{shiftId, amountCents}]}` or the single `shiftId` (422
  `SPLIT_NOT_EQUAL_DEPOSIT` / `SHIFT_LISTED_TWICE` / `SHIFT_AND_SHIFTS` /
  `SHIFT_NOT_IN_COMPANY`). `depositPosting.ts dropAllocations` is the one
  reader (a drop naming a shift with no allocation rows = one full share).
  Each share takes from its shift what earlier bags left — safe drops, then
  drawer takings, the rest from 1010; new drops lock per shift and stamp
  `droppedAt` inside the lock. The variance is against what is still to bank;
  a bag for a shift that holds cash is flagged even when nothing is left (cash
  over); a bag whose shifts all add up within tolerance raises no flag and
  resolves the earlier variance flags. Night audit `cash_not_banked` compares
  amounts per shift (nothing banked blocks; part banked blocks beyond the cash
  tolerance).
- **Cash voucher pay and confirmations (owner, 2026-10-16):** the pay goes
  through only if nothing it read changed — category, brand, holder, amount,
  purpose, payee name (409 `VOUCHER_CHANGED`). Finance or the CEO may record
  cash received on the holder's behalf with a reason (`POST
  /:id/confirm-received-on-behalf`, audit `confirm_received` via
  `finance_on_behalf`), never the raiser / holder (409 `SELF_APPROVE`) and
  never whoever paid it (409 `PAYER_CANNOT_CONFIRM`). Petty cash: only
  uploaded receipts (`receiptIds`) satisfy the photo rule; `receiptUrl` is
  metadata.
- **Equipment on a payee voucher (owner, 2026-10-19).** A finance payee
  voucher (kind `expense` only — a cash request is 422
  `ASSET_ONLY_ON_PAYEE_VOUCHER`) may name a fixed-asset class
  (`CashVoucher.assetClassId`, an active non-pooled class of the VOUCHER's
  company — 422 `ASSET_CLASS_NOT_IN_COMPANY` / `POOLED_CLASS_USE_QUICK_BUY`)
  instead of an expense account (`category` null; the class satisfies the
  equipment check), plus `assetLocationId` (required with no brand: 422
  `LOCATION_REQUIRED_FOR_SHARED`). Finance's pay goes through the ONE Quick-buy
  engine (`financePlanning/capexPosting.ts recordEquipmentPurchaseTx`, which
  `POST /finance/capex/quick-buy` also uses): a capital line on the outlet's
  standing project, its payment `capex.payment:<id>` Dr 1340 / Cr 1010 | the
  bank (no WHT) — from a box through `recordPettyCashSpendTx`'s capex line
  (Cr 1011) — and the same `capitalise` request for the CEO
  (`capexLineId` / `capitaliseEventId` on the voucher). Approved: Dr class cost
  / Cr 1340 → register → monthly depreciation; rejected: the cost stays on 1340
  as an advance (as a Quick buy's). **"General — to be assigned"** (owner, 2026-10-19): ONE
  inactive holding Location per company (`lib/generalLocation.ts`, slug
  `general-<tenantId>`, created on first read of the outlet lists), listed first
  in the voucher's and Quick buy's outlet pickers; equipment parked there is moved
  to its outlet later with a normal asset transfer. The documents check books nothing. Options:
  `GET /trustops/cash-vouchers/raise-options`. Tests:
  `tests/cashVoucherAsset.test.ts`.
- **"To pay from" on a payee voucher (owner, 2026-10-19).** Chosen at raise:
  `payFrom` cash | bank (+ `payFromBankAccountId`) | credit (+ `supplierId`, a
  live supplier of the voucher's company — 422 `SUPPLIER_NOT_IN_COMPANY`),
  stored as `plannedPaySource` / `plannedBankAccountId` / `supplierId`. Cash and
  bank only prefill finance's pay (source omitted → cash on hand / that bank;
  finance may pick another). Credit (`POST /:id/pay {source:'credit'}`, same
  people and gates as a pay) hands no cash over: an expense voucher becomes a
  SUPPLIER BILL through procurement's own engine (`createBill` =
  `prepareBill` + `insertBillTx` + `afterBillCreated`; bill number = the voucher
  number, due today unless `billDueDate`; Dr the 6xxx / Cr 2010, WHT per the
  supplier) — `supplierBillId`, `paySource 'credit'`, paid later through
  Supplier payments, in AP aging; an equipment voucher on credit raises the
  CapEx line on that supplier with no payment and the capitalisation request
  (the CEO's approval books Dr class cost / Cr 2012). Never a direct 2010
  journal. CHECKs `cash_vouchers_pay_source_credit_chk` /
  `cash_vouchers_planned_pay_chk` (migration `20261019110000`). Tests:
  `tests/cashVoucherPayFrom.test.ts`.
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
  The edit's reversal is dated on the ORIGINAL's day (today only when that day
  is in a closed month); `GET /accounting/period-close` returns
  `reopenedThrough`, and the journal page warns about it, blocks non-CEO
  posting into it and hides Edit / Cancel on closed-books entries for non-CEO
  ("Closed books — CEO only"; Request reversal stays).
  Still the CEO's: a register-account override (403
  `REGISTER_OVERRIDE_CEO_ONLY`) and anything dated in closed or reopened books
  (`closedBooks.ts`). Journal requests (`/journal-requests`) stay for the
  other preparers (owner, management).
  **Since 2026-10-23 a change of an EXISTING manual entry is split (owner:
  "option to edit/cancel/void any back dated or current Journal manual entry
  with final approval of CEO … CEO approve edits only when amount is edited,
  not for editing details/particulars/Memo").** A TEXT edit (description, the
  operator's reference, line memos, a line's sub-account tag) applies AT ONCE
  in place — `PATCH /accounting/journal/:id/text`, or an `/amend` whose lines
  keep the same account / side / amount / brand and the same day — audited
  `journal.text_edit` (old → new); an entry dated in closed / reopened books
  stays the CEO's (403 `CEO_ONLY_CLOSED_BOOKS`). **Only a change of AMOUNT
  needs the CEO (owner, 2026-10-23: "Yes only amount"):** finance moving the
  account, brand or date with the same amounts (same number of lines, same
  debit / credit amounts — `manualJournal.ts amountsUnchanged`) applies at once
  through the same reverse + re-post engine (register accounts and closed books
  still refused). An AMOUNT edit (a changed amount, lines added / removed /
  split) or a cancel by finance answers
  202 `{ pendingApproval, request }`: a journal request of kind `amend` /
  `reverse` (the ONE store, `journalRequests.ts`; approval type
  `journal_request`, those kinds section `ceo`, never delegable) that the CEO
  approves through the same engine (`manualJournal.ts amendManualJournal` /
  `reverseManualJournal`). One open change per entry (409 `CHANGE_PENDING`,
  under the entry's change lock, which every reversal takes too); the entry's
  fingerprint is stored at raise — approval refuses 409 `ENTRY_CHANGED` if it
  moved or was reversed; reject needs a note ≥10 (422 `NOTE_TOO_SHORT`);
  finance never approves. The CEO's own edit / cancel applies at once.
  Nobody but the CEO may even RAISE a change on an entry dated in closed /
  reopened books, or one that moves it into them (403 `CEO_ONLY_CLOSED_BOOKS`,
  `raiseChangeRequest`). Sub-accounts are finance's domain (owner, 2026-10-23):
  finance with `accounting` creates / renames / switches them off with no CEO
  approval.
- **The Journals tab (owner, 2026-10-23: "store all the Journal entries
  (Payment journals and receiving journal separately) to find the entries in
  no time").** `GET /accounting/journals?view=manual|payment|receipt|all`
  (`journalsRegister.ts`; ledger readers, `resolveTenantScope`, no date cap,
  cursor paged, search over voucher no. / reference / description / memos /
  supplier, payee and customer names / amount, `?format=csv|xlsx|pdf`). Payment
  = `paymentsRegister.ts`'s definition; RECEIPT is its mirror in the same file
  (`moneyFlowWhereSql('in')`: a live entry netting money IN to 1010 / 1011 /
  1020 / the company's bank codes; transfers between money accounts net out;
  sales / till sources only with `includeSales=1`). Each row carries its
  status (live / reversed / reversal / change_pending) and the caller's
  `canTextEdit` / `canRequestChange`. The Accounts view is THE account
  statement (`GET /accounting/ledger?view=statement`, now with `from` / `to`,
  `brandId`, `limit` + `cursor`, the same per-line rights) — never a second
  statement. **Cancelled pairs are hidden on every account (owner, 2026-10-29):**
  an entry and its cancellation ("Reversal of …", `<type>.reversal|void:<id>`)
  both dated in the window are left out of the lines, totals and every export
  (`accountStatement.ts cancelledPairIds`, `hiddenCancelled` + an export note);
  `?showCancelled=1` ("Show adjustment entries") brings them back; opening and
  closing never change. Diff of a change: `GET /accounting/journal-requests/:id/diff`.
- **Voucher types and Duplicate (owner, 2026-10-23: "at Voucher it should give option to opt Payment
  voucher (PV), journal voucher (JV), Receiving voucher (RV) and adjustment voucher (AV)"; "give option to
  generate duplicate voucher of existing entry").** A manual entry takes `voucherKind` PV | JV | RV | AV
  (`voucherNumbers.ts MANUAL_VOUCHER_KINDS`; each its own per-company series, AV-00001…; none = JV as
  before). PV must CREDIT an asset or liability account (paid from any asset, or set off against a
  liability) and RV must DEBIT one (owner, 2026-10-31: "Payment can be made from any asset account … Or to set off
  liability against payment, make both"; `assertManualVoucherKind` → 422 `VOUCHER_TYPE_MISMATCH`); JV / AV fit any
  entry. The payments register and system PV / RV stamps still read money accounts only. Checked in `postManualJournal`, at request raise / edit
  (`assertManualVoucherKindForLines`); a journal request keeps it in `changeMeta.voucherKind`; an amend
  keeps the original's type unless a new one is sent, and a type change is never a text-only edit (it
  re-posts, same-amount rules). The form suggests PV / RV / JV from the lines. "Duplicate" on a manual
  entry's panel opens New entry pre-filled (type, description, lines, brands, sub-accounts), dated today,
  no cheque reference — nothing posts until it is posted.
- **Sub-accounts (owner, 2026-10-23: "option to create sub account in chart of
  accounts, e.g in Wages … in name of employees … account statement with
  balance of subgroups").** A SUB-LEDGER, never child accounts: entries keep
  posting to the main account (trial balance, P&L, returns, close checks
  unchanged — tested byte-identical). `SubAccount` (per account, per company;
  kind `manual` | `employee`; switched off, never deleted) and
  `JournalLineSubAccount` (a tag on a journal line, Σ per line ≤ the line, same
  account and company; the line is never changed). `lib/subAccounts.ts` is the
  ONE writer; a reversal mirrors its original's tags (`reverseJournalEntry`).
  CHART_EDITORS manage them on `/setup/chart-of-accounts/:accountId/sub-accounts`;
  a manual line may name `subAccountId` — picked straight from the line's account
  drop-down ("6030 Wages › Ali Raza"; `GET /setup/chart-of-accounts?withSubAccounts=1`,
  the Select's `data-picked` label); re-tagging is text-level (at once,
  audited `journal.sub_account_tag`, `PUT /accounting/journal/lines/:lineId/sub-accounts`).
  Payroll and F&F tag each employee (`hr/ledger.ts tagPayrollRunTx` /
  `tagSettlementTx`: wages 6030–6035, gratuity 6036, 2020 accrual and payment,
  1350 recovery — statutory 2042–2044 untagged) in the posting's transaction;
  history once per company at boot (`hr/payrollSubLedgerBackfill.ts`, marker
  `subAccounts.payrollBackfilledAt:<tenantId>`, a mismatch is left untagged and
  flagged `sub_account_backfill_mismatch`). The account statement returns
  `subAccounts` (each opening / debits / credits / closing + Unassigned, tying
  to the account) and takes `subAccountId` for one sub-account's statement.
  **Sub-accounts are switched on per account (owner, 2026-10-23: "It should not automatically pick sub
  accounts for all wages heads, make it limited to Wages Expense (HO) account only, and add an option to
  switch on sub accounts for other head accounts also only in those for which i open subaccount").**
  `Account.subAccountsEnabled` (migration `20261023130000`: on for an account with a hand-made sub-account,
  and the company's "Wages Expense" account (owner: "It's just wages expense"), else
  6032 where payroll books office staff; new charts: 6032). Off = payroll never tags it (not a mismatch),
  no new tag (422 `SUB_ACCOUNTS_OFF`), the picker (`withSubAccounts`, `?active=1`) and the statement's
  `subAccounts` show none; old tags stay. Opening a sub-account switches its account on;
  `PUT /setup/chart-of-accounts/:id/sub-accounts-switch {enabled}` (CHART_EDITORS, audit
  `account.sub_accounts_switch`); chart page "Sub-accounts on".
- **Trial balance presentation (owner, 2026-10-16):** ONE net balance per
  account — debits − credits in the Debit column when positive, the Credit
  column when negative, never both — and accounts at zero are not listed (a
  cleared account such as 1357 drops off). `accounting/reports.ts
  trialBalance` (API, CSV, admin page and the `trial_balance` close check);
  the computed `3020*` retained-earnings b/f row is unchanged (but not listed
  when its amount is zero); totals still balance.
- **Chart of accounts (owner, 2026-10-16):** finance (with the `accounting`
  module) and the CEO add and rename accounts (`POST` / `PATCH
  /setup/chart-of-accounts`, `CHART_EDITORS`) and switch accounts off or
  back on (owner, 2026-10-16: "Give access to finance also"; the books'
  guards ACCOUNT_IN_USE / ACCOUNT_CONTROLLED still refuse). **An account
  holding a balance cannot be switched off** (owner, 2026-10-22, the 9272
  case: a switched-off account refuses every journal, so its balance was stuck)
  — 422 `ACCOUNT_HAS_BALANCE` until a journal clears it to zero. A duplicate code in the company is 409
  `ACCOUNT_CODE_TAKEN`. 1400–1599, 2012, 2100–2199, 6200–6249 and 6990–6999
  are refused for everyone, the CEO included (422 `ACCOUNT_CODE_RESERVED`; the
  leading four digits decide): only their own modules create them.
  **Current / non-current (owner, 2026-10-31):** `Account.classification`
  ('current' | 'non_current', assets and liabilities only — 422
  `TERM_ONLY_ASSET_LIABILITY`; NULL = the default by code) read ONLY through
  `lib/accountTerm.ts termOf` (defaults: assets 1500–1599, 1360 and 1600+
  non-current, else current; liabilities 2200+ non-current, else current).
  Set on the chart's account form (CHART_EDITORS); the chart lists and the
  balance sheet (screen + exports, `totals.current*/nonCurrent*`) split by it.
  A label only — no posting reads it, and it is separate from the Fixed Asset
  Register.
- **Which money account:** `moneyAccountCode(db, tenantId, {method, bankAccountId})`
  in `lib/bankAccounts.ts` is THE answer for every non-till payment (supplier
  payments, receivable receipts/refunds, wallet top-ups, CapEx, OpEx, gift
  cards, tax payments, payroll, F&F, loans, deposit drops): cash→1010,
  card→1030, bank-type→the named live LINKED bank of the SOURCE document's
  company; none named → the company's only bank, 1020 if none, 422
  `BANK_ACCOUNT_REQUIRED` if two or more; a wallet always names its account.
  `bankLedgerCode` is strict (422, never a silent 1020). Admin picker:
  `components/finance/BankAccountSelect.tsx`.
- **Bank codes (owner, 2026-10-16):** a bank account's ledger code must be an
  active 10xx asset in the company's chart, not in `NOT_BANK_CODES`
  (`lib/bankAccounts.ts`: 1010, 1011, 1015, 1030, 1110, 1115, 1351, 1355,
  1356, 1357), not register-controlled (422 `NOT_A_BANK_CODE` /
  `ACCOUNT_CONTROLLED`) and not used by another live bank of that company (409
  `BANK_CODE_IN_USE`) — Trash restore included. Re-pointing a bank whose old
  code holds a balance or open statement lines is the CEO's only, with
  `repointReason` ≥10 (else 409 `BANK_CODE_HAS_BALANCE`); audit
  `bank_account.relink` / `bank_account.create`.
- **Bank reconciliation (owner, 2026-10-16):** finance with `accounting`, the
  CEO and co-owners match by hand (`GET /bank/lines/:id/candidates`, `POST
  /bank/lines/:id/match`), book adjustments and unmatch (`BANK_BOOKERS` in
  `reconciliation/routes.ts`); finance without `accounting` and managers get
  403. A register-account override on an adjustment stays CEO-only. Ignore
  needs a reason ≥10 and `/unignore` undoes it (same people); all audited
  `reconciliation.line.*`. A payment that cleared late is a manual match,
  never an adjustment (it would book twice). `bank_unmatched` counts lines
  ignored in the period separately. A reversal is stored as
  `<sourceType>.reversal|void:<sourceId>` ("Reversal of …", never
  `reverses:`): neither the reversed original nor its reversal is a bank
  movement — use `deadEntryIds` (`reconciliation/service.ts`) wherever bank
  lines are paired or counted.
- **Exceptions and backfill (owner, 2026-10-16):** acknowledge / resolve need
  the `exceptions` module, an open or acknowledged flag (409 `FLAG_NOT_OPEN`)
  and a note ≥10; dismiss stays CEO-only. Flags about the books
  (`LEDGER_FLAG_KINDS`, `lib/exceptions.ts`: posting_failed, manual_journal,
  fixed_asset_gl_mismatch, cash_voucher_hold_unconverted, depreciation_failed,
  intercompany_mismatch) are resolved only by the CEO or finance with
  `accounting` (403 `LEDGER_FLAG_FINANCE_ONLY`); for anyone but the CEO a
  posting_failed flag resolves only once its `<sourceType>:<sourceId>` entry is
  in that company's books (409 `POSTING_NOT_ON_BOOKS`) — re-post through
  Backfill unposted, which closes the flag itself; nobody but the CEO resolves
  a manual_journal / fixed_asset_gl_mismatch flag about their own action (403
  `SELF_APPROVAL_BLOCKED`, `NO_SELF_RESOLVE_KINDS`). `POST
  /reconciliation/backfill-unposted` is the CEO's and finance's (dry run by
  default); while the CEO has a month reopened in a company in view a real run
  is the CEO's (409 `REOPENED_BOOKS_CEO_ONLY`); audit carries `actorRole` and
  `tenantIds`. The petty-cash history run stays CEO-only.
- **Allocations:** a run covers whole Pakistan days (`YYYY-MM-DD`, 00:00 to
  23:59:59.999 PKT; dated on the end day). Only untagged lines on the source
  account are split; cost already booked to a brand stays (`brandTaggedCents`).
  Rules and runs are CEO-only (`ADMIN_ONLY`; runs were not handed to finance),
  audit `allocation.run`.
- **Close checks:** a check that throws keeps its own rule
  (`check_failed:<key>` is overridable only if the check itself is);
  `trial_balance` is never overridable, even when it cannot run. The
  period-close page offers a one-click fix only to the roles its route admits
  (`FIX_ROLES` in `period-close/page.tsx`): depreciation, prepaid releases,
  card payout re-match and booking approved settlements go to the CEO and
  finance; every other fix, the fleet charge included, is CEO-only. A new fix
  path is added there in the same change.
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
- **Owner confirmed 2026-10-26 (G1, H5, G14, H14 — "keep as built"):** COD never paid stays pending and
  blocks the close until finance books it (never automatic); own-rider COD on 1351, fleet rider via the
  inter-company `cod` transfer; on-account = whole bill, cash GST rate, card or manager approval + credit
  limit; a tax invoice per bill at completion, the statement is not a tax invoice. HO-Q1 = the default
  (net cost 5000–6999, no markup). **HO-Q3 = SHOW AS INCOME** in the head office's books (not the 6990
  contra-expense default) — BUILT 2026-10-26: Cr 4220 Head Office Recharge Income. City Ledger and the head-office
  recharge stay OFF until the owner says so.
- **Pending owner/CA decisions** (decisions page
  https://claude.ai/artifact/W8tzVdHxhzYSKJiyzhcLRk): COD never paid (G1),
  rider COD on 1351 (H5), on-account tender (G14) and the on-account tax
  invoice (H14) — resumed 2026-10-15 and BUILT on the defaults, awaiting
  owner/CA confirmation (see "Delivery money and customers" and "On-account
  clients"). Head-office HO-Q1 / HO-Q3 are decided (owner, 2026-10-26; see "Head office").
  **Hasnain's answers of 2026-10-16:** H45 = the night audit's "still
  awaiting settlement" warning fires after 2 working days; H46 confirms the
  business day (05:00 PKT); H47 withholding is taken at the bill; H48 loyalty
  points stay at today's value (no change); H49 supplier opening balances
  offset 3010 (none expected at go-live); H50 card is removed from back-office
  receipts; H51 keep the defaults — on-account clients and head-office
  recharge stay OFF for the 25 Oct sign-off; H52 October payroll goes as is.
  Everything else (C*, G2–G13, F*, K*, H1–H52) is answered; seams still
  marked `TODO(<id>)` (H45, H49) are built next — see "Finance wave B" below.
  Build a `TODO(<id>)` only on the owner's answer.

- **Cost allocations are finance's too (owner, 2026-10-16: "Hasnain runs the
  monthly allocation and edits the rules; every run is recorded and can be
  reversed").** Saving rules, running them and `POST /allocations/runs/:id/reverse
  {reason ≥10}` are open to the CEO and finance with `accounting`; deleting a
  rule stays the CEO's. A reversal flips the run's entry
  (`allocation.run.reversal:<runId>`, brand tags kept) on the run's own day
  (today if that month is closed), once (409 `RUN_ALREADY_REVERSED`); a reversed
  run no longer blocks its period and the cost reader skips run and reversal
  entries. One run of a rule at a time (advisory lock + overlap re-check in the
  run's transaction). Closed books stay the CEO's through the ledger. Audited with
  `actorRole`. Tests: `tests/allocationsFinance.test.ts`.

- **Every report exports CSV / Excel / PDF (owner, 2026-10-20: "Add option
  to export BS, P&L, GL, and any other report/account statement in PDF and
  Excel also").** ONE renderer, `backend/src/lib/reportExport.ts`: a route
  builds its records once as a `ReportTable` and calls `sendReport` /
  `sendReportFor` with `exportFormatOf(?format)`. Convention: the report's own
  route takes `?format=csv|xlsx|pdf` (a path already ending `.csv` keeps
  working and takes the same `?format=`); same auth, module gate and company
  scope — export never widens access. A table's `wrapKeys` print those text
  columns in full over several lines in the PDF (never cut to "…"); the account statement
  wraps its entry and memo and shows the CHEQUE REFERENCE typed on a manual entry
  (`chequeReference`), never the system key `manual:<id>` (owner, 2026-10-23). The first column is **Particulars** (owner, 2026-10-24): the document's own narration (a cash voucher's purpose + payee, a petty-cash spend's reason, a manual entry's description) from `accounting/particulars.ts particularsOf` (company-scoped reads; the stored description never changes) — the statement, the Accounts view, the Journals list / export and the payments register's narration use it. The PDF header shows the company name large, the title under it (owner, 2026-10-24); a sectioned report whose sections have their own columns passes `columnsBySection` (till reports do): portrait, one grid so every section's values line up, data centred. CSV stays byte-identical to what the
  route sent before; Excel has money as numbers; PDF is A4 (landscape over 6
  columns), header repeated, "Page x of y". The GL account statement is
  `GET /accounting/ledger?accountId&view=statement` (`accountStatement.ts`).
  Admin: `components/ui/ExportMenu.tsx` (Export → CSV / Excel / PDF, through
  `api.download`). A new report uses these two, never its own exporter.
  Tests: `tests/reportExport.test.ts`.
- **Internal payment classification (owner, 2026-10-20: "a SEPARATE REPORTING
  DIMENSION inside the existing accounting system — no duplicate accounting
  entries, no separate statutory books").** Every payment carries Official /
  Unofficial / Unclassified (+ tax status `deducted | not_deducted |
  not_applicable` and a reason ≥10 when not deducted, documents as record files
  owner type `payment`). ONE table `payment_classifications` (migration
  `20261020100000`; `tenantId` = the ENTRY's company, `journalEntryId` @unique,
  RLS, in the merge repoint list); no row = Unclassified. **HARD RULE: it is a
  label + reports only** — no posting, account, trial balance, tax return or
  statutory / payroll / WHT report reads it; Unofficial payments stay in every
  statutory report exactly as before (tested byte-identical). ONE definition in
  `accounting/paymentsRegister.ts`: a payment = a live (not reversed / not a
  reversal) entry whose lines net-CREDIT the company's money accounts (1010,
  1011, 1020 and its bank codes); moves between money accounts net out; sales
  and till sources (order*, pos.*, shift.close) are out of scope. Written only
  by `classifyPaymentTx` (in the posting's own transaction; the pay routes take
  optional `classification` / `taxStatus` / `nonDeductionReason` — cash voucher
  pay, petty-cash spend, supplier payments, OpEx payments, CapEx pay + Quick
  buy, payroll / F&F paid, loan disbursement at final approval, tip-pool pay,
  tax payments, receivable refunds; the admin forms make it a REQUIRED pick)
  and afterwards by `PUT /accounting/payments/:id/classification` or bulk
  `POST /accounting/payments/classify` (≤200, all-or-nothing): CEO or finance
  with `accounting` only, foreign 404, non-payment 422 `NOT_A_PAYMENT`, a
  reason ≥10 to change a set value (always for bulk), audit
  `payment.classification`. A re-posted revision (`<ref>@n`) inherits the
  label until reclassified. Register `GET /accounting/payments` (+ `.csv`;
  CEO, owner, management, finance; Finance → Payments register) with an
  independent tie-out to the ledger's money credits. A new person-made payment
  route takes the same body fields and calls `classifyPaymentTx` /
  `classifyingTx` in its transaction. Tests: `tests/paymentClassification.test.ts`.

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
  `acknowledge {keys, reason ≥10}`; `trial_balance` never. **Go-live 1 Nov 2026** (owner, 2026-10-24: "it should
  implement from November 1st onwards"; `closeChecks.ts CLOSE_CHECKS_FROM`): a close through an earlier date
  shows every block as a warning (trial balance excepted); a later close checks only from 1 Nov (prevLock
  clamped, months ≥ 2026-11, a till opened before it never blocks). The suite runs every check
  (`CLOSE_CHECKS_FROM_OVERRIDE` in tests/setup.ts; `tests/periodCloseGoLive.test.ts`). The fiscal year is
  per company (`Tenant.fiscalYearEndMonth`, 30 June — H29) with a virtual
  roll-forward: nothing posts at year end.
- **Fixed assets v2:** classes per company; 1500–1599 and 2012 are
  `controlledBy 'fixed_asset'` (only `fixed_asset.*` / `capex.*` sources post
  there). Bought assets come in through CapEx capitalisation — the CEO approves
  every one, Quick buys included. **Quick buy "Paid from" (owner, 2026-10-27: "book the asset through liability
  directly (e.g. Paid through Due to Garibsons)")** = bank | cash | `garibsons` (an instalment with
  `CapexPayment.source 'garibsons'`, Dr 1340 / Cr 2210 — never a money account, no WHT, not a payment in the register,
  reference optional) | `credit` (supplier required — 422 `SUPPLIER_REQUIRED` / `SUPPLIER_NOT_IN_COMPANY`; no payment,
  the CEO's approval books Dr class cost / Cr 2012), all through `recordEquipmentPurchaseTx`. **Existing assets (owner, 2026-10-21: "It
  only showing buy equipment, give an option to add asset also, so we can add
  previously bought / Transferred from related party assets" — REVERSES "no
  opening / pre-servd assets"):** `POST /accounting/fixed-assets/existing`
  (Register → "Add existing asset") raises request kind `add_existing` on the
  same queue (`fixed_asset_request`, CEO approves; nothing posts before), in
  the ACTIVE company, at TODAY'S value (book value) over the REMAINING life
  (default the class life). On approval ONE entry `fixed_asset.acquire:<assetId>`
  Dr class cost / Cr **3010** (bought before servd; owners contributed) or
  **2210** (Garibsons paid), dated the in-service date, never late-dated (a
  closed month: 422 `PERIOD_LOCKED`); documents via record-files `fixed_asset`
  on the request id, moved to the asset on approval. **Another servd company
  gave it (owner, 2026-10-21: "Book value, no gain or loss"):** finance picks
  the GIVER's own register asset (`giverAssetId`; not there → 422
  `ASSET_NOT_ON_GIVER_REGISTER`, add it to the giver's register first); the
  value is its book value on the transfer date (never typed), life defaults
  to its months left, salvage carries over; raiser and approving CEO belong
  to BOTH companies. One approval transaction: giver caught up through the
  month before, then `fixed_asset.transfer_out:<giverAssetId>` Dr accumulated
  + Dr 1395 / Cr cost (no gain or loss; asset `transferred_out`); receiver
  `fixed_asset.acquire:<newId>` Dr cost / Cr 1395; the pair through the
  inter-company engine (`postSystemTransferTx`, source `asset_transfer`:
  receiver Dr 1395 / Cr Due to, giver Dr Due from / Cr 1395) — 1395 Fixed
  Asset Transfer Clearing nets to zero; a closed month in either company is
  422 `PERIOD_LOCKED` (contract: `modules/fixedAssets/README.md`). **From the chart of accounts (owner, 2026-10-31: "1st the asset will go to chart of accounts,
  then will be transferred to Fixed assets register"):** add_existing source `chart_account` + `sourceAccountCode`
  — finance books the item to one of the company's live ASSET accounts first, then raises the move; the CEO's
  approval posts `fixed_asset.acquire:<assetId>` Dr class cost / Cr that account (account row locked). Never from
  cash / bank / receivables (`NOT_BANK_CODES`, 1020, bank codes), stock 12xx, 1340 (capitalise through CapEx),
  15xx or a controlled account (422 `SOURCE_ACCOUNT_NOT_ALLOWED`); never more than the account holds less moves
  already pending from it (422 `SOURCE_ACCOUNT_SHORT`). `events.ts assertChartSourceAccount`; tests in
  `tests/fixedAssetExisting.test.ts`. Depreciation is AUTOMATIC (worker 03:20 PKT,
  `chargeThrough` the one path, no switch); smallwares are pooled (H21);
  prepayments sit on 1310 and release monthly (`accounting/prepaidReleases.ts`);
  refundable deposits (1360) only through CapEx. No deferred tax anywhere
  (H24). No sales tax on proceeds when used equipment is sold (H41). For
  TAX, smallwares are deducted in full in the year bought (H35) and the 25%
  initial allowance is decided PER ASSET (H42, Hasnain 2026-10-16): finance
  ticks `FixedAsset.initialAllowanceEligible` ("Eligible for 25% initial
  allowance (tax)" on the asset page; `PUT /accounting/fixed-assets/:id/
  initial-allowance`, finance or the CEO, audited
  `fixed_asset.initial_allowance`). It starts ticked for kitchen and power
  equipment and unticked for office, IT and every other class (capitalisation
  default; existing rows backfilled the same way). Ticked = the class rate, or
  the statutory 25% when the class carries 0 (`tax.ts initialAllowanceBpOf`).
  Tax view only, never the books; smallwares and land never. Once any tax year
  from the asset's first is frozen the tick is final (409 `TAX_YEAR_FROZEN`).
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
- **Loyalty revaluation (owner, 2026-10-17: "Yes to loyalty revaluation";
  H48 = today's point value):** 2060 always equals a company's outstanding
  points × its CURRENT point value. A change of `loyalty.point_value_cents`
  (`PATCH /loyalty/settings`, its existing rule) posts ONE entry in that
  company's books in the SAME transaction as the setting
  (`modules/loyalty/revaluation.ts`): points in 2060 × (new − old) — rise Dr
  6060 / Cr 2060, fall Dr 2060 / Cr 6060; no change or no points → no entry.
  Source `loyalty.revalue:<auditId>`: the AuditLog row (action
  `loyalty.revalue`, category accounting) is the record — old / new value,
  points, `deltaCents`. "Points in 2060" = balances − earns not yet booked +
  redemptions / expiries not yet booked. A per-company advisory lock
  (`lockLoyaltyValueTx`): the change takes it exclusive; every earn / redeem /
  expiry posting takes it shared and reads the value inside it
  (`pointValueCentsTx`, never the cache). A refused entry keeps the change,
  is flagged posting_failed and REPOSTERS `loyalty.revalue` posts the STORED
  delta (never recomputed). A reversal (`postLoyaltyReversal`: refund
  clawback, redemption given back) moves 2060 at TODAY's value (points ×
  current value, under the shared lock); every other line mirrors the
  original exactly and the difference goes to 6060 in the same entry; same
  value → the plain mirror.
- **Loyalty is PAUSED servd-wide (owner, 2026-10-22: "stop the Loyalty points section for now, will
  decide after opening … until then no amount should go to loyalty points account").** `lib/loyaltyPause.ts`,
  platform Setting `loyalty.paused`, ABSENT = PAUSED. Paused: `creditPointsTx` credits nothing (orders,
  reservations, reviews, bonuses, stamps), redeeming is 409 `LOYALTY_PAUSED` (quoteRedemption,
  claimRedemption, redeemPointsOnOrder), the expiry sweep does nothing and the point value cannot change
  (no revaluation) — nothing is booked to 2060. Balances are frozen, never erased; reversals of points earned
  before the pause still run. Only the CEO switches it (`PUT /loyalty/pause {paused, reason ≥10}`, audited;
  Configuration → Loyalty). The storefront hides points while `paused` (`/loyalty/program`, `/loyalty/status`).
  Tests run with loyalty ON (tests/setup.ts); the pause is `tests/loyaltyPause.test.ts`.
- **Withholding and statutory payables:** `lib/withholding.ts` is the one WHT
  resolver; `PUT /accounting/withholding/rates` the only writer of a
  company's rates (confirmed by the accountant, H32; withholding stays OFF per
  company until finance switches it on, H47: taken at the bill;
  `PUT /accounting/withholding/enabled {enabled, reason ≥10}` is finance's
  (with `accounting`) and the CEO's, active company only, audit
  `withholding.switch`, unchanged value 409 `WHT_SWITCH_UNCHANGED`; the CEO
  keeps the same switch on Configuration → Operations). A supplier whose filer status is not
  known pays the NON-filer rate until confirmed (H33). Salary tax 2042, EOBI 2043, SESSI / PESSI 2044
  (H7): challans go through the tax-payments register; `/accounting/statutory`
  is the one accrued-vs-paid view. OpEx posts the expense with input tax by
  authority and WHT to 2040; budgets compare the expense.
- **Supplier bills, credit notes and payments (owner, 2026-10-16):** finance
  does them. `procurement/routes.ts AP_WRITERS` = managers + finance;
  `requireApWriterModule` holds finance to `accounting` and every other role
  to `procurement`; GATED_PREFIXES admits either on `/procurement/bills`,
  `/credit-notes` and `/payments`. POs, receiving and the supplier master stay
  closed to finance. Every write is audited under the supplier's company; bill
  files (`supplier_bill`) follow the same rule. Admin: `/procurement` shows
  finance only Bills, Payments and Aging (`useApOnly`); sidebar Accounting →
  "Supplier bills & payments". A payment or due date that is not a date is 422
  `INVALID_DATE`.
- **PO cancel:** a PO with a pending GRNI match (a bill booked before
  delivery) cannot be cancelled (409 `PO_BILLED_AHEAD`; void the bill or raise
  a "short" credit note first); billing ahead on a cancelled PO is 409
  `PO_CANCELLED`. Both take the PO row lock. A pre-FIFO-cutover bill has no
  match: void it by hand before cancelling.
- **Supplier opening balances** are dated at `Supplier.openingBalanceDate`
  (DATE; managers only), or `createdAt` when empty — never today. A refusal is
  flagged posting_failed (`supplier.opening`, `metadata.documentDate`) and
  re-posted by the REPOSTERS `supplier.opening` entry; use
  `syncOpeningBalanceOrFlag`, never a bare sync in a route. Once anything is
  posted, changing the date is 409 `OPENING_DATE_LOCKED` (set the balance to
  0, then enter the date and amount again). The offset is **3010** Owner's
  capital (H49, Hasnain 2026-10-16; none expected at go-live;
  `openingBalance.ts OPENING_OFFSET_CODE`): entries already on 3020 stay; a
  reduction or a move to another company takes 3010 off first, then legacy
  3020. Suppliers with no company go to GS Foods (owner, 2026-10-16).
- **AP aging** takes `?asOf=YYYY-MM-DD` (end of the Karachi day) and is
  rebuilt as at that day (bills, credit notes, payments, applications, posted
  opening balance), tying to 2010 as at that day; company-less suppliers are
  listed to the CEO only. An unapplied payment shows as an unapplied credit in
  the past (total still ties).
- **Payroll and F&F paid (owner, 2026-10-16):** `PAYROLL_PAYERS` (admin,
  owner, management, finance; finance needs `accounting`) marks a locked
  payroll run or an approved full & final paid and runs
  `/hr/final-settlement/post-unposted`; approve, lock and reopen stay with
  `PAYROLL_APPROVERS`. Nobody, the CEO included, pays a run or settlement
  carrying their own pay (403 `OWN_PAY_IN_RUN`). Finance's list is
  `GET /hr/final-settlement/to-pay` on the `/hr/payroll` page; the three F&F
  paths are gated `staff_hr | accounting` (a pattern rule before
  `/hr/final-settlement`); run paid stays under `/hr/payroll`
  (`staff_hr | payroll`). October payroll goes as is (H52).
  **HR sends payroll to finance, then the CEO (owner, 2026-10-30: "HR sends to
  finance, then CEO"; "Finance will put tax figures").** Run status draft →
  `finance_review` → `finance_checked` → approved → locked → paid (migration
  `20261030110000`). `POST /hr/payroll/runs/:id/send-to-finance` (HR_ADMIN,
  draft only, `runBlocker` must pass — 409 `RUN_INCOMPLETE`; audit
  `hr.payroll.send_to_finance`); `/finance-pass {note?}` and `/finance-return
  {note ≥10}` (422 `NOTE_TOO_SHORT`; back to draft, note kept as
  `financeReturnNote`) — role finance holding `accounting`, or the CEO, never
  whoever created, prepared or sent it (approval type `payroll_finance_review`,
  section finance, never delegable; a run that came through head office: the
  CEO). Approve only from `finance_checked` (409 `NOT_FINANCE_CHECKED`); reopen
  clears the finance check. HR edits (recalculate, payslip, overtime, delete)
  only in draft (409 `RUN_NOT_DRAFT`). `PUT /hr/payroll/payslips/:id/tax
  {taxCents}` — finance (accounting) while `finance_review`, the CEO also on a
  draft; stored as `inputs.taxOverrideCents` (wins over `monthlyTaxCents`, kept
  through Recalculate); finance enters every payslip's tax, its own included
  (owner, 2026-10-30 — the CEO's approval is the check); audit `hr.payroll.tax_set`. The inbox and bell: `payroll_finance_review`
  (finance) then `payroll_run` (`finance_checked` only). EOBI stays HR's (off by
  default). Tests: `tests/payrollFinanceReview.test.ts`.
- **Tip pools: finance pays after the CEO's approval (owner, 2026-10-17).**
  Posting stays with the approvers (`APPROVERS` = CEO, co-owners) and records
  `TipPool.postedById` in the same write. Finance with `accounting` may pay a
  pool only when a CEO login posted it (403 `TIP_POOL_NEEDS_CEO_APPROVAL`
  otherwise, incl. pools posted before the column), re-checked in the claim;
  audit `tippool.pay` via `finance_after_ceo_post`; finance gets a bell when
  the CEO posts. Nobody — the CEO included — posts or pays a pool holding
  their own tips (403 `OWN_TIPS_IN_POOL`). `/tip-pools/:id/pay` admits
  `payroll | accounting`; reads stay on `payroll`.
- **One sales account per brand (owner, 2026-10-17).** `Concept.revenueAccountCode`
  (migration `20261017160000`): legacy brands keep 4001–4007; every other brand
  gets the first free code in **4010–4089** ("Sales — <brand>") in ITS company's
  chart, at brand create and by an idempotent boot step
  (`accounting/brandRevenueAccount.ts`). `revenueCodeForConcept` reads the
  stored code (4090 only as a fallback). Refunds and cancel-undos reverse the
  account the SALE credited (`saleBookingOf.saleRevenueAccount`), never
  today's mapping; past entries never move. The merge renumbers a clashing
  brand account. Untagged 4090 revenue shows on its own tax-return row.
- **Tip payouts** take `{method, bankAccountId}` through `moneyAccountCode` of
  the pool's company (`{}` = the only bank, 1020 if none, 422
  `BANK_ACCOUNT_REQUIRED` if two or more); legacy `paidFromAccountCode` still
  works with its checks.
- **Tax and statutory payments:** several per (company, authority, period).
  Every payment after the first is a top-up with its own CPR (422
  `CPR_REQUIRED_FOR_TOP_UP`; the same CPR again 409 `TAX_PAYMENT_EXISTS`),
  checked under a per-period advisory lock in both record and link. Unique key
  `(tenantId, authority, periodFrom, cprNumber)` (migration
  `20261017130000_tax_payroll_tax_payment_topups`); the company merge clashes
  only on the same CPR for the same authority and month. **Rollback:** once a
  period holds two payments an older image cannot rebuild the old unique
  index — void the top-up first.
- **Tax invoice register:** `GET /invoices` and `/invoices/register.csv`
  (`type`, `q`) are open to managers and finance (with `accounting`), read
  scope; admin Accounting → Tax invoices (`/accounting/tax-invoices`). Credit
  notes are stored negative, so totals are plain sums.
- **Wallet top-ups and gift cards (owner, 2026-10-16):** managers record both
  wallet top-up kinds; finance (with `accounting`) records PAID ones only
  (goodwill 403 `GOODWILL_MANAGERS_ONLY`) via Finance → Wallet top-ups
  (`/finance/wallet-topups`, module `accounting`); customers are found with
  `GET /wallet/customers?q=` (active company, needs `crm` or `accounting`),
  finance also reads `GET /wallet/customers/:id`. Finance (with `accounting`)
  settles value on VOIDED or EXPIRED gift cards through `POST
  /gift-cards/:id/void` (refund or payment not received; booked in the card's
  company; audit carries `actorRole`, `settle`); a LIVE card stays the
  managers' (403 `VOID_NEEDS_MANAGER`, under the card lock), a card holding
  nothing is 409 `NOTHING_TO_SETTLE`, forfeiting a sold card stays the CEO's.
- **Company-less suppliers → GS Foods, once (owner, 2026-10-16: "All to GS
  Foods").** `procurement/companylessSuppliers.ts` at boot (before the
  opening-balance sync), marker Setting
  `procurement.companylessSuppliersAssignedAt`. Target = the ONE `kind:
  'company'` named exactly `GS Foods`, else nothing changes and no marker
  (`/health` `supplierCompanies`, counts only; owner, 2026-10-17: live has no exact
  `GS Foods`, so the run flags each company-less supplier once for the CEO to
  assign by hand and writes the marker). Deleted suppliers move too. A
  supplier with any record in ANOTHER company (or a system supplier GS Foods
  already has — incl. a receipt at another company's outlet, with its stock,
  lots, GRNI matches or petty-cash lines there) is skipped and flagged
  `supplier_company_unassigned` (under the row lock: once) for the CEO; a
  supplier whose move throws is left for the next boot and the marker waits;
  the supplier editor resolves it. Ledger entries never move; company-less goods
  receipts are stamped; the opening balance posts in GS Foods. Audit
  `supplier.company_assigned`; a moved supplier with bills / payments never
  posted raises `supplier_unposted_after_move` (high) for the CEO → Procurement
  → Post unposted. Tests: `tests/companylessSuppliers.test.ts`.
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
  bank transfer, **bank deposit**, cheque — **no card**, owner 2026-10-16,
  H50: card is the till's only; routes 400, services `assertReceiptMethod` →
  422 `CARD_NOT_A_RECEIPT`; old card rows still read and refund as paid,
  `moneyAccountCode` card → 1030) and REQUIRES a payment
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
  `INGREDIENT_NOT_IN_COMPANY`) — EXCEPT the owner → user share of the kitchen
  flow (2026-10-26, below): a company's recipes may be used by the brands whose
  `Concept.recipeOwnerTenantId` is that company. `PATCH /inventory/:id` re-reads the category
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

### Stock by site, prep as stock (owner, 2026-10-24)

Owner card: "Each fired dish deducts its recipe from stock, with units, yields
and prep items; weekly variance of recipe against actual usage." Binding: FIFO
lots stay (D1), the draw stays at ring-up (D2), prep items become stock (D3),
per-site stock now (D4).

- **Every lot sits at ONE outlet** (`StockLot.locationId`); a draw takes only
  that site's lots. `lib/stockSite.ts` is THE rule for which site:
  `stockSiteOf` (the order's outlet → the brand's primary outlet → the
  company's STOCK HOME) for sales, returns, void waste, remakes, "Box given";
  `stockSiteForDocument` for waste / counts / prep batches (422
  `LOCATION_REQUIRED` when the company has 2+ active outlets and none is named,
  422 `LOCATION_NOT_IN_COMPANY` for another company's); receipts land at the
  dock's outlet, else the home. The stock home is picked once (single active
  outlet, else most sales in 30 days; never a head office or "General — to be
  assigned"), Setting `stock.homeLocationId:<t>`. A company with NO location
  keeps one pool (lots with no site) until it gets one.
- `lib/stockLedger.ts` stays the only writer: `consumeFifoTx` / `addLotTx`
  take `locationId` (required; null = the home), shortfalls are recorded and
  settled per site, `stock_balances` (per item per site, tenantId, RLS, merge
  repoint) is kept with every lot change and self-checked (500
  `STOCK_SITE_NOT_ON_LOTS`); `currentStock` stays the company total.
  `siteOnHand` / `siteOnHandMany` are a site's view. The site cut-over
  (`ensureSiteCutover`, from `ensureFifoReady` and at boot; marker
  `stock.siteCutoverAt:<t>` = {at, homeLocationId}; audit `stock.site_cutover`)
  moves lots with no site — and, then and whenever the home changes, lots at a
  deleted outlet or the "General" holding place (audit `stock.site_relocate`)
  — to the home and retags EVERY lot-carrying movement to its lot's site, so
  Σ movements per site = that site's lots; a write at such a site lands at the
  home, and a stranded lot met by a write is moved the same way.
- **Transfers between outlets of ONE company** (`modules/stockTransfers`):
  ship = `transfer_out` FIFO at lot cost, never clamped (409
  `INSUFFICIENT_STOCK`); receive = `transferInTx` new lots at the destination
  at the shipped cost and age, in the item's CURRENT class (a class change on
  the way posts `postItemReclassTx`); a shortfall is waste `transfer_shortfall`
  at the destination, booked BEFORE the arrived lots settle the site's sale
  shortfalls (`settle: false` + `settleTransferLotsTx`); cancel after ship
  returns to the very lots. `repriceLotTx` counts units in transit and in the
  lots they arrived in as on hand: the price difference follows them (a
  lot-less `transfer_out` row 'reprice:<lotId>:…' while travelling).
  No posting otherwise (same 12x0). In transit is off the lots but in the
  company valuation (`lotValuation` adds `inTransitByClass`). Two companies:
  422 `TRANSFER_CROSS_COMPANY`. Inter-company supply is a later build.
- **Prep as stock** (`modules/inventory/prepItems.ts`): a prep (component)
  recipe gets ONE stock item PER COMPANY (kitchen flow 2026-10-26) (`InventoryItem.kind 'prep'`, `prepRecipeId`
  @@unique([tenantId, prepRecipeId]), unit = `Recipe.yieldUnit` g / ml / pcs — locked once the item exists,
  409 `PREP_UNIT_LOCKED`), created on approval, on its first batch and at boot
  for every production prep. A recipe batch (`POST /prep-batches` with
  `recipeId`, `batches`) draws its recipe × batches FIFO at the site
  (`prep_draw`, source `prep_batch.input` — never cost of sales; 409
  `INSUFFICIENT_STOCK` lists every short item in `details.short`) and adds ONE
  lot of the prep item at the ACTUAL yield valued at exactly the value drawn
  (`prep_make`, lot source `prep_batch`); inputs of another cost class move by
  `postItemReclassTx`. Ad-hoc batches are unchanged (`inventory.prep_draw`).
  The sale explosion (`recipeCost.ts consumptionPerLine`, `prepStockAt` = the
  cooking site from `stockSiteOf`) draws the prep item in its own unit (no
  yield gross-up), never its raw ingredients — PER SITE: only where that site
  has ever held a lot of it (`livePrepItems`); any other site, another
  company's prep, or a prep with no item still explodes raw (pre-cut-over paths
  pass nothing = raw; company readers 'any'). Issued-on-receipt items are never
  drawn by a batch. Prep items never appear in the unused-ingredient clean-up.
  Costing and `explodeRecipe` (par sheet, prep list) stay raw.
- **Units:** `InventoryItem.purchaseUnit` + `purchaseUnitFactor`: a no-PO dock
  line typed in the purchase unit lands as qty × factor, valued exactly at the
  typed cost × purchase units (`receiveGoodsTx`). PO and bill lines stay in stock units (not built).
- **Counts:** `InventoryItem.countFrequency` daily | weekly;
  `GET /physical-counts/due?locationId=` (daily not counted today, weekly not
  counted since Monday PKT, at that site); a count's book is the SITE's. Whoever
  raised or approved a PO of the item in the last 14 days cannot count it at
  that site (403 `COUNTER_ORDERS_ITEM`; a PO's site = where it was received,
  every site until then; the CEO is exempt).
- **Weekly variance** = `reports/foodCost.ts weeklyVariance` on
  `ingredientVariance` (now with made / transfers in / out):
  `GET /reports/food-cost/variance?weekOf&locationId|tenantId&format=` — per
  tracked item (issue-on-receipt left out), actual (opening + received + made +
  transfers in − out − closing) vs recipe, explained (waste, staff meals,
  comps, prep, supplier returns), gap qty + PKR, worst first; the company view
  adds each site's totals; its totals count raw drawn into prep items once
  (`prepToStock`), and `counted` is per site. Admin: food cost page → "Weekly
  variance".
- `GET /inventory/negative?locationId=` (open sale shortfalls per site, by the
  settle's own rule `deadShortfallSaleIdsTx`; the nightly flag stays) and `GET /inventory/by-site`; the inventory list carries
  `bySite`.
- **Recipe gate:** a dish is switched ON only with a production recipe — 422
  `RECIPE_NOT_APPROVED` on `PATCH /menu/items/:id(/availability)` false → true;
  `POST /menu/items` and the brand template always create it off (asking for
  live is 422). Only dishes LIVE at go-live without an approved recipe
  (`MenuItem.liveAtRecipeGate`, set once by the migration) may come back on
  after an 86; dishes on sale with no approved recipe are listed by
  `GET /menu/items/live-without-recipe` (recipes page). The auto-86 still reads the COMPANY total (the menu switch is
  one for every outlet).
- Migration `20261024140000_stock_by_site`; tests `tests/stockBySite.test.ts`,
  `tests/prepAsStock.test.ts`.
- **Each brand keeps its own stock (owner B13 (a), 2026-10-26: "even when it shares a kitchen; moving stock between
  brands moves the cost between the brands' P&Ls automatically").** Contract: "BRANDS" in the header of
  `lib/stockLedger.ts`. A lot has an owning brand (`StockLot.conceptId`, NULL = shared). `addLotTx({conceptId})`
  (another company's brand 422 `BRAND_NOT_IN_COMPANY`); `consumeFifoTx({lotOwner})` — a sale (and a waste naming a
  brand) draws its brand's lots at the site, then the shared ones, NEVER another brand's (the rest is a shortfall, as
  before; a brand's lot settles only its own brand's shortfalls). Receipts: `GoodsReceipt.conceptId` = the brand named
  on the dock / PO receive, else `PurchaseOrder.conceptId`, else the outlet's only live brand, else shared
  (`receiving.ts receiptBrandTx`); the GRN tags each Dr 12x0 with its lot's brand. Moving stock between brands is a
  STOCK TRANSFER (`brandMove`, `fromConceptId` / `toConceptId`, null = shared; same outlet allowed only for it) —
  `POST /stock-transfers/brand-move` (managers, active company, at once; `stockTransfers/brandMove.ts brandMoveTx`) or
  the normal request → ship → receive flow: the ship draws only the from-brand's lots, `transferInTx({toConceptId})`
  opens the to-brand's lots at the same cost and age and posts ONE `inventory.brand_move:<transferId>` (Dr 12x0 tagged
  the new brand / Cr 12x0 tagged the old) — no P&L at the move; the seller's cost of sales (tagged by the selling
  brand, as before) carries it. A brand count (`conceptId` on `POST /crosschecks/physical-counts`) books against the
  brand's own lots: counted above them, the site's shared lots become the brand's first (a brand move, no variance),
  only the rest is a gain; a loss comes off the brand's own lots. A prep batch with `conceptId` draws the brand's then
  shared lots, and its prep lot / ad-hoc draw posting are the brand's. `GET /inventory/by-brand` = on hand per item per
  site per brand. Migration `20261027130000_brand_stock` gave existing lots the brand of an outlet with exactly ONE
  live brand (not when that outlet is / may be the stock home of a company with an outlet-less brand); outlets with
  several brands stay shared until a brand count or move assigns them. Tests `tests/brandStock.test.ts`.
  **Every brand move needs the CEO (owner, 2026-10-27: "moving stock between brands needs my approval").** Anyone but
  the CEO gets 202 `{ pendingApproval, request }` (the StockTransfer row itself, `requested` — no second store) and
  nothing moves; approval type `stock_brand_move` (section ceo, never delegable; `stockTransfers/brandMoveApproval.ts`):
  `POST /stock-transfers/:id/brand-move/approve` (one outlet: brandMoveTx in the claim's transaction, stock re-checked —
  409 `INSUFFICIENT_STOCK`; two outlets: approved, then ship / receive) | `/reject {note ≥10}` | `/withdraw`
  (requester); a manager never approves, rejects or ships a brand move the CEO did not approve (403
  `BRAND_MOVE_CEO_ONLY`). The CEO's own move is at once. Tests `tests/brandMoveApproval.test.ts`.

### Kitchen flow (owner, 2026-10-26)

"servd kitchen module basic flow is from master data --> recipe --> prep list --> spec list --> procurement -->
inventory --> par level set --> sales --> deduction basis plate recipe." Binding: K1–K7 (below). FIFO lots, the draw
at ring-up, per-site stock and prep items as stock all stand ("Stock by site").

- **Ingredient master is SERVD-WIDE (K1)** — `IngredientMaster`, deliberately NO `tenantId` (platform data). It is
  the DEFINITION only: name, stock unit, category, allergens, yield %, buying unit + factor and the SPEC (`spec` +
  `specFields`, K6: what we BUY — "burger meat = 80/20, coarse ground"). Each company's `InventoryItem`
  (`masterIngredientId`) keeps its price, supplier, par, stock, notes; ONE live item per master per company
  (partial unique `inventory_items_tenant_master_live_key`). `lib/ingredientMaster.ts` is the one helper:
  `findOrCreateMasterTx` (dedupe by normalised name), `ensureCompanyItemForMasterTx` (THE way a company's item for
  a master is found / linked / made — the linked item, else the company's TWIN, else a new one). ONE normalise rule
  (`cleanIngredientName` / `normalizeIngredientName`: JS `\s` trimmed + collapsed, lower case — mirrored exactly by the
  backfill SQL). **Units are FAMILIES** (`unitFamily`: mass g, volume ml, count pcs; any other unit its own): a
  master is kept in the family's BASE unit, kg / g (l / ml) twins are ONE master, kg vs pcs are two; a company item
  keeps its own unit of the master's family (recipe quantities convert via `measureToPurchaseUnits`);
  `findOrCreateMasterTx` never returns an incompatible unit; a picked master of another family is 409
  `MASTER_UNIT_MISMATCH`; `POST /inventory` keeps the typed unit and cost. API `/ingredient-master` (GET search
  server-side, any staff with recipes / inventory / procurement / par_sheet; POST → `needs_review` at once (K2),
  recipe editors + buyer; PATCH name / spec / allergens / yield = MANAGERS; category, unit and marking reviewed = CEO /
  fnb_manager only; a category change needs the editor in EVERY company that stocks it (409
  `MASTER_CATEGORY_NEEDS_MEMBERSHIP`) and moves each company's lots through `moveItemLotsToCategoryTx`, its own
  posting; a unit change once anything is stocked / bought / cooked is 409 `MASTER_UNIT_IN_USE`). `POST /:id/merge
  {intoId}` (CEO / fnb_manager) only RE-POINTS links and NEVER posts: a company stocking both is 409
  `MERGE_NEEDS_STOCK_MERGE`, units of different families 409 `MERGE_UNIT_MISMATCH`, different categories 409
  `MERGE_CATEGORY_MISMATCH` (fix the category first with the reviewer PATCH, which reclasses). On a linked item the
  definition fields are locked (422 `MASTER_FIELD_LOCKED`; its unit may change within the family). A Trash restore
  whose ingredient the company already stocks comes back UNLINKED (flag `ingredient_master_unlinked`); giving a
  company-less item a company that already stocks its ingredient is 409 `MASTER_TWIN_EXISTS`. `POST /inventory/from-master` = the active company's
  item (K3 auto-fill); `POST /inventory` links to a master too. Admin: Operations → Ingredients (`/kitchen/ingredients`),
  the recipe form's ingredient picker searches the master and adds a new one inline. Backfill (migration
  `20261026120000`): every non-prep item (live, company-less, or in the Trash but on a recipe) and every recipe line
  linked, grouped by normalised name + unit family; a second live item of one name and family in one company gets its
  own master "<name> (duplicate n)", needs_review.
- **Recipes belong to a COMPANY (K4)** — `Recipe.tenantId` = the OWNER; `Concept.recipeOwnerTenantId` (CEO field,
  BRAND_CEO_FIELDS) = who owns a brand's recipes when not its own company (Flipd → GS Foods); setting it re-owns the
  brand's dish and add-on recipes. The owner's editors create / edit / approve / delete (approvals: the owner
  company) — writing such a brand's recipes needs the OWNER as the ACTIVE company (422 `RECIPE_OWNER_NOT_ACTIVE`;
  stock items are never made in another company); a company USING it reads it at its OWN prices only (cost screens
  localise `strict`: a line it does not stock shows "Not stocked by <company>", no price) and never edits (403
  `RECIPE_OWNED_BY_OTHER_COMPANY`); a third company 404. A recipe with no owner (ambiguous at backfill) keeps the old derived rule and is flagged
  `recipe_company_unknown` at boot. Lines carry `masterIngredientId`; `lib/recipeCost.ts localiseGraph` resolves a
  shared recipe's owner-company lines to the SELLING / VIEWING company's item for that master (the sale makes one
  when missing — lot-less, a shortfall, never a block). Prep items are one per (company, recipe)
  (`@@unique([tenantId, prepRecipeId])`). A Flipd sale deducts Flipd's outlet stock, in Flipd's books — its existing
  twin (chicken in g for GS Foods' kg) before anything is created.
- **Recipes cost at the LATEST cost (owner, 2026-10-26)** — every recipe / sub-recipe cost screen, the pricing and
  menu engineering price each line at `lib/stockLedger.ts latestCostsMany` (latest purchase price, else latest
  manual cost, else the typed estimate) through `lib/recipeCost.ts withLatestCosts`. NEVER stock value, FIFO lots,
  cost of sales, food-cost actuals or anything posted — those stay FIFO at the price paid. Items and recipe lines
  expose `latestCostCents` / `latestCostAt`; price history: `GET /inventory/:id/price-history` (the one store,
  ItemPriceHistory; inventory auth).
- **The Ingredients sheet is servd's PRICING sheet, ONE servd price (owner, 2026-10-29: "the servd master sheet is
  not concerned with stocked or not stocked … a pure ingredient availability and pricing sheet … the stock in stock
  out business is at the per brand / per outlet level"; answers: one servd price, latest with the average shown,
  REPLACES the Sourcing sheet).** `lib/ingredientPrices.ts` is the one reader, DELIBERATELY servd-wide (every
  company's purchases count): latest = the newest goods-receipt lot of the master anywhere in servd (else the newest
  billed price, else manual cost, else the highest typed estimate); average = quantity-weighted deliveries of the last
  `AVERAGE_DAYS` (90). Held per base unit (g / ml / pcs), shown per kg / litre / pcs. `withLatestCosts` prices every
  recipe line WITH a master at it (converted into the item's unit; never "not stocked"); a line with no master keeps
  the company's `latestCostsMany`. `withAverageCosts` gives the recipe screens' "90-day average" beside the latest
  (`avg*` fields on the recipe list, detail and preview; a line with no recent delivery keeps its latest). Master
  rows carry `price` (null for `costsHiddenFor`); `GET /ingredient-master/:id/prices` = the history with date,
  company and supplier. Read only — stock, FIFO, cost of sales and food-cost actuals stay each company's own. The
  Sourcing sheet page is gone (`/sourcing` → `/kitchen/ingredients`); its "remove ingredients not in a recipe"
  clean-up is on Inventory (CEO). **Editable in the table (owner, 2026-10-29: "just make this editable within the
  table"):** name / spec (MASTER_EDITORS), category / unit (reviewers) through the existing PATCH, and the price —
  `PUT /ingredient-master/:id/price {priceCents per kg / litre / pcs}` (MASTER_CREATORS: editors + buyer; never a
  `costsHiddenFor` login; audit `ingredient_master.price`), stored in `IngredientMasterPrice` (platform table, no
  tenantId, one row per edit, never edited): a typed price is the LATEST until a newer delivery comes in (source
  `sheet`, in the history). Tests: `tests/ingredientMaster.test.ts`, `tests/recipeCompanyShare.test.ts`.
- **Par in PORTIONS (K5)** — `Recipe.portionsPerBatch` (portions one batch makes; size = yield ÷ it,
  `lib/portions.ts`, never stored) + `portionLabel`. A prep batch may be logged in portions (`actualPortions`; 422
  `NO_PORTION_SIZE` without). Portions are what CAME OUT: the draw is whole batches (`batches`, default 1), expected =
  batches × yield, so the variance and `yield_low` see a short batch. Daily par per outlet: `ParTarget` (tenantId = the outlet's company, RLS, merge
  repoint; `PUT /kitchen/par-targets`, managers).
- **ONE engine** `modules/kitchen/prepPlan.ts buildPrepPlan` (forecast = `forecastDishesForDay`, same weekday, last 4
  weeks) behind `GET /kitchen/prep-list`, `/kitchen/par-board`, `/kitchen/par-targets` and `/kitchen/shopping-list`
  (→ procurement's ONE suggester `reorderSuggestions(…, {demand, locationId})`; `POST …/draft-pos` through
  `createPo`; an ingredient the company has never stocked is listed as `notStocked` — "Not stocked yet — create" —
  never dropped, never ordered). `/ops/prep-list` and `GET /par-sheet` are removed (admin redirects). Spec list `GET /kitchen/spec-list`
  (+ `?format=`); PO email and detail carry each line's spec.
- **K7:** the old Component library is gone (`modules/components`, `/par-sheet/components`, module id `components`
  retired); its tables stay.
- Tests: `ingredientMaster`, `recipeCompanyShare`, `kitchenFlow`.
- **Removals on a line ("No onions"; owner, 2026-10-27: "any item that is being deducted from stock will be adjusted
  if customer asks to remove").** `OrderItem.removedIngredients` (JSON `[{masterIngredientId | inventoryItemId |
  prepRecipeId, name}]`, migration `20261027160000_order_line_removals`); `lib/lineRemovals.ts` is the one rule.
  Removable = the TOP-level lines of the dish's APPROVED plate recipe (raw by master, else stock item; sub-recipes by
  recipe), never packaging — `GET /menu/items/:id/removable` (any staff of the brand's company; other company 404).
  The ring-up and add-items check them in `prepareOrderLines` (422 `INGREDIENT_NOT_ON_RECIPE`); the sale explosion
  (`consumptionPerLine`) skips those lines (a sub-recipe with its whole explosion) for that line only, so stock and
  cost of sales follow; price unchanged. KDS / KOT / receipt / pre-bill print "No <name>". Add-ons and their
  'removes' recipes are unchanged. Till: "Remove" on a cart line (`components/pos/RemoveIngredients.tsx`). Tests:
  `tests/orderLineRemovals.test.ts`.
- **Kitchen stations: the F&B manager and the chef raise, the CEO approves (owner C3, 2026-10-26: "Approval
  stays with me").** `POST /stations` / `PATCH /stations/:id` by `fnb_manager` / `boh_management` (with
  `kds_config`) answer 202 `{ pendingApproval, request }` — a `StationChangeRequest` (tenantId = the brand's
  company, RLS, merge repoint; one pending per station, 409 `STATION_CHANGE_PENDING`; 409 `NOTHING_TO_CHANGE`);
  the CEO's own edit applies at once; delete stays the CEO's. Approval type `station_change` (section ceo,
  never delegable; `stations/changeRequests.ts`, provider `stations/approvalProvider.ts`): approve re-runs the
  station rules (`stations/rules.ts`) and applies in the claim's transaction; reject needs a note ≥10; the
  requester may withdraw (`/requests/:id/cancel`). KDS config shows "Waiting for the CEO".
- **Use-by dates (owner B6, 2026-10-26: "Use-by date on deliveries of perishable items, plus an expiring-soon list
  and bell notice").** `perishable` + `shelfLifeDays` are the MASTER's definition (`IngredientMaster`), mirrored onto
  linked items as MASTER_FIELDS (master PATCH, twin link, merge, new items; locked on a linked item — 422
  `MASTER_FIELD_LOCKED`); an unlinked item (prep, legacy) keeps its own. `StockLot.useBy` (DATE, Karachi day;
  `lib/useBy.ts`): the dock and PO receive require one on a perishable line with no shelf life (422
  `USE_BY_REQUIRED`; `receiveGoodsTx requireUseBy`), else received day + shelf life; a cash buy records one only
  when defaulted; a prep lot = the earliest use-by drawn (capped by the prep item's shelf life); a transfer's arrived
  lot keeps the shipped lot's. Record + report only — FIFO order and costing never read it. `GET
  /inventory/expiring?locationId&days=3` (`modules/inventory/expiring.ts`, siteScope, stock readers, no value for
  the kitchen floor); Inventory → "Use-by" tab. Bell `stock.expiring` (worker `stockExpiry`, 07:10 PKT): once per
  lot per stage (expires tomorrow / expired — markers written only by `stockLedger.ts markUseByNotifiedTx`), one
  notice per outlet to the company's kitchen managers holding `inventory`. Migration `20261026170000_stock_use_by`;
  tests `tests/stockUseBy.test.ts`.
- **Station screen = 4–6 order cards, Start, timers, tick; expo backlog + 60 s alert + bag stickers (owner B12,
  2026-10-26: "show them 4-6 orders at a time … Timer going off should just make the order card blink red.. no
  noise … if an order card is sitting on screen for 1 minute without being started, expo needs an alert").**
  `modules/expo/kitchenBoard.ts` extends the ONE KDS (never a second): `loadStationQueue` is THE station queue
  (`/expo/station/:id/queue` reads it unchanged); a CARD = one order's live work at one station (fired steps +
  legacy lines), oldest first, the first `Station.visibleCards` visible — FIXED at 4 for every station (owner, 2026-10-30: "make standard 4
  cards on screen for all kitchen stations"; migration `20261030120000`; the KDS config picker is gone,
  `PUT /expo/stations/:id/display` accepts only 4), the rest queued. Kitchen view (`/kds`) shows each station's
  cards in ONE horizontal row that scrolls sideways (owner, 2026-10-30). `GET /expo/station/:id/board` stamps `kdsShownAt` once on first show; Start
  (`/cards/:orderId/start`) stamps `startedAt` (step, or `OrderItem.startedAt` for a line); the tick
  (`/cards/:orderId/done`) bumps every row through `stepCascade.ts completeStepBump` (the cascade — the next
  station's step fires; also behind `POST /expo/steps/:id/bump`) or `updateItemStatus` (409 `CARD_ON_HOLD`).
  `KitchenTimer` (tenantId = the order's company, RLS, merge repoint): `POST/PATCH /expo/kitchen-timers`,
  `/:id/stop`; ended = the card blinks red — NO sound. `GET /expo/kitchen-status`: backlog `tickets` = orders
  queued somewhere and visible nowhere, the 60 s unstarted list (never a held card). Stickers: `GET
  /expo/orders/:id/print?kind=sticker|ticket&bags=1–20` at the company's label size (Setting
  `kds.labelSize:<tenantId>`, `PUT /expo/label-settings`, managers + expediter); the ticket is not a bill.
  Migration `20261027140000_kds_board_timers`; tests `tests/kdsBoard.test.ts`.

- **Weekly database backup FILE, CEO only (owner S13, 2026-10-26: "make it a weekly file i can download and
  save to my pc.. ceo only..").** `modules/backups/` (contract: `service.ts` header), page CEO → Backups
  (`/ceo/backups`, module `backups` — CEO workspace, `CEO_ONLY_MODULES`; every route ADMIN_ONLY). The API runs
  `pg_dump --format=custom` (the image installs `postgresql17-client` — build-arg `PG_CLIENT`; its major must be ≥
  the server's) as `BACKUP_DATABASE_URL` → `MIGRATE_DATABASE_URL` (the owner: a non-owner login under RLS dumps empty
  tables) → `DATABASE_URL`, password via PGPASSWORD only, streamed straight into an AES-256-GCM file (format in
  `backups/crypto.ts`): a fresh data key per file wrapped with an RSA public key whose private key is stored ONLY
  sealed under the CEO's backup passphrase (scrypt) — the passphrase is never stored, so the weekly job can encrypt
  but nobody (servd included) can open a file without it; each file carries what it needs except the passphrase
  in force when it was made. No passphrase → no backup (manual 409 `BACKUP_PASSPHRASE_REQUIRED`; weekly recorded
  failed + bell). Weekly Sunday 03:00 PKT (`workers/databaseBackup.ts`, ENABLE_WORKERS, never on the practice copy);
  files on the API box at `BACKUP_DIR` (default `/app/backups` = compose volume `servd_backups`), never the public
  media bucket; the last 8 good ones kept (`DatabaseBackup` rows, platform table, no tenantId). Download
  streams the ENCRYPTED file, audited `backup.download`; passphrase set / change audited (change needs the current
  one or `replaceForgotten`). Bell `backup.result` to the CEO on every weekly result. Opener:
  `backend/scripts/decrypt-backup.mjs <file>` (Node only; also `GET /backups/opener`) → `.dump` → `pg_restore`.
  Tests: `tests/databaseBackup.test.ts`.
- **Open-items IT answers (owner, 2026-10-26).** Error tracking: `lib/errorTracking.ts`
  (Sentry, `SENTRY_DSN_API`, scrubbed `beforeSend`, sandbox kind `error_report`; `captureServerError` is called
  only for the 5xx fall-through of the error handler). **The WhatsApp gateway watchdog is the EXISTING
  `workers/deliveryWatch.ts`** (never a second one): every 5 min, two confirmed bad runs → the existing WhatsApp /
  email alert PLUS one bell notice (`integration.alert`, `bellGatewayState`) to every active CEO and IT login (one row
  each, under the person's own company; dedupe per outage), one "back up" notice on recovery; state in Setting
  `integrations.delivery.state`; `/health` `whatsappGateway` warn (cause + count only). No exception flag
  (platform-wide, not a company's). Weekly Docker clean-up: `deploy/docker-cleanup.ps1` +
  `register-docker-cleanup.ps1` (images / cache older than 7 days, never volumes; see WINDOWS-SETUP.md).

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
  are ordinary manual transfers. **Head office books credit 4220 "Head Office
  Recharge Income"** (`ACCT.HO_RECHARGE_INCOME`, 42xx other income; HO-Q3
  decided by the owner 2026-10-26: SHOW AS INCOME) — never 6990, which stays
  the shared-fleet recharge's recovery account and is refused as a head-office
  recharge account; books still on 6990 move to 4220 at boot (recharge-OFF
  only, `headOffices/accounts.ts moveRechargeToIncome`). Each company gets
  "Head office charges — <HO>" at the first free code in 6200–6249.
- **The split is owner-set:** 37.5% GS Foods / 62.5% GS x Viva (3750 / 6250
  bps), created only by the setup wizard as "GS Head Office". Versioned per
  month (`splits.ts`); `splitByBps` is the ONE rounding rule (leftover paisa
  to the largest share at exactly 100%; below 100% the rest stays with the
  head office).
- **The head office is a SALARY-SPLITTING entity only (owner, 2026-10-30: "head office is just a salary
  splitting entity. no expenses to be charged other than salary splitting" — REPLACES HO-Q1's 5000–6999
  pool).** The cost pool is the wages accounts 6030–6036 (wages by department, each carrying the employer EOBI /
  SESSI payroll books there, and gratuity) — `headOffices/books.ts DEFAULT_COST_POOL`; `PUT
  /head-offices/:id/books/pool` refuses anything outside them (422 `POOL_SALARIES_ONLY`); migration
  `20261030130000` moved existing books to it (confirmation + recharge switch cleared). Nothing else the head
  office books is ever recharged. Books tab shows "What is shared" (no pool editor).
- **Recharge posting is OFF per head office** (H51, 2026-10-16: stays off for the 25 Oct sign-off) until the CA confirms the
  accounts (`HeadOfficeBooks.accountsConfirmedAt`) and the CEO sets
  `rechargeFromPeriod` (DB CHECK `head_office_books_enable_chk`). Any change
  to accounts, pool or links switches it back off. The worker (under
  `ENABLE_WORKERS`) only PREPARES and SUBMITS a run for approval — it never
  posts. **Decided (owner, 2026-10-26):** HO-Q1 = the default cost pool, NOW salaries
  only 6030–6036 (owner, 2026-10-30; no markup; `pool.ts` drops the recharge account by
  id); HO-Q3 = income (4220, BUILT; the All-companies P&L shows income and
  cost until eliminations exist — noted on the Books tab).
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
- **COD block links** go through `reconciliation/codCloseCheck.ts
  codPendingLink` (night audit `cod_pending`, month close `cod_with_rider`):
  Reconciliation → Cash on delivery while code-only delivery is ON, otherwise
  the till's pay-in list (`/pos/shift`; needs `pos`, so finance sees the
  no-access page — cosmetic).
- **Emergency overrides** (`/emergency-overrides`, module `emergency_overrides`;
  defaults RGM, chef, `fnb_manager`, `management`, CEO; not the co-owner):
  send the code to the rider (new code, WhatsApp to the rider, ONCE per order,
  mandatory reason; a collusion path, so audited and scored) and log
  returned food as waste. Every action answers 409 `CODE_ONLY_OFF` while the
  order's company has the switch off. Thin shell: the rules live in
  `dispatch/service.ts` and `orders/returnedFood.ts`.
- **A booked rider debt no longer blocks the night run (owner, 2026-10-17).**
  `cod_pending` blocks only COD with no live booked debt (own rider: a
  non-reversed `cod.rider_debt:<paymentId>` entry; fleet: a posted `cod`
  transfer) — booked ones warn "rider owes — booked"
  (`codCloseCheck.ts codBookedDebtIds`). The month close `cod_with_rider` is
  unchanged: it still blocks on any pending COD.
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
- **Managers correct a guest's phone / email (owner C20, 2026-10-26).** `POST /crm/customers/:id/contact
  {phone?, email?, reason ≥10}` (`crm/contactCorrection.ts`; MANAGERS + the '/crm' module rule; a guest the
  manager's companies served — else 404). Refuses a contact another guest holds (409 `PHONE_TAKEN` /
  `EMAIL_TAKEN`), clears the changed contact's verification, revokes every session of the customer, sends
  nothing, never touches a staff login; audit `customer.contact_change` (old → new, reason, actorRole). CRM
  page: "Correct phone / email".
- **Ban appeals** are an `OrderComplaint` of kind `ban_appeal` on the existing
  Complaints queue (no second table; `complaints/appeals.ts`; one queue, any
  company in the customer's history sees it). Customer routes
  `GET /storefront/account/blocks`, `POST /storefront/account/ban-appeals`
  (3 a customer an hour). **Switch:** platform Setting `crm.banAppealsEnabled`,
  OFF by default, the CEO's on Complaints (`PUT /complaints/settings/appeals`);
  OFF = storefront routes 404, WhatsApp keeps the BANNED reply, no
  BlockedNotice. `release-contact` clears `Customer.phone` and is audited.
- **Compensation tickets (owner, 2026-10-27: "extend Complaints").** Every customer compensation at the
  till — a void (line: audit `order_item_void`; whole bill: `order.cancel` with a user), a comp / No Charge
  (`order_comp`; staff meals are not), a refund (`order_refund` — card-machine refunds included, the refund a
  line void makes is that void's ticket — `order_refund_due`, `order_credit_note_payout`), a discount above the
  limit and a price override (review flags `discount_above_cap` / `price_override` on the order) — is ONE
  `OrderComplaint` of kind `compensation`, whatever the amount. Made from those committed rows, never by a
  hook in the till: `complaints/compensation.ts syncCompensationTicketsForCompany` (`compSourceRef`
  `audit:<id>` / `flag:<id>` unique, createMany skipDuplicates), worker `workers/compensationTickets.ts`
  (every minute, per company, 7-day window) + the list route's own sync. Company = the order's brand. Born
  `resolved` — managers' tickets need no CEO approval. `GET /complaints/compensation` (MANAGERS; type /
  status / flagged / dates / brand); `POST /complaints/:id/flag {note ≥10}` / `/unflag` — the CEO only
  (`FLAG_ROLES`; hand-over to come, the approvals delegation registry does not fit a review mark) — raises /
  resolves an ExceptionFlag `compensation_flagged` in the ticket's company naming the approving manager
  (actorId = the manager, so the bell tells the CEO). The ordinary complaint list / stats / dashboards
  exclude `compensation`; PATCH on a ticket is 409 `COMPENSATION_TICKET_READ_ONLY`. A PIN-approved discount /
  price override has no recorded approver (null). Admin: Complaints → Compensation tab. Migration
  `20261027170000_compensation_tickets`; tests `tests/compensationTickets.test.ts`.
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
  manual (one reminder a Karachi day). **A client in credit cannot be closed**
  (`exposureOfTx().creditCents` = money owed back, never netted against
  exposure; 409 `CLIENT_IN_CREDIT`; pay it back with `POST
  /accounting/receivables/:id/refunds`; screens show "In credit").
  **Pending owner/CA confirmation:** G14 (on-account tender) and H14
  (on-account tax invoice) — built on the defaults above; per H51 (2026-10-16)
  on-account stays OFF for the 25 Oct sign-off.

### City Ledger = the on-account clients (owner, 2026-10-24)

"Extend on-account" (owner's pick when the City Ledger brief overlapped the on-account clients): ONE store —
`CustomerAccount` / `CustomerAccountCharge` are the City Ledger accounts and their POS bills; never a second
ledger. Contract: header of `backend/src/modules/receivables/cityLedger.ts`.

- **Accounts:** `accountType` (company | corporate | travel_agent | guest | other), a typed account code or
  OA-0001… (409 `ACCOUNT_CODE_TAKEN`, per company), payment terms 0 ("immediate") – 180 days; the receivable
  account is 1110 (the one AR control account). Approval, limits and cards as before.
- **Closing a bill on City Ledger at the till:** the card as before, OR an account picked from
  `GET /pos/city-ledger/accounts` with a manager's approval (`requireManagerApproval`; `accountId` +
  `managerOverridePin` on `POST /pos/orders/:id/on-account`; 422 `ON_ACCOUNT_CARD_OR_MANAGER` with neither).
- **Paying bills one by one:** `CityLedgerSettlement` + `CityLedgerAllocation` (tenantId, RLS, merge
  repoint); an explicit split across chosen bills; `CustomerAccountCharge.settledCents`; still owed =
  amount − refunded − settled (`chargeOwedCents`). Only bills that are BOOKED and NOT on a statement (409
  `BILL_NOT_BOOKED` / `BILL_ON_STATEMENT` — a statement is paid in Receivables). ONE entry
  `cityledger.settlement:<id>` Dr money / Cr 1110 (memo `ON ACCOUNT`). Till: cash into the drawer (Dr 1015 + a
  `payin` CashMovement the shift close SKIPS — `shiftPosting.ts` cityLedgerIds) or bank transfer with its
  reference; back office (`/accounting/customer-accounts/:id/settlements`): RECEIPT_METHODS with a reference.
  Never card or Raast (their matching reads till sale payments only). Idempotent per (tenantId,
  idempotencyKey). Reversal (`/settlements/:sid/reverse`, reason ≥10): mirrored entry, bills owe again; till
  cash only while its drawer is open (a pay-out the close also skips); refused while a bill is on a statement
  (409 `SETTLED_BILL_ON_STATEMENT` — void the statement first).
- **Net of settled everywhere:** exposure (`exposureOfTx`, a bill refunded after payment owes BACK), the
  statement (bills only what each bill still owes; a fully paid bill is never billed), its write-off brand
  split and the 1110 tie-out.
- **Reports:** City Ledger Summary / Detail in the till Reports read ONLY `receivables/cityLedgerReport.ts`
  (account figures from `clientHistory`, the one running balance; bills as at the period end; a statement's
  money shown against its bills oldest first). The account field is required (`clAccounts=all` or ids; 400
  `ACCOUNT_REQUIRED`), plus `clAccountTypes` and option `ignoreZero`. Review fixes (2026-10-24): a bill refunded after payment owes BACK — finance pays it back (`direction: 'out'`, Dr 1110 / Cr money); a till cash settlement reversed after its drawer closed goes back out from cash on hand / a bank (`refundFrom`); a till bank transfer needs `transferVerified` and a reference unused by another live settlement; back-office receipts need an idempotency key and a date not in the future nor before the bill; typed codes never `OA-<n>`; 'booked' = the drawer's LIVE close; history / reports read STATEMENTS only (a back-office invoice naming the client is not City Ledger). Account-wide (all brands of the client's
  company). Back-office reads: `/:id/bills`, `/:id/history`, `/:id/settlements`, receipt HTML.
- Tests: `tests/cityLedger.test.ts`, `tests/onAccountTill.test.ts`.

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

### Record files (owner, 2026-10-16)

"It should ask for attachment instead of URL for supporting docs" — and, for
every screen, "One private store … so any record can carry files — only staff
of that company can open them, View + Download. One store across servd, no new
copies."

- **No URL fields for supporting documents.** A receipt, bill scan, dock
  photo, prep photo, HR document or asset document is an uploaded FILE. Old
  URL columns (`receiptUrl`, `attachmentUrl`, `photoUrl`, `fileUrl`,
  `documentUrls`) stay readable and displayed for old rows; new screens never
  ask for one.
- **One store:** `CashVoucherAttachment` (bytes in the DB, RLS by `tenantId`),
  kind `record_file`, owner `(ownerType, ownerId)` (migration
  `20261016210000_record_files`; owner CHECK in `tests/setup.ts`).
  `lib/recordFiles.ts` is the ONE writer / reader: files decode only through
  `lib/evidenceFile.ts` (images + PDF; Office / CSV / text where the provider
  allows it), ≤ 3 MB each, ≤ 10 per record (409 `TOO_MANY_FILES`, advisory
  lock), all checked before any write, stamped with the RECORD's company.
- **A provider per record type** (`modules/recordFiles/providers.ts`):
  `opex_payment`, `supplier_bill`, `goods_receipt`, `prep_batch`,
  `hr_document`, `fixed_asset`. Each applies its module's OWN rule — its role
  arrays, its Module Access gate (the central rule of the module's path via
  `enforceModuleAccess`, or its in-route `moduleGateForNewRoles`; `/record-files`
  is not a gated prefix itself) and its company scope (foreign → 404).
- **API `/record-files/:ownerType/:ownerId`** — GET list (metadata, never
  bytes), POST `{ files }` (1–5), GET `/:fileId` (inline for images / PDF,
  attachment otherwise). **No delete**: evidence on posted money is never
  removed (upload the right file instead); the Trash purge of an owner (HR
  document) erases its files (`purgeRecordFilesTx`). The dock receive takes
  `photos` inline and they satisfy the photo threshold.
- **Admin:** `components/files/RecordFiles.tsx` (saved record: list, View,
  Download, attach), `PendingFilesPicker.tsx` + `uploadRecordFiles`
  (create forms: create the record via its own route, then upload to its id),
  `FileViewModal.tsx`. ERP tokens only. One `<RecordFiles>` per row of a
  list takes `lazy` (loads on "Files") — never one request per row (the API
  rate limit is 200/min). `/record-files` is excluded from the portfolio
  "which company?" prompt (`lib/api.ts`): the server stamps the record's company.
- **Manual journal entries carry documents (owner, 2026-10-20):** provider
  `journal_entry` (a `manual:` entry only; read = ledger readers, attach =
  `JOURNAL_POSTERS` with `accounting`); the journal form uploads to the posted
  (or corrected) entry, each listed entry has a lazy Files panel.
- **A new screen with supporting documents = a provider + a two-company test**
  (`tests/recordFiles.test.ts`) in the same change — never a URL field, never
  a new file table.

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
- **Business day (owner, 2026-10-16; H46 confirms):** a till closing before
  05:00 PKT books to the business day it OPENED on. `lib/businessDay.ts` is
  the one rule (`BUSINESS_DAY_CUTOFF_HOURS`, `shiftBusinessDay` /
  `shiftBusinessDate` / `closedShiftsOfBusinessDays`): the `shift.close`
  entry is dated 23:59:59.999 PKT of the opening day, so the P&L, sales-tax
  return, month close and day lock follow; the night-audit shift checks, daily
  report, activity days, `sales_bank_unmatched`, the close checklist's
  unposted tills and a refused shift posting's document date use it too. A
  new reader of "the shifts of a day" uses `closedShiftsOfBusinessDays`, never
  `closedAt` in a calendar window. Orders and payments keep calendar dates.
  If the day is already audited or locked the posting is refused, flagged and
  re-posted late.
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
  fires after 2 working days (H45, Hasnain 2026-10-16): an `audited` day not
  `closed` once its 2nd working day after the sales day is over → ONE
  `night_audit.awaiting` bell notice to that company's CEO + finance (with
  accounting), naming what is unmatched; Mon–Sat working, Sunday off
  (`NON_WORKING_WEEKDAYS`, no bank-holiday calendar); once per day per
  company and reopen; run by the hourly `nightAuditSettle` worker after it
  settles (`nightAudit/service.ts notifyAwaitingSettlement`).
- **HR digest and reminders (owner, 2026-10-26, B5a).** `hr/expiryDigest.ts` + worker `workers/hrDigest.ts`:
  ONE `hr.digest` bell notice per recipient per ISO week per company (Setting `hr.digest.lastWeek:<tenantId>`
  + dedupeKey; daily 09:00 PKT check so a down box catches up) built from the HR Lifecycle & Dues report
  (`buildReport('lifecycle_dues')`: probation / contract ending within 30 days, CNIC within 90, overdue
  included): HR logins holding `staff_hr` get the company list, each HOD (hodDepartmentOf's rule) their
  department's. `hr.reminder`: an `hr_request` waiting on the same step 2+ days (since `updatedAt`) tells
  `approverIdsFor`, again every 2 days, max 3 per record per step (dedupeKey `hr.reminder:<id>:<step>:<n>`).
  Tests: `tests/hrFoodSafetyBell.test.ts`.
- **Food safety overdue + inspector printout (owner, 2026-10-26, B7a).** `foodSafety/overdue.ts` + worker
  `workers/foodSafetyOverdue.ts` (hourly): a unit with no reading for 24 h or a cleaning task past its
  frequency window sends ONE `food_safety.overdue` notice per occurrence (dedupeKey on the last reading / clean)
  to the company's manager, management, boh_management and fnb_manager logins holding `food_safety`.
  `GET /food-safety/inspector-report?format=pdf|xlsx|csv&from&to&locationId` (default 30 days, caller's company
  view, foreign outlet 404) through `lib/reportExport.ts`; "Print for inspector" on the page.

### Payroll pay basis (owner HR-1 / HR-2, 2026-10-16)

"We will do by actual number of days in a month." `computePayslip`
(`backend/src/modules/hr/logic.ts`) is the ONE engine (payroll and full &
final): **salary = monthly gross ÷ the month's calendar days (28–31) × paid
days**, paid days = days employed − absent days − unpaid leave days, rounded
once. Days before joining / after the last working day are not employed — never
absences (HR-2). Absent = an `absent` record (1) / `half_day` (0.5) on a day not
covered by approved leave; weekly off days, holidays, paid leave, lates and days
with no record are PAID. Lates stay a deduction line at the same daily rate.
EOBI-on-gross / SESSI / tax keep the employed-days base. The breakdown is kept on
each payslip as `inputs.payBasis` and is what the run page, the register CSV and
the Payroll Report's Days Worked show. New payslips carry no `absence` /
`unpaid_leave` lines (old ones keep theirs; `hr/ledger.ts` reads both). The old
"working days per month" (26) setting is RETIRED (`mergeSettings` drops it; a PUT
that sends it is ignored). Only drafts are recalculated; approved / locked runs
keep their figures. Tests: `tests/hrPayDaysBasis.test.ts`, `tests/hrModule.test.ts`.
**No paid days, no tax; F&F docks absences (owner, 2026-10-16: "skip tax when
no paid days, apply absences in F&F").** A month with paid days = 0 takes NO
income tax, NO EOBI (employee or employer) and NO SESSI; zero lines say why
(`NO_TAX_NO_PAID_DAYS`, `NO_EOBI_NO_PAID_DAYS`), and the accrual still balances.
Half a paid day is a paid month. A month whose tax exceeds a few days' pay still
goes negative and is blocked (`runBlocker`) — not capped. A full & final docks
each month it pays with that month's absences, half days and approved unpaid
leave, read by `service.ts attendanceWithin` (the ONE attendance reading
`prefillInputs` uses too); lates are not docked in F&F. Calculate stamps only a
settlement still editable with no approvals. Tests: `tests/hrNoPaidDaysFnf.test.ts`.
**Overtime is opt-in (owner, 2026-10-21: "give an option to HR to add OT in
final payroll at time of payroll, other wise it should not include in
payroll").** A payroll run and a full & final start with NO overtime; the
approved, unpaid OT is listed as `inputs.otAvailable` (`service.ts
unpaidOvertime` → `otAvailableOf`, priced as approval priced it) and is paid
only once HR adds it to a DRAFT: `POST /hr/payroll/payslips/:id/overtime
{recordIds}` (replaces the choice, `[]` removes it), `POST
/hr/payroll/runs/:id/overtime {all: true} | {payslipIds}` ("Add all available
overtime"), and for a full & final `POST /hr/final-settlement/calculate
{…, recordId, otRecordIds}` (stamped as `_calc.otRecordIds`). Same people and
gate as editing a payslip (`HR_ADMIN`); not a draft 409 `RUN_NOT_DRAFT` /
`FNF_NOT_DRAFT`; a record not approved, already on a payslip or settlement,
another employee's or company's 422 `OT_NOT_AVAILABLE`; audit
`hr.payroll.overtime_added` (+ `actorRole`). "Paid" = listed in a payslip's
`otRecordIds` (any run status) or an approved settlement's
`_calc.otRecordIds` — OT not added stays available. Recalculating keeps what
HR added while still available; a draft from before this rule starts from none
on its next recalculation. The F&F stores the days its salary pays as
`data._payBasis` (one row per month: from–to, days employed, absent, unpaid
leave, paid days, salary) — shown on the form and printed as "Days paid".
Tests: `tests/payrollOvertimeOptIn.test.ts`.
**Deductions by type (owner, 2026-10-30: "Make sub categories for deductions column, e.g: Late, Advances, loan,
IPD, etc to select by HR").** Per-company types in HR settings `deductionTypes` (`logic.ts DEFAULT_DEDUCTION_TYPES`:
Late coming, Advance, Loan, IPD (medical), Other; each `posting` `recovery` | `deduction`); `GET|POST /hr/deduction-types`,
`PATCH /:key {label?, posting?, active?}` (HR_ADMIN, active company; never deleted — switched off; a posting change
of a type on any payslip 409 `DEDUCTION_TYPE_IN_USE`; the settings PUT never touches them). HR adds lines to a DRAFT
payslip with `PATCH /hr/payroll/payslips/:id {deductionItems:[{id?, typeKey, amountCents, note?}]}` (replaces the
list; 409 `RUN_NOT_DRAFT`; a type not active in the payslip's company 422 `DEDUCTION_TYPE_UNKNOWN`; audit
`hr.payroll.deductions_set`), stored as `inputs.deductionItems` (label + posting snapshotted), kept through Recalculate,
one `ded:<typeKey>` line each in `computePayslip`. Books (`ledger.ts isPayReducing` / `isLoanRecovery`): `deduction`
nets off the wages debit like `other`; `recovery` credits 1350 like the installment and is split over the employee's
open loans / advances (`allocateRecoveries`, own kind first; more than owed 422 `LOAN_OVER_OUTSTANDING`, and a
Recalculate that no longer fits warns + `runBlocker` blocks) — `service.ts payslipLoanLines` is the one reading of a
payslip's loan recoveries. A typed "Late" is HR's extra amount ("(added by HR)"), apart from the engine's lates.
`deductionAdjustmentsCents` still works ("Other deductions"). Register / Deduction report exports list by type
(`dedTypeLabel`). F&F untouched. Tests: `tests/payrollDeductionTypes.test.ts`.
**Absent without a punch, punch overtime, Attendance & Leaves (owner,
2026-10-22: "Total days … should show days of the whole month, and days worked
should show as per attendance … calculate accurate Overtime, again OT should
not include in payroll on auto … add column for availed leaves").**
`hr/attendanceDays.ts` is the ONE reading (payroll, F&F, the report and the
register). **Rule A:** from HR setting `absentWithoutPunchFrom` (per company,
default `2026-10-01` — owner, 2026-10-30: "Dock October too", replacing H52's
"October pays as is" for absences; migration `20261030100000` moved companies still
on the old default; null = off) a WORKING day — the
rota (`rotaFor`) gives a shift, not a holiday for the person's branch, not on
approved leave, employed, and already over (before today PKT) — with no standing
attendance record is absent (1) and docked (`attendanceInputs`'
`noPunchWorkingDays`). Any standing record (punch, approved correction, manual
day the CEO approved) wins; a person with NO rota is never auto-absent.
**Rule B:** punch OT = time worked (paired punches; a corrected / hand-keyed day
its check-in → check-out) after the rota shift's end, or beyond
`standardDayHours` (9) on a day with no shift; under `otMinimumMinutes` (30)
ignored; priced like approved OT. **Rule C:** never paid on its own —
`service.ts availableOvertime` (the ONE list; `unpaidOvertime` is approved
records only) offers it as `{recordId: 'punch:<attendanceRecordId>', source:
'punch', basis}` beside approved items (`source: 'approved'`); HR adds it
through the existing opt-in routes (ids accept `punch:<uuid>`); paid once
(payslip `otRecordIds` / F&F `_calc.otRecordIds`). An approved request for the
same day wins over that day's punch OT, and is not offered when the day's punch
OT is already paid. Report: Total Days = calendar days; Days Worked = days with
attendance (half day 0.5); Absents / Unpaid as payroll docks; OT Hours =
approved + punch (approved wins per day); Casual / Annual / Sick Availed beside
the balances (balances include `leave_adjustment`). Tests:
`tests/hrPunchOvertimeAbsent.test.ts`.

**Company default rota (owner, 2026-10-22: "Put all staff on the rota before
1 Nov" — 11:00–19:00, Monday off).** HR setting `defaultRota {start, end,
breakMinutes, weeklyOff}` (per company, default ON at those values; null =
off; HR → Settings → "Company default rota"). `hr/rota.ts rotaFor`: a person
with NO roster of their own on a day works the default shift (source
`default`) or is off on its weekly-off days; their own roster, a swap, a
/scheduling change or leave wins. So the absent-without-punch rule and punch
overtime cover everyone. Tests: `tests/hrPunchOvertimeAbsent.test.ts`.

**Check-in by itself, office network only (owner, 2026-10-22: "It should
happen only when someone open servd on Office wifi").** The admin checks a
person with an HR record in at sign-in AND once a Karachi day while they stay
signed in (AppShell → `lib/checkInOnSignIn.ts`; asked again on return to the
tab, at most every 10 minutes; only the day's FIRST in — never re-checks in
someone who checked out today), but ONLY when `GET /time-clock/status`
answers `onOfficeNetwork`. A browser cannot read the Wi-Fi name, so an office
network is the public address the API sees (`req.ip`): HR settings
`officeNetworks` (per company, ≤20; HR → Settings → "Office networks", "Add the
network I'm on now" via `GET /hr/settings/current-network`), matched by
`lib/officeNetwork.ts` (IPv4 exact, IPv6 /64). No network listed = nobody is
checked in by themselves; the Check in button works anywhere as before.
`clockIn` writes an 'in' under a per-login advisory lock, so racing tabs never
stack two. Tests: `tests/officeNetwork.test.ts`.

**Geo-fenced attendance (owner's card + answers, 2026-10-22).** Builds on the
15 Oct time clock (`timeclock/policy.ts`, work locations) — never a second one.
Every punch is a person's OWN login: kiosk PIN clock-in was removed (owner,
2026-10-27); old kiosk punches still count and are still measured as recorded.
(1) The clock measures ONLY from the pin + radius the CEO approved
(`Location.fenceLatitude / fenceLongitude / fenceRadiusMetres`, migration
`20261022190000`; companies whose geofence was already on had their pins carried
over). A new / moved pin or radius (`latitude` / `longitude` /
`geofenceRadiusMetres`, edited on Locations) waits: approval type `location_pin`
(CEO only, never delegated; `GET /locations/fence-pins`, `POST
/locations/:id/fence-pin/approve|reject` with the pin shown — 409 `PIN_CHANGED`
if it moved; `fencePinPending` in `lib/approvalRights.ts` is the one rule). The
CEO's own edit is the approval. Company default radius 100 m. (2) A reading the
device says is worse than 50 m (`accuracyM`, `MAX_FIX_ACCURACY_M`) is out of
area (`poor_fix`); the in-store tablet does not send accuracy (indoor GPS). (3)
An office network in HR settings may name a location (`officeNetworks[].locationId`;
owner: "Office Wi-Fi = Head Office location"): a punch from it is AT that
location with no map reading — in area for that location's staff, out of area
for everyone else. (4) While the company's geofence is on, an employee's
out-of-area punch is saved and the DAY is held for their HOD
(`hr/attendance.ts holdDay`: status `submitted` + `data._outOfAreaHold`), so it
is out of payroll, overtime and tip-pool hours (`STANDING_ATTENDANCE`; tip pools
read standing days only) until approved. It goes through the HR request engine
— `service.ts workflowOf` gives such a day the one step `OUT_OF_AREA_WORKFLOW`
(HOD; HR when no manager); every reader of a record's steps uses `workflowOf`.
The person adds a reason with the punch (`reason`) or later (`POST
/time-clock/hold-reason`, own day only; the card asks). No new exempt roles (CEO
and co-owners only). (5) **A forgotten clock-out is clocked out by servd at
12:00 AM** after the in's day (owner: "it should auto log-out at 12:00 AM";
`autoClockOutData`: an `auto` out punch, check-out 00:00, the day keeps its
status, `_autoClockedOut`, flag `attendance_auto_clock_out` for HR; no punch
overtime and no tip-pool hours from it). (6) **Work locations may be map pins (owner, 2026-10-27: "make work locations a system in which i can add multiple
pin locations"):** an `HrWorkLocation` is EITHER a company Location OR the employee's own pin (label, lat, lng, radius;
≤20 per person, CHECK `hr_work_locations_kind_chk`, `PUT /hr/employees/:id/work-locations`); a new / moved pin waits for
the CEO (approval type `work_pin`, never delegated; `workPinPending` reuses `fencePinPending`; `POST /hr/work-pins/:id/
approve|reject`, 409 `PIN_CHANGED`, reject note ≥10) and is measured only from its approved pin (blank radius = the
company's), the old approved pin staying in force meanwhile; a punch there is named by the pin's label
(`ClockLog.pinLabel`). Tests: `tests/workLocationPins.test.ts`. Not built (needs the tablet / a native
app): fake-GPS detection, one registered phone per login, "tablet first".
Tests: `tests/geofenceAttendance.test.ts`.

**Attendance in bulk (owner, 2026-10-22: "Build the mark-present-for-a-date-
range option"; "HR could enter an employee's manual data in one go, instead of
one by one for each day").** HR → Attendance → "Enter days in bulk" (one
person: `GET /hr/attendance/bulk-days/preview` lists every day of ≤62 with the
rota's hours and what is already recorded; HR edits the grid; `POST
/hr/attendance/bulk-days {employeeId, remarks, days:[{date, status, checkIn,
checkOut, shiftId}]}`) and "Mark present for dates" (many people: `POST
/hr/attendance/mark-present {employeeIds, from, to, remarks, dryRun}` — every
WORKING day (`attendanceDays.ts workingDaysBetween`, rule A's reading), inside
the days employed, up to today, with no attendance row yet, becomes present at
the rota's hours; ≤3,000 days a call). Both `HR_BACK_OFFICE`, active company
only (other company's employee 404), and create each day through
`createRecord` — a hand-keyed day (`_manual`) that waits for the CEO, who
approves them together in the inbox (bulk approve). A day already recorded
(pending counts) is never written twice; refused per day, the rest go in.
Admin `components/hr/BulkAttendance.tsx`. Tests: `tests/hrBulkAttendance.test.ts`.

### Till flow (owner, 2026-10-20)

Contract: `backend/src/modules/pos/TILL_FLOW.md` (the screens build against it —
change a route only together with that file). Binding rules:

- **Two ways to close a bill** (`Order.settlementChannel`, set before / at the
  close; null = legacy / non-till). **Push to Keenu** (`POST /pos/orders/:id/keenu-push`,
  `pos/keenuPush.ts`): the bill goes through the POS connector (Keenu = the fiscal
  POS vendor; seam `FiscalDriver.pushBill` / `getBillPush` — the real Keenu driver is
  one file in `connectors/drivers/`; the TEST driver settles at once), servd records
  Keenu's tender through `processPayment` (key `keenu:<pushId>`), completeOrder files
  the ONE sale document (payload `settlement.pushId`) → revenue to the brand's MAIN
  account. **Close in servd** (`settlementChannel: 'servd'` on `/pos/payments`, or
  `PUT /pos/orders/:id/settlement-channel` before any other tender path) → revenue
  to the brand's **servd sub-account**. Its fiscal documents: under SRB direct
  (owner, 2026-10-30, driver in `registry.ts DIRECT_FISCAL_DRIVERS`) the NORMAL
  path — filed automatically by servd; under a fiscal POS driver (test / http /
  none) `manual_required` / `servd_channel` — NEVER sent (enqueue, retry, rebuild and
  the sender itself all refuse; `outbox.ts SERVD_CHANNEL` / `servdHandFiledTx`),
  never skipped. Rows already `servd_channel` stay hand-filed after a switch to SRB,
  and so does a return of a hand-filed sale. A pending Keenu push blocks every other
  tender (`KEENU_PUSH_PENDING` in the active-tender guard). **No fiscal POS, no push:**
  `GET /pos/orders/:id/keenu-push` returns `pushAvailable` (`keenuPush.ts
  keenuPushAvailable`, the same test as the push); false (SRB direct, connector off,
  reporting off) → the till shows "Close in servd" only.
- **Two accounts per brand:** `Concept.servdRevenueAccountCode` "Sales — <brand>
  (servd)" — the LAST free code of 4010–4089 (main accounts keep numbering from
  4010 up), created with the main one at brand create and by the boot step
  (`brandRevenueAccount.ts`); renumbered by the company merge like the main one.
  Both are 40xx brand sales (P&L, brand P&L, food cost, `brandSalesRevenueCents`);
  `brandSalesByAccount` (tax return, allocations) lists both. The ONE chooser is
  `journal.ts saleRevenueCodeFor`; refunds / credit notes / cancel-undos reverse the
  account the SALE credited (`saleBookingOf` picks the channel's line in a shift
  close that carries both).
- **Servd sales are filed by hand** on the SRB / FBR portal (owner confirmed) —
  ONLY while the company's fiscal driver is a fiscal POS; under SRB direct
  (2026-10-30) they are filed automatically. Finance records the hand filings on
  `/accounting/servd-filings` (`servdFilings.ts`, through `outbox.recordManualFiling` —
  no second filing table; `servdDocumentWhere` shows, for an SRB-direct company, only
  the hand-filed rows `servd_channel` / `servd_portal`). Close check
  **`servd_sales_unfiled`** BLOCKS (CEO-overridable) while any is unfiled on or
  before the lock. Reporting-OFF companies have no documents (as before).
- **Waiter = an HR employee of the order's company** (`Order.waiterEmployeeId`;
  waiter code = `HrEmployee.employeeCode`); pax `Order.partySize`; guest = a
  customer of the brand's company only (`tillFlow.ts attachableCustomerWhere` —
  another company's customer is 422; a typed mobile of another company's customer
  is never linked). Table occupancy = open orders (the board `GET /floors/board`);
  `Table.currentOrderId` is written at open and released at completion / cancel.
- **A delivery rung at the till** is source `manual` + `rawPayload.channel
  'till_delivery'` (`lib/tillDelivery.ts`): priced like the till (fee from the zone,
  GST on top at the tender rate — `lib/pricing.ts`), completes ON DELIVERY, booked
  by its own `order.complete`, COD = a pending cash row (lib/cod.ts custody, closed
  in servd). Never make it a `source 'pos'` order.
- **Tip from excess cash** (`excessAsTip`): tendered − due → `tipCents` (2095, the tip
  pool), never revenue. Sales reports take `settlement=keenu|servd|none|all`;
  `/reports/by-settlement` combined = the sum. Item codes: `MenuItem.itemCode`
  (unique per brand).
- **Add items to a sent ticket (owner, 2026-10-22).** `POST /pos/orders/:orderId/items`
  (`pos/service.ts addItemsToPosOrder`, contract in TILL_FLOW.md §4): the SAME open till ticket,
  only while no money is on it (409 `BILL_IN_PAYMENT`); the lines go through the ring-up's own
  rules (`orders/service.ts prepareOrderLines` — the ONE line check / routing ingestOrder uses —
  and `gatePriceOverrides`); the bill grows by the priced difference (the mirror of a void); only
  the new lines take stock (`orders/stock.ts deductInventoryForAddedLines`, which leaves the
  order's ONE depletion claim alone); audit `pos.order.items_added` (the idempotency record).
- **A payment lands on an OPEN drawer only (review, 2026-10-22).** `processPayment` refuses a
  closed drawer (409 `SHIFT_CLOSED`; a shift correction's re-issue excepted), and a drawer with a
  Keenu push whose outcome is not in cannot close, even with `confirmOpenTickets` (409
  `SHIFT_HAS_KEENU_PUSH`, `connectors/terminal/guard.ts`) — a late push used to be filed with the
  tax authority on a closed drawer and never reach the books. A shift correction refuses to void a
  tipped bill whose tip a posted / paid tip pool already shared (409 `TIP_ALREADY_POOLED`; void &
  re-issue keeps the tip).

### Till Order Summary and Reports (owner, 2026-10-22)

- **Order Summary** (till menu → Ordering): `GET /pos/orders/summary` (`pos/orderSummary.ts`, read only) —
  one brand, one Karachi day, All / Running / Settled / Voided with counts; Recall, Reprint Receipt / KOT,
  Void (running: cancel; settled: credit note), Split, Change Owner (= waiter) and Download PDF call the
  EXISTING routes. Contract: `pos/TILL_FLOW.md`.
- **MANAGER menu** = Day Close (night audit), Dashboard (operations), Reports, Shift Manager (`/pos/shift`),
  each shown only when `canOpenPath` lets the login open it.
- **Reports** (till menu → MANAGER → Reports) replaced the 20 Oct till Sales report screen. ONE engine:
  `reports/tillReports.ts` + `tillReportsRoutes.ts` (`/reports/till/catalog|lookups|run/:id`, REPORT_READERS,
  money only for FINANCIALS_VIEWERS, every brand through `assertConceptOwned`) on `reports/service.ts`
  (`SalesQuery.conceptIds` / `extra`). Contract: `reports/TILL_REPORTS.md`. Screen
  `components/pos/flow/TillReports.tsx` reads the catalog — a new report is a catalog entry + its builder,
  never a hard-coded screen. "terminal" = the cashier's drawer (Shift). Menu subgroup is not wanted (owner, 2026-10-22: "No need for menu subgroup").
- **Sub-categories and sessions (owner, 2026-10-22: "Yes, add sub-categories and sessions"; sessions per brand,
  a SEPARATE list from the reservation dayparts).** Sub-category = `Category.parentId` (ONE level, a main category
  of the same brand — 422 `PARENT_NOT_IN_BRAND` / `PARENT_IS_SUBCATEGORY` / `PARENT_IS_SELF`; a category with
  subs cannot be nested or deleted, `CATEGORY_HAS_SUBCATEGORIES`); set on Menu → Items. Session = `MenuSession`
  (`tenantId` = the brand's company, RLS, merge repoint; `/menu/sessions` GET any staff of the brand, POST/PATCH
  managers; 422 `SESSION_OVERLAP`, 409 `SESSION_NAME_TAKEN`; switched off, never deleted; Menu → Sessions). A bill
  falls into its brand's active session by its `placedAt` Karachi time (`tillReports.ts sessionResolver`) — nothing
  is stored on the order. Reports read them as in `reports/TILL_REPORTS.md`. Tests:
  `tests/menuSubcategoriesSessions.test.ts`.

### Open-items sweep (2026-10-23)

- **Offline till orders** (`frontend/admin/src/lib/offline-queue.ts`, the ONE
  queue; `public/sw.js` only caches GETs and never intercepts a write): a new
  ring-up that fails on the network is kept on the device with its
  idempotencyKey and re-sent by the PAGE through the normal api client (the
  cashier's session); it leaves the queue only on success or a manager's
  Discard; a server refusal stays with its reason (`OfflineQueue.tsx`). Money
  writes (payments, Keenu, No Charge, add items) are never queued offline —
  they fail with "No internet — not sent". Never fake a success.
- **Shift corrections:** finance cannot raise one on a drawer it ran or
  closed (403 `SELF_CORRECTION_BLOCKED`; the CEO is exempt; the closer is the
  `pos.shift.close` audit row); `/:id/retry` runs the approve right check; a
  set left `approved` with no progress for 5 minutes is moved to `failed` by
  `sweepStaleApplies` (boot + worker `shiftCorrectionSweep`).
- **Guest card** `GET /crm/customers/:id/context` returns only the companies
  in view (`scopedCustomerFigures` + `companyActivityFigures`); strike count
  stays servd-wide.
- **Supplier emails** go through `lib/mailer.ts sendEmail` (admin mail
  settings first), never their own transport.
- **CI runs on every push to main** (`.github/workflows/ci.yml`: tsc, 4 test
  shards with Postgres + Redis services, 4 RLS shards). `TEST_RLS=1` /
  `npm run test:rls` runs the suite as a non-owner role with the live RLS
  policies (`backend/tests/rls/`, exclusions in `exclude.txt`). Finding to
  act on: live connects as the table owner, so RLS is very likely NOT enforced
  on live; 34 tables (HR back office, fiscal documents, receivables, wallets…)
  have no policy; `group_orders` / `group_order_members` policies recurse
  (42P17). Fix those before ever switching live to a non-owner role.
- **Company lock gaps closed (owner F13 (a), 2026-10-26: "Fix those, then
  switch live to a non-owner login with the lock on").** Migration
  `20261026140000_rls_gap_close`: every table with `tenantId` has RLS + a
  policy (the RLS job's `rlsMode.test.ts` fails on a new one without);
  group-order policies use SECURITY DEFINER helpers (no 42P17); the helpers
  read `'__service__'` as unset, so the non-owner login MUST carry
  `ALTER ROLE … SET app.tenant_ids / app.customer_id = '__service__'`.
  A pre-auth path (webhook, token link) looks its token up with
  `serviceClient`, then `setRlsContext({ tenantIds: [proven company] })`;
  a write stamped with another company (exception flags, a new company)
  goes through `serviceClient`; a system write triggered from a customer's
  request (the order's stock draw, loyalty postings) runs in the ORDER's
  company (`runWithRlsContext`) or on `serviceClient`. Under RLS Postgres
  hides a unique violation's key (Prisma P2002 `target` is null) — never
  branch on it alone. ~90 policies still admit any staff request of any
  company (`app_has_any_tenant()`); tightening them is the follow-up.
  `entrypoint.sh` takes an optional
  `MIGRATE_DATABASE_URL` (owner) for migrations. IT runbook:
  `backend/tests/rls/NON_OWNER_SWITCH.md` — live not switched yet.
- **Look-and-feel (16 Oct answers):** finance pages use the shared parts in
  `components/finance/ui` (`Field`, `Input`, `Select`, `Button`, `Dialog`,
  `SidePanel`, `LinkButton`); `.s-input` is full width, so a toolbar / table
  control passes `w-auto` + compact sizing. Icons are line icons
  (`components/ui/NavIcon.tsx`, `components/finance/ui/icons.tsx`), never
  emoji; empty states are `CompactEmptyState` (`tone="dark"` on kitchen
  screens). Storefront buttons in ordering / checkout use
  `--servd-btn-radius` (0.5rem) or `.servd-btn-rect`, never pills.

- **Open-items answers (owner, 2026-10-26):** pre-orders at most **3 days** ahead (`MAX_PREORDER_AHEAD_DAYS` in
  `storefront/serviceHours.ts`, the one constant; 422 `SCHEDULE_TOO_FAR`). Ban appeals are switched ON by migration
  `20261026150200` only when the platform Setting was never set (the CEO can still switch off). The brand "G's Kitchen"
  (owner's test kitchen) is hidden from the public site by data migration `20261026150100` (`storefrontVisible` false;
  not deleted). **WhatsApp is its own sales channel:** `lib/orderChannel.ts orderChannelOf` / `whatsappOrderWhere` is the
  ONE "channel of an order" (source `servd` + `rawPayload.channel 'whatsapp'`); `salesByChannel`, `/reports/by-source`,
  the director view, the daily-sales email and the night-audit report read it — never group by `source` alone. **Guest tags
  are a per-company list** (`GuestTagType`, `tenantId`, unique by normalised name; `/reservations/guest-tag-types`
  GET any staff / POST+PATCH managers; admin Configuration -> Guest tags; picked on the guest card via
  `GuestTagsPanel`; `POST /reservations/guest-tags {tagTypeId}` 422 `TAG_SWITCHED_OFF` / `TAG_NOT_IN_ACTIVE_COMPANY`,
  409 `TAG_NAME_TAKEN` / `TAG_ALREADY_ON_GUEST`; a typed tag is visible only to its company; legacy free-form tags
  have no company). Tests: `tests/guestTagsChannels.test.ts`. **Dashboard starter numbers (C4):** `GET /dashboards/:id/numbers`
  (`modules/dashboards/routes.ts`, id ceo | operations | finance | marketing | hr; needs the module of that dashboard's
  page; company view = `resolveTenantScope`; each number from an existing report / table; money only to
  FINANCIALS_VIEWERS, others get `hidden`; a failing source = `value: null` + `reason`). Fixed sets, no per-person
  storage yet; the admin tiles are `components/ui/DashboardTiles.tsx`. Payroll vs budget stays empty (no budget exists).
  A new number is added in that file's `sets` — read from an existing function. Tests: `tests/dashboardNumbers.test.ts`.
- **Overbooking goes to the CEO (owner C10, 2026-10-26: "overbooking should auto come to ceo for approval. Manager
  shouldnt be able to do that without approval").** The host stand's overbook (manager's own login or a host with a
  manager's PIN, reason) still raises it, but unless the CEO books it (an `admin` login, or the CEO's own PIN) a NEW
  booking is stored as `ReservationStatus pending_approval` (202 `{ pendingApproval, overbookRequestId }`) — off the
  floor plan, capacity, the no-overlap constraint, reminders and the guest's account — and the guest is told NOTHING;
  a CHANGE past capacity (`PATCH /reservations/:id`) is held and the booking stays as it was. One store:
  `ReservationOverbookRequest` (tenantId = the brand's company, RLS, merge repoint; one pending per booking) —
  `modules/reservations/overbookApproval.ts` (contract in its header). Approval type `reservation_overbook` (section
  ceo, never delegable; provider `reservations/overbookProvider.ts`): `POST /reservations/overbook-requests/:id/approve`
  → booked + the normal confirmation (`sendBookingConfirmation`, the ONE host-stand confirmation); `/reject {note ≥10}`
  → cancelled + a polite "fully booked" WhatsApp / email (never the CEO's note); `/withdraw` (a held change). While it
  waits the booking is 409 `OVERBOOK_PENDING` on edit / confirm / seat / complete / no-show; cancelling it withdraws
  the request; 409 `RESERVATION_CHANGED` when a held change's booking moved. Tests:
  `tests/reservationOverbookApproval.test.ts`.
- **Goodwill wallet credit has its own account (owner C6, 2026-10-26: "Give wallet goodwill credit its own account so
  I can see what we give away").** `6065 Goodwill Credit to Customers` (canonical chart, every company at boot);
  `wallet/service.ts WALLET_GOODWILL_EXPENSE` — new goodwill top-ups are Dr 6065 / Cr 2050; older ones stay on 6060
  and anything undoing one mirrors ITS OWN entry (reverseJournalEntry), never today's constant. Paid top-ups unchanged.
  Tests: `tests/walletGoodwillAccount.test.ts`.

### Customer identity, member codes and invites (owner, 2026-10-26)

"the name should auto pull from the servd name customer selects … link an internal barcode for that customer …
allow them to get ppl to join group or simmer booking with link. To join the group ppl have to make an account."

- **The servd name = `Customer.nickname`** (customers are servd-wide, no tenantId, deliberately): 3–20 letters /
  digits / `.` / `_`, starts with a letter or digit, reserved words refused (`lib/nickname.ts`, mirrored in storefront
  `lib/nickname.ts`); unique servd-wide case-insensitive via the SQL index `customers_nickname_lower_key` on
  lower(nickname) — never re-declare it in schema.prisma. `GET /storefront/account/nickname-available?q=`,
  `PUT /storefront/account/nickname` (409 `NICKNAME_TAKEN`, 422 `NICKNAME_INVALID`; `storefront/identityRoutes.ts`).
  Sign-up asks the PROPER name ("Full name"); the first visit after sign-in shows `NicknameSheet` (servd's own pages
  only — never a brand page / brand host; "Later" = per tab). Group orders show members by nickname (server
  ignores the typed name when one exists; none → 422 `NAME_REQUIRED`); a booking's name defaults to the proper name.
- **Member code = `Customer.memberCode`** ('SV' + 10 digits) — INTERNAL (CRM / guest card barcode, never sent to the
  customer); set by the DB default `customer_member_code()` on EVERY insert path (SQL-only: sequence + function +
  default, migration `20261027100000`, applied in tests/setup.ts). Separate from the PUBLIC `referralCode`. CRM
  search matches it; admin renders Code 128 itself (`lib/code128.ts`, `components/customer/MemberBarcode.tsx`).
- **Phones are international:** storefront `components/ui/PhoneInput.tsx` + `lib/phoneCountries.ts` (the ONE phone
  field; Pakistan default; placeholder per country) sends `+<dial><number>`; `otp.ts normalisePhone` keeps a `+` /
  `00` non-92 number as E.164 digits, Pakistan rules unchanged; `notify.ts whatsappNumber` likewise.
- **Invite your table:** `modules/reservations/invites.ts` (contract in its header). The booker's link token is
  stored as sha256 only (`Reservation.inviteTokenHash`); joining needs a servd account; `ReservationGuest`
  (tenantId = the brand's company, RLS, merge repoint) ≤ partySize − 1 (409 `BOOKING_FULL`), closed booking 410
  `BOOKING_CLOSED`. Staff: `GET /reservations/:id/guests`; an invited guest counts as the company's customer
  (`crm/customerScope.ts`). Simmer's booking page is `app/reserve/[slug]/SimmerReserve.tsx` (simmer-brand rules);
  the invite page is `/reserve/invite/<token>`. Tests: `tests/customerIdentityInvites.test.ts`.
- **One public brand-list rule:** `lib/publicBrands.ts listedBrandWhere()` (active, not deleted, storefrontVisible,
  not a test company) for every public brand LIST; G's Kitchen is hidden by its storefrontVisible switch. The
  group-order and /reserve pickers use servd home's trading cards (`sections/servd/Kitchens.tsx` `KitchenPicker` /
  `KitchenCards`), never a second card design.

### Shift corrections (owner, 2026-10-21)

"A shift closed by staff/cashier, Finance should have access to reopen the
shift and cancel any KOT, with CEO's approval … not like refund … all this
void & cancellation should require CEO's approval to move the entry to
trash." `modules/shiftCorrections/` (header of `service.ts` is the contract);
API `/pos/shift-corrections` (module `accounting` — the ONLY gated path
under /pos); tables `shift_corrections` / `shift_correction_items`
(`tenantId` = the SHIFT's company, RLS, merge repoint list).

- **One set, one CEO decision.** Finance (with `accounting`) or the CEO raises
  ONE set on a CLOSED drawer (`POST /`, reason ≥10, items
  `{orderId, kind void_bill|cancel_kot|void_reissue, reason ≥10, moneyReturned, foodMade, newTender, tenderRef}`);
  one open set per drawer (409 `CORRECTION_PENDING`); closed month 409
  `BOOKS_CLOSED` (the CEO reopens the month first). Nothing moves until the
  CEO approves (`/:id/approve`, ADMIN_ONLY, approval type `shift_correction`
  — section `ceo`, never delegable; the CEO may approve a set they raised;
  finance never). Reject needs a note ≥10.
- **Apply = the existing engines, in order:** reopen an audited sales day
  (`reopenDay`) → reverse the drawer's LIVE close on its own date
  (`shift.close.reversal:<id>[@n]`) → each fix through `cancelOrder`
  (`shiftCorrection` option: the one completed → cancelled move for a
  voided final bill, no customer notice; tenders voided — Payment `failed` +
  `gatewayMeta.voided`, never refunded — unless `moneyReturned`; the fiscal
  VOID document `void:<orderId>` through the outbox; the order parked in the
  Trash; stock back to its lots, or wasted to 1290 when `foodMade`) →
  re-post the close from `buildShiftCloseEntry` as revision
  `shift.close:<id>@n` (counted cash stays, the variance recomputes; money
  really handed back is a REFUND DUE on till clearing until the till's refund
  route pays it). A refused step leaves the set `failed` (CEO `/:id/retry`;
  every step is idempotent); a close reversed but not re-posted is flagged
  `posting_failed`.
- **Readers of a drawer's close use the LIVE revision**
  (`shiftPosting.ts liveShiftCloses`) — never the exact `shift.close:<id>`
  reference when the question is "did this close book the order?" (cogs,
  saleBookingOf, the cancelled-ticket unwind). `shift.close.reversal` is a
  sales source (night-audit day lock) and a food-cost sale source.
- **Void & re-issue (owner, 2026-10-21: "make re-issue land on the original
  day").** Item `{kind void_reissue, newTender cash|card|raast, tenderRef}`
  (card slip / Raast bank reference; required for card / Raast; `foodMade` /
  `moneyReturned` 422). The wrong bill is voided as above but KEEPS its stock
  (`cancelOrder` `keepStock`); `reissueItem` then issues the corrected bill:
  the same lines priced at the NEW tender (`lib/pricing.ts`), same drawer,
  waiter, table, guest and settlement channel, NO kitchen ticket and NO stock
  draw (`ingestOrder` `correction` — lines `bumped`); the voided bill's sale
  movements and depletion claim MOVE to it (`orders/stock.ts
  moveSaleStockTx`; refused, 422 `REISSUE_NOT_SUPPORTED`, when its stock
  changed after the sale, or a wallet / gift card / points / promo / comp /
  delivery fee paid part of it); paid through `processPayment` and completed
  through `completeOrder` AS OF the voided bill's `completedAt` — the payment,
  a Raast receipt, `completedAt` and the ONE fiscal sale document carry the
  original day. The as-of date and the correction flag are processPayment's
  SECOND argument (`TillPaymentInternal`), which no route passes — never read
  them from a body. A typed card reference is accepted under the CEO's
  approval while the card machine is connected (`gatewayMeta.correction`); a
  Raast reference follows the receipt rules (409 `RAAST_REF_USED`). Keyed on
  the item (`shift-correction:<itemId>`): a retry never issues a second bill.
  What was really collected is never invented — the re-posted close
  recomputes the cash variance; card payouts / Raast statement matching show
  the rest. On-account bills and bills paid across drawers are not voided here
  (422). The tax invoice of the new bill is issued today (its numbering
  series). Tests: `tests/shiftCorrections.test.ts`.
- **Raast QR bills are corrected like cash and card (owner, 2026-10-21).** The
  bill's `RaastReceipt` follows the money. Void / cancel with NO money handed
  back (and void & re-issue Raast → cash / card): the tender is voided, the
  re-posted close carries no Raast money (no Dr bank, no refund due), and
  AFTER the re-post the receipt is voided through the CEO's own "void, never
  booked" path (`reconciliation/raast.ts voidNeverBooked`: posts nothing, bank
  reference stays claimed, never matched to the bank; the CEO's approval of
  the set is the authority; already voided = step done). A receipt already
  MATCHED to a bank line refuses that (422 `RAAST_MONEY_RECEIVED`). Money
  handed back: the receipt stays (provisional or matched), the tender stays
  paid, the re-posted close holds it as REFUND DUE (Dr the receiving bank / Cr
  till clearing) until the till's refund route pays it out. A receipt written
  off as not received (or any other state) is fixed in Reconciliation → Raast
  first (422 `RAAST_RECEIPT_NOT_VOIDABLE`). `saleBookedTx` reads the LIVE
  close: a cancelled till bill's close re-posted after the cancel with no
  refund due for it no longer counts as booking its Raast money.

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

## UI / UX check on every screen (owner, 2026-10-26)

"This sort of little UI/UX shit was supposed to be solved … put in md file to check UI/UX when we build
new stuff." **`docs/UI_CHECKLIST.md` is part of done** for every new or changed screen: phone (390 px),
tablet and laptop screenshots with every dropdown / menu / modal OPENED, long values, empty and error
states. Every dropdown, menu, pop-over and suggestion list is built on
`frontend/admin/src/components/ui/AnchoredMenu.tsx` (portal, fixed, kept on screen, flips up) — never an
`absolute right-0` panel inside the page (the P&L Export menu opened half off the phone screen and under
the tabs). Agents building UI get the checklist in their brief; the orchestrator screenshots before
shipping.

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
