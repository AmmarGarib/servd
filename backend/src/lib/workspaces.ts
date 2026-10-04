import type { UserRole } from '@prisma/client'
import { ASSIGNABLE_ROLES_WITH_ADMIN } from './roles.js'

/**
 * WORKSPACES — servd organised by OWNER (owner decision 47, 2026-10-04).
 *
 * The single source for which workspace a module lives in, who owns each
 * workspace, and who may add logins for whom. The admin app reads all of it
 * from GET /permissions/me and GET /permissions/workspaces; it keeps no copy.
 *
 * Workspaces are a GROUPING of the existing module ids (lib/moduleAccess.ts),
 * not a second access control: what a person can reach is still their
 * effective module set. A workspace is shown to someone only when they hold at
 * least one of its modules.
 */

export interface WorkspaceSection { key: string; title: string; modules: string[] }
export interface WorkspaceDef {
  id: 'operations' | 'finance' | 'marketing' | 'hr' | 'dev'
  title: string
  /** Roles that OWN the workspace (run it, add people to it). */
  ownerRoles: UserRole[]
  /** Roles whose day-to-day home is this workspace. */
  memberRoles: UserRole[]
  sections: WorkspaceSection[]
}

export const WORKSPACES: readonly WorkspaceDef[] = [
  {
    id: 'operations',
    title: 'Operations',
    ownerRoles: ['admin'],
    memberRoles: [
      'management', 'fnb_manager', 'foh_management', 'boh_management',
      'foh', 'boh', 'kitchen', 'expediter', 'cashier', 'procurement', 'manager',
    ],
    sections: [
      { key: 'kitchen',       title: 'Kitchen',          modules: ['kds_all', 'kds_dashboard', 'expo_station', 'kds_config'] },
      { key: 'menu',          title: 'Menu & recipes',   modules: ['menu', 'components', 'recipes'] },
      { key: 'stock',         title: 'Stock & buying',   modules: ['inventory', 'par_sheet', 'procurement'] },
      { key: 'food_safety',   title: 'Food safety',      modules: ['food_safety'] },
      { key: 'front',         title: 'Front of house',   modules: ['pos', 'orders', 'refunds', 'curbside', 'reservations', 'reservations_admin', 'tables', 'dispatch', 'riders'] },
      { key: 'dashboards',    title: 'Dashboards',       modules: ['dashboard', 'ops', 'fnb_dashboard', 'chain'] },
      { key: 'company',       title: 'Company',          modules: ['ceo_overview', 'business_info', 'tenants', 'role_management', 'role_modules', 'settings', 'configuration', 'onboarding'] },
    ],
  },
  {
    id: 'finance',
    title: 'Finance',
    ownerRoles: ['finance'],
    memberRoles: ['finance'],
    sections: [
      // accounting_audit stays CEO + management only by default (the books'
      // own trail) — it is filed here, but the role defaults withhold it.
      { key: 'books',   title: 'Books',            modules: ['finance_pl', 'accounting', 'accounting_audit', 'reconciliation', 'exceptions'] },
      { key: 'money',   title: 'Money & planning', modules: ['gift_cards', 'capital', 'projections', 'payroll'] },
      { key: 'reports', title: 'Reports',          modules: ['reports'] },
    ],
  },
  {
    id: 'marketing',
    title: 'Marketing',
    ownerRoles: ['marketing', 'brand_manager'],
    memberRoles: ['marketing', 'brand_manager'],
    sections: [
      { key: 'workspace', title: 'Workspace',      modules: ['marketing_workspace', 'calendar', 'analytics', 'brand_dashboard'] },
      { key: 'customers', title: 'Customers',      modules: ['crm', 'campaigns', 'promos', 'complaints', 'reviews'] },
      { key: 'brand',     title: 'Brand & site',   modules: ['brands', 'storefront'] },
    ],
  },
  {
    id: 'hr',
    title: 'HR',
    ownerRoles: ['hr'],
    memberRoles: ['hr'],
    sections: [
      { key: 'people', title: 'People', modules: ['staff_hr', 'staff_directory'] },
      { key: 'time',   title: 'Time',   modules: ['scheduling'] },
    ],
  },
  {
    id: 'dev',
    title: 'Dev',
    ownerRoles: ['it'],
    memberRoles: ['it'],
    sections: [
      { key: 'systems', title: 'Systems', modules: ['integrations', 'notifications'] },
      { key: 'trail',   title: 'Audit',   modules: ['audit_log'] },
      { key: 'help',    title: 'Help',    modules: ['help'] },
    ],
  },
]

/** Module ids deliberately in no workspace: retired, kept only so old rows parse. */
export const UNASSIGNED_MODULE_IDS = ['media'] as const

/** module id → workspace id. */
export const WORKSPACE_OF_MODULE: ReadonlyMap<string, WorkspaceDef['id']> = new Map(
  WORKSPACES.flatMap((w) => w.sections.flatMap((s) => s.modules.map((m) => [m, w.id] as const))),
)

// ── Who may add logins for whom ─────────────────────────────────────────────
// admin creates any login directly (POST /auth/users, no approval). Everyone
// else INVITES into their own reach (POST /auth/staff/invite) and the CEO
// approves. owner gets none: owners cannot touch staff accounts (escalation
// rule — an owner who could mint logins could mint an admin).
const OPS_FLOOR: UserRole[] = ['foh', 'boh', 'kitchen', 'expediter', 'cashier', 'procurement']

export const CHILD_ROLES: Readonly<Record<UserRole, readonly UserRole[]>> = {
  admin:          ASSIGNABLE_ROLES_WITH_ADMIN,
  owner:          [],
  management:     ['fnb_manager', 'foh_management', 'boh_management', ...OPS_FLOOR],
  fnb_manager:    ['foh_management', 'boh_management', ...OPS_FLOOR],
  boh_management: ['boh', 'kitchen', 'expediter'],
  foh_management: ['foh', 'cashier'],
  manager:        ['foh', 'cashier'],
  finance:        ['finance'],
  hr:             ['hr'],
  marketing:      ['marketing'],
  brand_manager:  ['marketing'],
  it:             [],
  foh: [], boh: [], kitchen: [], expediter: [], cashier: [], procurement: [],
}

export function childRolesFor(role: UserRole | string | null | undefined): UserRole[] {
  if (!role) return []
  return [...(CHILD_ROLES[role as UserRole] ?? [])]
}

/**
 * The caller's view: only workspaces where they hold ≥1 effective module, each
 * section narrowed to the modules they hold, and empty sections dropped.
 */
export function workspacesForUser(role: UserRole, modules: Set<string>) {
  return WORKSPACES.flatMap((w) => {
    const sections = w.sections
      .map((s) => ({ key: s.key, title: s.title, modules: s.modules.filter((m) => modules.has(m)) }))
      .filter((s) => s.modules.length > 0)
    if (sections.length === 0) return []
    return [{ id: w.id, title: w.title, owner: w.ownerRoles.includes(role), sections }]
  })
}
