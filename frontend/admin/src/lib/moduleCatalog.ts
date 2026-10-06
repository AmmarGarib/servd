// ─── Pages and gap notes, per module id ──────────────────────────────────────
//
// servd is organised by OWNER into five workspaces — Operations, Finance,
// Marketing, HR, Dev (owner decision 47). Which workspace and section a module
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

import type { ModuleId } from './appRoles'

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
  // ── Company
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
  configuration:  [{ label: 'Configuration hub', href: '/configuration', icon: '⚙️' }],
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
  par_sheet:      [{ label: 'Par sheet', href: '/par-sheet', icon: '📋' }],
  procurement:    [
    { label: 'Procurement', href: '/procurement', icon: '🏭', hint: 'Purchase orders, bills, payments' },
    { label: 'Receiving', href: '/procurement/receiving', sub: true },
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

  // ── Finance
  finance_pl:     [
    { label: 'Finance dashboard', href: '/dashboard/finance', icon: '⬡', lead: true },
    { label: 'P&L', href: '/accounting/pl-ledger', icon: '💰', hint: 'From the ledger — Statement and By brand' },
  ],
  accounting:     [
    { label: 'Accounting', href: '/accounting', icon: '📊' },
    { label: 'Ledger', href: '/accounting/ledger', sub: true },
    { label: 'Trial balance', href: '/accounting/trial-balance', sub: true },
    { label: 'Balance sheet', href: '/accounting/balance-sheet', sub: true },
    { label: 'Cash flow', href: '/accounting/cash-flow', sub: true },
    { label: 'Period close', href: '/accounting/period-close', sub: true },
    { label: 'Chart of accounts', href: '/configuration/chart-of-accounts', sub: true },
    { label: 'Allocations', href: '/allocations', sub: true },
    { label: 'Food cost', href: '/accounting/food-cost', sub: true },
    { label: 'Sales quadrants', href: '/accounting/menu-engineering', sub: true },
    { label: 'AP aging', href: '/accounting/ap-aging', sub: true },
    { label: 'Receivables', href: '/accounting/receivables', sub: true },
    { label: 'Sales tax return', href: '/accounting/sales-tax-return', sub: true },
    { label: 'Fixed assets', href: '/accounting/fixed-assets', sub: true },
    { label: 'Petty cash', href: '/finance/petty-cash', sub: true },
    { label: 'Deposit drops', href: '/finance/deposit-drops', sub: true },
    { label: 'Bank accounts', href: '/configuration/bank-accounts', sub: true },
  ],
  accounting_audit: [{ label: 'Accounting audit', href: '/accounting/audit-log', hint: 'Who moved the books — CEO and management only' }],
  gift_cards:     [{ label: 'Gift cards', href: '/gift-cards', icon: '🎁' }],
  reconciliation: [{ label: 'Reconciliation', href: '/reconciliation', icon: '⚖️' }],
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
  payroll:        [{ label: 'Tip pools', href: '/tip-pools', icon: '🧾' }],

  // ── Marketing
  marketing_workspace: [{ label: 'Activity log', href: '/marketing/activity', icon: '🚀' }],
  brand_dashboard: [{ label: 'Marketing dashboard', href: '/dashboard/marketing', icon: '⬡', lead: true }],
  crm:            [
    { label: 'CRM', href: '/crm', icon: '👥' },
    { label: 'Conversations', href: '/crm/conversations', sub: true },
    { label: 'Segments', href: '/crm/segments', sub: true },
    { label: 'Naughty list', href: '/crm/naughty-list', sub: true },
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
  integrations:   [
    { label: 'Integrations', href: '/settings/integrations', icon: '🔌', hint: 'Meta, WhatsApp, FBR / PRAL, supplier portal' },
    { label: 'WhatsApp', href: '/configuration/whatsapp', sub: true },
    { label: 'Email', href: '/configuration/email', sub: true },
    { label: 'Webhooks', href: '/configuration/webhooks', sub: true },
  ],
  audit_log:      [{ label: 'User audit log', href: '/configuration/audit-log', hint: 'Sign-ins and what each user did' }],
  notifications:  [{ label: 'Notifications', href: '/notifications', icon: '🔔' }],
  help:           [{ label: 'Help & support', href: '/help', icon: '❓' }],
}

/** Pages open to every login, whatever their modules (the API scopes them). */
export const PERSONAL_PAGES: ModulePage[] = [
  { label: 'My team', href: '/team', hint: 'Who reports to you, and adding a login' },
  { label: 'My approvals', href: '/hr/approvals', hint: 'Requests waiting on you' },
  { label: 'My HR', href: '/hr/me', hint: 'Leave, payslips, requests' },
]

/**
 * What is missing or unreliable, per module — current as of 2026-10-04.
 * Short and factual; omit a module rather than guess.
 */
export const MODULE_GAPS: Partial<Record<ModuleId, string>> = {
  pos: 'One refund engine, one comp engine and one settle path, all on the open drawer; GST is cash 15% / card 8% from one pricing function. Offline: sw.js replays queued till orders to the admin origin without a session, so they are lost. No screen to comp an order after it was rung; split bills (/orders/[id]/split) are not linked from the till.',
  orders: 'Every order is created by ingestOrder and completed by one completeOrder, which issues the invoice and queues FBR and SRB submission. Voids are per line on the order page.',
  refunds: 'The one refund engine: caps, manager PIN, cash from the open drawer, its own journal entry; a full refund restores loyalty, wallet and gift-card value.',
  reservations: 'Table state is set by the reservation flow only — POS orders never mark a table occupied. Guest tags have endpoints but no admin screen.',
  dashboard: 'The four workspace dashboards (Operations, Finance, Marketing, HR) are blank until the owner picks their numbers.',
  ops: 'The prep list forecasts for the first brand only; it has no brand picker.',
  inventory: 'Stock is set only by a count, a waste log or a delivery; sales deplete through the one recipe explosion and give stock back on cancel. Counts and prep batches are company-scoped. No stock ledger yet (only sales leave a movement trail), no expiry or lot dates, cost is moving-average, and stock transfers move no quantity.',
  par_sheet: 'A different "par" from InventoryItem.parLevel (which drives low-stock alerts): this sheet lists the sub-recipes the company\'s brands use.',
  recipes: 'One plate cost (lib/recipeCost.ts) behind recipes, pricing, food cost, COGS and stock depletion; till sales book COGS per brand at shift close. One price per item across channels; no combos.',
  procurement: 'One PO system, one receiving path (stock and moving-average cost in one transaction) and one AP aging tied to ledger AP. No requisition step, payment run or WHT certificate.',
  food_safety: 'Temperature limits with corrective actions and cleaning tasks, per company. No inspection export, no overdue reminders, not yet per outlet in the UI.',
  reconciliation: 'One expected-cash formula and one shift close; every closed shift posts to the ledger. Petty-cash spends that pay no supplier bill still post nothing.',
  accounting: 'One ledger feed, one period-lock path (reopen: CEO only, audited, raised as an exception). The ledger splits by brand, never by outlet; no transfer pricing or multi-currency. Receivables have no credit notes, statements or on-account tender. Depreciation is charged by pressing "Charge month". The Sales quadrants page reads data.items from a bare array, so it shows nothing.',
  finance_pl: 'From the ledger. Shared cost reaches a brand only through allocation runs; the rest is one head-office line (decision 22).',
  capital: 'A paid CapEx instalment posts as a supplier advance; a delivered item is capitalised onto the fixed-asset register. Old capital-ledger rows are read-only history.',
  reports: 'The demand forecast predicts items, not covers, so it cannot drive a rota.',
  crm: 'Segments are per company, computed nightly; bans, loyalty settings and tiers are per company.',
  campaigns: 'Email and WhatsApp only. No scheduled sends — a campaign is a draft until sent — and opens and clicks are not linked to orders.',
  storefront: 'Nothing publishes without the CEO (decision 41).',
  staff_hr: 'HR is the person master; each company can replace its forms in /hr/formats. Leave counts calendar days (weekly offs and holidays are not skipped); file fields take a link, not an upload.',
  staff_directory: 'A login is access only; one login can be linked to an employee in each company. Team leads add logins for their own roles from My team, and the CEO approves each one.',
  scheduling: 'Generated from the HR roster and approved swaps; managers store only one-off changes. Costed from HR salaries.',
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
