// Recipient helpers for the notification bell (lib/staffNotify.ts).
//
// Read live on serviceClient, never cached: a login switched off, a role
// changed or a module unticked a second ago stops receiving at once. Every
// helper is per COMPANY — a recipient list is always "the people of the
// event's company", never "everyone with role X".

import type { UserRole } from '@prisma/client'
import { serviceClient } from './prisma.js'
import { staffInCompaniesWhere } from '../modules/auth/staffAccounts.js'
import { effectiveModulesForUser } from './moduleAccess.js'

const ACTIVE_LOGIN = { isActive: true, accountStatus: 'active' as const, deletedAt: null }

/** Ids of the active logins of `tenantId` (primary company or membership), optionally of `roles`. */
export async function activeStaffOf(tenantId: string, roles?: readonly string[]): Promise<string[]> {
  if (!tenantId) return []
  const rows = await serviceClient.user.findMany({
    where: {
      AND: [
        staffInCompaniesWhere([tenantId], false),
        ACTIVE_LOGIN,
        ...(roles && roles.length > 0 ? [{ role: { in: [...roles] as UserRole[] } }] : []),
      ],
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  })
  return rows.map((r) => r.id)
}

/**
 * The CEO(s) — active `admin` logins — of `tenantId`. `null` (a company-less
 * item, CEO-only by rule) → every active admin.
 */
export async function ceosOf(tenantId: string | null): Promise<string[]> {
  if (tenantId) return activeStaffOf(tenantId, ['admin'])
  const rows = await serviceClient.user.findMany({
    where: { ...ACTIVE_LOGIN, role: 'admin' },
    select: { id: true },
    orderBy: { id: 'asc' },
  })
  return rows.map((r) => r.id)
}

/** Keep the users whose effective modules include `module` (admin always). */
export async function withModule(userIds: readonly string[], module: string): Promise<string[]> {
  const ids = [...new Set(userIds)].filter(Boolean)
  if (ids.length === 0) return []
  const users = await serviceClient.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, role: true, moduleAllow: true, moduleDeny: true },
  })
  const keep = new Set<string>()
  for (const u of users) {
    if (u.role === 'admin') { keep.add(u.id); continue }
    const mods = await effectiveModulesForUser({ role: u.role, moduleAllow: u.moduleAllow, moduleDeny: u.moduleDeny })
    if (mods.has(module)) keep.add(u.id)
  }
  return ids.filter((id) => keep.has(id))
}

/**
 * Finance of `tenantId`: active `finance` logins holding the `accounting`
 * module (the night audit sits under the /accounting gate).
 */
export async function financeOf(tenantId: string): Promise<string[]> {
  return withModule(await activeStaffOf(tenantId, ['finance']), 'accounting')
}

/** The night audit's audience: the CEO(s) ∪ finance of that company (NIGHT_AUDIT_RUNNERS). */
export async function nightAuditAudience(tenantId: string): Promise<string[]> {
  const [ceos, fin] = await Promise.all([ceosOf(tenantId), financeOf(tenantId)])
  return [...new Set([...ceos, ...fin])]
}
