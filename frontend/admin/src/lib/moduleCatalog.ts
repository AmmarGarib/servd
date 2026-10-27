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
  /** Sidebar line-icon name (components/ui/NavIcon.tsx) — never an emoji. */
  icon?: string
  /** Rendered as a child of the module's first page in the sidebar. */
  sub?: boolean
  /** A dashboard page: listed in the sidebar's "Dashboards" section, above
   *  and outside the workspaces (owner, 2026-10-06). */
  lead?: boolean
}

export const MODULE_PAGES: Partial<Record<ModuleId, ModulePage[]>> = {
  // ── CEO (decision D2): approvals, companies, logins & access, company rules
  approvals:      [
    { label: 'Approvals', href: '/ceo/approvals', icon: 'check', hint: 'Everything waiting on you, from every module' },
  ],
  // The Trash (owner, 2026-10-15). The module only puts the CEO-section link
  // in the sidebar; the page itself is also a personal page (below), and the
  // API lists per type from the caller's own modules and role.
  // Trash and Hand-over are left-menu links of their own (owner, 2026-10-20), not CEO-workspace pages: Trash is a
  // personal page (PERSONAL_PAGES) for every login; Hand-over is added for the CEO in AppShell.
  trash:          [],
  // Backups (owner S13, 2026-10-26: "make it a weekly file i can download and save to my pc.. ceo only..").
  backups:        [{ label: 'Backups', href: '/ceo/backups', icon: 'lock', hint: 'Weekly encrypted copy of the whole database to download' }],
  business_info:  [
    { label: 'Locations', href: '/configuration/locations', icon: 'pin', hint: 'Kitchen address and map pin' },
    { label: 'Delivery zones', href: '/configuration/delivery-zones', sub: true, hint: 'Beyond the last zone, delivery is refused' },
  ],
  tenants:        [
    { label: 'Add a company or brand', href: '/onboarding' },
    { label: 'Domains', href: '/configuration/domains', sub: true },
    { label: 'Head offices', href: '/ceo/head-offices', sub: true, hint: 'Shared staff and costs recharged to the companies' },
  ],
  // CEO home: a top-down view of every department, first in the Dashboards section.
  ceo_overview:   [{ label: 'Home', href: '/home', icon: 'home', lead: true }],
  role_management: [
    { label: 'Logins & module access', href: '/workforce', icon: 'users', hint: 'Every login, and what each person can open' },
    { label: 'Pending logins', href: '/workforce?status=pending', sub: true, hint: 'The CEO approves every login' },
  ],
  role_modules:   [{ label: 'Role presets', href: '/configuration/role-modules', icon: 'folders' }],
  configuration:  [
    { label: 'Company rules', href: '/configuration/operations', icon: 'cog', hint: 'Clock-in selfie and geofence, tip split, service charge — CEO only' },
    { label: 'Configuration hub', href: '/configuration', sub: true },
  ],
  onboarding:     [{ label: 'Setup wizard', href: '/onboarding' }],

  // ── Dashboards (one per workspace, blank until the owner picks the numbers)
  dashboard:      [{ label: 'Operations dashboard', href: '/dashboard/operations', icon: 'dashboard', lead: true }],
  ops:            [{ label: 'Prep list', href: '/kitchen/prep-list', hint: 'Per outlet, in portions — from the forecast and the par' }],

  // ── Kitchen
  kds_dashboard:  [{ label: 'Kitchen view', href: '/kds', icon: 'flame' }],
  expo_station:   [{ label: 'Expo station', href: '/expo', icon: 'sign' }],
  kds_all:        [{ label: 'Kitchen tracker', href: '/kds/reservations', hint: 'Upcoming reservations for the line' }],
  kds_config:     [{ label: 'KDS config', href: '/kds/config', icon: 'cog', hint: 'Stations, not staff' }],

  // ── Menu & recipes
  menu:           [
    { label: 'Menu', href: '/menu', icon: 'edit' },
    { label: 'Modifiers', href: '/configuration/modifiers', sub: true },
    { label: 'Dietary tags', href: '/configuration/dietary-tags', sub: true },
  ],
  recipes:        [
    { label: 'Recipes', href: '/accounting/recipes', icon: 'ruler' },
    // Kitchen flow (owner, 2026-10-26): servd's ONE ingredient master (K1) — definitions and specs.
    { label: 'Ingredients', href: '/kitchen/ingredients', sub: true, hint: "servd's ingredients and what we buy (specs)" },
    { label: 'Menu engineering', href: '/menu-engineering', icon: 'trend', hint: 'Plate cost to selling price and margin' },
    { label: 'Recipe approvals', href: '/accounting/recipes/approvals', sub: true },
  ],

  // ── Stock & buying
  inventory:      [
    { label: 'Inventory', href: '/inventory', icon: 'box', hint: 'Includes the waste log' },
    { label: 'Stock count', href: '/inventory/count', sub: true },
    { label: 'Stock transfers', href: '/inventory/transfers', sub: true, hint: 'Move stock between two outlets of one company' },
    { label: 'Low stock', href: '/inventory/alerts', sub: true },
    { label: 'Prep list', href: '/kitchen/prep-list', sub: true },
  ],
  // The par sheet's "Log a batch" / per-row "Log batch" open the prep batch
  // logger, so par_sheet holders (kitchen, expediter) open /inventory/prep too
  // — its reads (GET /par-sheet/preps, /crosschecks/prep-batches) and the
  // POST are ALL_STAFF, and the par sheet's "Made" column is filled only by
  // these batches.
  par_sheet:      [
    { label: 'Par board', href: '/par-sheet', icon: 'clipboard', hint: 'Preps in portions: target, on hand, made today, still to prep' },
    { label: 'Prep list', href: '/kitchen/prep-list', sub: true },
    { label: 'Log a prep batch', href: '/inventory/prep', sub: true },
  ],
  procurement:    [
    { label: 'Procurement', href: '/procurement', icon: 'factory', hint: 'Purchase orders, bills, payments' },
    { label: 'Receiving', href: '/procurement/receiving', sub: true },
    // Owner 2026-10-16: "Move sourcing sheet inside procurement section".
    { label: 'Sourcing sheet', href: '/sourcing', sub: true, hint: 'Ingredient catalogue and supplier prices' },
    // Kitchen flow (owner, 2026-10-26, part E): what the prep list needs → draft POs; what we buy and how (K6).
    { label: 'Shopping list', href: '/kitchen/shopping-list', sub: true, hint: 'What the prep list needs, less stock and orders — by supplier, with specs' },
    { label: 'Spec list', href: '/kitchen/spec-list', sub: true, hint: 'What we buy and how it must come, by supplier' },
    // Also an Accounting page: the API gate on /procurement/grni admits
    // procurement and accounting (finance asks for a write-off, the CEO approves).
    { label: 'Received, not billed', href: '/procurement/grni', sub: true },
    { label: 'Supplier chat', href: '/procurement/chat', sub: true },
    { label: 'Monitor', href: '/procurement/monitor', sub: true },
  ],

  // ── Food safety
  food_safety:    [{ label: 'Temperatures & cleaning', href: '/food-safety', icon: 'thermo' }],

  // ── Front of house
  pos:            [
    { label: 'Point of sale', href: '/pos', icon: 'card' },
    { label: 'Waiter mode', href: '/pos/waiter', sub: true },
    { label: 'Shift / till', href: '/pos/shift', sub: true, hint: 'Drops, vendor pay-outs and rider cash-on-delivery' },
  ],
  orders:         [{ label: 'Orders', href: '/orders', icon: 'clipboard' }],
  refunds:        [{ label: 'Refunds', href: '/refunds' }],
  curbside:       [{ label: 'Curbside', href: '/orders/curbside', icon: 'car' }],
  reservations:   [
    { label: 'Reservations', href: '/reservations', icon: 'utensils' },
    { label: 'Week view', href: '/reservations/week', sub: true },
  ],
  reservations_admin: [
    { label: 'Closures & blockouts', href: '/reservations/blockouts' },
    { label: 'Service hours', href: '/configuration/hours', sub: true },
    { label: 'Reservation policy', href: '/configuration/reservation-policy', sub: true },
    { label: 'Reservation analytics', href: '/reservations/analytics', sub: true },
  ],
  tables:         [{ label: 'Floor plan', href: '/floorplan', icon: 'seat' }],
  dispatch:       [{ label: 'Dispatch', href: '/dispatch', icon: 'bike' }],
  riders:         [{ label: 'Riders', href: '/riders' }],
  emergency_overrides: [{ label: 'Emergency overrides', href: '/emergency-overrides', hint: 'Send the hand-over code to the rider; log food a rider brought back' }],

  // ── Finance
  finance_pl:     [
    { label: 'Finance dashboard', href: '/dashboard/finance', icon: 'dashboard', lead: true },
    { label: 'P&L', href: '/accounting/pl-ledger', icon: 'wallet', hint: 'From the ledger — Statement and By brand' },
  ],
  accounting:     [
    { label: 'Accounting', href: '/accounting', icon: 'chart' },
    { label: 'Ledger', href: '/accounting/ledger', sub: true },
    { label: 'Journals', href: '/accounting/journal', sub: true },
    { label: 'Journal requests', href: '/accounting/journal?tab=requests', sub: true },
    { label: 'Trial balance', href: '/accounting/trial-balance', sub: true },
    { label: 'Balance sheet', href: '/accounting/balance-sheet', sub: true },
    { label: 'Cash flow', href: '/accounting/cash-flow', sub: true },
    { label: 'Payments register', href: '/finance/payments', sub: true, hint: 'Every payment (vendors, salaries, advances, petty cash, vouchers, expenses) with its internal classification — Official / Unofficial / Unclassified; ties to the ledger' },
    { label: 'Night audit', href: '/finance/night-audit', sub: true, hint: 'Sales only: lock each sales day (tills, Raast, COD, tenders) the same night; closed when card payouts and the bank side match' },
    { label: 'Shift corrections', href: '/finance/shift-corrections', sub: true, hint: 'Fix a mistake on a closed shift (void a bill, cancel an open ticket): finance lists the fixes, the CEO approves, then it applies on the sale\'s own day' },
    { label: 'Period close', href: '/accounting/period-close', sub: true },
    { label: 'Chart of accounts', href: '/configuration/chart-of-accounts', sub: true },
    { label: 'Allocations', href: '/allocations', sub: true },
    // Food cost moved to Reports → Food cost variance (module food_cost);
    // /accounting/food-cost forwards there (next.config.js).
    { label: 'Sales quadrants', href: '/accounting/menu-engineering', sub: true },
    { label: 'AP aging', href: '/accounting/ap-aging', sub: true },
    // Finance records supplier bills, credit notes and payments (owner,
    // 2026-10-16): /procurement opens to accounting too and shows finance only
    // Bills, Payments and Aging (procurement/page.tsx useApOnly).
    { label: 'Supplier bills & payments', href: '/procurement?tab=bills', sub: true, hint: 'Record supplier bills, credit notes and payments (cash, bank, cheque, wallet)' },
    { label: 'Received, not billed', href: '/procurement/grni', sub: true },
    // H20: waste and count differences wait in 1290 until the CEO approves
    // them into cost of sales (API /accounting/stock-differences).
    { label: 'Stock differences', href: '/finance/stock-differences', sub: true, hint: 'Waste and count differences waiting for the CEO, with their reasons' },
    // The opening count is finance's job, and finance holds no inventory
    // module: this entry lets accounting holders open the count page (and
    // its history) as well as the Stock count link under Inventory.
    { label: 'Opening stock count', href: '/inventory/count', sub: true, hint: "The first count of a company's stock — posted to owner's capital (3010)" },
    { label: 'Receivables', href: '/accounting/receivables', sub: true },
    { label: 'On-account clients', href: '/accounting/receivables/clients', sub: true, hint: 'Corporate clients who pay monthly — credit limits, QR cards, statements' },
    { label: 'Sales tax return', href: '/accounting/sales-tax-return', sub: true },
    // The register of tax invoices and credit notes issued (finance audit
    // 2026-10-17 item 23) — finance ties the return to the numbers issued.
    { label: 'Tax invoices', href: '/accounting/tax-invoices', sub: true, hint: 'Every tax invoice and credit note issued, by company — filter and download CSV' },
    { label: 'Statutory payments', href: '/accounting/statutory', sub: true },
    { label: 'Inter-company', href: '/accounting/intercompany', sub: true },
    { label: 'Fixed assets', href: '/accounting/fixed-assets', sub: true, hint: 'Register, smallwares pools, requests and reports; depreciation runs by itself each month' },
    { label: 'Petty cash', href: '/finance/petty-cash', sub: true },
    { label: 'Cash requests', href: '/finance/cash-vouchers', sub: true, hint: 'Anyone asks for cash; finance approves, then the CEO; finance pays and books it once; supporting documents are checked after' },
    { label: 'Deposit drops', href: '/finance/deposit-drops', sub: true },
    // Finance records PAID wallet top-ups (owner, 2026-10-16); goodwill
    // credits stay with managers on Customers / CRM.
    { label: 'Wallet top-ups', href: '/finance/wallet-topups', sub: true, hint: 'A customer paid to load their wallet — cash, bank transfer, bank deposit or cheque, with its reference #' },
    { label: 'Bank accounts', href: '/configuration/bank-accounts', sub: true },
  ],
  accounting_audit: [{ label: 'Accounting audit', href: '/accounting/audit-log', hint: 'Who moved the books — CEO and management only' }],
  gift_cards:     [{ label: 'Gift cards', href: '/gift-cards', icon: 'gift' }],
  reconciliation: [{ label: 'Reconciliation', href: '/reconciliation', icon: 'scale', hint: 'Shift closes, bank statements, card payouts and Raast QR receipts (provisional until the statement matches)' }],
  voided_prebills: [{ label: 'Voided pre bills', href: '/finance/voided-pre-bills', hint: 'Every pre-bill printed — flagged when it never became a full & final bill or the final bill came out lower' }],
  exceptions:     [{ label: 'Exceptions', href: '/exceptions', icon: 'alert' }],
  capital:        [
    { label: 'Project tracker', href: '/finance/capex', icon: 'hammer', hint: 'CapEx and OpEx' },
    { label: 'OpEx', href: '/finance/opex', sub: true },
    { label: 'Investment', href: '/finance/capital-ledger', sub: true },
  ],
  projections:    [{ label: 'Projections', href: '/finance/projections' }],
  reports:        [
    { label: 'Reports', href: '/reports', icon: 'trend' },
    { label: 'Demand forecast', href: '/analytics/forecast', sub: true },
  ],
  // Its own module, so the CEO can grant it without the rest of Reports. The
  // page needs food_cost; the API also answers accounting holders' reads (the
  // Accounting hub's gauge — GATED_PREFIXES readAnyOf).
  food_cost:      [{ label: 'Food cost variance', href: '/reports/food-cost', hint: 'Actual vs recipe per ingredient and brand, at the price paid (FIFO)' }],
  // 'payroll' is the Finance workspace's view of pay: tip pools and the
  // payroll register (GET /hr/payroll/runs — finance reads it, HR prepares it).
  payroll:        [
    { label: 'Tip pools', href: '/tip-pools', icon: 'receipt' },
    { label: 'Payroll register', href: '/hr/payroll', icon: 'cash', hint: 'Payroll runs, payslips and the bank file' },
  ],

  // ── Marketing
  marketing_workspace: [{ label: 'Activity log', href: '/marketing/activity', icon: 'rocket' }],
  brand_dashboard: [{ label: 'Marketing dashboard', href: '/dashboard/marketing', icon: 'dashboard', lead: true }],
  crm:            [
    { label: 'CRM', href: '/crm', icon: 'users' },
    { label: 'Conversations', href: '/crm/conversations', sub: true },
    { label: 'Segments', href: '/crm/segments', sub: true },
    { label: 'Naughty list', href: '/crm/naughty-list', sub: true },
    { label: 'Guest tags', href: '/configuration/guest-tags', sub: true, hint: 'VIP, allergy, birthday — the list staff pick from' },
    { label: 'Waitlist', href: '/crm/waitlist', sub: true },
    { label: 'Loyalty', href: '/configuration/loyalty', sub: true },
  ],
  campaigns:      [{ label: 'Campaigns', href: '/crm/campaigns', icon: 'mail' }],
  complaints:     [{ label: 'Complaints', href: '/complaints', icon: 'ticket' }],
  reviews:        [{ label: 'Reviews', href: '/reviews', icon: 'star' }],
  calendar:       [{ label: 'Calendar', href: '/calendar', icon: 'calendar' }],
  promos:         [
    { label: 'Promotions', href: '/promos', icon: 'percent' },
    { label: 'Discounts', href: '/discounts', sub: true },
    { label: 'QR codes', href: '/qrcodes', sub: true },
  ],
  brands:         [{ label: 'Brands', href: '/ceo/brands', icon: 'tag', hint: 'Brand info — tax, legal and the look stay with the CEO' }],
  analytics:      [{ label: 'Analytics', href: '/analytics', icon: 'chart' }],
  storefront:     [{ label: 'Storefront', href: '/storefront', icon: 'layout', hint: 'Pages, pop-ups, library, approvals' }],

  // ── HR
  staff_hr:       [
    { label: 'HR dashboard', href: '/dashboard/hr', icon: 'dashboard', lead: true },
    { label: 'Employees', href: '/hr/employees', icon: 'idcard' },
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
    { label: 'Workforce', href: '/workforce', icon: 'users', hint: 'Logins, companies, pending approvals' },
    { label: 'Positions (budget)', href: '/workforce/positions', sub: true },
    { label: 'Time clock', href: '/time-clock', sub: true },
    { label: 'Staff meals', href: '/staff-meals', sub: true },
  ],
  scheduling:     [{ label: 'Rota', href: '/scheduling', icon: 'calendar', hint: 'Generated from the HR roster' }],

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
    { label: 'Integrations', href: '/settings/integrations', icon: 'plug', hint: 'Meta, webhooks, supplier portal' },
    { label: 'Webhooks', href: '/configuration/webhooks', sub: true },
  ],
  audit_log:      [{ label: 'User audit log', href: '/configuration/audit-log', hint: 'Sign-ins and what each user did' }],
  notifications:  [{ label: 'Notifications', href: '/notifications', icon: 'bell' }],
  help:           [{ label: 'Help & support', href: '/help', icon: 'help' }],

  // ── Director (owner, 2026-10-18): a brand partner's read-only view. Held by
  // director logins (who see nothing else) and the CEO (who previews it).
  director_view:  [{ label: 'Brand performance', href: '/director', icon: 'chart', hint: "A brand's sales, P&L, food cost, menu, reviews and complaints — read-only" }],
}

/** Pages open to every login, whatever their modules (the API scopes them). */
export const PERSONAL_PAGES: ModulePage[] = [
  { label: 'My team', href: '/team', hint: 'Who reports to you, and adding a login' },
  // The one approvals inbox (decision D3) — the same page the CEO section
  // links; the API lists only what this login can act on.
  { label: 'Approvals', href: '/ceo/approvals', hint: 'Everything waiting on you' },
  // The bell's full list (owner, 2026-10-16): personal, every login.
  { label: 'Notifications', href: '/me/notifications', hint: 'Approvals, night audit and warnings sent to you' },
  // The Trash: openable by every login without the `trash` module because
  // GET /trash scopes it per type (module + role) and per company.
  { label: 'Trash', href: '/trash', hint: 'Restore deleted items, recover voided ones' },
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
  pos: 'One refund engine, one comp engine and one settle path, all on the open drawer; GST is cash 15% / card 8% from one pricing function. Offline: a new order is kept on the till (lib/offline-queue.ts) and re-sent with the cashier\'s session and the same idempotency key; a refused order stays on the till with the server\'s reason until a manager resends or discards it. Payments, Keenu, No Charge and adding items need the internet. No Charge comps an open order; Split is on the Order Summary.',
  orders: 'Every order is created by ingestOrder and completed by one completeOrder, which issues the invoice; tax filing goes only through the POS connector. Voids are per line on the order page.',
  refunds: 'The one refund engine: caps, manager PIN, cash from the open drawer, its own journal entry; a full refund restores loyalty, wallet and gift-card value.',
  reservations: 'A table is occupied by the reservation flow, or by an open till bill on it (released when the bill is completed or cancelled). Guest tags have endpoints but no admin screen.',
  dashboard: 'The four workspace dashboards (Operations, Finance, Marketing, HR) are blank until the owner picks their numbers.',
  ops: 'The prep list forecasts for the first brand only; it has no brand picker.',
  inventory: 'Stock is held as FIFO lots, costed at the price paid: lib/stockLedger.ts is the only writer and every change leaves a stock movement. Sales deplete through the one recipe explosion; unfired voids and cancels go back to their lots, fired ones are booked as waste. Counts and prep batches are company-scoped. One stock pool per company: lots carry their outlet, but per-outlet pools are the next build, so a transfer moves no quantity (a short receipt is booked as transit loss). Lots have no expiry dates.',
  par_sheet: 'The par board counts preps in PORTIONS (portions per recipe on each sub-recipe): the daily par per outlet and weekday, on hand at the outlet, made today. A different "par" from InventoryItem.parLevel (the low-stock alert for bought stock).',
  recipes: 'One plate cost (lib/recipeCost.ts) behind recipes, pricing, food cost, COGS and stock depletion, at the FIFO price of the lots being cooked; modifiers carry their own recipes; till sales book COGS per brand at shift close. Every dish has a Packaging section: it counts on takeaway and delivery, on every order of a brand whose service vessel is packaging (Stackd), and on a dine-in line only when staff tap "Box given". The Q factor is the only plate allowance — menu pricing, never booked. One price per item across channels; no combos.',
  procurement: 'One PO system and one receiving path: each receipt line opens a FIFO lot, held on 2015 until its bill clears it ("Received, not billed" lists what is open; a write-off needs the CEO). A bill\'s stock lines link to their receipt; equipment goes through CapEx, never a bill. One AP aging tied to ledger AP. No requisition step, payment run or WHT certificate.',
  food_safety: 'Temperature limits with corrective actions and cleaning tasks, per company, with overdue bell reminders and a PDF printout for inspectors. Not yet per outlet in the UI.',
  reconciliation: 'One expected-cash formula and one shift close; every closed shift posts to the ledger. A Raast QR receipt stays provisional until a bank-statement line matches it. Rider COD not handed in sits on 1351 and blocks the month close until the CEO approves; writing off a rider debt is not built.',
  accounting: 'One ledger feed and one period-close checklist (only the CEO may close over an overridable block, with a reason; reopen: CEO only, audited, raised as an exception). The ledger splits by brand, never by outlet; no transfer pricing or multi-currency. Bad debts are written off directly, each approved by the CEO; there is no doubtful-debt provision. On-account clients pay by QR card at the cash tax class and get monthly statements (not tax invoices). Head-office costs not recharged show as "Company overhead (unallocated)".',
  finance_pl: 'From the ledger. Shared cost reaches a brand only through allocation runs; the rest is one head-office line (decision 22).',
  capital: 'A CapEx line names its supplier; a paid instalment is an advance on 1340, with income tax withheld at the rate for the supplier\'s filer status (non-filer until confirmed) and input tax by authority. Capitalising a delivered item onto the fixed-asset register needs the CEO\'s approval; Quick buy (bank only) buys, pays and asks for capitalisation in one step. Old capital-ledger rows are read-only history.',
  reports: 'Food cost variance is its own module (food_cost), linked from Reports. The demand forecast predicts items, not covers, so it cannot drive a rota.',
  food_cost: 'Actual vs recipe at the FIFO price of the lots cooked, split food / drinks / packaging, with material cost by order type and brand. Per-outlet actual waits for per-outlet stock (the next build); periods before the FIFO cut-over have no lot data.',
  dispatch: 'A delivery is completed with the customer\'s code; the staff "Delivered" override is managers-only and only while the company\'s code-only switch is off.',
  riders: 'Riders belong to one company and carry another\'s orders only under a fleet agreement. No earnings or payouts yet; the app polls for offers.',
  crm: 'Segments, loyalty settings and tiers are per company, computed nightly. Customer strikes and bans are servd-wide (owner, 2026-10-15); a banned customer may appeal when appeals are switched on.',
  campaigns: 'Email and WhatsApp only. No scheduled sends — a campaign is a draft until sent — and opens and clicks are not linked to orders.',
  storefront: 'Nothing publishes without the CEO (decision 41).',
  staff_hr: 'HR is the person master; each company can replace its forms in /hr/formats. Leave counts calendar days (weekly offs and holidays are not skipped); file fields take a link, not an upload.',
  staff_directory: 'A login is access only; one login can be linked to an employee in each company. Team leads add logins for their own roles from My team, and the CEO approves each one. HR adds and offboards logins from the employee record: floor staff are active at once, manager and office logins wait for the CEO.',
  scheduling: 'Generated from the HR roster and approved swaps; managers store only one-off changes. Costed from HR salaries.',
  api_pos: 'Vendors not chosen yet: until the CEO goes live with a fiscal POS driver, every sale is held (visible, never sent). No nightly card-settlement match yet. Raast QR bank-SMS matching is off per company until the CEO switches it on; servd never logs in to internet banking.',
  integrations: 'No data export screen (database backups: CEO → Backups). Webhooks: one API, but only order events fire. Supplier chat still sends mail through its own env-only SMTP transport.',
  audit_log: 'Sign-ins (success, failure, OTP, 2FA, sign-out) are audited alongside account, access and on-shift actions, per company.',
}

/**
 * Module ids PARKED by the owner (2026-10-13, .handoff/parked/2026-10-14/):
 * the ids stay (Module Access, workspaces) but they have no page, so the
 * workspace homes and /modules hide a section made only of them instead of
 * showing an empty "No admin page" card.
 */
export const PARKED_MODULES: ReadonlySet<string> = new Set<string>([])

/** True when every module of a section is parked (the section is hidden). */
export function isParkedSection(modules: readonly string[]): boolean {
  return modules.length > 0 && modules.every((m) => PARKED_MODULES.has(m))
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
  // A head-office login's own landing page (D1).
  '/head-office',
  // The admin's one punch screen (decision 32) — the signed-in person's own
  // clock (kiosk mode removed 2026-10-27). Its API (/time-clock/status,
  // punch-in/out) is ALL_STAFF and punches only the caller, so every login
  // opens it; the Workforce sidebar link stays with staff_directory.
  '/time-clock',
  // Cash requests (/finance/cash-vouchers) are a personal page now, so the
  // line below opens them to every login.
  ...PERSONAL_PAGES.map((p) => p.href),
]

/** The only pages a director login opens (owner, 2026-10-18). */
export const DIRECTOR_OPEN_PREFIXES: readonly string[] = ['/director', '/account/password', '/login', '/reset-password']

/** True for a director login (owner, 2026-10-18). */
export function isDirector(role: string | null | undefined): boolean {
  return role === 'director'
}

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
  // A director login opens the Director page and its own account page — never
  // anything else, whatever is "always open" to staff (the API refuses it too).
  if (role === 'director') return DIRECTOR_OPEN_PREFIXES.some((p) => underPrefix(pathname, p))
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
