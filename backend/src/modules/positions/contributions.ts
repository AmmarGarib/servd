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
import { moveToTrash, trashReasonOf } from '../../lib/trash.js'
import type { UserRole } from '@prisma/client'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { resolveTenantScope } from '../../lib/tenantScope.js'
import { assertBothSidesOwned as assertPairOwned } from '../../lib/companyPairs.js'
import { moduleGateForNewRoles } from '../opex/moduleGate.js'
import { zInt4Cents } from '../../lib/money.js'
import { countedContributions } from '../../lib/labour-budget.js'
import { headOfficeSetupApplied } from '../headOffices/books.js'

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
  // D1: no default any more (the column defaults to 'other'); a caller names
  // the category, so nothing becomes a head-office contribution by accident.
  category: z.enum(['head_office', 'commissary', 'shared_services', 'other']),
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

/**
 * D1 (spec §8, amendment A15): a shared head office is a head office (CEO →
 * Head offices), not a contribution. Once the setup wizard has run
 * (headOfficeSetupApplied), recording a new head_office contribution, or
 * changing one (or turning a row into one), is 422 USE_HEAD_OFFICE. Until then
 * POST and PATCH behave as today, so an existing row can still be corrected in
 * the gap before the wizard. Ending one (DELETE) is always allowed.
 */
async function assertNotHeadOfficeAfterSetup(category: string | undefined): Promise<void> {
  if (category !== 'head_office') return
  if (await headOfficeSetupApplied()) {
    throw new AppError(
      'USE_HEAD_OFFICE',
      'Shared head-office salaries are planned through the head office now (CEO → Head offices → % split), not a contribution',
      422,
    )
  }
}

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

    // Planning counts only what countedContributions keeps: every active row,
    // except (after the head-office setup) a head_office row whose companies
    // are linked to a head office. Ended rows are listed read-only.
    const applied = await headOfficeSetupApplied()
    const counted = new Set((await countedContributions(all.filter((c) => c.isActive), applied)).map((c) => c.id))
    const shown = all.map((c) => ({
      ...c,
      counts: counted.has(c.id),
      readOnly: !c.isActive || (applied && c.category === 'head_office'),
    }))
    const incoming = shown.filter((c) => tenants.includes(c.destinationTenantId))
    const outgoing = shown.filter((c) => tenants.includes(c.sourceTenantId))

    return {
      incoming,
      outgoing,
      // Totals make life easier on the UI side — destination tenant adds these
      // up to show "monthly inflows" without re-summing client-side.
      incomingMonthlyCents: incoming.filter((c) => c.counts).reduce((s, c) => s + c.monthlyCents, 0),
      outgoingMonthlyCents: outgoing.filter((c) => c.counts).reduce((s, c) => s + c.monthlyCents, 0),
    }
  })

  fastify.post('/', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = contributionSchema.parse(req.body)
    await assertNotHeadOfficeAfterSetup(body.category)
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
      // A15: an existing head_office row may be corrected until the setup
      // wizard has run; after it (or turning a row into one) → USE_HEAD_OFFICE.
      await assertNotHeadOfficeAfterSetup(existing.category)
      await assertNotHeadOfficeAfterSetup(body.category)
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
    // Trash (owner, 2026-10-15): "delete" stays an end; the entry remembers the
    // state it had so Restore re-opens it. Filed under the paying company.
    await prisma.$transaction(async (tx) => {
      if (existing.isActive) {
        await moveToTrash(tx, req, {
          type: 'tenant_contribution', entityId: existing.id, tenantId: existing.sourceTenantId,
          title: existing.label, subtitle: `${existing.category}`, reason: trashReasonOf(req),
          meta: { previous: { isActive: true, endedAt: existing.endedAt ? existing.endedAt.toISOString() : null }, destinationTenantId: existing.destinationTenantId },
        })
      }
      await tx.tenantContribution.update({
        where: { id: existing.id },
        data: { isActive: false, endedAt: new Date() },
      })
    })
    return { ok: true }
  })
}
