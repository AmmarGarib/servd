import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from './prisma.js'
import { ForbiddenError } from './errors.js'

/**
 * Server-side module access — the enforcement half of the admin sidebar's
 * "Module Access" matrix (/configuration/role-modules).
 *
 * Three inputs combine into a user's effective module set:
 *   1. Role defaults (below — THE copy; the admin app reads them from
 *      GET /permissions/role-modules and keeps none of its own)
 *   2. The CEO's per-role override rows in RoleModuleAccess (full allow-list)
 *   3. The user's own moduleAllow / moduleDeny arrays (deny wins)
 *
 * The same resolution feeds the sidebar: GET /permissions/me returns the
 * caller's effective modules from effectiveModulesForUser(), so what the
 * sidebar shows and what the API lets through cannot disagree.
 *
 * Enforcement is deliberately scoped to the SENSITIVE READ SURFACES the 2026-06
 * audit flagged (finance, reports, management dashboards, payroll,
 * procurement) — not to ops-critical surfaces like orders/KDS/POS, where a
 * mis-configured matrix could lock staff out mid-service. Role-array gating
 * (requireAuth(...MANAGERS) etc.) still applies everywhere as before; this is
 * an ADDITIONAL narrowing on top.
 */

// ── Module registry (ids must match the frontend's ModuleId union) ──────────
export const MODULE_IDS = [
  'ceo_overview', 'business_info', 'role_management', 'role_modules', 'audit_log', 'accounting_audit', 'tenants',
  'brand_dashboard', 'fnb_dashboard',
  'dashboard', 'ops', 'orders', 'refunds', 'curbside', 'kds_all', 'kds_dashboard', 'expo_station', 'chain',
  'pos', 'reservations', 'reservations_admin', 'scheduling', 'tables', 'dispatch', 'riders',
  'menu', 'components', 'recipes', 'inventory', 'kds_config', 'par_sheet', 'food_safety',
  'marketing_workspace', 'crm', 'campaigns', 'complaints', 'reviews', 'calendar', 'media', 'promos', 'brands', 'analytics',
  // Storefront content module (decision 41): pages, pop-ups, library, drafts.
  // Publishing still needs the CEO (role admin) — this only lets you draft.
  'storefront',
  'finance_pl', 'payroll', 'accounting', 'gift_cards', 'reconciliation', 'exceptions', 'capital', 'projections', 'procurement', 'reports',
  'staff_directory', 'staff_hr',
  'settings', 'notifications', 'help', 'configuration', 'onboarding', 'integrations',
] as const
const MODULE_ID_SET = new Set<string>(MODULE_IDS)
const ALL_MODULES = [...MODULE_IDS] as string[]

// Ids that used to exist and may still sit in a saved RoleModuleAccess row or a
// user's moduleAllow/moduleDeny. They tagged no sidebar item and no gated
// prefix, so toggling them did nothing. Stripped on read and on write so an
// old row can still be edited and saved; any OTHER unknown id is a typo and
// is refused.
export const RETIRED_MODULE_IDS = [
  'staff_management', 'staff_foh', 'staff_boh', 'staff_procurement',
  'staff_marketing', 'staff_finance', 'kitchen_staff',
] as const
const RETIRED_SET = new Set<string>(RETIRED_MODULE_IDS)

/** Drop retired / unknown ids from a stored module list. */
export function knownModulesOnly(modules: readonly string[]): string[] {
  return modules.filter((m) => MODULE_ID_SET.has(m))
}
export function isRetiredModuleId(id: string): boolean { return RETIRED_SET.has(id) }

// Role defaults. The legacy 'manager' role (migrated to foh_management) keeps
// an entry only so a not-yet-migrated row still resolves.
const MANAGEMENT_MODULES = ALL_MODULES.filter((m) => m !== 'chain')
// 'manager' mirrors 'management' for everything EXCEPT the accounting trail.
const MANAGER_MODULES = MANAGEMENT_MODULES.filter((m) => m !== 'accounting_audit')
// Co-owner: everything the CEO sees — P&L, payroll, projections, investment —
// EXCEPT the governance surfaces. Withholding role_management/role_modules is
// what makes the escalation rule real: an owner who could edit roles could
// grant themselves `admin`. Staff-account admin stays with the CEO for the
// same reason (creating an admin user is equivalent to self-promotion).
const OWNER_MODULES = ALL_MODULES.filter(
  (m) => !['role_management', 'role_modules', 'accounting_audit'].includes(m),
)
// The books' own audit trail — period closes, manual journals, wage rates,
// tip-pool postings. Per the owner: the CEO and the exec (management) only.
// Deliberately withheld from co-owners and from finance, both of whom can SEE
// the numbers: this trail is the record of who MOVED them, which is the thing
// you read when you doubt one of those people.
export const ACCOUNTING_AUDIT_ROLES = ['admin', 'management'] as UserRole[]

export const DEFAULT_MODULE_ACCESS: Record<UserRole, string[]> = {
  admin:      ALL_MODULES,
  owner:      OWNER_MODULES,
  management: MANAGEMENT_MODULES,
  manager:    MANAGER_MODULES,
  foh_management: [
    'dashboard', 'ops', 'orders', 'refunds', 'curbside', 'kds_all', 'expo_station',
    'pos', 'reservations', 'reservations_admin', 'scheduling', 'tables', 'dispatch', 'riders',
    'crm', 'complaints', 'reviews', 'campaigns',
    'staff_directory',
    'reports', 'integrations',
  ],
  boh_management: [
    'dashboard', 'ops', 'orders', 'kds_all', 'kds_dashboard', 'expo_station',
    'menu', 'components', 'recipes', 'par_sheet', 'inventory', 'kds_config', 'food_safety',
    'procurement', 'staff_directory',
    'reports',
  ],
  foh:       ['pos', 'reservations', 'tables', 'dispatch', 'orders', 'curbside'],
  boh:       ['kds_all', 'kds_dashboard', 'inventory', 'recipes', 'par_sheet', 'food_safety'],
  kitchen:   ['kds_dashboard', 'par_sheet', 'food_safety'],
  expediter: ['kds_all', 'expo_station', 'orders', 'par_sheet', 'food_safety'],
  cashier:   ['dashboard', 'pos', 'orders', 'curbside', 'tables'],
  procurement: ['procurement', 'inventory', 'reports'],
  marketing: [
    'marketing_workspace', 'crm', 'campaigns', 'complaints', 'reviews',
    'calendar', 'media', 'promos', 'brands', 'analytics', 'storefront',
  ],
  brand_manager: [
    'brand_dashboard',
    'marketing_workspace', 'crm', 'campaigns', 'complaints', 'reviews',
    'calendar', 'media', 'promos', 'brands', 'analytics', 'storefront',
  ],
  fnb_manager: [
    'fnb_dashboard',
    'dashboard', 'ops', 'orders', 'refunds', 'curbside',
    'kds_all', 'kds_dashboard', 'expo_station',
    'menu', 'components', 'recipes', 'par_sheet', 'inventory', 'kds_config', 'food_safety',
    'pos', 'reservations', 'reservations_admin', 'scheduling', 'tables', 'dispatch', 'riders',
    'complaints', 'reviews',
    'staff_directory',
    'finance_pl', 'accounting', 'reports',
  ],
  finance: [
    'dashboard', 'orders',
    'finance_pl', 'payroll', 'accounting', 'gift_cards', 'reconciliation',
    'exceptions', 'capital', 'projections', 'reports',
  ],
  hr: [
    'staff_directory', 'staff_hr', 'payroll', 'scheduling',
  ],
  // IT / developer — owns the Dev workspace (decision 47, lib/workspaces.ts).
  it: ['integrations', 'audit_log', 'notifications', 'help'],
}

export function isKnownModuleId(id: string): boolean { return MODULE_ID_SET.has(id) }

// ── Role-override cache ─────────────────────────────────────────────────────
let overrideCache: { at: number; rows: Map<UserRole, string[]> } | null = null
const CACHE_TTL_MS = 30_000

export function invalidateModuleAccessCache() { overrideCache = null }

async function roleOverrides(): Promise<Map<UserRole, string[]>> {
  if (overrideCache && Date.now() - overrideCache.at < CACHE_TTL_MS) return overrideCache.rows
  const rows = await prisma.roleModuleAccess.findMany()
  const map = new Map<UserRole, string[]>(rows.map((r) => [r.role, r.modules]))
  overrideCache = { at: Date.now(), rows: map }
  return map
}

/** Effective module set: (override ?? default) ∪ moduleAllow − moduleDeny. Admin sees all. */
export async function effectiveModulesForUser(user: {
  role: UserRole
  moduleAllow?: string[]
  moduleDeny?: string[]
}): Promise<Set<string>> {
  if (user.role === 'admin') return new Set(ALL_MODULES)
  const overrides = await roleOverrides()
  const base = new Set(knownModulesOnly(overrides.get(user.role) ?? DEFAULT_MODULE_ACCESS[user.role] ?? []))
  for (const m of knownModulesOnly(user.moduleAllow ?? [])) base.add(m)
  for (const m of user.moduleDeny ?? []) base.delete(m)
  return base
}

// ── URL → required-module map (first match wins; ANY listed module passes) ──
// Paths are matched after stripping the /api/v1 prefix. Covers the
// audit-flagged financial/reporting surfaces plus the HR back office — see
// header comment.
const GATED_PREFIXES: Array<{ prefix: string; anyOf: string[] }> = [
  // The P&L (and its by-brand tab) is THE P&L — reachable with the P&L module
  // or the accounting module, as the old /finance P&L was.
  { prefix: '/accounting/pl-ledger', anyOf: ['finance_pl', 'accounting'] },
  { prefix: '/accounting',    anyOf: ['accounting'] },
  { prefix: '/reports',       anyOf: ['reports'] },
  { prefix: '/management',    anyOf: ['brand_dashboard', 'fnb_dashboard'] },
  // The one AP aging serves the Accounting AP aging page too, so finance
  // (accounting, no procurement) can open it.
  { prefix: '/procurement/ap-aging', anyOf: ['procurement', 'accounting'] },
  { prefix: '/procurement',   anyOf: ['procurement'] },
  { prefix: '/reconciliation', anyOf: ['reconciliation'] },
  { prefix: '/gift-cards',    anyOf: ['gift_cards'] },
  // HR back office — the HR_ADMIN surfaces (hr/routes.ts). Until now the
  // 'staff_hr' toggle only hid the sidebar link; per owner decision 34 module
  // access is THE control, so it is enforced here too. Every role in HR_ADMIN
  // (admin, owner, management, hr) holds staff_hr by default, so nobody loses
  // access unless the CEO has switched it off for them.
  //
  // Deliberately NOT gated: /hr/me*, /hr/approvals, /hr/team, /hr/lookups,
  // /hr/org (GET) and /hr/records/* — those are every employee's self-service
  // and HOD approvals (ALL_STAFF by design), and a prefix rule cannot tell
  // /records/:s/:id/submit from the admin list under the same prefix.
  { prefix: '/hr/employees',        anyOf: ['staff_hr'] },
  { prefix: '/hr/documents',        anyOf: ['staff_hr'] },
  { prefix: '/hr/payroll',          anyOf: ['staff_hr'] },
  { prefix: '/hr/letters',          anyOf: ['staff_hr'] },
  { prefix: '/hr/reports',          anyOf: ['staff_hr'] },
  { prefix: '/hr/settings',         anyOf: ['staff_hr'] },
  { prefix: '/hr/forms',            anyOf: ['staff_hr'] },
  { prefix: '/hr/sections',         anyOf: ['staff_hr'] },
  { prefix: '/hr/dashboard',        anyOf: ['staff_hr'] },
  { prefix: '/hr/due',              anyOf: ['staff_hr'] },
  { prefix: '/hr/final-settlement', anyOf: ['staff_hr'] },
  { prefix: '/hr/org/units',        anyOf: ['staff_hr'] },
  { prefix: '/hr/org/departments',  anyOf: ['staff_hr'] },
]

/**
 * Called from the auth middleware once the principal is attached. Throws 403
 * when the request path is module-gated and the user's effective modules don't
 * include it. Fails OPEN on unexpected errors (matching tokenRevocation's
 * stance): a transient DB blip on the override lookup must not take down the
 * finance surfaces — role-array gating still applies underneath.
 */
export async function enforceModuleAccess(
  url: string,
  user: { role: UserRole; moduleAllow?: string[]; moduleDeny?: string[] },
): Promise<void> {
  if (user.role === 'admin') return
  const path = (url.split('?')[0] ?? '').replace(/^\/api\/v1/, '')
  const rule = GATED_PREFIXES.find((r) => path === r.prefix || path.startsWith(r.prefix + '/') || path.startsWith(r.prefix + '?'))
  if (!rule) return
  let modules: Set<string>
  try {
    modules = await effectiveModulesForUser(user)
  } catch {
    return   // fail open — see docstring
  }
  if (!rule.anyOf.some((m) => modules.has(m))) {
    throw new ForbiddenError(`Your account does not have access to this module (${rule.anyOf[0]}). Ask the CEO to enable it in Module Access.`)
  }
}
