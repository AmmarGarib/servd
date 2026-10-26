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
 * Enforcement covers the prefixes in GATED_PREFIXES below: the sensitive read
 * surfaces the 2026-06 audit flagged (finance, reports, management dashboards,
 * payroll, procurement), the HR back office and — wave 3 (UI-12) — the live
 * operations reads (/orders, /expo, /dispatch, /riders, /crm), each with
 * EVERY module whose pages use it, so no floor role that works them is
 * refused by its DEFAULTS. The till's ring-up / payment (/pos/*) and the
 * per-item bump (PATCH /order-items/:id/status) stay ungated.
 *
 * The KITCHEN SCREEN IS GATED, reads and writes: the station and expo queues
 * AND the step bump, fire and hand-off all live under /expo (POST
 * /expo/steps/:id/bump, /expo/orders/:id/fire|handoff — the admin KDS pages
 * and the tablet), and the tablet's "mark ready" is PATCH /orders/:id/status.
 * So a Module Access row (or a per-user deny) that leaves a kitchen role with
 * none of expo_station / kds_dashboard / kds_all stops that role's KDS —
 * module access is THE control (decision 34); untick those only for a role
 * that should not run the line. The writes are not exempted on their own:
 * with the queue reads refused there is nothing on screen to bump.
 *
 * Role-array gating (requireAuth(...MANAGERS) etc.) still applies everywhere
 * as before; this is an ADDITIONAL narrowing.
 */

// ── Module registry (ids must match the frontend's ModuleId union) ──────────
export const MODULE_IDS = [
  'ceo_overview', 'business_info', 'role_management', 'role_modules', 'audit_log', 'accounting_audit', 'tenants',
  // CEO → Approvals (owner decision D3): the one approvals inbox. Its sidebar
  // entry for the governance roles; the inbox itself (GET /approvals) is open
  // to every login and lists only what that login's existing approve routes
  // would let it act on (modules/approvals). Not gated: it grants nothing.
  'approvals',
  // CEO → Trash (owner, 2026-10-15): deleted / voided / cancelled items with
  // Restore and "Recover as copy". Like approvals it grants nothing — /trash
  // is open to every login and each type is gated by its OWN module + roles
  // in modules/trash (registry.ts); only the CEO empties it.
  'trash',
  'brand_dashboard', 'fnb_dashboard',
  'dashboard', 'ops', 'orders', 'refunds', 'curbside', 'kds_all', 'kds_dashboard', 'expo_station', 'chain',
  'pos', 'reservations', 'reservations_admin', 'scheduling', 'tables', 'dispatch', 'riders',
  // Operations → Emergency overrides (owner, 2026-10-13): send the hand-over
  // code to the rider's number when the customer cannot receive it; log food
  // a rider brought back as waste. The RGM, the chef and the F&B manager.
  'emergency_overrides',
  'menu', 'recipes', 'inventory', 'kds_config', 'par_sheet', 'food_safety',
  'marketing_workspace', 'crm', 'campaigns', 'complaints', 'reviews', 'calendar', 'media', 'promos', 'brands', 'analytics',
  // Storefront content module (decision 41): pages, pop-ups, library, drafts.
  // Publishing still needs the CEO (role admin) — this only lets you draft.
  'storefront',
  'finance_pl', 'payroll', 'accounting', 'gift_cards', 'reconciliation', 'exceptions', 'capital', 'projections', 'procurement', 'reports',
  // Finance → Voided pre bills (spec §17.1): every pre-bill printed, read-only.
  'voided_prebills',
  // Finance → Reports → Food cost variance (wave B): actual vs recipe per
  // ingredient and brand at the price paid (FIFO lots), food / drinks / packaging.
  'food_cost',
  'staff_directory', 'staff_hr',
  'settings', 'notifications', 'help', 'configuration', 'onboarding', 'integrations',
  // Dev → API (spec D13): Hasham's WhatsApp connector and the POS connector.
  'api_whatsapp', 'api_pos',
  // Director → Brand performance (owner, 2026-10-18): the read-only Director
  // page (/director, API GET /director/*). Held ONLY by the director role (and
  // the CEO, who previews it) — DIRECTOR_ONLY_MODULES below.
  'director_view',
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
  // The old Component library (owner, 2026-10-26, K7): its page and API are gone; its tables stay.
  'components',
] as const
const RETIRED_SET = new Set<string>(RETIRED_MODULE_IDS)

/** Drop retired / unknown ids from a stored module list. */
export function knownModulesOnly(modules: readonly string[]): string[] {
  return modules.filter((m) => MODULE_ID_SET.has(m))
}
export function isRetiredModuleId(id: string): boolean { return RETIRED_SET.has(id) }

// Role defaults. The legacy 'manager' role (migrated to foh_management) keeps
// an entry only so a not-yet-migrated row still resolves.
//
// The sidebar and the API must agree (audit PPL-08): a role holds a module by
// default only when the routes behind it let that role in.
//   api_whatsapp  — /auth/integrations/whatsapp*: CONNECTOR_ADMINS (admin, it)
//   api_pos       — /connectors: CONNECTOR_ADMINS + management (read-only)
//   voided_prebills — GET /pre-bills: admin, owner, management, finance
// So management holds everything except the WhatsApp connector (whose routes
// it cannot open), owner and the legacy manager hold neither API connector.
//   emergency_overrides — /emergency-overrides (PARKED with delivery, owner
//     2026-10-13: no route or page yet): the RGM (foh_management), the chef
//     (boh_management), the F&B manager, management and the CEO — the people
//     on shift who own a delivery gone wrong. Not the co-owner, not the
//     legacy manager.
const API_WHATSAPP_ONLY = ['api_whatsapp']
const API_CONNECTORS = ['api_whatsapp', 'api_pos']

// CEO-ONLY modules: no role but the CEO (role admin) may hold them — not by
// default, not through a saved Module Access row, not through a user's
// moduleAllow. effectiveModulesForUser drops them for every other role, the
// Module Access save and the staff save strip them, and their routes check
// role admin themselves, so a stale row can never re-open one.
// None today: 'brands' (the brand editor) left this list on 2026-10-20 (owner:
// "adding brand info etc can go to marketing manager") — marketing and the
// brand manager hold it by default; its tax / legal / look fields stay the
// CEO's on the route itself (concepts/routes.ts BRAND_CEO_FIELDS).
export const CEO_ONLY_MODULES: readonly string[] = []
const CEO_ONLY_SET = new Set<string>(CEO_ONLY_MODULES)

// DIRECTOR modules (owner, 2026-10-18). A director login holds EXACTLY these —
// fixed: no preset row, no per-person tick and no moduleAllow widens or
// narrows it (effectiveModulesForUser). And no role but the director and the
// CEO holds them: the Director API admits only those two roles, so a tick on
// anyone else would be a sidebar link the server refuses.
export const DIRECTOR_MODULES: readonly string[] = ['director_view']
const DIRECTOR_ONLY_SET = new Set<string>(DIRECTOR_MODULES)

/**
 * Drop the modules a non-admin, non-director list may never carry: the
 * CEO-only modules (Brands) and the director-only modules.
 */
export function withoutCeoOnlyModules(modules: readonly string[]): string[] {
  return modules.filter((m) => !CEO_ONLY_SET.has(m) && !DIRECTOR_ONLY_SET.has(m))
}

// ── Role presets: what HR may and may not change (owner, 2026-10-16) ────────
// "Give the presets thing to HR" — Role presets (PUT /permissions/role-modules,
// module role_modules) are HR's, within safe limits. The CEO keeps full
// control. This is the ONE definition; the admin reads it from
// GET /permissions/role-modules → presetLimits.
//   ceoOnlyRoles      — presets only the CEO edits: the CEO seat, the
//                       co-owner, and HR's own role (no self-promotion).
//   governanceModules — modules HR may neither grant nor remove on any
//                       preset: logins, module access itself, companies and
//                       the books' audit trail.
// Per-person module access (/permissions/users/:id/modules) stays CEO only.
export const PRESET_LIMITS = {
  // director (owner, 2026-10-18): its modules are fixed (DIRECTOR_MODULES) —
  // HR never touches it; the CEO's save is refused too (DIRECTOR_PRESET_FIXED).
  ceoOnlyRoles: ['admin', 'owner', 'hr', 'director'] as readonly UserRole[],
  governanceModules: ['role_management', 'role_modules', 'tenants', 'accounting_audit'] as readonly string[],
} as const

const MANAGEMENT_MODULES = ALL_MODULES.filter((m) => m !== 'chain' && m !== 'brands' && !API_WHATSAPP_ONLY.includes(m) && !CEO_ONLY_SET.has(m) && !DIRECTOR_ONLY_SET.has(m))
// 'manager' mirrors 'management' for everything EXCEPT the accounting trail,
// the API connectors, the Finance pre-bill register (none of whose routes
// admit the legacy role) and Emergency overrides.
const MANAGER_MODULES = MANAGEMENT_MODULES.filter(
  (m) => m !== 'accounting_audit' && m !== 'voided_prebills' && m !== 'emergency_overrides' && !API_CONNECTORS.includes(m),
)
// Co-owner: everything the CEO sees — P&L, payroll, projections, investment —
// EXCEPT the governance surfaces. Withholding role_management/role_modules is
// what makes the escalation rule real: an owner who could edit roles could
// grant themselves `admin`. Staff-account admin stays with the CEO for the
// same reason (creating an admin user is equivalent to self-promotion).
// The API connectors are the CEO's and IT's (Dev workspace, CONNECTOR_ADMINS)
// — the routes do not admit owner, so neither does the sidebar. Emergency
// overrides are an on-shift tool (see above), not the co-owner's.
const OWNER_MODULES = ALL_MODULES.filter(
  (m) => !['role_management', 'role_modules', 'accounting_audit', 'emergency_overrides', 'brands'].includes(m) && !API_CONNECTORS.includes(m) && !CEO_ONLY_SET.has(m) && !DIRECTOR_ONLY_SET.has(m),
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
    'emergency_overrides',
    'crm', 'complaints', 'reviews', 'campaigns',
    'staff_directory',
    'reports', 'integrations',
  ],
  // BOH managers rota the kitchen: /scheduling has always let them in
  // (ROTA_PLANNERS), so the Rota link is theirs too (audit PPL-08). The chef
  // reads the food-cost variance of the kitchen they run (food_cost) and logs
  // food a rider brought back (emergency_overrides).
  boh_management: [
    'dashboard', 'ops', 'orders', 'kds_all', 'kds_dashboard', 'expo_station',
    'emergency_overrides',
    'menu', 'recipes', 'par_sheet', 'inventory', 'kds_config', 'food_safety',
    'procurement', 'staff_directory', 'scheduling',
    'reports', 'food_cost',
  ],
  foh:       ['pos', 'reservations', 'tables', 'dispatch', 'orders', 'curbside'],
  boh:       ['kds_all', 'kds_dashboard', 'inventory', 'recipes', 'par_sheet', 'food_safety'],
  kitchen:   ['kds_dashboard', 'par_sheet', 'food_safety'],
  expediter: ['kds_all', 'expo_station', 'orders', 'par_sheet', 'food_safety'],
  cashier:   ['dashboard', 'pos', 'orders', 'curbside', 'tables'],
  procurement: ['procurement', 'inventory', 'reports'],
  // brands: the brand editor's brand info (owner, 2026-10-20); tax / legal / look stay the CEO's on the route.
  marketing: [
    'marketing_workspace', 'crm', 'campaigns', 'complaints', 'reviews',
    'calendar', 'media', 'promos', 'analytics', 'storefront', 'brands',
  ],
  brand_manager: [
    'brand_dashboard',
    'marketing_workspace', 'crm', 'campaigns', 'complaints', 'reviews',
    'calendar', 'media', 'promos', 'analytics', 'storefront', 'brands',
  ],
  fnb_manager: [
    'fnb_dashboard',
    'dashboard', 'ops', 'orders', 'refunds', 'curbside',
    'kds_all', 'kds_dashboard', 'expo_station',
    'menu', 'recipes', 'par_sheet', 'inventory', 'kds_config', 'food_safety',
    // Buying (owner decision 47: the F&B manager owns Operations — "all BOH and
    // FOH, menu, stock, buying"); missing until the 2026-10-17 simulation.
    'procurement',
    'pos', 'reservations', 'reservations_admin', 'scheduling', 'tables', 'dispatch', 'riders',
    'emergency_overrides',
    'complaints', 'reviews',
    'staff_directory',
    'finance_pl', 'accounting', 'reports', 'food_cost',
  ],
  // The Finance workspace (lib/workspaces.ts). Each of these has a route that
  // lets finance in (audit BOOKS-02 / PPL-08): 'payroll' is the payroll
  // register (GET /hr/payroll/runs, read-only) and tip pools; 'capital' and
  // 'projections' are /finance/* and /projections; 'food_cost' is
  // /reports/food-cost.
  finance: [
    'dashboard', 'orders', 'pos',
    'finance_pl', 'payroll', 'accounting', 'gift_cards', 'reconciliation',
    'exceptions', 'capital', 'projections', 'reports', 'voided_prebills', 'food_cost',
  ],
  // 'payroll' = tip pools (HR runs the people side of the split); HR payroll
  // itself is staff_hr.
  // 'role_modules' = Role presets (owner, 2026-10-16: "Give the presets thing
  // to HR"), within PRESET_LIMITS — the CEO-only roles and the governance
  // modules stay the CEO's (PUT /permissions/role-modules enforces them).
  hr: [
    'staff_directory', 'staff_hr', 'payroll', 'scheduling', 'role_modules',
  ],
  // IT / developer — owns the Dev workspace (decision 47, lib/workspaces.ts).
  // The API section (WhatsApp + POS connector) is theirs with the CEO.
  it: ['api_whatsapp', 'api_pos', 'integrations', 'audit_log', 'notifications', 'help'],
  // Director (owner, 2026-10-18): the read-only Director page and nothing
  // else — fixed (DIRECTOR_MODULES).
  director: [...DIRECTOR_MODULES],
}

export function isKnownModuleId(id: string): boolean { return MODULE_ID_SET.has(id) }

// ── Role-override cache ─────────────────────────────────────────────────────
let overrideCache: { at: number; rows: Map<UserRole, string[]> } | null = null
const CACHE_TTL_MS = 30_000

export function invalidateModuleAccessCache() { overrideCache = null }

// ── New default modules reach SAVED override rows (once) ────────────────────
// A RoleModuleAccess row is a FULL allow-list: it replaces the role's defaults.
// So when a module id is added to a role's defaults, any role the CEO has
// already saved in the matrix silently does NOT get it — e.g. an `it` row saved
// before the POS connector shipped would 403 IT on every /connectors call.
//
// Each grant below is applied to the saved rows exactly ONCE (a marker in the
// platform `settings` table records it), appending the module to the rows of
// every role whose defaults now hold it. After that the row is the CEO's again:
// untick the module and it stays unticked. Roles with no saved row already get
// it from the defaults. Data only — no schema change.
//
// Add a grant here whenever a module id is added to an existing role's
// defaults (the role set is derived from DEFAULT_MODULE_ACCESS, so it cannot
// drift). Runs at boot (index.ts) and, failing that, before the first override
// read in each process.
export const MODULE_GRANTS: readonly string[] = [
  // POS connector + pre-bills (spec D13 / §17.1, 2026-10-11).
  'api_pos', 'api_whatsapp', 'voided_prebills',
  // CEO workspace → Approvals (owner decisions D2/D3, 2026-10-11): reaches
  // the saved rows of owner / management / legacy manager, whose defaults
  // are "every module except …" and so now hold it.
  'approvals',
  // Finance wave B (2026-10-14): the food-cost variance report (fnb_manager,
  // boh_management, finance, owner, management, legacy manager) and Emergency
  // overrides (foh_management, boh_management, fnb_manager, management).
  'food_cost', 'emergency_overrides',
  // The Trash bin (2026-10-15): owner / management / legacy manager defaults
  // ("every module except …") now hold it.
  'trash',
  // Role presets moved to HR (owner, 2026-10-16). Scoped to hr in
  // MODULE_GRANT_ROLES: management / legacy manager defaults already hold it,
  // and a saved row of theirs is left exactly as the CEO saved it.
  'role_modules',
  // The F&B manager owns buying (decision 47; found by the simulated month,
  // 2026-10-17). Scoped to fnb_manager in MODULE_GRANT_ROLES.
  'procurement',
  // Finance runs the till (owner, 2026-10-20). Scoped to finance in MODULE_GRANT_ROLES.
  'pos',
  // Brand info goes to marketing (owner, 2026-10-20). Scoped in MODULE_GRANT_ROLES.
  'brands',
]
/**
 * Grants that reach only SOME of the roles whose defaults hold the module
 * (default: every such role — rolesGrantedByDefault). Read by applyModuleGrants.
 */
export const MODULE_GRANT_ROLES: Readonly<Partial<Record<string, readonly UserRole[]>>> = {
  role_modules: ['hr'],
  procurement: ['fnb_manager'],
  pos: ['finance'],
  brands: ['marketing', 'brand_manager'],
}
export const MODULE_GRANTS_MARKER_KEY = 'moduleAccess.grantsApplied'

// ── Modules TAKEN AWAY from saved rows (once) ───────────────────────────────
// The mirror of MODULE_GRANTS: when a module leaves every non-admin role, the
// saved RoleModuleAccess rows and users' moduleAllow that still list it are
// cleaned once (marker in `settings`). Enforcement does not depend on it —
// CEO_ONLY_MODULES are dropped on every read — this keeps the Module Access
// matrix and the staff screen honest. Each entry has a stable key.
export const MODULE_REVOKES: ReadonlyArray<{ key: string; modules: readonly string[] }> = [
  // (2026-10-14's 'brands-ceo-only' revoke was retired on 2026-10-20 when brand info went to marketing; it had
  // run on live. Kept off the list so a fresh copy never takes back the grant above.)
]
export const MODULE_REVOKES_MARKER_KEY = 'moduleAccess.revokesApplied'

/** Non-admin roles whose defaults hold `moduleId` — who a grant adds it for. */
export function rolesGrantedByDefault(moduleId: string): UserRole[] {
  return (Object.keys(DEFAULT_MODULE_ACCESS) as UserRole[])
    .filter((r) => r !== 'admin' && DEFAULT_MODULE_ACCESS[r].includes(moduleId))
}

function parseMarker(value: string | undefined): string[] {
  if (!value) return []
  try {
    const v = JSON.parse(value) as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * Apply every pending MODULE_GRANTS entry to the saved override rows, once.
 * Idempotent and safe to run concurrently: each row update is conditional on
 * the module being absent (`NOT has`), and the marker is a union.
 * Returns the grants applied and the roles whose rows changed.
 */
export async function applyModuleGrants(): Promise<{ applied: string[]; roles: UserRole[] }> {
  const marker = await prisma.setting.findUnique({ where: { key: MODULE_GRANTS_MARKER_KEY } })
  const done = new Set(parseMarker(marker?.value))
  const pending = MODULE_GRANTS.filter((m) => !done.has(m))
  if (pending.length === 0) return { applied: [], roles: [] }

  const touched = new Set<UserRole>()
  for (const moduleId of pending) {
    const scoped = MODULE_GRANT_ROLES[moduleId]
    const roles = scoped ? rolesGrantedByDefault(moduleId).filter((r) => scoped.includes(r)) : rolesGrantedByDefault(moduleId)
    for (const role of roles) {
      const r = await prisma.roleModuleAccess.updateMany({
        where: { role, NOT: { modules: { has: moduleId } } },
        data: { modules: { push: moduleId } },
      })
      if (r.count > 0) touched.add(role)
    }
  }
  const value = JSON.stringify([...new Set([...done, ...pending])])
  // createMany+skipDuplicates then update, not upsert: two processes booting
  // together would race an upsert's INSERT into a unique violation.
  await prisma.setting.createMany({ data: [{ key: MODULE_GRANTS_MARKER_KEY, value }], skipDuplicates: true })
  await prisma.setting.update({ where: { key: MODULE_GRANTS_MARKER_KEY }, data: { value } })
  invalidateModuleAccessCache()
  return { applied: pending, roles: [...touched] }
}

/**
 * Apply every pending MODULE_REVOKES entry once: strip its modules from every
 * saved role row and from every user's moduleAllow. Conditional updates
 * (only rows that still list the module) and a union marker, so it is
 * idempotent and safe to run from two processes at once. moduleDeny is left
 * alone (a deny of a module nobody holds is harmless).
 */
export async function applyModuleRevokes(): Promise<{ applied: string[]; roleRows: number; users: number }> {
  const marker = await prisma.setting.findUnique({ where: { key: MODULE_REVOKES_MARKER_KEY } })
  const done = new Set(parseMarker(marker?.value))
  const pending = MODULE_REVOKES.filter((r) => !done.has(r.key))
  if (pending.length === 0) return { applied: [], roleRows: 0, users: 0 }

  let roleRows = 0
  let users = 0
  for (const rev of pending) {
    for (const moduleId of rev.modules) {
      const rows = await prisma.roleModuleAccess.findMany({ where: { modules: { has: moduleId } }, select: { id: true, modules: true } })
      for (const r of rows) {
        // Conditional on the row still listing it — a concurrent run is a no-op.
        const u = await prisma.roleModuleAccess.updateMany({
          where: { id: r.id, modules: { has: moduleId } },
          data: { modules: r.modules.filter((m) => m !== moduleId) },
        })
        roleRows += u.count
      }
      const people = await prisma.user.findMany({ where: { moduleAllow: { has: moduleId } }, select: { id: true, moduleAllow: true } })
      for (const p of people) {
        const u = await prisma.user.updateMany({
          where: { id: p.id, moduleAllow: { has: moduleId } },
          data: { moduleAllow: p.moduleAllow.filter((m) => m !== moduleId) },
        })
        users += u.count
      }
    }
  }
  const value = JSON.stringify([...new Set([...done, ...pending.map((r) => r.key)])])
  await prisma.setting.createMany({ data: [{ key: MODULE_REVOKES_MARKER_KEY, value }], skipDuplicates: true })
  await prisma.setting.update({ where: { key: MODULE_REVOKES_MARKER_KEY }, data: { value } })
  invalidateModuleAccessCache()
  return { applied: pending.map((r) => r.key), roleRows, users }
}

// Once per process, before the first override read. Fails open (the next
// process tries again); the boot call in index.ts normally got there first.
let grantsOnce: Promise<void> | null = null
function ensureModuleGrants(): Promise<void> {
  if (!grantsOnce) {
    grantsOnce = applyModuleGrants()
      .then(() => applyModuleRevokes())
      .then(() => undefined, () => { grantsOnce = null })
  }
  return grantsOnce
}

async function roleOverrides(): Promise<Map<UserRole, string[]>> {
  if (overrideCache && Date.now() - overrideCache.at < CACHE_TTL_MS) return overrideCache.rows
  await ensureModuleGrants()
  const rows = await prisma.roleModuleAccess.findMany()
  const map = new Map<UserRole, string[]>(rows.map((r) => [r.role, r.modules]))
  overrideCache = { at: Date.now(), rows: map }
  return map
}

/**
 * A role's base case (the CEO's saved row ?? the in-code default), without
 * CEO-only modules — what a person of that role holds with no per-person ticks.
 * The CEO's per-person editor (PUT /permissions/users/:id/modules) stores a
 * person's choice as the difference from this.
 */
export async function rolePresetModules(role: UserRole): Promise<string[]> {
  if (role === 'admin') return [...ALL_MODULES]
  if (role === 'director') return [...DIRECTOR_MODULES]
  const overrides = await roleOverrides()
  return withoutCeoOnlyModules(knownModulesOnly(overrides.get(role) ?? DEFAULT_MODULE_ACCESS[role] ?? []))
}

/** Effective module set: (override ?? default) ∪ moduleAllow − moduleDeny. Admin sees all. */
export async function effectiveModulesForUser(user: {
  role: UserRole
  moduleAllow?: string[]
  moduleDeny?: string[]
}): Promise<Set<string>> {
  if (user.role === 'admin') return new Set(ALL_MODULES)
  // A director holds exactly the director modules — never a saved row, never
  // a per-person allow (owner, 2026-10-18: strictly read-only, own brands).
  if (user.role === 'director') return new Set(DIRECTOR_MODULES)
  const overrides = await roleOverrides()
  const base = new Set(knownModulesOnly(overrides.get(user.role) ?? DEFAULT_MODULE_ACCESS[user.role] ?? []))
  for (const m of knownModulesOnly(user.moduleAllow ?? [])) base.add(m)
  for (const m of user.moduleDeny ?? []) base.delete(m)
  for (const m of CEO_ONLY_MODULES) base.delete(m)   // never through a row or an allow
  for (const m of DIRECTOR_MODULES) base.delete(m)   // the director's alone (and the CEO's)
  return base
}

/**
 * Scheduled reports (POST /setup/scheduled-reports; workers/scheduledReports.ts):
 * a report type whose page is module-gated needs the same module(s) — the
 * read side of that page's GATED_PREFIXES rule — to be scheduled AND every
 * time it runs (the creator's access is re-read, so the CEO's untick stops
 * the emails). /setup itself is not module-gated, so without this a manager
 * refused the page (foh_management on the food-cost variance) could have it
 * emailed anywhere.
 */
export const SCHEDULED_REPORT_MODULES: Readonly<Record<string, readonly string[]>> = {
  food_cost: ['food_cost', 'accounting'],    // /reports/food-cost (readAnyOf)
  ap_aging:  ['procurement', 'accounting'],  // /procurement/ap-aging
}

/** May this login run (or schedule) `reportType`? Admin always; else its effective modules. */
export async function mayScheduleReport(
  user: { role: UserRole; moduleAllow?: string[]; moduleDeny?: string[] },
  reportType: string,
): Promise<boolean> {
  const needs = SCHEDULED_REPORT_MODULES[reportType]
  if (!needs || user.role === 'admin') return true
  const modules = await effectiveModulesForUser(user)
  return needs.some((m) => modules.has(m))
}

// ── URL → required-module map (first match wins; ANY listed module passes) ──
// Paths are matched after stripping the /api/v1 prefix. Covers the
// audit-flagged financial/reporting surfaces, the HR back office and (wave 3,
// UI-12) the live-operations reads — see header comment.
//
// A rule's `anyOf` is EVERY module whose pages call that prefix — the admin
// pages (frontend/admin lib/moduleCatalog.ts), the tablet (KDS / expo,
// dispatch, floor, customer lookup) and the till — so a role reaches the API
// exactly when its sidebar shows a page that needs it. A rule with `pattern`
// matches that regex instead of the plain prefix (for an id in the middle of
// the path); `prefix` then only documents it.
//
// Only STAFF sessions reach this (requireAuth / requireRefresh). Customer
// tokens (storefront), rider tokens (/rider*, /rider-auth*), signed webhooks
// and public routes never do — and '/riders' does not match '/rider/…'.
// A rule may also carry `readAnyOf`: the modules that may READ it (GET /
// HEAD) when that set is wider than who may write — e.g. finance reads the
// payables under /procurement with its 'accounting' module but never raises
// a PO or pays a bill through it. Writes always need `anyOf`.
const GATED_PREFIXES: Array<{ prefix: string; anyOf: string[]; readAnyOf?: string[]; pattern?: RegExp }> = [
  // Dev → API → WhatsApp connector: GET / PUT / POST test of the ONE
  // platform-wide gateway (auth/routes.ts). Whoever can change its URL can
  // redirect every company's signup, staff sign-in and 2FA code, so the CEO's
  // Module Access switch must actually close it (decision 34). NOT
  // /auth/integrations/delivery-status — that feeds the managers' banner.
  { prefix: '/auth/integrations/whatsapp', anyOf: ['api_whatsapp'] },
  // The P&L (and its by-brand tab) is THE P&L — reachable with the P&L module
  // or the accounting module, as the old /finance P&L was.
  { prefix: '/accounting/pl-ledger', anyOf: ['finance_pl', 'accounting'] },
  { prefix: '/accounting',    anyOf: ['accounting'] },
  // Shift corrections (owner, 2026-10-21): finance's fixes on a closed drawer, the CEO approves. The only
  // gated path under /pos (the till itself never is).
  { prefix: '/pos/shift-corrections', anyOf: ['accounting'] },
  // Reports → Food cost variance (wave B; the old /accounting/food-cost page
  // forwards here). Its own module — the 'reports' module does NOT open it
  // (foh_management and procurement hold reports, not food costs) — and the
  // accounting module may read it (the Accounting hub's gauge).
  { prefix: '/reports/food-cost', anyOf: ['food_cost'], readAnyOf: ['food_cost', 'accounting'] },
  // Sales quadrants (margin) is an Accounting page (/accounting/menu-engineering).
  { prefix: '/reports/menu-engineering', anyOf: ['accounting', 'reports'] },
  { prefix: '/reports',       anyOf: ['reports'] },
  { prefix: '/management',    anyOf: ['brand_dashboard', 'fnb_dashboard'] },
  // The one AP aging serves the Accounting AP aging page too, so finance
  // (accounting, no procurement) can open it.
  { prefix: '/procurement/ap-aging', anyOf: ['procurement', 'accounting'] },
  // Payables reads for finance (wave 3, UI-07): the Accounting hub's vendor
  // and PO widgets, petty cash's bill picker. Their GET routes admit
  // AP_READERS; every write (raise / approve / receive a PO, enter or pay a
  // bill, add a supplier) still needs the procurement module.
  //
  // Received, not billed (GRNI, wave B): finance works it as well as
  // procurement — finance REQUESTS a write-off of goods never billed, the CEO
  // approves it (the route's own guard decides). Before '/procurement/bills'.
  { prefix: '/procurement/grni',            anyOf: ['procurement', 'accounting'] },
  // Supplier bills, credit notes and payments are finance's work too (owner,
  // 2026-10-16): writes admit 'accounting' here; the routes' own
  // requireApWriterModule keeps finance to 'accounting' and every other role
  // to 'procurement' (procurement/routes.ts AP_WRITERS).
  { prefix: '/procurement/bills',           anyOf: ['procurement', 'accounting'] },
  { prefix: '/procurement/credit-notes',    anyOf: ['procurement', 'accounting'] },
  { prefix: '/procurement/payments',        anyOf: ['procurement', 'accounting'] },
  { prefix: '/procurement/purchase-orders', anyOf: ['procurement'], readAnyOf: ['procurement', 'accounting'] },
  // 'capital' reads the supplier picker (?view=picker) of the OpEx / CapEx
  // forms (vendor, filer status, WHT section); adding a supplier stays procurement.
  { prefix: '/procurement/suppliers',       anyOf: ['procurement'], readAnyOf: ['procurement', 'accounting', 'capital'] },
  { prefix: '/procurement',   anyOf: ['procurement'] },
  { prefix: '/reconciliation', anyOf: ['reconciliation'] },
  { prefix: '/gift-cards',    anyOf: ['gift_cards'] },
  // Dev → API → POS connector: configuration, go-live, fiscal documents and
  // card charges (modules/connectors/routes.ts). NOT the till's own
  // /pos/terminal/* and /pos/orders/:id/fiscal* (role-gated, ops-critical) nor
  // the vendor webhook /webhooks/pos (signed, no staff session).
  { prefix: '/connectors',    anyOf: ['api_pos'] },
  // Finance → Voided pre bills: the pre-bill register (modules/prebills).
  // NOT the till's /pos/orders/:id/pre-bill or /pos/pre-bills/:id/html —
  // printing a pre-bill must never depend on a Finance toggle.
  { prefix: '/pre-bills',     anyOf: ['voided_prebills'] },
  // Capital (CapEx tracker + the old capital ledger — every /finance route),
  // projections and tip pools (audit PPL-08). Their role arrays let every
  // manager tier in, so without these a FOH/BOH manager who holds none of the
  // modules read the capital ledger, projections and tip pools.
  { prefix: '/finance',       anyOf: ['capital'] },
  { prefix: '/projections',   anyOf: ['projections'] },
  // Tip pool pay (owner, 2026-10-17: "finance can pay tip pools with CEO's
  // approval"): the pay route admits 'accounting' too — the route itself
  // holds finance to 'accounting' and a CEO-posted pool, and every other
  // role to 'payroll' as before. Reading the pools stays 'payroll' (finance
  // holds it by default): a readAnyOf 'accounting' would open them to every
  // role with accounting (owner, management, fnb_manager — PPL-08).
  { prefix: '/tip-pools/:id/pay', anyOf: ['payroll', 'accounting'], pattern: /^\/tip-pools\/[^/]+\/pay\/?$/ },
  { prefix: '/tip-pools',     anyOf: ['payroll'] },
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
  // Finance reads the payroll register with its 'payroll' module (BOOKS-02);
  // preparing, approving and paying it stay with the HR_ADMIN / approver
  // role arrays in hr/routes.ts.
  { prefix: '/hr/payroll',          anyOf: ['staff_hr', 'payroll'] },
  { prefix: '/hr/letters',          anyOf: ['staff_hr'] },
  { prefix: '/hr/reports',          anyOf: ['staff_hr'] },
  { prefix: '/hr/settings',         anyOf: ['staff_hr'] },
  { prefix: '/hr/forms',            anyOf: ['staff_hr'] },
  { prefix: '/hr/sections',         anyOf: ['staff_hr'] },
  { prefix: '/hr/dashboard',        anyOf: ['staff_hr'] },
  { prefix: '/hr/due',              anyOf: ['staff_hr'] },
  // Finance marks approved settlements paid, books unposted ones and reads
  // the "to pay" list (owner, 2026-10-16) — with its 'accounting' module; the
  // routes' own guard (hr/routes.ts PAYROLL_PAYERS) decides the role.
  { prefix: '/hr/final-settlement/to-pay|post-unposted|:id/paid', anyOf: ['staff_hr', 'accounting'], pattern: /^\/hr\/final-settlement\/(?:to-pay|post-unposted|[^/]+\/paid)\/?$/ },
  { prefix: '/hr/final-settlement', anyOf: ['staff_hr'] },
  { prefix: '/hr/org/units',        anyOf: ['staff_hr'] },
  { prefix: '/hr/org/departments',  anyOf: ['staff_hr'] },
  // HR → Attendance (the Today board and punch log, hr/attendanceTracking.ts):
  // its one page is /hr/attendance under staff_hr. A manager role reads it
  // only when the CEO gives it staff_hr (the role array is HR team + managers).
  { prefix: '/hr/attendance-tracking', anyOf: ['staff_hr'] },

  // ── Live operations (wave 3, UI-12) ──────────────────────────────────────
  // Their role arrays are ALL_STAFF (every floor role works them), so before
  // these rules IT, marketing, HR and procurement read the live order
  // pipeline and the refundable-orders list, and every role read the rider
  // roster, the dispatch board and the expo queue. These narrow them to the
  // roles whose modules hold a page that uses them. NOT the till's own
  // /pos/* (ring-up, pay, pre-bill, refund — role-gated in pos/routes.ts) nor
  // the per-item bump PATCH /order-items/:id/status. The KDS's step bump,
  // fire and hand-off ARE under /expo below, and the tablet's mark-ready is
  // PATCH /orders/:id/status: a Module Access row that strips every kitchen
  // module from a role stops its KDS (see the header comment).
  //
  // /orders — callers, by module:
  //   orders        /orders, /orders/[id], courses, split (admin)
  //   refunds       /refunds (the refundable-orders list, /orders?status=…)
  //   curbside      /orders/curbside (admin + tablet)
  //   pos           the till's open-orders list and /orders/:id (tillApi.ts)
  //   kds_dashboard /kds/[station] (useKdsSocket → /orders/:id), tablet KDS
  //                 expo lane (PATCH /orders/:id/status)
  //   kds_all       the live-station pages under the Kitchen view
  //   expo_station  /expo → /orders/:id/courses, fire-course
  //   riders        /riders (open delivery orders to assign)
  //   dispatch      tablet Dispatch screen (/orders?status=…)
  // So cashier (pos, orders, curbside), foh, kitchen, boh, expediter and every
  // manager tier keep it; finance keeps it ('orders'); marketing,
  // brand_manager, hr, it and procurement — none of these — are refused.
  { prefix: '/orders', anyOf: ['orders', 'refunds', 'curbside', 'pos', 'kds_dashboard', 'kds_all', 'expo_station', 'riders', 'dispatch'] },
  // /expo — the expo queue and the station queues: admin /expo
  // (expo_station), /kds and /kds/[station] (kds_dashboard; the live-station
  // children under kds_all), the tablet KDS (kitchen, boh, expediter). It
  // covers the line's WRITES too — POST /expo/steps/:id/bump and
  // /expo/orders/:id/fire|handoff (and the managers' /reject) — so a role
  // needs one of these modules to bump, fire or hand off a ticket.
  { prefix: '/expo',     anyOf: ['expo_station', 'kds_dashboard', 'kds_all'] },
  // /dispatch — admin /dispatch (dispatch), /riders (riders: assign, rider
  // status) and the tablet Dispatch screen. A delivery is completed with the
  // customer's code; staff "Delivered" only while the company's code-only
  // switch is off (resumed 2026-10-15).
  { prefix: '/dispatch', anyOf: ['dispatch', 'riders'] },
  // /head-offices — CEO → Companies → Head offices (the routes are CEO-only too).
  { prefix: '/head-offices', anyOf: ['tenants'] },
  // /hr/head-office-transfers — the CEO's people move (routes are ADMIN_ONLY too).
  { prefix: '/hr/head-office-transfers', anyOf: ['staff_hr'] },
  // /riders — the roster, history, fleet agreements: admin /riders only. The
  // rider app is /rider/* with a rider token and never reaches this.
  { prefix: '/riders',   anyOf: ['riders'] },
  // Operations → Emergency overrides: PARKED with delivery (owner,
  // 2026-10-13). No route is registered under this prefix and no page links
  // to it; the gate rule and module id stay so the resume needs no access
  // change (reroute the hand-over code to the rider, log food brought back).
  { prefix: '/emergency-overrides', anyOf: ['emergency_overrides'] },
  // CRM. The guest-context panel (GET context / PATCH notes) also sits on the
  // Reservations page (CustomerContextSidebar) and the tablet's Customer
  // screen; Reach out (POST /crm/conversations) on Complaints and Reviews;
  // the campaign builder reads segments and the summary. Everything else under
  // /crm — the customer list and profile, bans, strikes, the naughty list —
  // is the CRM module's (UI-12: boh_management read /crm/customers).
  { prefix: '/crm/customers/:id/context|notes', pattern: /^\/crm\/customers\/[^/]+\/(context|notes)$/, anyOf: ['crm', 'reservations'] },
  { prefix: '/crm/conversations',      anyOf: ['crm', 'complaints', 'reviews'] },
  // The feedback inbox carries contact-form names, phones and emails: only the
  // Reviews module's Messages page reads it (the public POST is unauthenticated
  // and never reaches this gate).
  { prefix: '/feedback',               anyOf: ['reviews'] },
  { prefix: '/crm/campaigns',          anyOf: ['campaigns', 'crm'] },
  { prefix: '/crm/behavioral-segments', anyOf: ['crm', 'campaigns'] },
  { prefix: '/crm/summary',            anyOf: ['crm', 'campaigns'] },
  // A blocked customer's appeal is worked on the Complaints page (help desk):
  // lifting the ban or releasing a contact (email / number) is open to the
  // complaints module as well as CRM. Everything else under /crm/bans stays CRM.
  { prefix: '/crm/bans/:id/lift|release-contact', pattern: /^\/crm\/bans\/[^/]+\/(lift|release-contact)$/, anyOf: ['crm', 'complaints'] },
  { prefix: '/crm',                    anyOf: ['crm'] },
  // /complaints — the Complaints page only. Ban appeals carry the customer's
  // phone, email and strikes, so the role arrays alone (ALL_STAFF) are too wide.
  { prefix: '/complaints',             anyOf: ['complaints'] },
  // Director → Brand performance (owner, 2026-10-18). The routes admit only
  // director + admin; this keeps the module the one switch on top.
  { prefix: '/director',               anyOf: ['director_view'] },
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
  /** The HTTP method; only GET / HEAD may use a rule's `readAnyOf`. Omitted = treated as a write. */
  method?: string,
): Promise<void> {
  if (user.role === 'admin') return
  const path = (url.split('?')[0] ?? '').replace(/^\/api\/v1/, '')
  const rule = GATED_PREFIXES.find((r) => r.pattern
    ? r.pattern.test(path)
    : path === r.prefix || path.startsWith(r.prefix + '/') || path.startsWith(r.prefix + '?'))
  if (!rule) return
  let modules: Set<string>
  try {
    modules = await effectiveModulesForUser(user)
  } catch {
    return   // fail open — see docstring
  }
  const isRead = method === 'GET' || method === 'HEAD'
  const allowed = isRead && rule.readAnyOf ? rule.readAnyOf : rule.anyOf
  if (!allowed.some((m) => modules.has(m))) {
    throw new ForbiddenError(`Your account does not have access to this module (${rule.anyOf[0]}). Ask the CEO to enable it in Module Access.`)
  }
}
