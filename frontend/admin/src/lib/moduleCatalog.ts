// ─── Module catalogue ─────────────────────────────────────────────────────────
//
// Structured to the operator's ERP reference model:
//
//   A. Universal core (15)      — any business model needs these
//   B. Restaurant layer (16)    — specific to running food service
//
// Four of the core modules are PLATFORM INFRASTRUCTURE (identity, master data,
// stock ledger, approvals). Everything else is CRUD on top of them, so they are
// flagged and should be built properly once rather than re-implemented per area.
//
// Every module is always listed on /modules, whatever your role. Two orthogonal
// dimensions decide what you see:
//
//   BUILD STATE  — does this exist in servd yet?
//     built       some sections are wired up
//     not-built   nothing exists; the card states the gap
//
//   ACCESS STATE — derived from the permission atoms your role holds
//     full        you hold every atom in the module
//     partial     you hold some; the module opens showing ONLY those
//     locked      you hold none
//
// Access is DERIVED, never stored, so the existing role→module map at
// /configuration/role-modules stays the single source of truth.
//
// `gaps` is the honest note about what is missing or duplicated inside a
// module. It is written to be read by the operator, not by code — this file
// doubles as the redundancy/gap register.

import type { ModuleId } from './appRoles'

export interface ModuleSection {
  label: string
  href: string
  /** Permission atom gating this section. Omitted = ungated. */
  module?: ModuleId
  /** Short note shown under the section — flags duplicates and caveats. */
  hint?: string
}

export interface AppModule {
  id: string
  /** Position in the operator's reference list, e.g. "A3" / "B7". */
  ref: string
  name: string
  icon: string
  category: 'core' | 'restaurant'
  blurb: string
  /** Identity, master data, stock ledger, approvals — build once, properly. */
  platform?: boolean
  /** What is missing, duplicated or unreliable here. Shown in the module view. */
  gaps?: string
  sections: ModuleSection[]
}

export const MODULE_CATALOG: AppModule[] = [
  // ═════════════════════ A. UNIVERSAL CORE ═════════════════════
  {
    id: 'identity', ref: 'A1', name: 'Identity & Access', icon: '🔐',
    category: 'core', platform: true,
    blurb: 'Users, roles, permissions and the audit trail.',
    gaps: 'Two separate audit-log surfaces (/accounting/audit-log and /configuration/audit-log) read the same tenant-less AuditLog table.',
    sections: [
      { label: 'Staff directory',     href: '/workforce',                       module: 'staff_directory' },
      { label: 'Roles & permissions', href: '/configuration/roles',             module: 'role_management' },
      { label: 'Module access',       href: '/configuration/role-modules',      module: 'role_modules' },
      { label: 'Pending signups',     href: '/configuration/pending-approvals', module: 'role_management' },
      { label: 'Audit log',           href: '/configuration/audit-log',         module: 'audit_log' },
      { label: 'Audit log (accounting)', href: '/accounting/audit-log',         module: 'audit_log', hint: 'Duplicate surface — same table' },
    ],
  },
  {
    id: 'master-data', ref: 'A2', name: 'Master Data', icon: '🗃',
    category: 'core', platform: true,
    blurb: 'Items, vendors, customers, locations, units, tax codes — one source of truth.',
    gaps: 'No single master-data surface exists. Each entity is edited inside whichever module happens to use it, and there are three unlinked people models (User / Position / KitchenStaff).',
    sections: [
      { label: 'Menu items',      href: '/menu',                       module: 'menu' },
      { label: 'Inventory items', href: '/inventory',                  module: 'inventory' },
      { label: 'Vendors',         href: '/procurement',                module: 'procurement' },
      { label: 'Customers',       href: '/customers',                  module: 'crm' },
      { label: 'Locations',       href: '/configuration/locations',    module: 'business_info' },
      { label: 'Tax codes',       href: '/configuration/tax',          module: 'accounting' },
      { label: 'Modifiers',       href: '/configuration/modifiers',    module: 'menu' },
      { label: 'Dietary tags',    href: '/configuration/dietary-tags', module: 'menu' },
    ],
  },
  {
    id: 'gl', ref: 'A3', name: 'General Ledger', icon: '📒',
    category: 'core',
    blurb: 'Chart of accounts, journals, period close, multi-entity.',
    gaps: 'Two parallel sets of books: /finance reads FinancialEntry, the ledger reports read JournalLine. Both are written live. Multi-currency is not implemented.',
    sections: [
      { label: 'Accounting',        href: '/accounting',                      module: 'accounting' },
      { label: 'P&L (ledger)',      href: '/accounting/pl-ledger',            module: 'accounting' },
      { label: 'P&L (entries)',     href: '/finance',                         module: 'finance_pl', hint: 'Second P&L — different source data' },
      { label: 'Trial balance',     href: '/accounting/trial-balance',        module: 'accounting' },
      { label: 'Balance sheet',     href: '/accounting/balance-sheet',        module: 'accounting' },
      { label: 'Period close',      href: '/accounting/period-close',         module: 'accounting' },
      { label: 'Period locks',      href: '/configuration/period-locks',      module: 'accounting' },
      { label: 'Chart of accounts', href: '/configuration/chart-of-accounts', module: 'accounting' },
      { label: 'Allocations',       href: '/allocations',                     module: 'accounting' },
      { label: 'Entities / brands', href: '/settings',                        module: 'tenants' },
    ],
  },
  {
    id: 'ap', ref: 'A4', name: 'Accounts Payable', icon: '📤',
    category: 'core',
    blurb: 'Vendor bills, aging, payment runs, withholding.',
    gaps: 'Aging exists; there is no payment-run workflow and no withholding-certificate handling.',
    sections: [
      { label: 'AP aging',        href: '/accounting/ap-aging',   module: 'accounting' },
      { label: 'Supplier bills',  href: '/procurement',           module: 'procurement' },
    ],
  },
  {
    id: 'ar', ref: 'A5', name: 'Accounts Receivable', icon: '📥',
    category: 'core',
    blurb: 'Invoicing, receipts, credit limits, aging.',
    gaps: 'Mostly missing. An invoices API exists with no admin surface; no AR aging, no credit limits. Fine while every sale is settled at the till — needed the moment you invoice corporate accounts.',
    sections: [],
  },
  {
    id: 'cash', ref: 'A6', name: 'Cash & Bank', icon: '🏦',
    category: 'core',
    blurb: 'Bank reconciliation, petty cash, treasury position.',
    sections: [
      { label: 'Reconciliation',  href: '/reconciliation',            module: 'reconciliation' },
      { label: 'Cash flow',       href: '/accounting/cash-flow',      module: 'accounting' },
      { label: 'Petty cash',      href: '/finance/petty-cash',        module: 'accounting' },
      { label: 'Deposit drops',   href: '/finance/deposit-drops',     module: 'accounting' },
      { label: 'Bank accounts',   href: '/configuration/bank-accounts', module: 'accounting' },
      { label: 'Exceptions',      href: '/exceptions',                module: 'exceptions' },
    ],
  },
  {
    id: 'procurement', ref: 'A7', name: 'Procurement', icon: '📦',
    category: 'core',
    blurb: 'Requisition → PO → GRN → 3-way match.',
    gaps: 'Two complete supplier/PO implementations on the same tables (/procurement and the legacy /accounting/vendors). No requisition step, and no true 3-way match.',
    sections: [
      { label: 'Purchase orders', href: '/procurement',            module: 'procurement' },
      { label: 'Receiving (GRN)', href: '/procurement/receiving',  module: 'procurement' },
      { label: 'Supplier chat',   href: '/procurement/chat',       module: 'procurement' },
      { label: 'Monitor',         href: '/procurement/monitor',    module: 'procurement' },
      { label: 'Vendors (legacy)', href: '/accounting/vendors',    module: 'procurement', hint: 'Duplicate of this module — candidate for removal' },
      { label: 'Sourcing sheet',  href: '/sourcing',               module: 'inventory' },
    ],
  },
  {
    id: 'stock', ref: 'A8', name: 'Inventory / Stock Ledger', icon: '📊',
    category: 'core', platform: true,
    blurb: 'Movements, valuation, transfers, counts, variance posting.',
    gaps: 'Valuation is weighted-average on receipt; there is no FIFO option and no formal variance posting from counts back to the GL.',
    sections: [
      { label: 'Inventory',      href: '/inventory',        module: 'inventory' },
      { label: 'Stock count',    href: '/inventory/count',  module: 'inventory' },
      { label: 'Low stock',      href: '/inventory/alerts', module: 'inventory' },
      { label: 'Par sheet',      href: '/par-sheet',        module: 'par_sheet' },
    ],
  },
  {
    id: 'sales', ref: 'A9', name: 'Sales & Order Management', icon: '🧾',
    category: 'core',
    blurb: 'Quote → order → fulfilment → invoice, channel-agnostic.',
    sections: [
      { label: 'Orders',   href: '/orders',          module: 'orders' },
      { label: 'Refunds',  href: '/refunds',         module: 'refunds' },
      { label: 'Curbside', href: '/orders/curbside', module: 'curbside' },
    ],
  },
  {
    id: 'tax', ref: 'A10', name: 'Tax & Statutory', icon: '🏛',
    category: 'core',
    blurb: 'FBR / SRB filings, sales tax, withholding certificates.',
    gaps: 'Sales-tax return and FBR submission exist. No withholding certificates.',
    sections: [
      { label: 'Sales tax return', href: '/accounting/sales-tax-return', module: 'accounting' },
      { label: 'Tax settings',     href: '/configuration/tax',           module: 'accounting' },
    ],
  },
  {
    id: 'hr', ref: 'A11', name: 'HR & Payroll', icon: '👥',
    category: 'core',
    blurb: 'Attendance, leave, payroll, statutory deductions.',
    gaps: 'No leave management. Payroll posts gross rather than net, so deductions never reach the bank leg. Kitchen brigade is a second staff roster with no link to user accounts.',
    sections: [
      { label: 'Staff directory',    href: '/workforce',           module: 'staff_directory' },
      { label: 'Positions (budget)', href: '/workforce/positions', module: 'staff_directory' },
      { label: 'Payroll runs',       href: '/payroll',             module: 'payroll' },
      { label: 'Tip pools',          href: '/tip-pools',           module: 'payroll' },
      { label: 'Time clock',         href: '/time-clock',          module: 'staff_directory' },
      { label: 'Kitchen brigade',    href: '/kds/config',          module: 'kitchen_staff', hint: 'Separate roster — not linked to user accounts' },
    ],
  },
  {
    id: 'assets', ref: 'A12', name: 'Fixed Assets', icon: '🏭',
    category: 'core',
    blurb: 'Asset register, depreciation schedules, disposals.',
    gaps: 'Not built. Capex tracks project spend but there is no asset register, no depreciation schedule and no disposals — so the balance sheet carries no depreciating asset base.',
    sections: [],
  },
  {
    id: 'approvals', ref: 'A13', name: 'Approvals & Workflow', icon: '✅',
    category: 'core', platform: true,
    blurb: 'Thresholds and delegation as one horizontal service.',
    gaps: 'Exists only as per-area bolt-ons: recipes, purchase orders, payroll and signups each implement their own approval. No thresholds, no delegation, no single queue. This is the platform service that should replace all of them.',
    sections: [
      { label: 'Recipe approvals', href: '/accounting/recipes/approvals',    module: 'recipes' },
      { label: 'Pending signups',  href: '/configuration/pending-approvals', module: 'role_management' },
    ],
  },
  {
    id: 'bi', ref: 'A14', name: 'Reporting & BI', icon: '📈',
    category: 'core',
    blurb: 'P&L, balance sheet, cash flow, plus operational dashboards.',
    gaps: 'Five separate role dashboards (CEO, Brand, F&B, BOH, FOH) plus a live dashboard — heavy for the current headcount.',
    sections: [
      { label: 'Reports',         href: '/reports',            module: 'reports' },
      { label: 'Analytics',       href: '/analytics',          module: 'analytics' },
      { label: 'CEO overview',    href: '/dashboard/ceo',      module: 'ceo_overview' },
      { label: 'Live dashboard',  href: '/dashboard',          module: 'dashboard' },
      { label: 'Brand dashboard', href: '/dashboard/brand',    module: 'brand_dashboard' },
      { label: 'F&B dashboard',   href: '/dashboard/fnb',      module: 'fnb_dashboard' },
      { label: 'Demand forecast', href: '/analytics/forecast', module: 'reports' },
      { label: 'Chain rollup',    href: '/chain',              module: 'chain' },
    ],
  },
  {
    id: 'integration', ref: 'A15', name: 'Integration Layer', icon: '🔌',
    category: 'core',
    blurb: 'APIs, webhooks, import/export, document attachments.',
    sections: [
      { label: 'Integrations',  href: '/settings/integrations',   module: 'integrations' },
      { label: 'Webhooks',      href: '/configuration/webhooks',  module: 'integrations' },
      { label: 'Notifications', href: '/notifications',           module: 'notifications' },
      { label: 'Media / files', href: '/media',                   module: 'media' },
      { label: 'Backup',        href: '/configuration/backup',    module: 'business_info' },
      { label: 'Domains',       href: '/configuration/domains',   module: 'tenants' },
    ],
  },

  // ═════════════════════ B. RESTAURANT LAYER ═════════════════════
  {
    id: 'pos', ref: 'B1', name: 'POS / Order Capture', icon: '💳',
    category: 'restaurant',
    blurb: 'Dine-in, counter and online capture; tables, split bills, routing.',
    sections: [
      { label: 'Point of Sale', href: '/pos',        module: 'pos' },
      { label: 'Waiter mode',   href: '/pos/waiter', module: 'pos' },
      { label: 'Floor plan',    href: '/tables',     module: 'tables' },
    ],
  },
  {
    id: 'menu-eng', ref: 'B2', name: 'Menu Engineering', icon: '📖',
    category: 'restaurant',
    blurb: 'Recipes as multi-level BOM, modifiers, combos, channel pricing.',
    gaps: 'Multi-level BOM works (components nest). No combos, and no channel-specific pricing — one price per item across every channel.',
    sections: [
      { label: 'Menu',             href: '/menu',                        module: 'menu' },
      { label: 'Pricing workspace', href: '/menu-engineering',           module: 'recipes' },
      { label: 'Sales quadrants',  href: '/accounting/menu-engineering', module: 'accounting' },
      { label: 'Modifiers',        href: '/configuration/modifiers',     module: 'menu' },
    ],
  },
  {
    id: 'costing', ref: 'B3', name: 'Recipe Costing & Variance', icon: '🎯',
    category: 'restaurant',
    blurb: 'Theoretical vs actual cost — the differentiator.',
    gaps: 'Theoretical costing is solid. Actual-vs-theoretical variance is only approximated against purchases, not against measured stock movements, so the number is indicative rather than trustworthy. Depends on clean master data (A2) and stock ledger (A8).',
    sections: [
      { label: 'Recipes',    href: '/accounting/recipes',   module: 'recipes' },
      { label: 'Food cost',  href: '/accounting/food-cost', module: 'accounting' },
      { label: 'Plate pricing', href: '/menu-engineering',  module: 'recipes' },
    ],
  },
  {
    id: 'kds', ref: 'B4', name: 'KDS', icon: '🍳',
    category: 'restaurant',
    blurb: 'Ticket routing, fire times, course pacing.',
    sections: [
      { label: 'Kitchen view', href: '/kds',         module: 'kds_dashboard' },
      { label: 'All orders',   href: '/kds/all',     module: 'kds_all' },
      { label: 'Expo station', href: '/expo',        module: 'expo_station' },
      { label: 'KDS config',   href: '/kds/config',  module: 'kds_config' },
      { label: 'Ops centre',   href: '/ops',         module: 'ops' },
    ],
  },
  {
    id: 'commissary', ref: 'B5', name: 'Commissary / Production', icon: '🏗',
    category: 'restaurant',
    blurb: 'Batch prep, yield factors, inter-outlet transfers at cost.',
    gaps: 'Batch prep and yield factors exist inside recipes. Inter-outlet transfers at cost are not wired to the stock ledger, so a transfer does not move value between brands.',
    sections: [
      { label: 'Prep',      href: '/inventory/prep', module: 'inventory' },
      { label: 'Par sheet', href: '/par-sheet',      module: 'par_sheet' },
    ],
  },
  {
    id: 'perishables', ref: 'B6', name: 'Perishable Controls', icon: '🧊',
    category: 'restaurant',
    blurb: 'Par levels, daily indent, expiry / FIFO, spot counts by station.',
    gaps: 'Par levels and counts exist. No expiry tracking, no FIFO, and counts are not station-scoped.',
    sections: [
      { label: 'Par sheet',   href: '/par-sheet',        module: 'par_sheet' },
      { label: 'Stock count', href: '/inventory/count',  module: 'inventory' },
      { label: 'Low stock',   href: '/inventory/alerts', module: 'inventory' },
    ],
  },
  {
    id: 'variance', ref: 'B7', name: 'Waste, Void, Comp & Staff Meals', icon: '🗑',
    category: 'restaurant',
    blurb: 'The four buckets that explain most of your variance.',
    gaps: 'All four are captured but in four different places, with no combined variance view. Voids and comps live inside orders and are only visible via the Z-report, which currently signs refunds the wrong way.',
    sections: [
      { label: 'Waste log',   href: '/inventory',   module: 'inventory' },
      { label: 'Staff meals', href: '/staff-meals', module: 'staff_directory' },
      { label: 'Refunds / voids', href: '/refunds', module: 'refunds' },
    ],
  },
  {
    id: 'shift', ref: 'B8', name: 'Shift Management', icon: '🕗',
    category: 'restaurant',
    blurb: 'Cash-up, drawer variance, Z-reads, handover.',
    gaps: 'The Z-report subtracts refunds that are already stored negative, overstating net revenue and showing a false cash shortage.',
    sections: [
      { label: 'Shift / till',   href: '/pos/shift',             module: 'pos' },
      { label: 'Deposit drops',  href: '/finance/deposit-drops', module: 'accounting' },
      { label: 'Reconciliation', href: '/reconciliation',        module: 'reconciliation' },
    ],
  },
  {
    id: 'labor', ref: 'B9', name: 'Labour vs Forecast', icon: '📅',
    category: 'restaurant',
    blurb: 'Rostering against hourly covers, live labour-cost %.',
    gaps: 'Scheduling and demand forecast both exist but are not joined — you cannot roster against forecast covers or see a live labour-cost % against sales.',
    sections: [
      { label: 'Scheduling',      href: '/scheduling',         module: 'scheduling' },
      { label: 'Demand forecast', href: '/analytics/forecast', module: 'reports' },
    ],
  },
  {
    id: 'fiscal', ref: 'B10', name: 'Fiscal / SRB SDC', icon: '🧾',
    category: 'restaurant',
    blurb: 'Real-time invoice reporting to the revenue authority.',
    sections: [
      { label: 'FBR / PRAL setup', href: '/settings/integrations',       module: 'integrations' },
      { label: 'Sales tax return', href: '/accounting/sales-tax-return', module: 'accounting' },
    ],
  },
  {
    id: 'channels', ref: 'B11', name: 'Channel Reconciliation', icon: '🔀',
    category: 'restaurant',
    blurb: 'Payout vs order-level revenue across your own channels.',
    gaps: 'Third-party aggregators are excluded by standing policy — GS Foods runs its own fleet — so this covers storefront, POS and app only. Per-channel payout reconciliation is not built.',
    sections: [
      { label: 'Orders by source', href: '/reports',        module: 'reports' },
      { label: 'Reconciliation',   href: '/reconciliation', module: 'reconciliation' },
    ],
  },
  {
    id: 'crm', ref: 'B12', name: 'CRM & Loyalty', icon: '🧑‍🤝‍🧑',
    category: 'restaurant',
    blurb: 'Customer identity across counter, app and web.',
    sections: [
      { label: 'Customers',     href: '/customers',             module: 'crm' },
      { label: 'CRM',           href: '/crm',                   module: 'crm' },
      { label: 'Conversations', href: '/crm/conversations',     module: 'crm' },
      { label: 'Segments',      href: '/crm/segments',          module: 'crm' },
      { label: 'Loyalty',       href: '/configuration/loyalty', module: 'crm' },
      { label: 'Gift cards',    href: '/gift-cards',            module: 'gift_cards' },
      { label: 'Complaints',    href: '/complaints',            module: 'complaints' },
      { label: 'Reviews',       href: '/reviews',               module: 'reviews' },
    ],
  },
  {
    id: 'reservations', ref: 'B13', name: 'Reservations & Table State', icon: '🍽',
    category: 'restaurant',
    blurb: 'Bookings and live table state — relevant to Simmer, not to counter formats.',
    sections: [
      { label: 'Reservations',  href: '/reservations',            module: 'reservations' },
      { label: 'Week view',     href: '/reservations/week',       module: 'reservations' },
      { label: 'Closures',      href: '/reservations/blockouts',  module: 'reservations_admin' },
      { label: 'Service hours', href: '/reservations/hours',      module: 'reservations_admin' },
      { label: 'Analytics',     href: '/reservations/analytics',  module: 'reservations_admin' },
      { label: 'Floor plan',    href: '/tables',                  module: 'tables' },
    ],
  },
  {
    id: 'haccp', ref: 'B14', name: 'Food Safety / HACCP', icon: '🌡',
    category: 'restaurant',
    blurb: 'Temperature logs, cleaning schedules, expiry checks.',
    gaps: 'Not built. No temperature logs, cleaning schedules or corrective-action records — the usual first request in a health inspection.',
    sections: [],
  },
  {
    id: 'multi-outlet', ref: 'B15', name: 'Multi-outlet / Franchise', icon: '🏢',
    category: 'restaurant',
    blurb: 'Outlet P&L, transfer pricing, central-vs-outlet permissions.',
    gaps: 'Per-brand P&L and tenant scoping work. Transfer pricing between outlets is not implemented, and the ledger-based reports are group-wide with no per-entity split.',
    sections: [
      { label: 'Tenants & brands', href: '/settings',     module: 'tenants' },
      { label: 'Chain rollup',     href: '/chain',        module: 'chain' },
      { label: 'Allocations',      href: '/allocations',  module: 'accounting' },
    ],
  },
  {
    id: 'marketing', ref: 'B16', name: 'Marketing & Attribution', icon: '📣',
    category: 'restaurant',
    blurb: 'Campaigns, promos, content, and what they actually drove.',
    gaps: 'Campaign and promo execution is built; attribution back to revenue is not — you cannot yet say which campaign produced which orders.',
    sections: [
      { label: 'Workspace',    href: '/marketing',          module: 'marketing_workspace' },
      { label: 'Campaigns',    href: '/crm/campaigns',      module: 'campaigns' },
      { label: 'Promotions',   href: '/promos',             module: 'promos' },
      { label: 'Discounts',    href: '/discounts',          module: 'promos' },
      { label: 'QR codes',     href: '/qrcodes',            module: 'promos' },
      { label: 'Calendar',     href: '/calendar',           module: 'calendar' },
      { label: 'Activity log', href: '/marketing/activity', module: 'marketing_workspace' },
      { label: 'Brands & storefront', href: '/marketing/brands', module: 'brands' },
      { label: 'Visual layout',   href: '/storefront',        module: 'brands' },
      { label: 'Landing hero',    href: '/storefront-hero',   module: 'brands' },
      { label: 'Brand footers',   href: '/storefront-footer', module: 'brands' },
      { label: 'Content pages',   href: '/content',           module: 'brands' },
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
