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
import type { UserRole } from '@prisma/client'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { resolveTenantScope } from '../../lib/tenantScope.js'
import { moduleGateForNewRoles } from '../opex/moduleGate.js'
import { zInt4Cents } from '../../lib/money.js'

// Companies whose contributions this request may SEE (view-aware: the active
// company, or every member company in "All companies" view).
async function readableTenantIds(req: FastifyRequest): Promise<string[]> {
  return (await resolveTenantScope(req)).tenantIds
}

// A contribution is a capital movement between two companies. Recording or
// changing one moves money on BOTH sides' books, so the operator must belong
// to both companies, and one of them must be the active company (the one the
// operator is acting as). Membership on only one side let GS x Viva finance
// book a transfer into or out of GS Foods.
function assertBothSidesOwned(req: FastifyRequest, sourceTenantId: string, destinationTenantId: string): void {
  const su = req.staffUser!
  const members = su.memberTenantIds
  if (sourceTenantId === destinationTenantId) {
    throw new AppError('SAME_COMPANY', 'A contribution must be between two different companies', 422)
  }
  if (!members.includes(sourceTenantId) || !members.includes(destinationTenantId)) {
    throw new AppError('CONTRIBUTION_NOT_YOURS', 'You must be a member of both the paying and the receiving company', 422)
  }
  if (!su.tenantId || (su.tenantId !== sourceTenantId && su.tenantId !== destinationTenantId)) {
    throw new AppError('CONTRIBUTION_NOT_ACTIVE', 'One side of the contribution must be your active company', 422)
  }
}

// An existing contribution the operator may edit: 404 when neither side is
// one of their companies (it doesn't exist as far as they're concerned),
// 403 when only one side is.
async function findEditable(req: FastifyRequest, id: string) {
  const members = req.staffUser!.memberTenantIds
  const existing = await prisma.tenantContribution.findFirst({
    where: {
      id,
      OR: [{ sourceTenantId: { in: members } }, { destinationTenantId: { in: members } }],
    },
  })
  if (!existing) throw new NotFoundError('TenantContribution', id)
  if (!members.includes(existing.sourceTenantId) || !members.includes(existing.destinationTenantId)) {
    throw new ForbiddenError('You must be a member of both companies to change this contribution')
  }
  return existing
}

const splitItemSchema = z.object({
  label: z.string().min(1).max(80),
  cents: z.number().int(),
})

const contributionSchema = z.object({
  sourceTenantId:      z.string().min(1),
  destinationTenantId: z.string().min(1),
  category: z.enum(['head_office', 'commissary', 'shared_services', 'other']).default('head_office'),
  // tenant_contributions.monthlyCents is INT4 (BOOKS-06 left it there: one
  // company's monthly transfer to another stays well under PKR 21,474,836.47).
  // Above it the request is 422 AMOUNT_TOO_LARGE, never a raw 500 at insert.
  monthlyCents: zInt4Cents('The monthly contribution'),
  label: z.string().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  internalSplit: z.array(splitItemSchema).nullable().optional(),
  isActive: z.boolean().default(true),
})

// Reading the contributions follows the Positions page (wave 3): the manager
// tiers, HR and finance — the figures net into the budgeted payroll they all
// read. Recording or changing one moves money between two companies' books,
// so writes stay with MANAGERS (and assertBothSidesOwned below).
const CONTRIBUTION_READERS = Array.from(new Set([...MANAGERS, 'hr', 'finance'])) as UserRole[]
// Same module rule as the Positions reads (HR 'staff_directory', finance
// 'capital'); manager tiers unchanged (W3B-RV-1).
const CONTRIBUTION_READ_GUARD = [requireAuth(...CONTRIBUTION_READERS), moduleGateForNewRoles(['staff_directory', 'capital'])]

export async function contributionRoutes(fastify: FastifyInstance) {

  // List both directions for the active tenant.
  fastify.get('/', { preHandler: CONTRIBUTION_READ_GUARD }, async (req) => {
    const tenants = await readableTenantIds(req)
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

  fastify.post('/', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = contributionSchema.parse(req.body)
    assertBothSidesOwned(req, body.sourceTenantId, body.destinationTenantId)
    const created = await prisma.tenantContribution.create({
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
    return reply.status(201).send(created)
  })

  fastify.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = contributionSchema.partial().parse(req.body)
      const existing = await findEditable(req, req.params.id)
      // Re-pointing either side: the resulting pair must still be two of the
      // operator's companies, one of them active.
      if (body.sourceTenantId !== undefined || body.destinationTenantId !== undefined) {
        assertBothSidesOwned(
          req,
          body.sourceTenantId ?? existing.sourceTenantId,
          body.destinationTenantId ?? existing.destinationTenantId,
        )
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
    const existing = await findEditable(req, req.params.id)
    // Soft-end: keep history but stop counting toward live totals.
    await prisma.tenantContribution.update({
      where: { id: existing.id },
      data: { isActive: false, endedAt: new Date() },
    })
    return { ok: true }
  })
}
