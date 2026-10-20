/**
 * Roles & modules — DISPLAY metadata only.
 *
 * Which roles exist, which may be assigned, and which modules each role gets
 * by default are decided by the API (backend/src/lib/roles.ts and
 * backend/src/lib/moduleAccess.ts) and served by GET /permissions/role-modules
 * ({ defaults, overrides, modules, roles }) and GET /permissions/me
 * ({ role, modules }). This file holds only what the server cannot: labels,
 * icons and descriptions for the UI, plus the TypeScript unions that name the
 * ids. A role or module id added on the server without an entry here still
 * works; it just renders with a title-cased fallback label.
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
  | 'owner'             // co-owner — CEO-level visibility, not final authority
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
  | 'brand_manager'     // marketing/brand manager — owns the Brand dashboard
  | 'fnb_manager'       // food & beverage manager (BOH + FOH) — owns the F&B dashboard
  | 'finance'
  | 'hr'
  | 'it'                // IT / developer — owns the Dev workspace
  // Director (owner, 2026-10-18): a brand partner — read-only figures for the
  // brands on their login, on /director only. Deliberately NOT in APP_ROLES
  // below: it has no preset to edit and no "view as" (its modules are fixed).
  | 'director'

export interface RoleMeta {
  value: AppRole
  label: string
  emoji: string
  description: string
  /** Real CEO always retains everything; flag is used to gate the switcher self-selection. */
  isSuperuser?: boolean
}

export const APP_ROLES: RoleMeta[] = [
  { value: 'admin',           label: 'CEO',              emoji: '👑',  description: 'Founder — final approver, the only role that can edit roles & module access', isSuperuser: true },
  { value: 'owner',           label: 'Owner',            emoji: '🔑',  description: 'Co-owner — sees everything the CEO sees and approves staff work, but their own submissions escalate to the CEO and they cannot edit roles' },
  { value: 'management',      label: 'Management',       emoji: '🧑‍💼', description: 'GM / day-to-day operator — full ops + finance, no platform' },
  { value: 'foh_management',  label: 'FOH Management',   emoji: '🎩',  description: 'Floor manager — service, dispatch, reservations, complaints' },
  { value: 'boh_management',  label: 'BOH Management',   emoji: '👨‍🍳', description: 'Head chef — kitchen, inventory, recipes, brigade' },
  { value: 'foh',             label: 'FOH (Front)',      emoji: '💁',  description: 'Servers / hosts — POS, reservations, floor plan' },
  { value: 'boh',             label: 'BOH (Back)',       emoji: '🍳',  description: 'Line cooks / prep — KDS station, inventory consumption' },
  { value: 'kitchen',         label: 'Kitchen (Line)',   emoji: '🔥',  description: 'Single-station KDS view only' },
  { value: 'expediter',       label: 'Expediter',        emoji: '🪧',  description: 'Pass / quality check — all-orders KDS view' },
  { value: 'cashier',         label: 'Cashier',          emoji: '💳',  description: 'POS + curbside + basic dashboard' },
  { value: 'procurement',     label: 'Procurement',      emoji: '🏭',  description: 'Supplier chat and POs. Sees deliveries at the dock; a manager receives' },
  { value: 'marketing',       label: 'Marketing',        emoji: '🚀',  description: 'CRM, campaigns, reviews, complaints, content' },
  { value: 'brand_manager',   label: 'Brand Manager',    emoji: '📣',  description: 'Owns the Brand dashboard — ARPU, LTV, AOV, retention. Marketing + growth.' },
  { value: 'fnb_manager',     label: 'F&B Manager',      emoji: '🍽️',  description: 'Owns the F&B dashboard — kitchen throughput, menu, food cost, quality. BOH + FOH.' },
  { value: 'finance',         label: 'Finance',          emoji: '💰',  description: 'P&L, payroll, accounting, reconciliation' },
  { value: 'hr',              label: 'HR / Workforce',   emoji: '👥',  description: 'Staff records, attendance, payroll, scheduling' },
  { value: 'it',              label: 'IT / developer',   emoji: '',    description: 'Owns the Dev workspace — the API connectors (WhatsApp, POS), integrations, the user audit log, notifications, help' },
]

/** Display label for any role string the backend returns. Maps admin → CEO. */
export function roleLabel(role: string | undefined | null): string {
  if (!role) return ''
  const meta = APP_ROLES.find((r) => r.value === role)
  if (meta) return meta.label
  if (role === 'director') return 'Director'
  // Fallback: title-case the raw value
  return role.charAt(0).toUpperCase() + role.slice(1)
}

/** Module IDs — must match the `module` tag on every nav item in AppShell. */
export type ModuleId =
  // Executive (CEO only by default)
  | 'ceo_overview' | 'approvals' | 'business_info' | 'role_management' | 'role_modules' | 'audit_log' | 'accounting_audit' | 'tenants' | 'trash'
  // Management — manager-tier dashboards (Brand Manager, F&B Manager)
  | 'brand_dashboard' | 'fnb_dashboard'
  // Live
  | 'dashboard' | 'ops' | 'orders' | 'refunds' | 'curbside' | 'kds_all' | 'kds_dashboard' | 'expo_station' | 'chain'
  // Service
  | 'pos' | 'reservations' | 'reservations_admin' | 'scheduling' | 'tables' | 'dispatch' | 'riders'
  | 'emergency_overrides'
  // Kitchen
  | 'menu' | 'components' | 'recipes' | 'inventory' | 'kds_config' | 'par_sheet' | 'food_safety'
  // Marketing
  | 'marketing_workspace' | 'crm' | 'campaigns' | 'complaints' | 'reviews' | 'calendar' | 'media' | 'promos' | 'brands' | 'storefront' | 'analytics'
  // Finance
  | 'finance_pl' | 'payroll' | 'accounting' | 'gift_cards' | 'reconciliation' | 'exceptions' | 'capital' | 'projections' | 'procurement' | 'reports'
  | 'voided_prebills' | 'food_cost'
  // Workforce — `staff_directory` is the unified hub; `staff_hr` is the HR
  // back office (enforced by the API on the HR admin routes). The seven
  // per-category ids that used to sit here tagged nothing and were retired.
  | 'staff_directory'
  | 'staff_hr'
  // Setup
  | 'settings'  | 'notifications' | 'help' | 'configuration' | 'onboarding' | 'integrations'
  // Dev → API: the two connectors (spec §10)
  | 'api_whatsapp' | 'api_pos'
  // Director → Brand performance (owner, 2026-10-18): director logins + the CEO.
  | 'director_view'

export interface ModuleMeta {
  id: ModuleId
  label: string
  /** Which top-level NAV section this lives in — used by the editor UI to group items */
  section: 'Executive' | 'Management' | 'Live' | 'Service' | 'Kitchen' | 'Marketing' | 'Finance' | 'Workforce' | 'Setup'
}

export const MODULES: ModuleMeta[] = [
  { id: 'ceo_overview',       label: 'CEO Overview',        section: 'Executive' },
  { id: 'approvals',          label: 'Approvals inbox',     section: 'Executive' },
  { id: 'business_info',      label: 'Locations & delivery zones', section: 'Executive' },
  { id: 'role_management',    label: 'Staff approvals',     section: 'Executive' },
  { id: 'role_modules',       label: 'Module Access',       section: 'Executive' },
  { id: 'audit_log',          label: 'User audit log',      section: 'Executive' },
  { id: 'accounting_audit',   label: 'Accounting Audit',    section: 'Executive' },
  { id: 'brand_dashboard',    label: 'Marketing dashboard', section: 'Management' },
  { id: 'fnb_dashboard',      label: 'F&B Dashboard',       section: 'Management' },
  { id: 'tenants',            label: 'Tenants / Brands',    section: 'Executive' },
  { id: 'trash',              label: 'Trash',               section: 'Executive' },

  { id: 'dashboard',          label: 'Operations dashboard', section: 'Live' },
  { id: 'ops',                label: 'Prep list',           section: 'Live' },
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
  { id: 'emergency_overrides', label: 'Emergency overrides', section: 'Service' },

  { id: 'menu',               label: 'Menu',                section: 'Kitchen' },
  { id: 'components',         label: 'Components',          section: 'Kitchen' },
  { id: 'recipes',            label: 'Recipes',             section: 'Kitchen' },
  { id: 'inventory',          label: 'Inventory',           section: 'Kitchen' },
  { id: 'par_sheet',          label: 'Par Sheet',           section: 'Kitchen' },
  { id: 'kds_config',         label: 'KDS Config',          section: 'Kitchen' },
  { id: 'food_safety',        label: 'Food Safety Logs',    section: 'Kitchen' },

  { id: 'marketing_workspace', label: 'Marketing Workspace', section: 'Marketing' },
  { id: 'crm',                label: 'CRM',                 section: 'Marketing' },
  { id: 'campaigns',          label: 'Campaigns',           section: 'Marketing' },
  { id: 'complaints',         label: 'Complaints',          section: 'Marketing' },
  { id: 'reviews',            label: 'Reviews',             section: 'Marketing' },
  { id: 'calendar',           label: 'Content Calendar',    section: 'Marketing' },
  { id: 'media',              label: 'Media (legacy)',      section: 'Marketing' },
  { id: 'promos',             label: 'Promotions',          section: 'Marketing' },
  { id: 'brands',             label: 'Brand info',          section: 'Marketing' },
  { id: 'storefront',         label: 'Storefront content',  section: 'Marketing' },
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
  { id: 'food_cost',          label: 'Food cost variance',  section: 'Finance' },
  { id: 'voided_prebills',    label: 'Voided pre bills',    section: 'Finance' },

  { id: 'staff_directory',    label: 'Staff Directory',     section: 'Workforce' },
  { id: 'staff_hr',           label: 'HR',                  section: 'Workforce' },

  // Account config — Integrations / Notifications / Help now live in the
  // Executive sidebar section (the standalone "Setup" group was retired).
  { id: 'integrations',       label: 'Integrations',        section: 'Executive' },
  { id: 'api_whatsapp',       label: 'WhatsApp connector',  section: 'Executive' },
  { id: 'api_pos',            label: 'POS connector',       section: 'Executive' },
  { id: 'notifications',      label: 'Notifications',       section: 'Executive' },
  { id: 'help',               label: 'Help & Support',      section: 'Executive' },
  // Still-defined modules that aren't in the primary sidebar: the first-run
  // wizard (reachable from the Dashboard checklist), the Configuration Hub
  // deep-links, and the legacy Brands & Stations gate.
  { id: 'onboarding',         label: 'Onboarding',          section: 'Setup' },
  { id: 'configuration',      label: 'Configuration Hub',   section: 'Setup' },
  { id: 'settings',           label: 'Brands & Stations',   section: 'Setup' },
]

/**
 * Executive tier — the CEO and any co-owner. Use for VISIBILITY decisions
 * ("should this person see the Executive section / the CEO dashboard / the
 * approvals inbox?").
 *
 * Do NOT use this for AUTHORITY decisions. Granting or revoking access,
 * editing roles and module maps, and being the final approver are `admin`
 * only — an owner who could edit roles could promote themselves to admin.
 * For those, keep comparing against 'admin' explicitly.
 */
export function isExecutive(role: string | undefined | null): boolean {
  return role === 'admin' || role === 'owner'
}
