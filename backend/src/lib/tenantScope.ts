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
import { NotFoundError } from './errors.js'
import { requestedBrand, markBrandApplied } from './brandScope.js'

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

// ─── Ownership helpers for company-anchored rows ─────────────────────────────
//
// Three scope modes, matching how the auth middleware already treats
// tenantFilter:
//   • 'read'   — view-aware: the active company, or every company the
//                operator belongs to when "All companies" is on.
//   • 'write'  — editing/deleting an EXISTING row: every company the operator
//                belongs to (a head-office manager can edit either kitchen).
//   • 'create' — binding a NEW row / attaching a brand to a new row: the
//                active company only (x-servd-active-tenant aware). Never let
//                a create span companies — that is exactly how GS Foods'
//                kitchen ended up carrying a GSX Viva brand.

export type ScopeMode = 'read' | 'write' | 'create'

export type TenantIdWhere = { tenantId: string } | { tenantId: { in: string[] } }

/** Prisma `where` fragment on a `tenantId` column for the given mode. */
export async function scopeTenantWhere(req: FastifyRequest, mode: ScopeMode = 'read'): Promise<TenantIdWhere> {
  const su = req.staffUser
  if (!su) return { tenantId: { in: [] } }
  if (mode === 'create') return su.tenantId ? { tenantId: su.tenantId } : { tenantId: { in: [] } }
  if (mode === 'write') {
    const ids = su.memberTenantIds
    return ids.length === 1 ? { tenantId: ids[0]! } : { tenantId: { in: ids } }
  }
  return tenantWhere(await resolveTenantScope(req))
}

/**
 * Resolve a concept the operator may act on in `mode`, or 404. Use this on
 * every endpoint that takes a conceptId from the client (query, params or
 * body) before touching anything under that brand. 404 rather than 403 so a
 * foreign id doesn't confirm the brand exists.
 */
export async function assertConceptOwned(
  req: FastifyRequest,
  conceptId: string,
  mode: ScopeMode = 'write',
): Promise<{ id: string; tenantId: string | null }> {
  const concept = await prisma.concept.findFirst({
    where: { id: conceptId, deletedAt: null, ...(await scopeTenantWhere(req, mode)) },
    select: { id: true, tenantId: true },
  })
  if (!concept) throw new NotFoundError('Concept', conceptId)
  return concept
}

/**
 * Every concept id in scope for `mode`. Drop into `where: { conceptId: { in } }`
 * on list endpoints for brand-anchored tables (tables, floors, QR codes,
 * reservations, delivery zones, …) instead of trusting a client conceptId.
 */
export async function conceptIdsInScope(req: FastifyRequest, mode: ScopeMode = 'read'): Promise<string[]> {
  const rows = await prisma.concept.findMany({
    where: { deletedAt: null, ...(await scopeTenantWhere(req, mode)) },
    select: { id: true },
  })
  const ids = rows.map((r) => r.id)
  // Global brand filter (lib/brandScope.ts): on reads, narrow to the picked
  // brand — but only if it is actually in scope. A brand left over from
  // another company is ignored rather than turning every page empty.
  if (mode === 'read') {
    const brand = requestedBrand(req)
    if (brand && ids.includes(brand)) {
      markBrandApplied(req)
      return [brand]
    }
  }
  return ids
}

/**
 * Narrow an optional client-supplied conceptId to the scope: returns
 * `{ conceptId }` when it is owned, `{ conceptId: { in: [...] } }` over the
 * whole scope when absent, and 404s when it is foreign.
 */
export async function conceptWhere(
  req: FastifyRequest,
  conceptId: string | undefined | null,
  mode: ScopeMode = 'read',
): Promise<{ conceptId: string } | { conceptId: { in: string[] } }> {
  if (conceptId) {
    await assertConceptOwned(req, conceptId, mode)
    return { conceptId }
  }
  return { conceptId: { in: await conceptIdsInScope(req, mode) } }
}
