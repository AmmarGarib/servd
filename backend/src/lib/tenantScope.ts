// Tenant-scope resolver for read endpoints.
//
// Default behaviour: every read filters by the user's active tenant
// (`req.staffUser.tenantId`). When the admin frontend has switched to
// "All companies" view, it sends an `x-servd-portfolio: 1` header and we
// expand the filter to the full set of tenants the user is a member of.
//
// Write endpoints should NOT use this — writes must always bind to a single
// tenant, otherwise we'd dump rows into ambiguous ownership. The portfolio-
// write guard on the client already gates those at the UI layer.

import type { FastifyRequest } from 'fastify'
import { prisma } from './prisma.js'

export interface TenantScope {
  /** True when the operator has portfolio mode engaged. */
  portfolio:  boolean
  /** Tenant IDs to include in `where: { tenantId: { in: ... } }`. */
  tenantIds:  string[]
  /** Convenience for the common direct-equality query. Null when portfolio mode is on. */
  tenantId:   string | null
}

/**
 * Resolve the effective set of tenants for the current request. Reads
 * `req.staffUser` (which must already be populated by the auth middleware)
 * and the `x-servd-portfolio` header.
 *
 * Cached per-request inside the FastifyRequest so a single route handler
 * that touches multiple tables doesn't refetch the membership list.
 */
export async function resolveTenantScope(req: FastifyRequest): Promise<TenantScope> {
  // Cheap cache so a handler with 3 queries doesn't pay 3× the DB cost.
  const cached = (req as FastifyRequest & { __tenantScope?: TenantScope }).__tenantScope
  if (cached) return cached

  const activeTenant = req.staffUser?.tenantId ?? null
  const wantsPortfolio = req.headers['x-servd-portfolio'] === '1'

  let scope: TenantScope
  if (!wantsPortfolio || !req.staffUser) {
    scope = {
      portfolio: false,
      tenantIds: activeTenant ? [activeTenant] : [],
      tenantId:  activeTenant,
    }
  } else {
    // Portfolio mode: pull every tenant the user is a member of. Always
    // include the active tenant as a safety net (in case the membership
    // row was deleted but the user.tenantId still points at it).
    const memberships = await prisma.tenantMember.findMany({
      where: { userId: req.staffUser.id },
      select: { tenantId: true },
    })
    const ids = new Set<string>(memberships.map((m) => m.tenantId))
    if (activeTenant) ids.add(activeTenant)
    scope = {
      portfolio: true,
      tenantIds: Array.from(ids),
      tenantId:  null,
    }
  }

  ;(req as FastifyRequest & { __tenantScope?: TenantScope }).__tenantScope = scope
  return scope
}

/**
 * Produce a Prisma where-clause fragment to scope a query by the resolved
 * tenants. Use this everywhere a read previously hard-coded
 * `tenantId: req.staffUser.tenantId`.
 */
export function tenantWhere(scope: TenantScope): { tenantId: string } | { tenantId: { in: string[] } } {
  if (scope.tenantIds.length === 1) return { tenantId: scope.tenantIds[0]! }
  return { tenantId: { in: scope.tenantIds } }
}
