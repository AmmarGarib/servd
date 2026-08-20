// Single source of truth for the platform's permission catalogue.
//
// - `key` is the stable identifier persisted in `role_permissions` and read
//   by `requirePermission()` middleware + the `useCan()` frontend hook.
// - `label` + `desc` are operator-facing; shown in the matrix editor.
// - `category` groups permissions on the editor UI.
// - `defaultsByRole` seeds the DB on first startup and is merged on every
//   restart — adding a new permission to this list automatically gives admins
//   the configured default and shows it in the matrix.

import type { UserRole } from '@prisma/client'

export interface Permission {
  key: string
  label: string
  desc: string
  category: 'live' | 'service' | 'kitchen' | 'menu' | 'finance' | 'crm' | 'platform'
  defaultsByRole: Record<UserRole, boolean>
}

// Default-bundle helpers. Every bundle covers every role in UserRole — the
// expanded enum (post 2026-05-13) has 14 values:
//   admin (CEO), manager (legacy), management, foh_management, boh_management,
//   foh, boh, kitchen, expediter, cashier, procurement, marketing, finance, hr.
// Specialist roles (procurement / finance / hr) default to a tight allow-list
// scoped to their domain; the CEO can edit the matrix at /configuration/roles.
// brand_manager = marketing-tier manager (Brand dashboard owner).
// fnb_manager   = ops manager over BOH + FOH (F&B dashboard owner).
const ON: Record<UserRole, boolean> = {
  admin: true,  owner: true,  manager: true,  management: true,  foh_management: true, boh_management: true,
  foh: true,    boh: true,      kitchen: true,     expediter: true,      cashier: true,
  procurement: true, marketing: true, brand_manager: true, fnb_manager: true, finance: true, hr: true,
}
const MGR: Record<UserRole, boolean> = {
  admin: true,  owner: true,  manager: true,  management: true,  foh_management: true, boh_management: true,
  foh: false,   boh: false,     kitchen: false,    expediter: false,     cashier: false,
  procurement: false, marketing: false, brand_manager: true, fnb_manager: true, finance: false, hr: false,
}
const ADMIN: Record<UserRole, boolean> = {
  // owner deliberately EXCLUDED — this bundle gates staff:edit,
  // permissions:edit and tokens:manage, each of which would let a co-owner
  // escalate to admin. Widen per-permission at /configuration/roles if wanted.
  admin: true,  owner: false,  manager: false, management: false, foh_management: false, boh_management: false,
  foh: false,   boh: false,     kitchen: false,    expediter: false,      cashier: false,
  procurement: false, marketing: false, brand_manager: false, fnb_manager: false, finance: false, hr: false,
}
const KITCHEN: Record<UserRole, boolean> = {
  admin: true,  owner: true,  manager: true,  management: true,  foh_management: false, boh_management: true,
  foh: false,   boh: true,      kitchen: true,     expediter: true,       cashier: false,
  procurement: false, marketing: false, brand_manager: false, fnb_manager: true, finance: false, hr: false,
}
const POS: Record<UserRole, boolean> = {
  admin: true,  owner: true,  manager: true,  management: true,  foh_management: true, boh_management: false,
  foh: true,    boh: false,     kitchen: false,    expediter: false,     cashier: true,
  procurement: false, marketing: false, brand_manager: false, fnb_manager: true, finance: false, hr: false,
}
const MARKETING: Record<UserRole, boolean> = {
  admin: true,  owner: true,  manager: true,  management: true,  foh_management: false, boh_management: false,
  foh: false,   boh: false,     kitchen: false,    expediter: false,      cashier: false,
  procurement: false, marketing: true,  brand_manager: true, fnb_manager: false, finance: false, hr: false,
}
const FINANCE: Record<UserRole, boolean> = {
  admin: true,  owner: true,  manager: true,  management: true,  foh_management: false, boh_management: false,
  foh: false,   boh: false,     kitchen: false,    expediter: false,      cashier: false,
  procurement: false, marketing: false, brand_manager: false, fnb_manager: false, finance: true, hr: false,
}
const NONE: Record<UserRole, boolean> = {
  admin: true,  owner: false,  manager: false, management: false, foh_management: false, boh_management: false,
  foh: false,   boh: false,     kitchen: false,    expediter: false,      cashier: false,
  procurement: false, marketing: false, brand_manager: false, fnb_manager: false, finance: false, hr: false,
}
// Suppress unused warning when FINANCE isn't referenced in the catalogue yet.
void FINANCE

export const PERMISSIONS: Permission[] = [
  // Live / overview
  { key: 'dashboard:view',        label: 'View dashboard',         desc: 'Access the operations dashboard', category: 'live',     defaultsByRole: MGR },
  { key: 'chain:view',            label: 'Chain rollup',           desc: 'See all brands side-by-side',     category: 'live',     defaultsByRole: ADMIN },
  { key: 'orders:view',           label: 'View orders',            desc: 'Browse the order list + details', category: 'live',     defaultsByRole: ON },
  { key: 'orders:refund',         label: 'Refund order',           desc: 'Reverse a paid order with reason', category: 'live',    defaultsByRole: MGR },
  { key: 'orders:cancel',         label: 'Cancel order',           desc: 'Cancel a non-completed order',    category: 'live',     defaultsByRole: MGR },

  // Service / floor
  { key: 'pos:operate',           label: 'Operate POS',            desc: 'Take orders + payments at POS',   category: 'service',  defaultsByRole: POS },
  { key: 'pos:open_shift',        label: 'Open shift',             desc: 'Open a cash drawer / till',       category: 'service',  defaultsByRole: POS },
  { key: 'pos:close_shift',       label: 'Close shift',            desc: 'Close till + reconcile cash',     category: 'service',  defaultsByRole: POS },
  { key: 'pos:override_price',    label: 'Override price',         desc: 'Sell at a non-menu price',        category: 'service',  defaultsByRole: MGR },
  { key: 'pos:comp',              label: 'Comp / freebie',         desc: 'Mark items as complimentary',     category: 'service',  defaultsByRole: MGR },
  { key: 'tables:manage',         label: 'Manage tables',          desc: 'Edit floor plan, table assignments', category: 'service', defaultsByRole: MGR },
  { key: 'reservations:manage',   label: 'Manage reservations',    desc: 'Create / edit table bookings',    category: 'service',  defaultsByRole: POS },
  { key: 'riders:dispatch',       label: 'Dispatch riders',        desc: 'Assign deliveries to riders',     category: 'service',  defaultsByRole: MGR },

  // Kitchen
  { key: 'kds:operate',           label: 'Operate KDS',            desc: 'Bump / hold / fire / recall items', category: 'kitchen', defaultsByRole: KITCHEN },
  { key: 'kds:photo_capture',     label: 'Capture plating photos', desc: 'Snap a photo on bump',            category: 'kitchen',  defaultsByRole: KITCHEN },
  { key: 'kds:void_item',         label: 'Void item',              desc: 'Remove an item from a fired ticket', category: 'kitchen', defaultsByRole: MGR },
  { key: 'inventory:view',        label: 'View inventory',         desc: 'See stock levels',                category: 'kitchen',  defaultsByRole: KITCHEN },
  { key: 'inventory:adjust',      label: 'Adjust stock',           desc: 'Manual stock corrections + waste log', category: 'kitchen', defaultsByRole: MGR },
  { key: 'inventory:86',          label: 'Mark item 86',           desc: 'Toggle a menu item available/sold-out', category: 'kitchen', defaultsByRole: KITCHEN },
  { key: 'recipes:view',          label: 'View recipes',           desc: 'See recipe steps + ingredient lists', category: 'kitchen', defaultsByRole: KITCHEN },
  { key: 'recipes:edit',          label: 'Edit recipes',           desc: 'Change steps, ingredients, costing', category: 'kitchen', defaultsByRole: MGR },

  // Menu
  { key: 'menu:view',             label: 'View menu',              desc: 'Browse menu structure',           category: 'menu',     defaultsByRole: ON },
  { key: 'menu:edit',             label: 'Edit menu',              desc: 'Add / edit items, prices, categories', category: 'menu', defaultsByRole: MGR },
  { key: 'menu:delete',           label: 'Delete menu items',      desc: 'Permanently remove items',        category: 'menu',     defaultsByRole: ADMIN },
  { key: 'storefront:edit',       label: 'Edit storefront',        desc: 'Hero, banner, layout, hours',     category: 'menu',     defaultsByRole: MGR },

  // Finance
  { key: 'reports:view',          label: 'View reports',           desc: 'Sales totals, top items, station times', category: 'finance', defaultsByRole: MGR },
  { key: 'reports:financial',     label: 'View financial reports', desc: 'P&L, food cost, margin per item', category: 'finance',  defaultsByRole: MGR },
  { key: 'accounting:view',       label: 'Accounting hub',         desc: 'Journal entries, sales tax return', category: 'finance', defaultsByRole: MGR },
  { key: 'procurement:view',      label: 'View procurement',       desc: 'Suppliers, POs, bills',           category: 'finance',  defaultsByRole: MGR },
  { key: 'procurement:edit',      label: 'Edit procurement',       desc: 'Create POs, approve bills, pay vendors', category: 'finance', defaultsByRole: MGR },
  { key: 'fbr:submit',            label: 'Submit to FBR',          desc: 'Trigger FBR e-invoice submission', category: 'finance', defaultsByRole: ADMIN },

  // Marketing — anchored on the outside-agency use case. Marketing role gets
  // these by default; manager + admin always have them too.
  { key: 'marketing:workspace',   label: 'Marketing workspace',    desc: 'Access the marketing-team landing page',           category: 'crm', defaultsByRole: MARKETING },
  { key: 'marketing:campaigns',   label: 'Send campaigns',         desc: 'Create + send email / SMS / WhatsApp blasts',      category: 'crm', defaultsByRole: MARKETING },
  { key: 'marketing:promos',      label: 'Manage promo codes',     desc: 'Create + edit + retire promo / discount codes',    category: 'crm', defaultsByRole: MARKETING },
  { key: 'marketing:calendar',    label: 'Content calendar',       desc: 'Schedule + publish social posts',                  category: 'crm', defaultsByRole: MARKETING },
  { key: 'marketing:storefront',  label: 'Storefront edits',       desc: 'Hero, banner, brand microsite layout',             category: 'crm', defaultsByRole: MARKETING },
  { key: 'marketing:media',       label: 'Media library',          desc: 'Upload / browse marketing creative',               category: 'crm', defaultsByRole: MARKETING },
  { key: 'marketing:analytics',   label: 'Marketing analytics',    desc: 'Funnel, segment, campaign performance reports',    category: 'crm', defaultsByRole: MARKETING },
  { key: 'marketing:approval',    label: 'Approve marketing work', desc: 'Sign off on agency-submitted campaigns / posts',   category: 'crm', defaultsByRole: MGR },

  // Customers / CRM
  { key: 'customers:view',        label: 'View customers',         desc: 'Customer list, history, loyalty', category: 'crm',      defaultsByRole: POS },
  { key: 'customers:edit',        label: 'Edit customers',         desc: 'Adjust profile, contact info',    category: 'crm',      defaultsByRole: MGR },
  { key: 'customers:wallet',      label: 'Adjust customer wallet', desc: 'Credit / debit wallet balance',   category: 'crm',      defaultsByRole: MGR },
  { key: 'segments:manage',       label: 'Manage segments',        desc: 'Create / edit customer segments', category: 'crm',      defaultsByRole: MGR },
  { key: 'campaigns:manage',      label: 'Run campaigns',          desc: 'Send marketing blasts',           category: 'crm',      defaultsByRole: MGR },
  { key: 'complaints:view',       label: 'View complaints',        desc: 'See submitted complaints',        category: 'crm',      defaultsByRole: ON },
  { key: 'complaints:resolve',    label: 'Resolve complaints',     desc: 'Update status, write resolution', category: 'crm',      defaultsByRole: MGR },

  // Platform / config
  { key: 'staff:view',            label: 'View staff',             desc: 'See team list',                   category: 'platform', defaultsByRole: MGR },
  { key: 'staff:edit',            label: 'Edit staff',             desc: 'Create / disable users, assign roles', category: 'platform', defaultsByRole: ADMIN },
  { key: 'permissions:edit',      label: 'Edit permissions',       desc: 'Change what each role can do',    category: 'platform', defaultsByRole: ADMIN },
  { key: 'settings:view',         label: 'View settings',          desc: 'Open the configuration hub',      category: 'platform', defaultsByRole: MGR },
  { key: 'settings:edit',         label: 'Edit settings',          desc: 'Change concept / station / preferences', category: 'platform', defaultsByRole: MGR },
  { key: 'integrations:edit',     label: 'Edit integrations',      desc: 'Connect / disconnect R2, SMTP, Twilio, aggregators', category: 'platform', defaultsByRole: ADMIN },
  { key: 'tokens:manage',         label: 'Manage API tokens',      desc: 'Issue + revoke bearer tokens',    category: 'platform', defaultsByRole: ADMIN },
  { key: 'audit:view',            label: 'View audit log',         desc: 'See who did what, when',          category: 'platform', defaultsByRole: MGR },
  { key: 'billing:view',          label: 'View billing',           desc: 'Subscription plan + invoices',    category: 'platform', defaultsByRole: ADMIN },
]

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key)
export type PermissionKey = (typeof PERMISSION_KEYS)[number]

// ─── Seeding ──────────────────────────────────────────────────────────────────
// Runs on backend startup. Inserts any missing role × permission rows using
// the catalogue defaults. Existing rows are NEVER overwritten — admins keep
// their custom configuration across deploys.

import type { PrismaClient } from '@prisma/client'

export async function seedPermissions(prisma: PrismaClient): Promise<{ inserted: number }> {
  const ROLES = [
    'admin', 'manager', 'management', 'foh_management', 'boh_management',
    'foh', 'boh', 'kitchen', 'expediter', 'cashier',
    'procurement', 'marketing', 'brand_manager', 'fnb_manager', 'finance', 'hr',
  ] as UserRole[]
  const existing = await prisma.rolePermission.findMany({
    select: { role: true, permission: true },
  })
  const existingSet = new Set(existing.map((r) => `${r.role}::${r.permission}`))

  let inserted = 0
  for (const perm of PERMISSIONS) {
    for (const role of ROLES) {
      const key = `${role}::${perm.key}`
      if (existingSet.has(key)) continue
      await prisma.rolePermission.create({
        data: { role, permission: perm.key, enabled: perm.defaultsByRole[role] ?? false },
      })
      inserted++
    }
  }
  return { inserted }
}

// ─── Runtime checks ───────────────────────────────────────────────────────────

let cache: { byRole: Map<string, Set<string>>; expiresAt: number } | null = null
const CACHE_TTL_MS = 30_000

async function loadPermissions(prisma: PrismaClient): Promise<Map<string, Set<string>>> {
  const rows = await prisma.rolePermission.findMany({
    where: { enabled: true },
    select: { role: true, permission: true, enabled: true },
  })
  const byRole = new Map<string, Set<string>>()
  for (const r of rows) {
    if (!byRole.has(r.role)) byRole.set(r.role, new Set())
    byRole.get(r.role)!.add(r.permission)
  }
  return byRole
}

export async function userCan(prisma: PrismaClient, role: UserRole, permission: string): Promise<boolean> {
  if (role === 'admin') return true     // Admin always has everything — safety net
  const now = Date.now()
  if (!cache || cache.expiresAt < now) {
    cache = { byRole: await loadPermissions(prisma), expiresAt: now + CACHE_TTL_MS }
  }
  return cache.byRole.get(role)?.has(permission) ?? false
}

/**
 * Per-user permission check — same as userCan() but consults the user's
 * permissionAllow / permissionDeny override arrays first. Use this in
 * authorisation paths where the caller already has the user's ID; falls
 * back to role-level when the user has no overrides set.
 *
 *   permissionDeny  wins over everything (force-revoke)
 *   permissionAllow grants even if the role default says no
 *   otherwise → role default from the matrix
 */
export async function userCanWithOverrides(
  prisma: PrismaClient,
  user: { id: string; role: UserRole; permissionAllow?: string[]; permissionDeny?: string[] },
  permission: string,
): Promise<boolean> {
  if (user.permissionDeny?.includes(permission)) return false
  if (user.permissionAllow?.includes(permission)) return true
  return userCan(prisma, user.role, permission)
}

export function invalidatePermissionCache() {
  cache = null
}

export async function permissionsForRole(prisma: PrismaClient, role: UserRole): Promise<string[]> {
  if (role === 'admin') return PERMISSION_KEYS as string[]
  const now = Date.now()
  if (!cache || cache.expiresAt < now) {
    cache = { byRole: await loadPermissions(prisma), expiresAt: now + CACHE_TTL_MS }
  }
  return Array.from(cache.byRole.get(role) ?? [])
}

/**
 * Effective permission list for one user — role default unioned with their
 * permissionAllow array, minus their permissionDeny array. Used by the
 * `/permissions/me` endpoint so the frontend useCan() hook sees the same
 * effective set the backend enforces.
 */
export async function effectivePermissionsForUser(
  prisma: PrismaClient,
  user: { role: UserRole; permissionAllow?: string[]; permissionDeny?: string[] },
): Promise<string[]> {
  const base = new Set(await permissionsForRole(prisma, user.role))
  for (const p of user.permissionAllow ?? []) base.add(p)
  for (const p of user.permissionDeny  ?? []) base.delete(p)
  return Array.from(base)
}
