import type { UserRole } from '@prisma/client'
import { prisma } from './prisma.js'
import { ForbiddenError } from './errors.js'

// Brand access = COMPANY membership (owner decision 35, 2026-09-27).
//
// This used to be a per-user brand whitelist (User.conceptIds) with a bypass
// list of management roles. Nothing in the app ever wrote the whitelist — only
// seed scripts did — so every non-bypass role (cashier, foh, boh, kitchen,
// expediter, owner, fnb_manager, …) created from Workforce was refused on
// POST /pos/orders, the order lists, reservations and floors. Per the owner
// there is no per-brand restriction of floor staff within a company, so the
// whitelist is no longer read (the column is kept). What remains is the
// company rule: a brand is reachable when it belongs to a company the caller
// is a member of (primary company or a TenantMember row).
//
// Callers still run their own view-aware company scoping first (conceptWhere /
// assertConceptOwned); this is the backstop for the paths that only had this
// check — POS order creation among them.
//
// The signatures are unchanged so the call sites keep working; they pass
// req.staffUser, which carries memberTenantIds. Follow-up: fold these into
// lib/tenantScope.ts and delete this file.

type Staff = { id: string; role: UserRole; memberTenantIds?: string[] }

const tenantOfConcept = new Map<string, { tenantId: string | null; expires: number }>()
const CACHE_TTL_MS = 30_000

async function conceptTenantId(conceptId: string): Promise<string | null> {
  const now = Date.now()
  const hit = tenantOfConcept.get(conceptId)
  if (hit && hit.expires > now) return hit.tenantId
  const c = await prisma.concept.findUnique({ where: { id: conceptId }, select: { tenantId: true } })
  const tenantId = c?.tenantId ?? null
  tenantOfConcept.set(conceptId, { tenantId, expires: now + CACHE_TTL_MS })
  return tenantId
}

/** Kept for callers that used to bust the whitelist cache; nothing to bust per user now. */
export function invalidateConceptAccessCache(_userId: string): void {
  // no-op — access is company membership, resolved per request.
}

export async function assertConceptAccess(staff: Staff, conceptId: string): Promise<void> {
  // The CEO owns the portfolio (same rule as the staff editor).
  if (staff.role === 'admin') return
  const tenantId = await conceptTenantId(conceptId)
  if (!tenantId || !(staff.memberTenantIds ?? []).includes(tenantId)) {
    throw new ForbiddenError(`Access to concept ${conceptId} is not granted for this user`)
  }
}

/**
 * The brands the caller may see among `conceptIds` (or all of their companies'
 * brands when none were asked for). Never throws on an empty result — callers
 * treat an empty list as an empty page.
 */
export async function filterConceptIdsForStaff(
  staff: Staff,
  conceptIds?: string[] | null,
): Promise<string[] | null> {
  if (staff.role === 'admin') return conceptIds ?? null
  const tenantIds = staff.memberTenantIds ?? []
  if (tenantIds.length === 0) return []
  const rows = await prisma.concept.findMany({
    where: {
      tenantId: { in: tenantIds },
      ...(conceptIds && conceptIds.length > 0 ? { id: { in: conceptIds } } : {}),
    },
    select: { id: true },
  })
  return rows.map((r) => r.id)
}
