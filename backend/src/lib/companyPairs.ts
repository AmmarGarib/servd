// Company PAIRS — the one membership check for anything that moves between two
// companies (finance wave B, H30).
//
// Company separation (CLAUDE.md) binds every write to ONE company. A few
// records belong to two companies at once: an inter-company transfer (both
// books post), a shared-fleet rate (the provider charges the client), a
// planning contribution (one company bears a cost for another). Whoever
// records or changes one must belong to BOTH companies — membership of one
// side let a single-company operator book into, or out of, the other — and
// one of the two must be the company they are acting as (the active company),
// exactly as a create binds to the active company everywhere else.
//
//   assertBothSidesOwned(req, a, b) — routes that a person drives:
//     422 SAME_COMPANY               a === b
//     403 NOT_IN_BOTH_COMPANIES      the caller is not a member of both
//     422 ACTIVE_COMPANY_NOT_A_PARTY neither side is the active company
//     422 COMPANY_NOT_FOUND          one side is not a live company
//   isMemberOfBoth(user, a, b) — the same membership test without the
//     active-company rule, for system-adjacent paths (a fleet rider's COD
//     debt, the approval of a transfer, the fleet re-poster's guard).
//
// There is no second copy: positions/contributions.ts, intercompany/* and the
// COD rider-debt path all import these.

import type { FastifyRequest } from 'fastify'
import { serviceClient } from './prisma.js'
import { AppError, UnauthorizedError } from './errors.js'

/** True when `user` belongs to both companies (and they are two different companies). */
export function isMemberOfBoth(user: { id: string; memberTenantIds: string[] }, a: string, b: string): boolean {
  if (!a || !b || a === b) return false
  return user.memberTenantIds.includes(a) && user.memberTenantIds.includes(b)
}

/**
 * Every company a user belongs to (their primary company plus TenantMember
 * rows) — the same set the auth middleware puts on req.staffUser.memberTenantIds,
 * for code that has only a user id (a re-post run by an operator).
 */
export async function memberTenantIdsOf(userId: string): Promise<string[]> {
  const [user, memberships] = await Promise.all([
    serviceClient.user.findUnique({ where: { id: userId }, select: { tenantId: true } }),
    serviceClient.tenantMember.findMany({ where: { userId }, select: { tenantId: true } }),
  ])
  const ids = new Set(memberships.map((m) => m.tenantId))
  if (user?.tenantId) ids.add(user.tenantId)
  return Array.from(ids)
}

/**
 * The caller may act on the pair (a, b): a member of BOTH companies, with one
 * of them the active company, and both live. `what` names the record in the
 * messages ("transfer", "fleet rate", "contribution").
 */
export async function assertBothSidesOwned(req: FastifyRequest, a: string, b: string, opts: { what?: string } = {}): Promise<void> {
  const su = req.staffUser
  if (!su) throw new UnauthorizedError('Missing authentication')
  const what = opts.what ?? 'record'
  if (!a || !b || a === b) {
    throw new AppError('SAME_COMPANY', `A ${what} must be between two different companies`, 422)
  }
  if (!isMemberOfBoth(su, a, b)) {
    throw new AppError(
      'NOT_IN_BOTH_COMPANIES',
      `Only someone who belongs to both companies can record or change this ${what} — ask the CEO or a finance user of both`,
      403,
    )
  }
  if (!su.tenantId || (su.tenantId !== a && su.tenantId !== b)) {
    throw new AppError(
      'ACTIVE_COMPANY_NOT_A_PARTY',
      `Switch to one of the two companies first — a ${what} is recorded from one of its own companies`,
      422,
    )
  }
  const live = await serviceClient.tenant.count({ where: { id: { in: [a, b] }, deletedAt: null } })
  if (live !== 2) throw new AppError('COMPANY_NOT_FOUND', 'One of the two companies no longer exists', 422)
}
