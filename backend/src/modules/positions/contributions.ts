// Inter-tenant contributions — JV / shared-service monthly transfers.
//
// Endpoints (registered under /positions/contributions/*):
//   GET    /positions/contributions          — list (both directions for active tenant)
//   POST   /positions/contributions          — create
//   PATCH  /positions/contributions/:id      — edit
//   DELETE /positions/contributions/:id      — soft (sets endedAt + isActive=false)
//
// Returns separate `incoming` / `outgoing` arrays so the workforce page can
// show "Viva contributes 500k → GS Foods" on the GS Foods view and the same
// row as "We send 500k → GS Foods" on the GS x Viva view.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS } from '../auth/middleware.js'

// Tenant filter narrowing for non-nullable FK columns.
function tenantIds(req: FastifyRequest): string[] {
  const f = req.staffUser!.tenantFilter
  if (f === null) return []
  if (typeof f === 'string') return [f]
  return f.in
}

const splitItemSchema = z.object({
  label: z.string().min(1).max(80),
  cents: z.number().int(),
})

const contributionSchema = z.object({
  sourceTenantId:      z.string().min(1),
  destinationTenantId: z.string().min(1),
  category: z.enum(['head_office', 'commissary', 'shared_services', 'other']).default('head_office'),
  monthlyCents: z.number().int().nonnegative(),
  label: z.string().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  internalSplit: z.array(splitItemSchema).nullable().optional(),
  isActive: z.boolean().default(true),
})

export async function contributionRoutes(fastify: FastifyInstance) {

  // List both directions for the active tenant.
  fastify.get('/', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const tenants = tenantIds(req)
    if (tenants.length === 0) return { incoming: [], outgoing: [] }

    const all = await prisma.tenantContribution.findMany({
      where: {
        OR: [
          { destinationTenantId: { in: tenants } },
          { sourceTenantId:      { in: tenants } },
        ],
      },
      include: {
        sourceTenant:      { select: { id: true, name: true, slug: true } },
        destinationTenant: { select: { id: true, name: true, slug: true } },
      },
      orderBy: [{ isActive: 'desc' }, { startedAt: 'desc' }],
    })

    const incoming = all.filter((c) => tenants.includes(c.destinationTenantId))
    const outgoing = all.filter((c) => tenants.includes(c.sourceTenantId))

    return {
      incoming,
      outgoing,
      // Totals make life easier on the UI side — destination tenant adds these
      // up to show "monthly inflows" without re-summing client-side.
      incomingMonthlyCents: incoming.filter((c) => c.isActive).reduce((s, c) => s + c.monthlyCents, 0),
      outgoingMonthlyCents: outgoing.filter((c) => c.isActive).reduce((s, c) => s + c.monthlyCents, 0),
    }
  })

  fastify.post('/', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const body = contributionSchema.parse(req.body)
    // Guardrail: at least one side (source or dest) must be a tenant the
    // operator belongs to. Stops a CEO from manufacturing contributions
    // between two tenants they don't own.
    const tenants = tenantIds(req)
    if (!tenants.includes(body.sourceTenantId) && !tenants.includes(body.destinationTenantId)) {
      return { error: 'You must be a member of either the source or destination tenant.' }
    }
    return prisma.tenantContribution.create({
      data: {
        sourceTenantId: body.sourceTenantId,
        destinationTenantId: body.destinationTenantId,
        category: body.category,
        monthlyCents: body.monthlyCents,
        label: body.label,
        description: body.description ?? null,
        internalSplit: body.internalSplit ?? undefined,
        isActive: body.isActive,
      },
    })
  })

  fastify.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = contributionSchema.partial().parse(req.body)
      const tenants = tenantIds(req)
      // Resolve the row to confirm the operator can edit it.
      const existing = await prisma.tenantContribution.findUnique({ where: { id: req.params.id } })
      if (!existing) return { error: 'not_found' }
      if (!tenants.includes(existing.sourceTenantId) && !tenants.includes(existing.destinationTenantId)) {
        return { error: 'forbidden' }
      }
      return prisma.tenantContribution.update({
        where: { id: req.params.id },
        data: {
          ...body,
          internalSplit: body.internalSplit ?? undefined,
        },
      })
    },
  )

  fastify.delete<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const tenants = tenantIds(req)
    const existing = await prisma.tenantContribution.findUnique({ where: { id: req.params.id } })
    if (!existing) return { error: 'not_found' }
    if (!tenants.includes(existing.sourceTenantId) && !tenants.includes(existing.destinationTenantId)) {
      return { error: 'forbidden' }
    }
    // Soft-end: keep history but stop counting toward live totals.
    await prisma.tenantContribution.update({
      where: { id: req.params.id },
      data: { isActive: false, endedAt: new Date() },
    })
    return { ok: true }
  })
}
