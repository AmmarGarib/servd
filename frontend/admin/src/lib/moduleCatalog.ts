// ─── Module catalogue ─────────────────────────────────────────────────────────
//
// ONE list. There used to be two — "A · Universal core" and "B · Restaurant
// layer" — which sorted modules by whether a non-restaurant business would also
// need them. That is a true statement about the world and a useless one here:
// GS Foods runs restaurants, so every module is in scope, and the split only
// meant that things you do in the same sitting sat in different halves of the
// page. Cash counting was in A, the shift that produces the cash was in B.
//
// Modules were merged where they were verifiably the same thing — same admin
// route, or same underlying tables — not where they merely sounded related.
// "Both are financial" was not accepted as an argument. 31 entries became 18.
// Each module names what it `absorbed` so the old references still resolve.
//
// ORDER is by what a defect costs you if left alone, not by alphabet or by
// accounting convention. Money moving wrongly at the till outranks a missing
// food-safety screen, so POS is first and HACCP is last. Read top-down and you
// are working in descending order of damage.
//
// ─── On the `gaps` notes ──────────────────────────────────────────────────────
//
// These are the register you reconcile from, so they are only worth having if
// they are true. Every one of the 31 original notes was re-verified against the
// code in September 2026: 3 described things already fixed, 3 were wrong, and
// 25 were true but materially incomplete. Not one was accurate as written. They
// have all been rewritten from what the code actually does.
//
// They are deliberately specific — file, endpoint, table, column. A note saying
// "reporting is incomplete" cannot be actioned; a note saying "GET
// /reports/menu-engineering returns a bare array while the page reads
// data.items, so it always shows zero" can be fixed this afternoon. Keep that
// standard when you edit them, and re-verify rather than assume: a stale gap
// register sends people chasing things that were fixed months ago.
//
// `build` is what exists TODAY, checked the same way:
//   built      — real endpoints and UI, in use
//   partial    — some of it works, some is stubbed or unreachable
//   not-built  — nothing exists; the card says so rather than pretending
//
// ACCESS is separate and always derived from the permission atoms your role
// holds, never stored here — /configuration/role-modules stays the single
// source of truth:
//   full     you hold every atom in the module
//   partial  you hold some; the module opens showing ONLY those
//   locked   you hold none

import type { ModuleId } from './appRoles'

export interface ModuleSection {
  label: string
  href: string
  /** Permission atom gating this section. Omitted = ungated. */
  module?: ModuleId
  /** Short note shown under the section — flags duplicates and caveats. */
  hint?: string
}

export type BuildState = 'built' | 'partial' | 'not-built'

export interface AppModule {
  id: string
  /** Position in the single list. Ordered by cost-of-defect, highest first. */
  ref: string
  name: string
  icon: string
  /** What exists today, verified against the code — not what was planned. */
  build: BuildState
  blurb: string
  /**
   * Old catalogue ids folded into this module, kept so historical references
   * and anything pointing at the two-category model still resolve.
   */
  absorbed?: string[]
  /** Identity, master data, stock ledger, approvals — build once, properly. */
  platform?: boolean
  /** What is missing, duplicated or unreliable here. Shown in the module view. */
  gaps?: string
  sections: ModuleSection[]
}

export const MODULE_CATALOG: AppModule[] = [
  {
    id: 'pos', ref: '1', name: 'POS, orders & write-offs', icon: '💳',
    build: 'built', absorbed: ['pos', 'sales', 'variance'],
    blurb: 'Taking the order, taking the money, and everything that leaves without being paid for.',
    gaps: 'Tax is wrong at the till in two directions: the POS never sends the tender, so every sale is taxed at taxRateCash (15%) even on card (should be 8%), and the cart displays GST at the legacy concept.taxRate (17%), so the on-screen total never matches what is charged. Offline orders are lost — sw.js replays to the wrong origin unauthenticated, then deletes them. Two refund engines disagree: /refunds reverses ledger, loyalty and gift cards but writes no Payment row (so the till, Z-report and SRB return never see it) and ignores the caps at /configuration/refund-policy; POS refundOrder() does the reverse. Comps go through one engine (POST /pos/orders/:id/comp — caps, manager PIN, audit, on the open drawer, never more than is due) and the web till\'s Comp tile uses it, but there is no admin screen to comp an order after it was rung; voids are per line on the order page (/orders/[id]) through the one POS void, with its caps and manager PIN. StaffMeal cost never posts to the ledger or deducts stock, so it never reaches COGS. Split bills (/orders/[id]/split) and the live floor plan (/floorplan) exist but are not linked from here.',
    sections: [
      { label: 'Point of Sale', href: '/pos',              module: 'pos' },
      { label: 'Waiter mode',   href: '/pos/waiter',       module: 'pos' },
      { label: 'Floor plan',    href: '/tables',           module: 'tables' },
      { label: 'Orders',        href: '/orders',           module: 'orders' },
      { label: 'Refunds',       href: '/refunds',          module: 'refunds', hint: 'Disagrees with the POS refund path — see gaps' },
      { label: 'Curbside',      href: '/orders/curbside',  module: 'curbside' },
      { label: 'Waste log',     href: '/inventory',        module: 'inventory', hint: 'A tab inside Inventory, not its own screen' },
      { label: 'Staff meals',   href: '/staff-meals',      module: 'staff_directory' },
    ],
  },
  {
    id: 'cash', ref: '2', name: 'Cash drawer, drops & matching', icon: '🏦',
    build: 'partial', absorbed: ['cash', 'shift', 'channels'],
    blurb: 'The shift, the drawer it produces, and reconciling both against the bank.',
    gaps: 'One expected-cash formula (backend lib/drawer.ts) feeds the close and its variance alert, the Z-report, the ledger post, /reconciliation, the CEO "Cash balanced" card and deposit drops, judged against each company\'s own tolerance (Configuration → Receipts). There is one close (POST /pos/shifts/:id/close): /reconciliation closes through it, so every shift reaches the ledger, and tills re-sync their drawer from /pos/shifts/current. Bank accounts link to chart codes, deposit drops post to the picked bank\'s code, and statement imports pick a bank account and can be cleared line by line. Still open: shifts closed from /reconciliation before the fix never reached the ledger — scripts/backfill-shift-close-postings.ts lists them, and posting the ones in locked months waits on the owner. Drawer pay-outs still post to 8010 as unclassified and petty-cash spends post nothing (only a spend that pays a supplier bill does), pending the owner\'s call on till pay-outs vs petty cash. Cash refunds post gross to 7040, without the GST share, until refunds get their own posting. petty_cash_boxes, staff_meals and exception_flags carry no tenantId and their list endpoints do not filter.',
    sections: [
      { label: 'Shift / till',    href: '/pos/shift',                   module: 'pos' },
      { label: 'Reconciliation',  href: '/reconciliation',              module: 'reconciliation' },
      { label: 'Cash flow',       href: '/accounting/cash-flow',        module: 'accounting' },
      { label: 'Petty cash',      href: '/finance/petty-cash',          module: 'accounting' },
      { label: 'Deposit drops',   href: '/finance/deposit-drops',       module: 'accounting' },
      { label: 'Bank accounts',   href: '/configuration/bank-accounts', module: 'accounting' },
      { label: 'Exceptions',      href: '/exceptions',                  module: 'exceptions' },
      { label: 'Orders by source', href: '/reports',                    module: 'reports', hint: 'The one sales-by-channel view (the /orders tab was removed)' },
    ],
  },
  {
    id: 'crm', ref: '3', name: 'Customers, campaigns & storefront', icon: '🧑‍🤝‍🧑',
    build: 'built', absorbed: ['crm', 'marketing'],
    blurb: 'Who buys from you, how you reach them, and the public site they see.',
    gaps: 'Campaigns reach every customer we hold contact details for, across all companies, unless they unsubscribed — intended. Brand targeting is optional per campaign, and every message carries an unsubscribe link. Scheduled campaigns still never fire; nothing reads scheduledAt. Loyalty rates and tiers are global (Setting and TierConfig have no tenantId), so all companies share one ladder. /gift-cards/redeem checks neither company nor the card\'s own conceptId. Three parallel segment systems exist (Segment, CustomerSegment, smart-segments) and campaigns can only target the first. Promo attribution works for codes and QR (Order.promoCodeId, promo_code_usages), but POS never sends promo_code_id, so a promo cannot be redeemed at the till, and email/SMS campaigns track opens and clicks with no link to orders.',
    sections: [
      { label: 'Customers',          href: '/customers',           module: 'crm' },
      { label: 'CRM',                href: '/crm',                 module: 'crm' },
      { label: 'Conversations',      href: '/crm/conversations',   module: 'crm' },
      { label: 'Segments',           href: '/crm/segments',        module: 'crm', hint: 'One of three segment systems' },
      { label: 'Loyalty',            href: '/configuration/loyalty', module: 'crm' },
      { label: 'Gift cards',         href: '/gift-cards',          module: 'gift_cards' },
      { label: 'Complaints',         href: '/complaints',          module: 'complaints' },
      { label: 'Reviews',            href: '/reviews',             module: 'reviews' },
      { label: 'Workspace',          href: '/marketing',           module: 'marketing_workspace' },
      { label: 'Campaigns',          href: '/crm/campaigns',       module: 'campaigns', hint: 'All customers, or by brand' },
      { label: 'Promotions',         href: '/promos',              module: 'promos' },
      { label: 'Discounts',          href: '/discounts',           module: 'promos' },
      { label: 'QR codes',           href: '/qrcodes',             module: 'promos' },
      { label: 'Calendar',           href: '/calendar',            module: 'calendar' },
      { label: 'Activity log',       href: '/marketing/activity',  module: 'marketing_workspace' },
      { label: 'Brands & storefront', href: '/marketing/brands',   module: 'brands' },
      { label: 'Visual layout',      href: '/storefront',          module: 'brands' },
      { label: 'Landing hero',       href: '/storefront-hero',     module: 'brands' },
      { label: 'Brand footers',      href: '/storefront-footer',   module: 'brands' },
      { label: 'Content pages',      href: '/content',             module: 'brands' },
    ],
  },
  {
    id: 'procurement', ref: '4', name: 'Suppliers, POs & bills', icon: '📦',
    build: 'built', absorbed: ['procurement', 'ap'],
    blurb: 'Ordering from suppliers, receiving it, and paying for it.',
    gaps: 'One purchase-order system (/procurement: approvals over the threshold, bills, payments); the legacy /accounting/vendors and /recipes/vendors + /recipes/purchase-orders are gone. One receiving path (procurement receiveGoods) behind the dock page and the PO Receive action: it writes the goods receipt, PurchaseOrderLine.quantityReceived, stock and the moving-average cost in one transaction, with the dock photo threshold and the raiser-cannot-receive rule (CEO exempt); deliveries without a PO are allowed for manager tiers with the unit cost entered at the dock. One AP aging (GET /procurement/ap-aging) behind the Accounting AP aging page, the Procurement Aging tab, the emailed report and the supplier statement: net of withholding, by due date, unapplied payments as credits, and supplier opening balances posted to the ledger once (Dr 3020 / Cr 2010), so each supplier has one balance and it ties to AP 2010. Receiving variance flags carry no company yet (ExceptionFlag has no tenant). No requisition step, no payment run, no WHT certificate.',
    sections: [
      { label: 'Purchase orders',  href: '/procurement',            module: 'procurement' },
      { label: 'Receiving (GRN)',  href: '/procurement/receiving',  module: 'procurement' },
      { label: 'Supplier chat',    href: '/procurement/chat',       module: 'procurement' },
      { label: 'Monitor',          href: '/procurement/monitor',    module: 'procurement' },
      { label: 'Sourcing sheet',   href: '/sourcing',               module: 'inventory' },
      { label: 'AP aging',         href: '/accounting/ap-aging',    module: 'accounting' },
    ],
  },
  {
    id: 'hr', ref: '5', name: 'Staff, rota & pay', icon: '👥',
    build: 'partial', absorbed: ['hr', 'labor'],
    blurb: 'Who works here, when they work, and what they are paid — plus the full HR cycle from hiring to exit.',
    gaps: 'The HR module (/hr) is a base layer built from the HR spec: all 30 sections exist with working default formats, and the HR team replaces each format in /hr/formats (paste a field list, import JSON, or edit field by field) without a code change. Logic that is live: approvals HOD → HR → Management, leave balances and over-booking checks, overtime pay, loans recovered through locked payroll, salary revisions / promotions / transfers applied on their effective date, payroll with EOBI and SESSI, final settlement, letters, 25 reports. Payroll: HR payroll is the only payroll — locking a month posts it to the ledger (wages by department, tax, EOBI/SESSI, loan recoveries against wages payable), and marking it paid clears wages payable; a loan posts when approved. EOBI is an on/off setting per company (compulsory from 10 employees). The old /payroll and the kitchen brigade payroll are removed (their tables are kept for history). People: HR is the person master — a login is access only, not every login has an employee record, and one login can be linked to an employee in each company. Attendance comes from punches: the time clock, the tablet and the kiosk PIN (for staff without a login) write each day\'s attendance, present or late against the roster; a day with no clock-out becomes a missing punch, and HR corrects exceptions with an approved attendance correction. The rota: standing shifts and weekly offs are HR roster records, the /scheduling week is generated from them, managers store only one-off exceptions there, and it is costed from HR salaries; an approved HR shift swap moves the day. Clock-in geofence: one rule per company (Configuration → Operations), fenced on the company\'s branch map pins. Tip pools follow the company\'s rules (who is in, weights, split) and its punches. Departments and designations are written in HR → Org setup only; a position\'s title is an HR designation. Known limits: leave days are calendar days — weekly offs and holidays are not skipped yet; file fields take a link, not an upload; a one-day rota change can only be stored for someone with a login until the rota table is keyed by employee.',
    sections: [
      { label: 'HR dashboard',       href: '/hr',                  module: 'staff_hr' },
      { label: 'Employees (HR)',     href: '/hr/employees',        module: 'staff_hr' },
      { label: 'Attendance',         href: '/hr/attendance',       module: 'staff_hr', hint: 'Each day\'s punches next to the attendance they wrote' },
      { label: 'HR sections',        href: '/hr/sections',         module: 'staff_hr', hint: 'Recruitment, attendance, leave, performance, exits — all 30 spec sections' },
      { label: 'HR payroll',         href: '/hr/payroll',          module: 'staff_hr' },
      { label: 'HR documents',       href: '/hr/documents',        module: 'staff_hr' },
      { label: 'HR letters',         href: '/hr/letters',          module: 'staff_hr' },
      { label: 'HR reports',         href: '/hr/reports',          module: 'staff_hr' },
      { label: 'HR formats',         href: '/hr/formats',          module: 'staff_hr', hint: 'Where the HR team plugs in their own forms' },
      { label: 'HR org setup',       href: '/hr/org',              module: 'staff_hr' },
      { label: 'HR settings',        href: '/hr/settings',         module: 'staff_hr' },
      { label: 'My approvals',       href: '/hr/approvals' },
      { label: 'My HR',              href: '/hr/me' },
      { label: 'Staff directory',    href: '/workforce',           module: 'staff_directory' },
      { label: 'Positions (budget)', href: '/workforce/positions', module: 'staff_directory' },
      { label: 'Tip pools',          href: '/tip-pools',           module: 'payroll' },
      { label: 'Time clock',         href: '/time-clock',          module: 'staff_directory', hint: 'Clock yourself in, or punch with an employee ID + kiosk PIN' },
      { label: 'Rota',               href: '/scheduling',          module: 'scheduling', hint: 'Generated from HR roster; one-off changes only' },
      { label: 'Demand forecast',    href: '/analytics/forecast',  module: 'reports', hint: 'Predicts items, not covers — cannot drive a rota' },
    ],
  },
  {
    id: 'gl', ref: '6', name: 'The books', icon: '📒',
    build: 'partial', absorbed: ['gl', 'multi-outlet'], platform: true,
    blurb: 'The general ledger, the statements that come out of it, and the entities it splits by.',
    gaps: 'One P&L: /accounting/pl-ledger (Statement + By brand) sums JournalLine; /finance redirects there, and the old FinancialEntry P&L (GET /accounting/pl) is gone. One transaction feed: /accounting/ledger (GET /accounting/ledger, ?id= for one entry). POS sales still reach the ledger only at shift close, so an unclosed till is not in the P&L yet; refunds on a drawer that is already closed are not posted by anyone (whose cash pays them is an open owner question). Period locks have two write paths that disagree: /accounting/period-close cannot move backwards, /setup/period-locks can delete a lock outright. Outlet-level P&L does not exist: journal_lines carry conceptId only, so the ledger splits by brand and never by outlet. Transfer pricing is absent — StockTransfer moves quantity, has no cost field and posts no journal entry. Allocation rules are company-blind: sourceAccountCode is globally unique and /allocations/rules and /runs leak across companies. No multi-currency.',
    sections: [
      { label: 'Accounting',        href: '/accounting',                      module: 'accounting' },
      { label: 'P&L',               href: '/accounting/pl-ledger',            module: 'finance_pl', hint: 'From the ledger — Statement and By brand' },
      { label: 'Ledger',            href: '/accounting/ledger',               module: 'accounting' },
      { label: 'Trial balance',     href: '/accounting/trial-balance',        module: 'accounting' },
      { label: 'Balance sheet',     href: '/accounting/balance-sheet',        module: 'accounting' },
      { label: 'Period close',      href: '/accounting/period-close',         module: 'accounting' },
      { label: 'Period locks',      href: '/configuration/period-locks',      module: 'accounting' },
      { label: 'Chart of accounts', href: '/configuration/chart-of-accounts', module: 'accounting' },
      { label: 'Accounting audit',  href: '/accounting/audit-log',            module: 'accounting_audit' },
      { label: 'Allocations',       href: '/allocations',                     module: 'accounting' },
      { label: 'Entities / brands', href: '/settings',                        module: 'tenants' },
      { label: 'Chain rollup',      href: '/chain',                           module: 'chain' },
    ],
  },
  {
    id: 'tax', ref: '7', name: 'Tax, invoices & FBR/SRB filing', icon: '🏛',
    build: 'partial', absorbed: ['tax', 'fiscal', 'ar'],
    blurb: 'What you owe the revenue authorities, what you file, and what customers owe you.',
    gaps: 'Online sales are not being filed at all: only POS enqueues to FBR/SRB, so every storefront order goes unreported. srbPosId cannot be set anywhere in admin — it is absent from PATCH /concepts and the Brands form, which carries only fbrPosId — so SRB submission silently skips every brand. The FBR adapter builds item lines at the legacy concept.taxRate (17%) while the till charges 15/8, so line tax will never reconcile to the header. /configuration/tax is a read-only stub, so rates are not editable, and menu-item zero-rated/exempt is saved but never applied (taxRate.ts is dead code). Receivables now have a base layer at /accounting/receivables: invoices post to 1110 (with GST to 2030), payments clear to bank or cash, partial payments and overpayment protection, void-while-unpaid, and aging by days past due. Still missing there: credit notes (a paid invoice cannot be corrected), statements and reminders to the customer, credit limits, an "on account" tender at the POS, and FBR submission of these invoices.',
    sections: [
      { label: 'Sales tax return', href: '/accounting/sales-tax-return', module: 'accounting' },
      { label: 'Tax settings',     href: '/configuration/tax',           module: 'accounting', hint: 'Read-only stub — rates are not editable' },
      { label: 'FBR / PRAL setup', href: '/settings/integrations',       module: 'integrations' },
      { label: 'Receivables',      href: '/accounting/receivables',      module: 'accounting', hint: 'Invoices customers pay later — base layer' },
    ],
  },
  {
    id: 'stock', ref: '8', name: 'Stock on hand & movement', icon: '📊',
    build: 'partial', absorbed: ['stock', 'perishables', 'commissary'], platform: true,
    blurb: 'What you hold, what it cost, and what happens to it between delivery and plate.',
    gaps: 'There is no stock ledger. inventory_items.currentStock is a single mutable number that sales, waste, receipts and counts all overwrite, and only sales record the movement (a per-order stock.sale_deplete / stock.sale_restore row in audit_logs) — everything else can\'t be traced or audited after the fact. Sales now deplete in purchase units through the same recipe explosion as COGS (sub-recipes included) and give the stock back when an order is cancelled or rejected. Everything else here follows from the missing ledger: counts reset stock to physical and flag shrinkage but post nothing to the GL; an ad-hoc prep batch deducts its inputs (converted to purchase units) and never books the finished item back in, while a batch logged against a sub-recipe deducts nothing because sales already explode that sub-recipe — and the prep page never sends the recipe, so a sub-recipe prepped there is counted twice; /stock-transfers only flips a status, moves no quantity, has no UI in any client, and receiving moves no stock. No expiry or batch/lot date exists anywhere in the schema, and cost is weighted-average on receipt with no FIFO. Two unrelated things are called "par" (InventoryItem.parLevel for alerts, ComponentParLevel for the daily sheet). "Below par" has one backend rule (par set and stock at or under it, by the item\'s company), but the emailed low-stock report, reorder suggestions and the /inventory and /inventory/alerts pages still apply their own. PhysicalCount and PrepBatch have no tenantId and their endpoints do not filter, so counts and batches are shared across brands.',
    sections: [
      { label: 'Inventory',   href: '/inventory',        module: 'inventory' },
      { label: 'Stock count', href: '/inventory/count',  module: 'inventory' },
      { label: 'Low stock',   href: '/inventory/alerts', module: 'inventory', hint: 'Reads InventoryItem.parLevel, not the par sheet' },
      { label: 'Par sheet',   href: '/par-sheet',        module: 'par_sheet', hint: 'A different "par" — ComponentParLevel' },
      { label: 'Prep',        href: '/inventory/prep',   module: 'inventory' },
    ],
  },
  {
    id: 'master-data', ref: '9', name: 'Master data & reference lists', icon: '🗃',
    build: 'partial', absorbed: ['master-data'], platform: true,
    blurb: 'Items, vendors, customers, locations, units and tax codes — meant to be one source of truth.',
    gaps: 'No master-data screen exists. Six of the eight links below are other modules\' pages; only Locations and Dietary tags belong to this module, which makes it a menu rather than a surface. /configuration/tax is a placeholder, so MenuItem.taxClassification cannot be set in admin at all. Units are free text on InventoryItem with no UOM master, which is what lets the food-cost calculation be wrong by three orders of magnitude on kg and litre items. Dietary tags can be defined but not attached to an item. Ingredients are one row per company: the Sourcing sheet and Inventory both create through the same POST, bound to the active company (no shared items), and cost is the moving average of deliveries — a typed price is only an opening estimate until the first delivery. Legacy company-less items are assigned from the Sourcing sheet; merging duplicate items needs a reviewed script, and the negotiated list price has no field of its own yet. The old note claimed three unlinked people models; that is now two — Position already links to User via filledByUserId, and only KitchenStaff has no user link.',
    sections: [
      { label: 'Menu items',      href: '/menu',                        module: 'menu' },
      { label: 'Inventory items', href: '/inventory',                   module: 'inventory' },
      { label: 'Vendors',         href: '/procurement',                 module: 'procurement' },
      { label: 'Customers',       href: '/customers',                   module: 'crm' },
      { label: 'Locations',       href: '/configuration/locations',     module: 'business_info' },
      { label: 'Tax codes',       href: '/configuration/tax',           module: 'accounting', hint: 'Stub — cannot set an item\'s tax class' },
      { label: 'Modifiers',       href: '/configuration/modifiers',     module: 'menu' },
      { label: 'Dietary tags',    href: '/configuration/dietary-tags',  module: 'menu', hint: 'Definable, but not attachable to an item' },
    ],
  },
  {
    id: 'approvals', ref: '10', name: 'Approvals', icon: '✅',
    build: 'partial', absorbed: ['approvals'], platform: true,
    blurb: 'Anything that needs a second person before it counts.',
    gaps: 'Approvals are per-area bolt-ons rather than a service, so there is no single queue and no delegation. The real flows are recipes, purchase orders, stock transfers, staff signups, and PIN-approved waste, petty cash and staff meals — each with its own screen and its own rules. Thresholds exist for exactly one of them: procurement.approvalThresholdCents auto-approves purchase orders under PKR 50,000, and it is configured inside /procurement rather than here. Payroll has no approval step at all; it is only role-gated, so a single operator can post a run unchallenged.',
    sections: [
      { label: 'Recipe approvals', href: '/accounting/recipes/approvals',    module: 'recipes' },
      { label: 'Pending signups',  href: '/workforce?status=pending',        module: 'role_management' },
    ],
  },
  {
    id: 'recipes', ref: '11', name: 'Recipes, plate cost & menu pricing', icon: '📖',
    build: 'partial', absorbed: ['menu-eng', 'costing'],
    blurb: 'What a dish is made of, what it costs to make, and what you charge for it.',
    gaps: 'Plate cost now has one source (backend lib/recipeCost.ts): the recipe list, the pricing page, /recipes/food-cost, the sales-quadrant report, the ledger\'s COGS and the stock depletion at sale all use it — per-measure unit costs, sub-recipes at any depth, each recipe\'s own Q factor applied once, and no kitchen labour (labour reaches price only as payroll opex). Remaining gaps: till (POS) sales still book no COGS, because the shift close posts revenue only; the Sales quadrants page reads data.items from a bare array, so it always shows zero; the CEO dashboard\'s per-brand food cost still reads the quadrant report instead of the ledger; the recipe form\'s live preview still carries its own copy of the maths (POST /recipes/costing-preview exists to replace it); and a refund reverses COGS in the ledger while the stock stays consumed. Counts and waste are never compared to theoretical usage. No combos, and one priceCents across all channels.',
    sections: [
      { label: 'Menu',              href: '/menu',                        module: 'menu' },
      { label: 'Pricing workspace', href: '/menu-engineering',            module: 'recipes' },
      { label: 'Sales quadrants',   href: '/accounting/menu-engineering', module: 'accounting', hint: 'Always shows zero — see gaps' },
      { label: 'Modifiers',         href: '/configuration/modifiers',     module: 'menu' },
      { label: 'Recipes',           href: '/accounting/recipes',          module: 'recipes' },
      { label: 'Food cost',         href: '/accounting/food-cost',        module: 'accounting', hint: 'Unit-cost bug makes this unreliable' },
    ],
  },
  {
    id: 'identity', ref: '12', name: 'Logins, roles & audit trail', icon: '🔐',
    build: 'built', absorbed: ['identity'], platform: true,
    blurb: 'Who can sign in, what they may touch, and a record of what they did.',
    gaps: 'Sign-in events are still not audited — logins, logouts and failed attempts are never written to audit_logs, which is the one thing an access trail is for. No job ever purges the table, so rows accumulate indefinitely with no retention policy. Separately, role "hr" is granted the staff_directory module but /auth/users and /positions are MANAGERS-only, so an HR account gets a 403 on the page its own permission promises. Access is Module Access plus each route\'s role gate; the per-action permission matrix was removed because nothing enforced it, and pending signups are reviewed on /workforce.',
    sections: [
      { label: 'Staff directory',     href: '/workforce',                       module: 'staff_directory' },
      { label: 'Pending signups',     href: '/workforce?status=pending',        module: 'role_management' },
      { label: 'Module access',       href: '/configuration/role-modules',      module: 'role_modules' },
      { label: 'Audit log',           href: '/configuration/audit-log',         module: 'audit_log', hint: 'Identity trail — money moves are on the accounting log' },
    ],
  },
  {
    id: 'reservations', ref: '13', name: 'Reservations & table state', icon: '🍽',
    build: 'built', absorbed: ['reservations'],
    blurb: 'Bookings, covers and what each table is doing right now.',
    gaps: 'Table state drifts from reality because only the reservation flow sets it: cancelling a seated booking never frees the table, nothing ever clears "cleaning", and POS orders never mark a table occupied at all — so a walk-in table shows as free. Table.currentPartySize and currentOrderId are manual entry only. Guest-tag endpoints exist with no admin UI, and the live floor (/floorplan) and kitchen reservation tracker (/kds/reservations) are both built but not linked from here.',
    sections: [
      { label: 'Reservations', href: '/reservations',           module: 'reservations' },
      { label: 'Week view',    href: '/reservations/week',      module: 'reservations' },
      { label: 'Closures',     href: '/reservations/blockouts', module: 'reservations_admin' },
      { label: 'Service hours', href: '/reservations/hours',    module: 'reservations_admin' },
      { label: 'Analytics',    href: '/reservations/analytics', module: 'reservations_admin' },
      { label: 'Floor plan',   href: '/tables',                 module: 'tables' },
    ],
  },
  {
    id: 'kds', ref: '14', name: 'Kitchen screens', icon: '🍳',
    build: 'built', absorbed: ['kds'],
    blurb: 'What the kitchen sees, in what order, and when it is fired.',
    gaps: 'The Expo tablet screen is dead — it calls /kds/stations/:id/items and /orders/items/:id/advance, neither of which exists. Bumping in admin runs on /expo/* only, so the /kds queue, fire, bump, recall and metrics endpoints have no caller and station timing is never surfaced anywhere. The course-pacing worker auto-fires items every 30 seconds regardless of expo\'s "Confirm & Fire" gate, so the gate can be bypassed by simply waiting. The old HR entry linked /kds/config as "Kitchen brigade"; that roster is people and lives under Staff, while this is stations.',
    sections: [
      { label: 'Kitchen view', href: '/kds',        module: 'kds_dashboard' },
      { label: 'All orders',   href: '/kds/all',    module: 'kds_all' },
      { label: 'Expo station', href: '/expo',       module: 'expo_station' },
      { label: 'KDS config',   href: '/kds/config', module: 'kds_config', hint: 'Stations, not staff' },
      { label: 'Ops centre',   href: '/ops',        module: 'ops' },
    ],
  },
  {
    id: 'bi', ref: '15', name: 'Reports & dashboards', icon: '📈',
    build: 'built', absorbed: ['bi'],
    blurb: 'The numbers, per role — and where they are estimates rather than facts.',
    gaps: 'The CEO money section is the ledger (net revenue, margins, tax collected); brand margins measure each brand\'s tagged lines and still spread untagged cost by ledger revenue share (whether that should stay an unallocated head-office line is an open owner question). Sales, orders and average ticket on the CEO, Reports, Chain, Brand and F&B dashboards are sales-register figures (what customers paid, incl. GST) and are labelled so — whether those dashboards should show ledger revenue instead is an open owner question. Five role dashboards exist (CEO, Brand, F&B, BOH, FOH) but /dashboard is only a chooser and BOH/FOH are not listed here, so they are reachable only through it. The demand forecast defaults its weather lookup to Lahore because WEATHER_LAT is unset.',
    sections: [
      { label: 'Reports',         href: '/reports',            module: 'reports' },
      { label: 'Analytics',       href: '/analytics',          module: 'analytics' },
      { label: 'CEO overview',    href: '/dashboard/ceo',      module: 'ceo_overview', hint: 'Brand margins allocate shared cost — see gaps' },
      { label: 'Live dashboard',  href: '/dashboard',          module: 'dashboard' },
      { label: 'Brand dashboard', href: '/dashboard/brand',    module: 'brand_dashboard' },
      { label: 'F&B dashboard',   href: '/dashboard/fnb',      module: 'fnb_dashboard' },
      { label: 'Demand forecast', href: '/analytics/forecast', module: 'reports' },
      { label: 'Chain rollup',    href: '/chain',              module: 'chain' },
    ],
  },
  {
    id: 'integration', ref: '16', name: 'Integrations, webhooks & backups', icon: '🔌',
    build: 'partial', absorbed: ['integration'],
    blurb: 'How servd talks to everything else — and how you get your data out.',
    gaps: 'Backup is a hardcoded stub: there is no real backup or export behind /configuration/backup, so the answer to "can we get our data out" is currently no. The webhooks UI offers 12 events but only 5 ever fire (order confirmed, dispatched, delivered, refunded, and inventory.low_stock) — shift, payment, reservation and order.placed subscriptions are silently dead, so anyone relying on them is waiting for a call that never comes. Two rival webhook APIs exist: /setup/webhooks is company-scoped, /webhooks/endpoints is not. media_assets and the Meta tokens in settings have no tenantId, so every company shares one media library and one Facebook page.',
    sections: [
      { label: 'Integrations', href: '/settings/integrations',   module: 'integrations' },
      { label: 'Webhooks',     href: '/configuration/webhooks',  module: 'integrations', hint: '7 of 12 advertised events never fire' },
      { label: 'Notifications', href: '/notifications',          module: 'notifications' },
      { label: 'Media / files', href: '/media',                  module: 'media' },
      { label: 'Backup',       href: '/configuration/backup',    module: 'business_info', hint: 'Stub — no real backup exists' },
      { label: 'Domains',      href: '/configuration/domains',   module: 'tenants' },
    ],
  },
  {
    id: 'assets', ref: '17', name: 'Equipment & fixed assets', icon: '🏭',
    build: 'partial', absorbed: ['assets'],
    blurb: 'Ovens, fit-outs and vehicles — what you own and what it is worth now.',
    gaps: 'Base layer built (Sept 2026): a register at /accounting/fixed-assets that capitalises each asset (Dr 1510–1550, Cr bank, cash, supplier payable or owner’s capital for equipment already owned), charges straight-line depreciation monthly (Dr 6150 / Cr 1590, one entry per asset per month, safe to re-run), and books disposals with the gain or loss to 8030. Still missing: depreciation is charged by pressing “Charge month”, not on a schedule; only straight-line exists (no reducing balance); the CapEx tracker (/finance/capex) is not linked, so a project’s spend is not turned into assets automatically; no maintenance or warranty reminders; cost, life and dates cannot be edited once posted (by design — a correction needs a reversal, which has no screen yet).',
    sections: [
      { label: 'Asset register', href: '/accounting/fixed-assets', module: 'accounting' },
      { label: 'CapEx tracker',  href: '/finance/capex',           module: 'capital', hint: 'Project spend — not yet linked to the register' },
    ],
  },
  {
    id: 'haccp', ref: '18', name: 'Food safety logs', icon: '🌡',
    build: 'partial', absorbed: ['haccp'],
    blurb: 'Temperature checks, cleaning schedules and corrective actions.',
    gaps: 'Base layer built (Sept 2026) at /food-safety: temperature units with limits, a standard starting set (chillers 0–5°C, freezer ≤ −18°C, hot hold ≥ 63°C, cooking core ≥ 75°C, chilled deliveries ≤ 8°C), readings that cannot be saved out of range without a corrective action and raise a high-severity exception, and daily/weekly/monthly cleaning tasks with a due list. Still missing: no printable inspection report or export; units and tasks are per company, not yet per outlet in the UI (locationId exists but is not set); no reminders when a check is overdue; nothing yet for allergens, supplier approval, pest control or staff training records; expiry tracking still belongs in the stock ledger, which does not exist.',
    sections: [
      { label: 'Temperatures & cleaning', href: '/food-safety', module: 'food_safety' },
    ],
  },
]

export type ModuleAccessState = 'full' | 'partial' | 'locked' | 'not-built'

export interface ModuleAccess {
  state: ModuleAccessState
  visible: ModuleSection[]
  total: number
}

/**
 * Derive a module's state. Build state wins: a module with nothing wired up
 * reads 'not-built' for everyone, including the CEO — "you have permission to
 * a thing that doesn't exist" is not a useful message.
 *
 * `allowed === null` means unrestricted (a real CEO).
 */
export function moduleAccessFor(
  mod: AppModule,
  allowed: Set<ModuleId> | null,
): ModuleAccess {
  if (mod.sections.length === 0) {
    return { state: 'not-built', visible: [], total: 0 }
  }
  if (!allowed) {
    return { state: 'full', visible: mod.sections, total: mod.sections.length }
  }
  const gated = mod.sections.filter((s) => s.module)
  const grantedGated = gated.filter((s) => allowed.has(s.module!))
  if (grantedGated.length === 0) {
    return { state: 'locked', visible: [], total: mod.sections.length }
  }
  const visible = mod.sections.filter((s) => !s.module || allowed.has(s.module))
  return {
    state: grantedGated.length === gated.length ? 'full' : 'partial',
    visible,
    total: mod.sections.length,
  }
}

export function findModule(id: string): AppModule | undefined {
  return MODULE_CATALOG.find((m) => m.id === id)
}

/** Which module owns a path — drives the module-scoped sidebar. */
export function moduleForPath(pathname: string): AppModule | undefined {
  let best: AppModule | undefined
  let bestLen = -1
  for (const mod of MODULE_CATALOG) {
    for (const s of mod.sections) {
      if ((pathname === s.href || pathname.startsWith(s.href + '/')) && s.href.length > bestLen) {
        best = mod
        bestLen = s.href.length
      }
    }
  }
  return best
}
