// ─── Module catalogue ─────────────────────────────────────────────────────────
//
// The admin is organised as MODULES (workspaces) rather than one long sidebar
// tree. Login lands on /modules — a hub of every module in the system. A module
// is always visible and always clickable; what changes is what you get when you
// open it:
//
//   full     — you hold every permission inside it
//   partial  — you hold some; the module opens showing ONLY those sections
//   locked   — you hold none; the module opens to a "locked" explainer
//
// Two layers, deliberately:
//   • ModuleId (src/lib/appRoles.ts) = the fine-grained PERMISSION atom, and the
//     unit the CEO edits at /configuration/role-modules. ~61 of them.
//   • Module (this file)             = the coarse WORKSPACE a human navigates.
//
// Access is DERIVED, never stored: a module's state is computed from which of
// its sections' ModuleIds the viewer holds. That means the existing role→module
// map stays the single source of truth and nothing new has to be kept in sync.
//
// Categories:
//   'core'  — every business needs this (finance, people, procurement…)
//   'ours'  — specific to how we run (kitchen, storefront, service…)
//
// To reorganise the admin, edit THIS FILE. Moving a section between modules is
// a one-line change; no routing or permission work is involved.

import type { ModuleId } from './appRoles'

export interface ModuleSection {
  label: string
  href: string
  /** Permission atom gating this section. Omitted = visible to anyone who can
   *  open the module at all (e.g. a module's own landing page). */
  module?: ModuleId
  /** Short note shown under the section in the module view. */
  hint?: string
}

export interface AppModule {
  id: string
  name: string
  icon: string
  category: 'core' | 'ours'
  /** One line describing what the module is FOR — shown on the hub card. */
  blurb: string
  sections: ModuleSection[]
}

export const MODULE_CATALOG: AppModule[] = [
  // ══════════════════════════ CORE ══════════════════════════
  {
    id: 'finance',
    name: 'Finance',
    icon: '💰',
    category: 'core',
    blurb: 'P&L, the ledger, reconciliation and everything the accountant asks for.',
    sections: [
      { label: 'P&L',                 href: '/finance',                     module: 'finance_pl' },
      { label: 'Accounting',          href: '/accounting',                  module: 'accounting' },
      { label: 'P&L (ledger)',        href: '/accounting/pl-ledger',        module: 'accounting' },
      { label: 'Trial balance',       href: '/accounting/trial-balance',    module: 'accounting' },
      { label: 'Balance sheet',       href: '/accounting/balance-sheet',    module: 'accounting' },
      { label: 'Cash flow',           href: '/accounting/cash-flow',        module: 'accounting' },
      { label: 'AP aging',            href: '/accounting/ap-aging',         module: 'accounting' },
      { label: 'Period close',        href: '/accounting/period-close',     module: 'accounting' },
      { label: 'Sales tax return',    href: '/accounting/sales-tax-return', module: 'accounting' },
      { label: 'Allocations',         href: '/allocations',                 module: 'accounting' },
      { label: 'Reconciliation',      href: '/reconciliation',              module: 'reconciliation' },
      { label: 'Exceptions',          href: '/exceptions',                  module: 'exceptions' },
      { label: 'Gift cards',          href: '/gift-cards',                  module: 'gift_cards' },
      { label: 'Petty cash',          href: '/finance/petty-cash',          module: 'accounting' },
      { label: 'Deposit drops',       href: '/finance/deposit-drops',       module: 'accounting' },
      { label: 'Chart of accounts',   href: '/configuration/chart-of-accounts', module: 'accounting' },
      { label: 'Bank accounts',       href: '/configuration/bank-accounts',  module: 'accounting' },
      { label: 'Tax settings',        href: '/configuration/tax',            module: 'accounting' },
      { label: 'Audit log',           href: '/accounting/audit-log',         module: 'audit_log' },
    ],
  },
  {
    id: 'people',
    name: 'People',
    icon: '👥',
    category: 'core',
    blurb: 'Who works here, what they are paid, and when they are on.',
    sections: [
      { label: 'Staff directory',   href: '/workforce',                 module: 'staff_directory' },
      { label: 'Positions (budget)', href: '/workforce/positions',      module: 'staff_directory', hint: 'Budgeted seats — feeds projections' },
      { label: 'Scheduling',        href: '/scheduling',                module: 'scheduling' },
      { label: 'Payroll runs',      href: '/payroll',                   module: 'payroll' },
      { label: 'Tip pools',         href: '/tip-pools',                 module: 'payroll' },
      { label: 'Time clock',        href: '/time-clock',                module: 'staff_directory' },
      { label: 'Kitchen brigade',   href: '/kds/config',                module: 'kitchen_staff', hint: 'Separate roster — overlaps the staff directory' },
      { label: 'Staff meals',       href: '/staff-meals',               module: 'staff_directory' },
      { label: 'Pending signups',   href: '/configuration/pending-approvals', module: 'role_management' },
    ],
  },
  {
    id: 'procurement',
    name: 'Procurement & Inventory',
    icon: '📦',
    category: 'core',
    blurb: 'Suppliers, purchase orders, stock on hand and what to re-order.',
    sections: [
      { label: 'Procurement',       href: '/procurement',            module: 'procurement' },
      { label: 'Supplier chat',     href: '/procurement/chat',       module: 'procurement' },
      { label: 'Receiving',         href: '/procurement/receiving',  module: 'procurement' },
      { label: 'Monitor',           href: '/procurement/monitor',    module: 'procurement' },
      { label: 'Vendors (legacy)',  href: '/accounting/vendors',     module: 'procurement', hint: 'Duplicate of Procurement — candidate for removal' },
      { label: 'Inventory',         href: '/inventory',              module: 'inventory' },
      { label: 'Low stock alerts',  href: '/inventory/alerts',       module: 'inventory' },
      { label: 'Stock count',       href: '/inventory/count',        module: 'inventory' },
      { label: 'Prep',              href: '/inventory/prep',         module: 'inventory' },
      { label: 'Par sheet',         href: '/par-sheet',              module: 'par_sheet' },
      { label: 'Sourcing sheet',    href: '/sourcing',               module: 'inventory' },
    ],
  },
  {
    id: 'sales',
    name: 'Sales & Orders',
    icon: '🧾',
    category: 'core',
    blurb: 'Taking money: the till, live orders, and everything already sold.',
    sections: [
      { label: 'Point of Sale',   href: '/pos',            module: 'pos' },
      { label: 'Waiter mode',     href: '/pos/waiter',     module: 'pos' },
      { label: 'Shift / Till',    href: '/pos/shift',      module: 'pos' },
      { label: 'Orders (history)', href: '/orders',        module: 'orders' },
      { label: 'Refunds',         href: '/refunds',        module: 'refunds' },
      { label: 'Curbside',        href: '/orders/curbside', module: 'curbside' },
    ],
  },
  {
    id: 'customers',
    name: 'Customers',
    icon: '🧑‍🤝‍🧑',
    category: 'core',
    blurb: 'The guest list, what they said, and how they are treated.',
    sections: [
      { label: 'Customers',     href: '/customers',        module: 'crm' },
      { label: 'CRM',           href: '/crm',              module: 'crm' },
      { label: 'Conversations', href: '/crm/conversations', module: 'crm' },
      { label: 'Segments',      href: '/crm/segments',     module: 'crm' },
      { label: 'Naughty list',  href: '/crm/naughty-list', module: 'crm' },
      { label: 'Complaints',    href: '/complaints',       module: 'complaints' },
      { label: 'Reviews',       href: '/reviews',          module: 'reviews' },
      { label: 'Loyalty',       href: '/configuration/loyalty', module: 'crm' },
    ],
  },
  {
    id: 'growth',
    name: 'Marketing',
    icon: '📣',
    category: 'core',
    blurb: 'Campaigns, promos and the content calendar.',
    sections: [
      { label: 'Workspace',    href: '/marketing',           module: 'marketing_workspace' },
      { label: 'Activity log', href: '/marketing/activity',  module: 'marketing_workspace' },
      { label: 'Campaigns',    href: '/crm/campaigns',       module: 'campaigns' },
      { label: 'Content calendar', href: '/calendar',        module: 'calendar' },
      { label: 'Media',        href: '/media',               module: 'media' },
      { label: 'Promotions',   href: '/promos',              module: 'promos' },
      { label: 'Discounts',    href: '/discounts',           module: 'promos' },
      { label: 'QR codes',     href: '/qrcodes',             module: 'promos' },
    ],
  },
  {
    id: 'insight',
    name: 'Reports & Analytics',
    icon: '📊',
    category: 'core',
    blurb: 'Every dashboard and report, in one place instead of five.',
    sections: [
      { label: 'CEO overview',     href: '/dashboard/ceo',     module: 'ceo_overview' },
      { label: 'Live dashboard',   href: '/dashboard',         module: 'dashboard' },
      { label: 'Brand dashboard',  href: '/dashboard/brand',   module: 'brand_dashboard' },
      { label: 'F&B dashboard',    href: '/dashboard/fnb',     module: 'fnb_dashboard' },
      { label: 'Reports',          href: '/reports',           module: 'reports' },
      { label: 'Analytics',        href: '/analytics',         module: 'analytics' },
      { label: 'Demand forecast',  href: '/analytics/forecast', module: 'reports' },
      { label: 'Sales quadrants',  href: '/accounting/menu-engineering', module: 'accounting' },
      { label: 'Food cost',        href: '/accounting/food-cost', module: 'accounting' },
      { label: 'Chain rollup',     href: '/chain',             module: 'chain' },
    ],
  },
  {
    id: 'capital',
    name: 'Capital & Planning',
    icon: '🏗',
    category: 'core',
    blurb: 'Build costs, run-rate opex and the 12-month forecast.',
    sections: [
      { label: 'Capex',       href: '/finance/capex',          module: 'capital' },
      { label: 'OpEx',        href: '/finance/opex',           module: 'capital' },
      { label: 'Projections', href: '/finance/projections',    module: 'projections' },
      { label: 'Investment',  href: '/finance/capital-ledger', module: 'capital' },
    ],
  },
  {
    id: 'admin',
    name: 'Administration',
    icon: '⚙️',
    category: 'core',
    blurb: 'Company setup, access control and integrations.',
    sections: [
      { label: 'Business info',       href: '/business-info',                module: 'business_info' },
      { label: 'Tenants & brands',    href: '/settings',                     module: 'tenants' },
      { label: 'Locations',           href: '/configuration/locations',      module: 'business_info' },
      { label: 'Roles & permissions', href: '/configuration/roles',          module: 'role_management' },
      { label: 'Module access',       href: '/configuration/role-modules',   module: 'role_modules' },
      { label: 'Integrations',        href: '/settings/integrations',        module: 'integrations' },
      { label: 'Notifications',       href: '/notifications',                module: 'notifications' },
      { label: 'Domains',             href: '/configuration/domains',        module: 'tenants' },
      { label: 'Operations config',   href: '/configuration/operations',     module: 'business_info' },
      { label: 'Audit log',           href: '/configuration/audit-log',      module: 'audit_log' },
      { label: 'Backup',              href: '/configuration/backup',         module: 'business_info' },
      { label: 'Help & support',      href: '/help' },
    ],
  },

  // ══════════════════════════ OURS ══════════════════════════
  {
    id: 'kitchen',
    name: 'Kitchen',
    icon: '🍳',
    category: 'ours',
    blurb: 'The pass, the stations, and the recipes behind them.',
    sections: [
      { label: 'Ops Center',    href: '/ops',           module: 'ops' },
      { label: 'Expo station',  href: '/expo',          module: 'expo_station' },
      { label: 'Kitchen view',  href: '/kds',           module: 'kds_dashboard' },
      { label: 'All orders',    href: '/kds/all',       module: 'kds_all' },
      { label: 'KDS config',    href: '/kds/config',    module: 'kds_config' },
      { label: 'Recipes',       href: '/accounting/recipes', module: 'recipes' },
      { label: 'Recipe approvals', href: '/accounting/recipes/approvals', module: 'recipes' },
      { label: 'Menu engineering', href: '/menu-engineering', module: 'recipes', hint: 'Plate costing + pricing' },
    ],
  },
  {
    id: 'menu',
    name: 'Menu',
    icon: '📖',
    category: 'ours',
    blurb: 'What is on sale, how it is described and what it costs.',
    sections: [
      { label: 'Menu',          href: '/menu',                        module: 'menu' },
      { label: 'Modifiers',     href: '/configuration/modifiers',     module: 'menu' },
      { label: 'Dietary tags',  href: '/configuration/dietary-tags',  module: 'menu' },
    ],
  },
  {
    id: 'service',
    name: 'Service & Floor',
    icon: '🍽',
    category: 'ours',
    blurb: 'Bookings, the floor plan, and getting food out the door.',
    sections: [
      { label: 'Reservations',       href: '/reservations',            module: 'reservations' },
      { label: 'Week view',          href: '/reservations/week',       module: 'reservations' },
      { label: 'Closures',           href: '/reservations/blockouts',  module: 'reservations_admin' },
      { label: 'Service hours',      href: '/reservations/hours',      module: 'reservations_admin' },
      { label: 'Reservation analytics', href: '/reservations/analytics', module: 'reservations_admin' },
      { label: 'Floor plan',         href: '/tables',                  module: 'tables' },
      { label: 'Dispatch',           href: '/dispatch',                module: 'dispatch' },
      { label: 'Riders',             href: '/riders',                  module: 'riders', hint: 'API exists; rider app not built' },
    ],
  },
  {
    id: 'storefront',
    name: 'Storefront & Brands',
    icon: '🎨',
    category: 'ours',
    blurb: 'The customer-facing site: brand looks, pages and layout.',
    sections: [
      { label: 'Brands',        href: '/marketing/brands',    module: 'brands' },
      { label: 'Visual layout', href: '/storefront',          module: 'brands' },
      { label: 'Designer hub',  href: '/marketing/storefront', module: 'brands' },
      { label: 'Landing hero',  href: '/storefront-hero',     module: 'brands' },
      { label: 'Brand footers', href: '/storefront-footer',   module: 'brands' },
      { label: 'Content pages', href: '/content',             module: 'brands' },
      { label: 'Brand identity', href: '/configuration/brand-identity', module: 'brands' },
      { label: 'Brand assets',  href: '/configuration/brand-assets',    module: 'brands' },
    ],
  },
]

export type ModuleAccessState = 'full' | 'partial' | 'locked'

export interface ModuleAccess {
  state: ModuleAccessState
  /** Sections the viewer may actually open. */
  visible: ModuleSection[]
  /** How many sections exist in total (visible + withheld). */
  total: number
}

/**
 * Derive a module's access state from the permission atoms the viewer holds.
 *
 * `allowed === null` means "no restriction" (a real CEO) — everything is full.
 * Sections with no `module` are always visible, but they do NOT by themselves
 * unlock a module: a module whose only reachable section is un-gated still
 * counts as locked, otherwise every module would look partially open.
 */
export function moduleAccessFor(
  mod: AppModule,
  allowed: Set<ModuleId> | null,
): ModuleAccess {
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

/** Which module owns a given path — used to show module context in the header. */
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
