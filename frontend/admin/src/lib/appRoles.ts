/**
 * Roles & module-visibility — single source of truth.
 *
 * Two layers:
 *  1. `APP_ROLES`        – every role the operator can assign / impersonate.
 *  2. `DEFAULT_MODULE_ACCESS` – which sidebar modules each role sees by default.
 *                              The admin can edit these in /configuration/role-modules
 *                              and the override is persisted in localStorage (zustand).
 *
 * Every nav item in AppShell is tagged with a `module` ID drawn from this list,
 * so the same identifier flows through sidebar filtering + the admin editor.
 */

// The platform superuser is the CEO. We deliberately don't expose a separate
// "admin" surface — for a single-tenant restaurant operator the founder *is*
// the admin. The backend's UserRole.admin enum value remains; only the label
// changes here so the UI reads as "CEO" everywhere.
export type AppRole =
  | 'admin'             // backend value — displayed as "CEO"
  | 'management'
  | 'foh_management'
  | 'boh_management'
  | 'foh'
  | 'boh'
  | 'kitchen'
  | 'expediter'
  | 'cashier'
  | 'procurement'
  | 'marketing'
  | 'finance'
  | 'hr'

export interface RoleMeta {
  value: AppRole
  label: string
  emoji: string
  description: string
  /** Real CEO always retains everything; flag is used to gate the switcher self-selection. */
  isSuperuser?: boolean
}

export const APP_ROLES: RoleMeta[] = [
  { value: 'admin',           label: 'CEO',              emoji: '👑',  description: 'Founder / owner — always has every permission', isSuperuser: true },
  { value: 'management',      label: 'Management',       emoji: '🧑‍💼', description: 'GM / day-to-day operator — full ops + finance, no platform' },
  { value: 'foh_management',  label: 'FOH Management',   emoji: '🎩',  description: 'Floor manager — service, dispatch, reservations, complaints' },
  { value: 'boh_management',  label: 'BOH Management',   emoji: '👨‍🍳', description: 'Head chef — kitchen, inventory, recipes, brigade' },
  { value: 'foh',             label: 'FOH (Front)',      emoji: '💁',  description: 'Servers / hosts — POS, reservations, floor plan' },
  { value: 'boh',             label: 'BOH (Back)',       emoji: '🍳',  description: 'Line cooks / prep — KDS station, inventory consumption' },
  { value: 'kitchen',         label: 'Kitchen (Line)',   emoji: '🔥',  description: 'Single-station KDS view only' },
  { value: 'expediter',       label: 'Expediter',        emoji: '🪧',  description: 'Pass / quality check — all-orders KDS view' },
  { value: 'cashier',         label: 'Cashier',          emoji: '💳',  description: 'POS + curbside + basic dashboard' },
  { value: 'procurement',     label: 'Procurement',      emoji: '🏭',  description: 'Supplier chat, POs, inventory receipt' },
  { value: 'marketing',       label: 'Marketing',        emoji: '🚀',  description: 'CRM, campaigns, reviews, complaints, content' },
  { value: 'finance',         label: 'Finance',          emoji: '💰',  description: 'P&L, payroll, accounting, reconciliation' },
  { value: 'hr',              label: 'HR / Workforce',   emoji: '👥',  description: 'Staff records, attendance, payroll, scheduling' },
]

/** Display label for any role string the backend returns. Maps admin → CEO. */
export function roleLabel(role: string | undefined | null): string {
  if (!role) return ''
  const meta = APP_ROLES.find((r) => r.value === role)
  if (meta) return meta.label
  // Fallback: title-case the raw value
  return role.charAt(0).toUpperCase() + role.slice(1)
}

/** Module IDs — must match the `module` tag on every nav item in AppShell. */
export type ModuleId =
  // Executive (CEO only by default)
  | 'ceo_overview' | 'role_management' | 'role_modules' | 'audit_log' | 'tenants'
  // Live
  | 'dashboard' | 'ops' | 'orders' | 'refunds' | 'curbside' | 'kds_all' | 'kds_dashboard' | 'expo_station' | 'chain'
  // Service
  | 'pos' | 'reservations' | 'reservations_admin' | 'scheduling' | 'tables' | 'dispatch' | 'riders'
  // Kitchen
  | 'menu' | 'components' | 'recipes' | 'inventory' | 'kds_config' | 'par_sheet'
  // Marketing
  | 'marketing_workspace' | 'crm' | 'campaigns' | 'complaints' | 'reviews' | 'calendar' | 'media' | 'promos' | 'brands' | 'analytics'
  // Finance
  | 'finance_pl' | 'payroll' | 'accounting' | 'gift_cards' | 'reconciliation' | 'exceptions' | 'capital' | 'projections' | 'procurement' | 'reports'
  // Workforce — `staff_directory` is the unified hub; the per-category ids
  // gate the sidebar deep-links so the CEO can hide a whole category from a
  // role without losing the directory itself.
  | 'staff_directory'
  | 'staff_management'
  | 'staff_foh'
  | 'staff_boh'
  | 'staff_procurement'
  | 'staff_marketing'
  | 'staff_finance'
  | 'staff_hr'
  | 'kitchen_staff'
  // Setup
  | 'settings'  | 'notifications' | 'help' | 'configuration' | 'onboarding'

export interface ModuleMeta {
  id: ModuleId
  label: string
  /** Which top-level NAV section this lives in — used by the editor UI to group items */
  section: 'Executive' | 'Live' | 'Service' | 'Kitchen' | 'Marketing' | 'Finance' | 'Workforce' | 'Setup'
}

export const MODULES: ModuleMeta[] = [
  { id: 'ceo_overview',       label: 'CEO Overview',        section: 'Executive' },
  { id: 'role_management',    label: 'Roles & Permissions', section: 'Executive' },
  { id: 'role_modules',       label: 'Module Access',       section: 'Executive' },
  { id: 'audit_log',          label: 'Audit Log',           section: 'Executive' },
  { id: 'tenants',            label: 'Tenants / Brands',    section: 'Executive' },

  { id: 'dashboard',          label: 'Dashboard',           section: 'Live' },
  { id: 'ops',                label: 'Ops Center',          section: 'Live' },
  { id: 'orders',             label: 'Orders',              section: 'Live' },
  { id: 'refunds',            label: 'Refunds',             section: 'Live' },
  { id: 'curbside',           label: 'Curbside',            section: 'Live' },
  { id: 'kds_all',            label: 'KDS — All Orders',    section: 'Live' },
  { id: 'kds_dashboard',      label: 'Kitchen view',        section: 'Live' },
  { id: 'expo_station',       label: 'Expo Station',        section: 'Live' },
  { id: 'chain',              label: 'Chain Rollup',        section: 'Live' },

  { id: 'pos',                label: 'Point of Sale',       section: 'Service' },
  { id: 'reservations',       label: 'Reservations',        section: 'Service' },
  { id: 'reservations_admin', label: 'Reservation Admin',   section: 'Service' },
  { id: 'scheduling',         label: 'Scheduling',          section: 'Service' },
  { id: 'tables',             label: 'Floor Plan',          section: 'Service' },
  { id: 'dispatch',           label: 'Dispatch',            section: 'Service' },
  { id: 'riders',             label: 'Riders',              section: 'Service' },

  { id: 'menu',               label: 'Menu',                section: 'Kitchen' },
  { id: 'components',         label: 'Components',          section: 'Kitchen' },
  { id: 'recipes',            label: 'Recipes',             section: 'Kitchen' },
  { id: 'inventory',          label: 'Inventory',           section: 'Kitchen' },
  { id: 'par_sheet',          label: 'Par Sheet',           section: 'Kitchen' },
  { id: 'kds_config',         label: 'KDS Config',          section: 'Kitchen' },

  { id: 'marketing_workspace', label: 'Marketing Workspace', section: 'Marketing' },
  { id: 'crm',                label: 'CRM',                 section: 'Marketing' },
  { id: 'campaigns',          label: 'Campaigns',           section: 'Marketing' },
  { id: 'complaints',         label: 'Complaints',          section: 'Marketing' },
  { id: 'reviews',            label: 'Reviews',             section: 'Marketing' },
  { id: 'calendar',           label: 'Content Calendar',    section: 'Marketing' },
  { id: 'media',              label: 'Media',               section: 'Marketing' },
  { id: 'promos',             label: 'Promotions',          section: 'Marketing' },
  { id: 'brands',             label: 'Brands & Storefront', section: 'Marketing' },
  { id: 'analytics',          label: 'Analytics',           section: 'Marketing' },

  { id: 'finance_pl',         label: 'P&L',                 section: 'Finance' },
  { id: 'payroll',            label: 'Payroll',             section: 'Finance' },
  { id: 'accounting',         label: 'Accounting',          section: 'Finance' },
  { id: 'gift_cards',         label: 'Gift Cards',          section: 'Finance' },
  { id: 'reconciliation',     label: 'Reconciliation',      section: 'Finance' },
  { id: 'exceptions',         label: 'Exceptions',          section: 'Finance' },
  { id: 'capital',            label: 'Capital',             section: 'Finance' },
  { id: 'projections',        label: 'Projections',         section: 'Finance' },
  { id: 'procurement',        label: 'Procurement',         section: 'Finance' },
  { id: 'reports',            label: 'Reports',             section: 'Finance' },

  { id: 'staff_directory',    label: 'Staff Directory',     section: 'Workforce' },
  { id: 'staff_management',   label: 'Management',          section: 'Workforce' },
  { id: 'staff_foh',          label: 'Front of House',      section: 'Workforce' },
  { id: 'staff_boh',          label: 'Back of House',       section: 'Workforce' },
  { id: 'staff_procurement',  label: 'Procurement',         section: 'Workforce' },
  { id: 'staff_marketing',    label: 'Marketing',           section: 'Workforce' },
  { id: 'staff_finance',      label: 'Finance',             section: 'Workforce' },
  { id: 'staff_hr',           label: 'HR',                  section: 'Workforce' },
  { id: 'kitchen_staff',      label: 'Kitchen Brigade',     section: 'Workforce' },

  { id: 'onboarding',         label: 'Onboarding',          section: 'Setup' },
  { id: 'configuration',      label: 'Configuration Hub',   section: 'Setup' },
  { id: 'settings',           label: 'Brands & Stations',   section: 'Setup' },
  { id: 'notifications',      label: 'Notifications',       section: 'Setup' },
  { id: 'help',               label: 'Help & Support',      section: 'Setup' },
]

const ALL_MODULE_IDS = MODULES.map((m) => m.id)

/**
 * Default mapping role → modules. Admin/CEO see everything; specialised roles
 * see only their work surface. The CEO can edit this in
 * /configuration/role-modules — overrides are stored in zustand.
 */
export const DEFAULT_MODULE_ACCESS: Record<AppRole, ModuleId[]> = {
  admin: ALL_MODULE_IDS,
  management: ALL_MODULE_IDS.filter((m) => !['chain'].includes(m)),

  foh_management: [
    'dashboard', 'ops', 'orders', 'refunds', 'curbside', 'kds_all', 'expo_station',
    'pos', 'reservations', 'reservations_admin', 'scheduling', 'tables', 'dispatch', 'riders',
    'crm', 'complaints', 'reviews', 'campaigns',
    'staff_directory', 'staff_foh', 'kitchen_staff',
    'reports',
  ],
  boh_management: [
    'dashboard', 'ops', 'orders', 'kds_all', 'kds_dashboard', 'expo_station',
    'menu', 'components', 'recipes', 'par_sheet', 'inventory', 'kds_config',
    'procurement', 'staff_directory', 'staff_boh', 'staff_procurement', 'kitchen_staff',
    'reports',
  ],
  foh: [
    'pos', 'reservations', 'tables', 'dispatch', 'orders', 'curbside',
  ],
  boh: [
    'kds_all', 'kds_dashboard', 'inventory', 'recipes', 'par_sheet',
  ],
  // Line cook's surface: the Kitchen view dashboard + Par sheet. They do NOT
  // get the Expo Station (that's the expediter's pass-station overview) and
  // they do NOT get KDS Config (admin-only station CRUD). 2026-05-14: dropped
  // kds_all so the per-station injections + Expo Station vanish from the cook's
  // sidebar — /kds is now the single entry point.
  kitchen:   ['kds_dashboard', 'par_sheet'],
  expediter: ['kds_all', 'expo_station', 'orders', 'par_sheet'],
  cashier:   ['dashboard', 'pos', 'orders', 'curbside', 'tables'],

  procurement: ['procurement', 'inventory', 'reports'],

  marketing: [
    'marketing_workspace', 'crm', 'campaigns', 'complaints', 'reviews',
    'calendar', 'media', 'promos', 'brands', 'analytics',
  ],

  finance: [
    'dashboard', 'orders',
    'finance_pl', 'payroll', 'accounting', 'gift_cards', 'reconciliation',
    'exceptions', 'capital', 'projections', 'reports',
  ],

  hr: [
    'staff_directory', 'staff_management', 'staff_foh', 'staff_boh',
    'staff_procurement', 'staff_marketing', 'staff_finance', 'staff_hr',
    'kitchen_staff', 'payroll', 'scheduling',
  ],
}
