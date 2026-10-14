// Inter-tenant contributions — JV / shared-service monthly figures (planning
// only: nothing here posts to the ledger; see the note above assertBothSidesOwned).
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
import { ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { resolveTenantScope } from '../../lib/tenantScope.js'
import { assertBothSidesOwned as assertPairOwned } from '../../lib/companyPairs.js'
import { moduleGateForNewRoles } from '../opex/moduleGate.js'
import { zInt4Cents } from '../../lib/money.js'

// Companies whose contributions this request may SEE (view-aware: the active
// company, or every member company in "All companies" view).
async function readableTenantIds(req: FastifyRequest): Promise<string[]> {
  return (await resolveTenantScope(req)).tenantIds
}

// A contribution is a PLANNING figure: the monthly amount one company bears
// for another (head office, commissary, shared services). It nets into the
// budgeted payroll on the Positions page and posts NOTHING to either company's
// books. Money that really moves between two companies' books is an
// inter-company transfer (Accounting → Inter-company, modules/intercompany —
// H30); whether contributions should also post monthly as inter-company
// charges is an open owner question (Q5), so they do not.
//
// The record still speaks for both companies, so the operator must belong to
// both, and one of them must be the active company (the one the operator is
// acting as) — the ONE pair check in lib/companyPairs.ts (403
// NOT_IN_BOTH_COMPANIES / 422 ACTIVE_COMPANY_NOT_A_PARTY / 422 SAME_COMPANY).
// Membership on only one side let GS x Viva finance record a contribution
// into or out of GS Foods.
function assertBothSidesOwned(req: FastifyRequest, sourceTenantId: string, destinationTenantId: string): Promise<void> {
  return assertPairOwned(req, sourceTenantId, destinationTenantId, { what: 'contribution' })
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
// read. Recording or changing one speaks for two companies (a planning
// figure, never posted), so writes stay with MANAGERS (and
// assertBothSidesOwned below).
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
    await assertBothSidesOwned(req, body.sourceTenantId, body.destinationTenantId)
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
        await assertBothSidesOwned(
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
