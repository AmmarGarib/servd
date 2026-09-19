import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from './prisma.js'
import { ForbiddenError } from './errors.js'

/**
 * Server-side module access — the enforcement half of the admin sidebar's
 * "Module Access" matrix (/configuration/role-modules).
 *
 * Three inputs combine into a user's effective module set:
 *   1. Role defaults (below — keep in sync with frontend/admin/src/lib/appRoles.ts)
 *   2. The CEO's per-role override rows in RoleModuleAccess (full allow-list)
 *   3. The user's own moduleAllow / moduleDeny arrays (deny wins)
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
  'menu', 'components', 'recipes', 'inventory', 'kds_config', 'par_sheet',
  'marketing_workspace', 'crm', 'campaigns', 'complaints', 'reviews', 'calendar', 'media', 'promos', 'brands', 'analytics',
  'finance_pl', 'payroll', 'accounting', 'gift_cards', 'reconciliation', 'exceptions', 'capital', 'projections', 'procurement', 'reports',
  'staff_directory', 'staff_management', 'staff_foh', 'staff_boh', 'staff_procurement', 'staff_marketing', 'staff_finance', 'staff_hr', 'kitchen_staff',
  'settings', 'notifications', 'help', 'configuration', 'onboarding', 'integrations',
] as const
const MODULE_ID_SET = new Set<string>(MODULE_IDS)
const ALL_MODULES = [...MODULE_IDS] as string[]

// Role defaults — ported from frontend appRoles.ts DEFAULT_MODULE_ACCESS.
// The legacy 'manager' role mirrors 'management'.
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
    'staff_directory', 'staff_foh', 'kitchen_staff',
    'reports', 'integrations',
  ],
  boh_management: [
    'dashboard', 'ops', 'orders', 'kds_all', 'kds_dashboard', 'expo_station',
    'menu', 'components', 'recipes', 'par_sheet', 'inventory', 'kds_config',
    'procurement', 'staff_directory', 'staff_boh', 'staff_procurement', 'kitchen_staff',
    'reports',
  ],
  foh:       ['pos', 'reservations', 'tables', 'dispatch', 'orders', 'curbside'],
  boh:       ['kds_all', 'kds_dashboard', 'inventory', 'recipes', 'par_sheet'],
  kitchen:   ['kds_dashboard', 'par_sheet'],
  expediter: ['kds_all', 'expo_station', 'orders', 'par_sheet'],
  cashier:   ['dashboard', 'pos', 'orders', 'curbside', 'tables'],
  procurement: ['procurement', 'inventory', 'reports'],
  marketing: [
    'marketing_workspace', 'crm', 'campaigns', 'complaints', 'reviews',
    'calendar', 'media', 'promos', 'brands', 'analytics',
  ],
  brand_manager: [
    'brand_dashboard',
    'marketing_workspace', 'crm', 'campaigns', 'complaints', 'reviews',
    'calendar', 'media', 'promos', 'brands', 'analytics',
  ],
  fnb_manager: [
    'fnb_dashboard',
    'dashboard', 'ops', 'orders', 'refunds', 'curbside',
    'kds_all', 'kds_dashboard', 'expo_station',
    'menu', 'components', 'recipes', 'par_sheet', 'inventory', 'kds_config',
    'pos', 'reservations', 'reservations_admin', 'scheduling', 'tables', 'dispatch', 'riders',
    'complaints', 'reviews',
    'staff_directory', 'staff_foh', 'staff_boh', 'kitchen_staff',
    'finance_pl', 'accounting', 'reports',
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

export function isKnownModuleId(id: string): boolean { return MODULE_ID_SET.has(id) }

// ── Role-override cache (mirrors the permissions cache pattern) ─────────────
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
  const base = new Set(overrides.get(user.role) ?? DEFAULT_MODULE_ACCESS[user.role] ?? [])
  for (const m of user.moduleAllow ?? []) base.add(m)
  for (const m of user.moduleDeny ?? []) base.delete(m)
  return base
}

// ── URL → required-module map (first match wins; ANY listed module passes) ──
// Paths are matched after stripping the /api/v1 prefix. Deliberately covers
// only the audit-flagged financial/reporting surfaces — see header comment.
const GATED_PREFIXES: Array<{ prefix: string; anyOf: string[] }> = [
  { prefix: '/accounting/pl', anyOf: ['finance_pl', 'accounting'] },
  { prefix: '/accounting',    anyOf: ['accounting'] },
  { prefix: '/reports',       anyOf: ['reports'] },
  { prefix: '/management',    anyOf: ['brand_dashboard', 'fnb_dashboard'] },
  { prefix: '/payroll',       anyOf: ['payroll'] },
  { prefix: '/procurement',   anyOf: ['procurement'] },
  { prefix: '/reconciliation', anyOf: ['reconciliation'] },
  { prefix: '/gift-cards',    anyOf: ['gift_cards'] },
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
