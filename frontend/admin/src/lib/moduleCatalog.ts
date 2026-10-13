// ─── Pages and gap notes, per module id ──────────────────────────────────────
//
// servd is organised by OWNER into six workspaces — CEO, Operations, Finance,
// Marketing, HR, Dev (owner decision 47; the CEO section is decision D2,
// 2026-10-11: Operations is the F&B manager's). Which workspace and section a module
// sits in, who owns it and which roles live there are defined ONLY by the API
// (backend src/lib/workspaces.ts, served by GET /permissions/me and
// GET /permissions/workspaces). This file keeps no copy of that.
//
// What the API cannot know, and so lives here:
//   • MODULE_PAGES — the admin pages behind each module id (label, href, an
//     optional hint). The sidebar, the workspace homes (/w/[id]) and the
//     Modules page all render a section as "the pages of its modules".
//   • MODULE_GAPS — a short, CURRENT note of what is missing or unreliable.
//     Keep them factual and short, and re-verify rather than assume: a stale
//     gap register sends people chasing things that were fixed months ago. If
//     unsure, say less.
//
// The 18-module catalogue that used to live here (ordered by cost of defect)
// is replaced by the workspaces; its still-true notes were carried over.

import type { ModuleId as AppModuleId } from './appRoles'

// 'approvals' (CEO → Approvals, decision D3) is a module id the API serves;
// until the ModuleId union in appRoles.ts lists it, the catalogue widens the
// union here so its pages can be declared. Harmless once the union has it.
type ModuleId = AppModuleId | 'approvals'

export interface ModulePage {
  label: string
  href: string
  /** Shown under the page on workspace homes. */
  hint?: string
  /** Existing sidebar glyph, if the page had one. */
  icon?: string
  /** Rendered as a child of the module's first page in the sidebar. */
  sub?: boolean
  /** A dashboard page: listed in the sidebar's "Dashboards" section, above
   *  and outside the workspaces (owner, 2026-10-06). */
  lead?: boolean
}

export const MODULE_PAGES: Partial<Record<ModuleId, ModulePage[]>> = {
  // ── CEO (decision D2): approvals, companies, logins & access, company rules
  approvals:      [{ label: 'Approvals', href: '/ceo/approvals', icon: '✓', hint: 'Everything waiting on you, from every module' }],
  business_info:  [
    { label: 'Locations', href: '/configuration/locations', icon: '📍', hint: 'Kitchen address and map pin' },
    { label: 'Delivery zones', href: '/configuration/delivery-zones', sub: true, hint: 'Beyond the last zone, delivery is refused' },
  ],
  tenants:        [
    { label: 'Add a company or brand', href: '/onboarding' },
    { label: 'Domains', href: '/configuration/domains', sub: true },
  ],
  // CEO home: a top-down view of every department, first in the Dashboards section.
  ceo_overview:   [{ label: 'Home', href: '/home', icon: '⌂', lead: true }],
  role_management: [{ label: 'Pending logins', href: '/workforce?status=pending', hint: 'The CEO approves every login' }],
  role_modules:   [{ label: 'Module access', href: '/configuration/role-modules', icon: '🗂' }],
  configuration:  [
    { label: 'Company rules', href: '/configuration/operations', icon: '⚙️', hint: 'Clock-in selfie and geofence, tip split, service charge — CEO only' },
    { label: 'Configuration hub', href: '/configuration', sub: true },
  ],
  onboarding:     [{ label: 'Setup wizard', href: '/onboarding' }],

  // ── Dashboards (one per workspace, blank until the owner picks the numbers)
  dashboard:      [{ label: 'Operations dashboard', href: '/dashboard/operations', icon: '⬡', lead: true }],
  ops:            [{ label: 'Prep list', href: '/ops/prep-list', hint: 'Per station, from the demand forecast' }],

  // ── Kitchen
  kds_dashboard:  [{ label: 'Kitchen view', href: '/kds', icon: '🍳' }],
  expo_station:   [{ label: 'Expo station', href: '/expo', icon: '🪧' }],
  kds_all:        [{ label: 'Kitchen tracker', href: '/kds/reservations', hint: 'Upcoming reservations for the line' }],
  kds_config:     [{ label: 'KDS config', href: '/kds/config', icon: '⚙️', hint: 'Stations, not staff' }],

  // ── Menu & recipes
  menu:           [
    { label: 'Menu', href: '/menu', icon: '📝' },
    { label: 'Modifiers', href: '/configuration/modifiers', sub: true },
    { label: 'Dietary tags', href: '/configuration/dietary-tags', sub: true },
  ],
  recipes:        [
    { label: 'Recipes', href: '/accounting/recipes', icon: '📐' },
    { label: 'Menu engineering', href: '/menu-engineering', icon: '💹', hint: 'Plate cost to selling price and margin' },
    { label: 'Recipe approvals', href: '/accounting/recipes/approvals', sub: true },
  ],

  // ── Stock & buying
  inventory:      [
    { label: 'Inventory', href: '/inventory', icon: '📦', hint: 'Includes the waste log' },
    { label: 'Stock count', href: '/inventory/count', sub: true },
    { label: 'Low stock', href: '/inventory/alerts', sub: true },
    { label: 'Prep', href: '/inventory/prep', sub: true },
    { label: 'Sourcing sheet', href: '/sourcing', icon: '🧾' },
  ],
  // The par sheet's "Log a batch" / per-row "Log batch" open the prep batch
  // logger, so par_sheet holders (kitchen, expediter) open /inventory/prep too
  // — its reads (GET /par-sheet/preps, /crosschecks/prep-batches) and the
  // POST are ALL_STAFF, and the par sheet's "Made" column is filled only by
  // these batches.
  par_sheet:      [
    { label: 'Par sheet', href: '/par-sheet', icon: '📋' },
    { label: 'Log a prep batch', href: '/inventory/prep', sub: true },
  ],
  procurement:    [
    { label: 'Procurement', href: '/procurement', icon: '🏭', hint: 'Purchase orders, bills, payments' },
    { label: 'Receiving', href: '/procurement/receiving', sub: true },
    // Also an Accounting page: the API gate on /procurement/grni admits
    // procurement and accounting (finance asks for a write-off, the CEO approves).
    { label: 'Received, not billed', href: '/procurement/grni', sub: true },
    { label: 'Supplier chat', href: '/procurement/chat', sub: true },
    { label: 'Monitor', href: '/procurement/monitor', sub: true },
  ],

  // ── Food safety
  food_safety:    [{ label: 'Temperatures & cleaning', href: '/food-safety', icon: '🌡' }],

  // ── Front of house
  pos:            [
    { label: 'Point of sale', href: '/pos', icon: '💳' },
    { label: 'Waiter mode', href: '/pos/waiter', sub: true },
    { label: 'Shift / till', href: '/pos/shift', sub: true, hint: 'Drops, vendor pay-outs and rider cash-on-delivery' },
  ],
  orders:         [{ label: 'Orders', href: '/orders', icon: '📋' }],
  refunds:        [{ label: 'Refunds', href: '/refunds' }],
  curbside:       [{ label: 'Curbside', href: '/orders/curbside', icon: '🚗' }],
  reservations:   [
    { label: 'Reservations', href: '/reservations', icon: '🍽' },
    { label: 'Week view', href: '/reservations/week', sub: true },
  ],
  reservations_admin: [
    { label: 'Closures & blockouts', href: '/reservations/blockouts' },
    { label: 'Service hours', href: '/configuration/hours', sub: true },
    { label: 'Reservation policy', href: '/configuration/reservation-policy', sub: true },
    { label: 'Reservation analytics', href: '/reservations/analytics', sub: true },
  ],
  tables:         [{ label: 'Floor plan', href: '/floorplan', icon: '🪑' }],
  dispatch:       [{ label: 'Dispatch', href: '/dispatch', icon: '🛵' }],
  riders:         [{ label: 'Riders', href: '/riders' }],
  // A delivery completes only with the customer's code; when that fails the
  // RGM, chef or F&B manager acts here (owner, 2026-10-13).
  emergency_overrides: [{ label: 'Emergency overrides', href: '/emergency-overrides', hint: 'Send the hand-over code to the rider; log food a rider brought back' }],

  // ── Finance
  finance_pl:     [
    { label: 'Finance dashboard', href: '/dashboard/finance', icon: '⬡', lead: true },
    { label: 'P&L', href: '/accounting/pl-ledger', icon: '💰', hint: 'From the ledger — Statement and By brand' },
  ],
  accounting:     [
    { label: 'Accounting', href: '/accounting', icon: '📊' },
    { label: 'Ledger', href: '/accounting/ledger', sub: true },
    { label: 'Journal entry', href: '/accounting/journal', sub: true },
    { label: 'Trial balance', href: '/accounting/trial-balance', sub: true },
    { label: 'Balance sheet', href: '/accounting/balance-sheet', sub: true },
    { label: 'Cash flow', href: '/accounting/cash-flow', sub: true },
    { label: 'Period close', href: '/accounting/period-close', sub: true },
    { label: 'Chart of accounts', href: '/configuration/chart-of-accounts', sub: true },
    { label: 'Allocations', href: '/allocations', sub: true },
    // Food cost moved to Reports → Food cost variance (module food_cost);
    // /accounting/food-cost forwards there (next.config.js).
    { label: 'Sales quadrants', href: '/accounting/menu-engineering', sub: true },
    { label: 'AP aging', href: '/accounting/ap-aging', sub: true },
    { label: 'Received, not billed', href: '/procurement/grni', sub: true },
    { label: 'Receivables', href: '/accounting/receivables', sub: true },
    { label: 'On-account clients', href: '/accounting/receivables/clients', sub: true, hint: 'Corporate clients who pay monthly — credit limits, QR cards, statements' },
    { label: 'Sales tax return', href: '/accounting/sales-tax-return', sub: true },
    { label: 'Statutory payments', href: '/accounting/statutory', sub: true },
    { label: 'Inter-company', href: '/accounting/intercompany', sub: true },
    { label: 'Fixed assets', href: '/accounting/fixed-assets', sub: true, hint: 'Register, automatic monthly depreciation, smallwares pools, disposals, PPE note' },
    { label: 'Petty cash', href: '/finance/petty-cash', sub: true },
    { label: 'Cash requests', href: '/finance/cash-vouchers', sub: true, hint: 'Anyone asks for cash; HOD and director sign; the cashier pays; receipts book it' },
    { label: 'Deposit drops', href: '/finance/deposit-drops', sub: true },
    { label: 'Bank accounts', href: '/configuration/bank-accounts', sub: true },
  ],
  accounting_audit: [{ label: 'Accounting audit', href: '/accounting/audit-log', hint: 'Who moved the books — CEO and management only' }],
  gift_cards:     [{ label: 'Gift cards', href: '/gift-cards', icon: '🎁' }],
  reconciliation: [{ label: 'Reconciliation', href: '/reconciliation', icon: '⚖️', hint: 'Shift closes, bank statements, card payouts, Raast QR receipts (provisional until the statement matches) and cash on delivery owed by riders' }],
  voided_prebills: [{ label: 'Voided pre bills', href: '/finance/voided-pre-bills', hint: 'Every pre-bill printed — flagged when it never became a full & final bill or the final bill came out lower' }],
  exceptions:     [{ label: 'Exceptions', href: '/exceptions', icon: '🚨' }],
  capital:        [
    { label: 'Project tracker', href: '/finance/capex', icon: '🏗', hint: 'CapEx and OpEx' },
    { label: 'OpEx', href: '/finance/opex', sub: true },
    { label: 'Investment', href: '/finance/capital-ledger', sub: true },
  ],
  projections:    [{ label: 'Projections', href: '/finance/projections' }],
  reports:        [
    { label: 'Reports', href: '/reports', icon: '📈' },
    { label: 'Demand forecast', href: '/analytics/forecast', sub: true },
  ],
  // Its own module, so the CEO can grant it without the rest of Reports. The
  // page needs food_cost; the API also answers accounting holders' reads (the
  // Accounting hub's gauge — GATED_PREFIXES readAnyOf).
  food_cost:      [{ label: 'Food cost variance', href: '/reports/food-cost', hint: 'Actual vs recipe per ingredient and brand, at the price paid (FIFO)' }],
  // 'payroll' is the Finance workspace's view of pay: tip pools and the
  // payroll register (GET /hr/payroll/runs — finance reads it, HR prepares it).
  payroll:        [
    { label: 'Tip pools', href: '/tip-pools', icon: '🧾' },
    { label: 'Payroll register', href: '/hr/payroll', icon: '💵', hint: 'Payroll runs, payslips and the bank file' },
  ],

  // ── Marketing
  marketing_workspace: [{ label: 'Activity log', href: '/marketing/activity', icon: '🚀' }],
  brand_dashboard: [{ label: 'Marketing dashboard', href: '/dashboard/marketing', icon: '⬡', lead: true }],
  crm:            [
    { label: 'CRM', href: '/crm', icon: '👥' },
    { label: 'Conversations', href: '/crm/conversations', sub: true },
    { label: 'Segments', href: '/crm/segments', sub: true },
    { label: 'Naughty list', href: '/crm/naughty-list', sub: true },
    { label: 'Waitlist', href: '/crm/waitlist', sub: true },
    { label: 'Loyalty', href: '/configuration/loyalty', sub: true },
  ],
  campaigns:      [{ label: 'Campaigns', href: '/crm/campaigns', icon: '✉️' }],
  complaints:     [{ label: 'Complaints', href: '/complaints', icon: '🎫' }],
  reviews:        [{ label: 'Reviews', href: '/reviews', icon: '⭐' }],
  calendar:       [{ label: 'Calendar', href: '/calendar', icon: '📅' }],
  promos:         [
    { label: 'Promotions', href: '/promos', icon: '🎟' },
    { label: 'Discounts', href: '/discounts', sub: true },
    { label: 'QR codes', href: '/qrcodes', sub: true },
  ],
  brands:         [{ label: 'Brands', href: '/marketing/brands', icon: '🏷', hint: 'The one brand editor' }],
  analytics:      [{ label: 'Analytics', href: '/analytics', icon: '📊' }],
  storefront:     [{ label: 'Storefront', href: '/storefront', icon: '◩', hint: 'Pages, pop-ups, library, approvals' }],

  // ── HR
  staff_hr:       [
    { label: 'HR dashboard', href: '/dashboard/hr', icon: '⬡', lead: true },
    { label: 'Employees', href: '/hr/employees', icon: '🪪' },
    { label: 'Attendance', href: '/hr/attendance', sub: true },
    { label: 'All sections', href: '/hr/sections', sub: true },
    { label: 'HR payroll', href: '/hr/payroll', sub: true },
    { label: 'Documents', href: '/hr/documents', sub: true },
    { label: 'Letters', href: '/hr/letters', sub: true },
    { label: 'HR reports', href: '/hr/reports', sub: true },
    { label: 'Formats', href: '/hr/formats', sub: true },
    { label: 'Org setup', href: '/hr/org', sub: true },
    { label: 'HR settings', href: '/hr/settings', sub: true },
  ],
  staff_directory: [
    { label: 'Workforce', href: '/workforce', icon: '👥', hint: 'Logins, companies, pending approvals' },
    { label: 'Positions (budget)', href: '/workforce/positions', sub: true },
    { label: 'Time clock', href: '/time-clock', sub: true },
    { label: 'Staff meals', href: '/staff-meals', sub: true },
  ],
  scheduling:     [{ label: 'Rota', href: '/scheduling', icon: '📅', hint: 'Generated from the HR roster' }],

  // ── Dev
  // API section (spec §10, D13): exactly two connectors.
  // Email sits with the WhatsApp connector: both are the message gateways
  // behind codes and resets, and both answer only CONNECTOR_ADMINS (admin,
  // it) — the same roles that hold api_whatsapp. Under 'integrations' it was
  // linked to foh_management and management, who got 403 (UI-15).
  api_whatsapp:   [
    { label: 'WhatsApp connector', href: '/connectors/whatsapp', hint: "Hasham's gateway — OTPs, staff codes, order messages" },
    { label: 'Email', href: '/configuration/email', sub: true, hint: 'SMTP — the backup channel for codes and resets' },
  ],
  api_pos:        [{ label: 'POS connector', href: '/connectors/pos', hint: 'Fiscal POS (FBR / SRB), card machine and Raast QR bank alerts' }],
  integrations:   [
    { label: 'Integrations', href: '/settings/integrations', icon: '🔌', hint: 'Meta, webhooks, supplier portal' },
    { label: 'Webhooks', href: '/configuration/webhooks', sub: true },
  ],
  audit_log:      [{ label: 'User audit log', href: '/configuration/audit-log', hint: 'Sign-ins and what each user did' }],
  notifications:  [{ label: 'Notifications', href: '/notifications', icon: '🔔' }],
  help:           [{ label: 'Help & support', href: '/help', icon: '❓' }],
}

/** Pages open to every login, whatever their modules (the API scopes them). */
export const PERSONAL_PAGES: ModulePage[] = [
  { label: 'My team', href: '/team', hint: 'Who reports to you, and adding a login' },
  // The one approvals inbox (decision D3) — the same page the CEO section
  // links; the API lists only what this login can act on.
  { label: 'Approvals', href: '/ceo/approvals', hint: 'Everything waiting on you' },
  { label: 'My HR', href: '/hr/me', hint: 'Leave, payslips, requests' },
  // Cash requests (owner, 2026-10-13): anyone who needs cash raises one here
  // and uploads the receipts afterwards; the box's custodian (the cashier)
  // pays from the same page without the accounting module. Outside the cash
  // keepers, the API lists only requests the caller raised or holds, may sign
  // as HOD, or must pay from a box they hold; signing, approving and paying
  // are checked server-side.
  { label: 'Cash requests', href: '/finance/cash-vouchers', hint: 'Ask for cash and upload your receipts' },
]

/**
 * What is missing or unreliable, per module — current as of 2026-10-04; the
 * stock, food-cost and finance notes as of 2026-10-13 (wave B).
 * Short and factual; omit a module rather than guess.
 */
export const MODULE_GAPS: Partial<Record<ModuleId, string>> = {
  pos: 'One refund engine, one comp engine and one settle path, all on the open drawer; GST is cash 15% / card 8% from one pricing function. Offline: sw.js replays queued till orders to the admin origin without a session, so they are lost. No screen to comp an order after it was rung; split bills (/orders/[id]/split) are not linked from the till.',
  orders: 'Every order is created by ingestOrder and completed by one completeOrder, which issues the invoice; tax filing goes only through the POS connector. Voids are per line on the order page.',
  refunds: 'The one refund engine: caps, manager PIN, cash from the open drawer, its own journal entry; a full refund restores loyalty, wallet and gift-card value.',
  reservations: 'Table state is set by the reservation flow only — POS orders never mark a table occupied. Guest tags have endpoints but no admin screen.',
  dashboard: 'The four workspace dashboards (Operations, Finance, Marketing, HR) are blank until the owner picks their numbers.',
  ops: 'The prep list forecasts for the first brand only; it has no brand picker.',
  inventory: 'Stock is held as FIFO lots, costed at the price paid: lib/stockLedger.ts is the only writer and every change leaves a stock movement. Sales deplete through the one recipe explosion; unfired voids and cancels go back to their lots, fired ones are booked as waste. Counts and prep batches are company-scoped. One stock pool per company: lots carry their outlet, but per-outlet pools are the next build, so a transfer moves no quantity (a short receipt is booked as transit loss). Lots have no expiry dates.',
  par_sheet: 'A different "par" from InventoryItem.parLevel (which drives low-stock alerts): this sheet lists the sub-recipes the company\'s brands use.',
  recipes: 'One plate cost (lib/recipeCost.ts) behind recipes, pricing, food cost, COGS and stock depletion, at the FIFO price of the lots being cooked; modifiers carry their own recipes; till sales book COGS per brand at shift close. Every dish has a Packaging section: it counts on takeaway and delivery, on every order of a brand whose service vessel is packaging (Stackd), and on a dine-in line only when staff tap "Box given". The Q factor is the only plate allowance — menu pricing, never booked. One price per item across channels; no combos.',
  procurement: 'One PO system and one receiving path: each receipt line opens a FIFO lot, held on 2015 until its bill clears it ("Received, not billed" lists what is open; a write-off needs the CEO). A bill\'s stock lines link to their receipt; equipment goes through CapEx, never a bill. One AP aging tied to ledger AP. No requisition step, payment run or WHT certificate.',
  food_safety: 'Temperature limits with corrective actions and cleaning tasks, per company. No inspection export, no overdue reminders, not yet per outlet in the UI.',
  reconciliation: 'One expected-cash formula and one shift close; every closed shift posts to the ledger. A Raast QR receipt stays provisional until a bank-statement line matches it.',
  accounting: 'One ledger feed and one period-close checklist (only the CEO closes over a blocking item, with a reason; reopen: CEO only, audited, raised as an exception). The ledger splits by brand, never by outlet; no transfer pricing or multi-currency. Bad debts are written off directly, each approved by the CEO; there is no doubtful-debt provision.',
  finance_pl: 'From the ledger. Shared cost reaches a brand only through allocation runs; the rest is one head-office line (decision 22).',
  capital: 'A CapEx line names its supplier; a paid instalment is an advance on 1340, with income tax withheld at the supplier\'s filer rate and input tax by authority. Capitalising a delivered item onto the fixed-asset register needs the CEO\'s approval; Quick buy (bank only) buys, pays and asks for capitalisation in one step. Old capital-ledger rows are read-only history.',
  reports: 'Food cost variance is its own module (food_cost), linked from Reports. The demand forecast predicts items, not covers, so it cannot drive a rota.',
  food_cost: 'Actual vs recipe at the FIFO price of the lots cooked, split food / drinks / packaging, with material cost by order type and brand. Per-outlet actual waits for per-outlet stock (the next build); periods before the FIFO cut-over have no lot data.',
  crm: 'Segments are per company, computed nightly; bans, loyalty settings and tiers are per company.',
  campaigns: 'Email and WhatsApp only. No scheduled sends — a campaign is a draft until sent — and opens and clicks are not linked to orders.',
  storefront: 'Nothing publishes without the CEO (decision 41).',
  staff_hr: 'HR is the person master; each company can replace its forms in /hr/formats. Leave counts calendar days (weekly offs and holidays are not skipped); file fields take a link, not an upload.',
  staff_directory: 'A login is access only; one login can be linked to an employee in each company. Team leads add logins for their own roles from My team, and the CEO approves each one.',
  scheduling: 'Generated from the HR roster and approved swaps; managers store only one-off changes. Costed from HR salaries.',
  api_pos: 'Vendors not chosen yet: until the CEO goes live with a fiscal POS driver, every sale is held (visible, never sent). No nightly card-settlement match yet. Raast QR bank-SMS matching is off per company until the CEO switches it on; servd never logs in to internet banking.',
  integrations: 'No backup or data export screen. Webhooks: one API, but only order events fire. Supplier chat still sends mail through its own env-only SMTP transport. Meta tokens are global settings, so every company shares one Facebook page.',
  audit_log: 'Sign-ins (success, failure, OTP, 2FA, sign-out) are audited alongside account, access and on-shift actions, per company.',
}

/** Pages behind a set of module ids, in order, de-duplicated by href. */
export function pagesForModules(modules: readonly string[]): ModulePage[] {
  const seen = new Set<string>()
  const out: ModulePage[] = []
  for (const m of modules) {
    for (const p of MODULE_PAGES[m as ModuleId] ?? []) {
      if (seen.has(p.href)) continue
      seen.add(p.href)
      out.push(p)
    }
  }
  return out
}

/** The current gap notes of a section's modules. */
export function gapsForModules(modules: readonly string[]): Array<{ module: string; note: string }> {
  return modules
    .map((m) => ({ module: m, note: MODULE_GAPS[m as ModuleId] }))
    .filter((x): x is { module: string; note: string } => !!x.note)
}

/**
 * Pages every login may open whatever its modules: the workspace homes, the
 * personal pages (My team, the approvals inbox, My HR), the account page and
 * help. Their API reads are scoped to the caller.
 */
export const ALWAYS_OPEN_PREFIXES: readonly string[] = [
  '/w', '/me', '/account', '/help', '/login', '/kds/login', '/reset-password', '/supplier',
  // The admin's one punch screen (decision 32) — "Me" and kiosk mode. Its API
  // (/time-clock/status, punch-in/out, kiosk/punch) is ALL_STAFF and punches
  // only the caller (or the employee whose code + PIN is entered), so every
  // login opens it; the Workforce sidebar link stays with staff_directory.
  '/time-clock',
  // Cash requests (/finance/cash-vouchers) are a personal page now, so the
  // line below opens them to every login.
  ...PERSONAL_PAGES.map((p) => p.href),
]

function underPrefix(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(href + '/')
}

/**
 * The modules that open a path: every module with a page at the LONGEST
 * matching href (two modules can list the same page — /hr/payroll is both
 * HR's and Finance's payroll register; /workforce both Staff and Logins).
 * Empty when no catalogued page covers the path (it is open to every login).
 *
 * The Kitchen view (/kds) and its live station pages (/kds/<station>) are
 * kds_dashboard's, but kds_all holders (the expediter) open them too: the
 * sidebar lists the stations for kds_all, /kds/login sends every signed-in
 * user to /kds, and the /kds page serves "every active station" to roles
 * without an assignment list. Their reads (/kds/my-stations, /kds/unrouted,
 * /expo/station/:id/queue) admit kds_all.
 */
export function modulesForPath(pathname: string): ModuleId[] {
  let bestLen = -1
  let best: ModuleId[] = []
  for (const [mod, pages] of Object.entries(MODULE_PAGES) as Array<[ModuleId, ModulePage[]]>) {
    for (const p of pages) {
      const href = p.href.split('?')[0]!
      if (!underPrefix(pathname, href)) continue
      if (href.length > bestLen) { bestLen = href.length; best = [mod] }
      else if (href.length === bestLen && !best.includes(mod)) best.push(mod)
    }
  }
  if (best.length === 1 && best[0] === 'kds_dashboard' && (pathname === '/kds' || pathname.startsWith('/kds/'))) best.push('kds_all')
  return best
}

/**
 * May this login open the page at `pathname`? The CEO (admin) opens
 * everything; the always-open pages are open to all; otherwise the user needs
 * one of the modules behind the page (GET /permissions/me `modules`). The API
 * enforces the same modules on the reads behind the page — this keeps the
 * page from rendering empty with 403s, it is not the control.
 */
export function canOpenPath(pathname: string, role: string | undefined, modules: readonly string[]): boolean {
  if (role === 'admin') return true
  if (ALWAYS_OPEN_PREFIXES.some((p) => underPrefix(pathname, p))) return true
  const need = modulesForPath(pathname)
  if (need.length === 0) return true
  return need.some((m) => modules.includes(m))
}

/** Which module owns a path (longest matching page href). */
export function moduleForPath(pathname: string): ModuleId | undefined {
  let best: ModuleId | undefined
  let bestLen = -1
  for (const [mod, pages] of Object.entries(MODULE_PAGES) as Array<[ModuleId, ModulePage[]]>) {
    for (const p of pages) {
      const href = p.href.split('?')[0]!
      if ((pathname === href || pathname.startsWith(href + '/')) && href.length > bestLen) {
        best = mod
        bestLen = href.length
      }
    }
  }
  return best
}
