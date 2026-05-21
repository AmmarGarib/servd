// OpEx tracker â€” recurring operational expense management.
// Categories (Rent, Payroll, Utilities, etc.) â†’ Lines (specific vendors /
// items) â†’ Payments (per-period actuals). Variance vs budget fires flags.
//
// Special: the Payroll category pulls live from PayrollRun + ClockLog data
// rather than manual entry â€” that's wired in the GET /opex endpoint.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS } from '../auth/middleware.js'
import { flagException } from '../../lib/exceptions.js'

const cadenceEnum = z.enum(['monthly', 'quarterly', 'annual', 'per_use'])

const lineSchema = z.object({
  categoryId:    z.string().min(1),
  conceptId:     z.string().uuid().nullable().optional(),
  projectId:     z.string().min(1).nullable().optional(),    // optional link to a CapexProject
  name:          z.string().min(1).max(120),
  vendor:        z.string().max(120).nullable().optional(),
  vendorContact: z.string().max(120).nullable().optional(),
  amountCents:   z.number().int().nonnegative(),
  cadence:       cadenceEnum.default('monthly'),
  nextDueDate:   z.string().nullable().optional(),
  paymentMethod: z.string().max(40).nullable().optional(),
  bankAccountId: z.string().min(1).nullable().optional(),
  source:        z.enum(['manual', 'payroll', 'license', 'subscription']).default('manual'),
  notes:         z.string().nullable().optional(),
})

export async function opexRoutes(fastify: FastifyInstance) {

  // â”€â”€â”€ Categories â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  fastify.get<{ Querystring: { projectId?: string; scope?: string } }>('/categories',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const { projectId, scope } = req.query
      // Filter lines by project: 'project' = lines with this projectId,
      // 'company' = lines with no projectId (cross-project), absent = both.
      const lineFilter: { isActive: boolean; projectId?: string | null } = { isActive: true }
      if (projectId && scope !== 'company') lineFilter.projectId = projectId
      else if (scope === 'company')          lineFilter.projectId = null

      const categories = await prisma.opexCategory.findMany({
        where: { deletedAt: null, isActive: true, tenantId: req.staffUser!.tenantFilter },
        include: { lines: { where: lineFilter, include: { payments: { orderBy: { periodStart: 'desc' }, take: 12 } } } },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      })

      // Hide categories that have no lines after filtering (only when filtering)
      const filtered = (projectId || scope) ? categories.filter((c) => c.lines.length > 0) : categories

      return filtered.map((c) => {
        const monthlyExpected = c.lines.reduce((s, l) => s + monthlyCents(l.amountCents, l.cadence), 0)
        const overBudgetPct = c.budgetMonthlyCents > 0 ? (monthlyExpected / c.budgetMonthlyCents) - 1 : 0
        return {
          ...c,
          monthlyExpectedCents: monthlyExpected,
          overBudgetPct,
          lineCount: c.lines.length,
        }
      })
    },
  )

  fastify.post('/categories', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({
      name:               z.string().min(1).max(80),
      emoji:              z.string().max(8).nullable().optional(),
      conceptId:          z.string().uuid().nullable().optional(),
      budgetMonthlyCents: z.number().int().nonnegative().default(0),
      notes:              z.string().nullable().optional(),
      sortOrder:          z.number().int().optional(),
    }).parse(req.body)
    if (body.conceptId) {
      const concept = await prisma.concept.findFirst({
        where: { id: body.conceptId, tenantId: req.staffUser!.tenantFilter, deletedAt: null },
      })
      if (!concept) return reply.status(403).send({ error: { code: 'CROSS_TENANT', message: 'Concept does not belong to your active company' } })
    }
    const cat = await prisma.opexCategory.create({ data: { ...body, tenantId: req.staffUser!.tenantId! } })
    return reply.status(201).send(cat)
  })

  fastify.patch<{ Params: { id: string } }>('/categories/:id', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({
      name:               z.string().min(1).max(80).optional(),
      emoji:              z.string().max(8).nullable().optional(),
      budgetMonthlyCents: z.number().int().nonnegative().optional(),
      notes:              z.string().nullable().optional(),
      sortOrder:          z.number().int().optional(),
      isActive:           z.boolean().optional(),
    }).parse(req.body)
    const owned = await prisma.opexCategory.findFirst({
      where: { id: req.params.id, tenantId: req.staffUser!.tenantFilter, deletedAt: null },
    })
    if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Category not found in your active company' } })
    return prisma.opexCategory.update({ where: { id: req.params.id }, data: body })
  })

  fastify.delete<{ Params: { id: string } }>('/categories/:id', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const owned = await prisma.opexCategory.findFirst({
      where: { id: req.params.id, tenantId: req.staffUser!.tenantFilter, deletedAt: null },
    })
    if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Category not found in your active company' } })
    await prisma.opexCategory.update({
      where: { id: req.params.id },
      data: { deletedAt: new Date(), isActive: false },
    })
    return reply.status(204).send()
  })

  // â”€â”€â”€ Lines â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  fastify.post('/lines', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = lineSchema.parse(req.body)
    // Verify category belongs to active tenant.
    const cat = await prisma.opexCategory.findFirst({
      where: { id: body.categoryId, tenantId: req.staffUser!.tenantFilter, deletedAt: null },
    })
    if (!cat) return reply.status(403).send({ error: { code: 'CROSS_TENANT', message: 'Category does not belong to your active company' } })
    if (body.conceptId) {
      const concept = await prisma.concept.findFirst({
        where: { id: body.conceptId, tenantId: req.staffUser!.tenantFilter, deletedAt: null },
      })
      if (!concept) return reply.status(403).send({ error: { code: 'CROSS_TENANT', message: 'Concept does not belong to your active company' } })
    }
    const line = await prisma.opexLine.create({
      data: {
        ...body,
        nextDueDate: body.nextDueDate ? new Date(body.nextDueDate) : null,
      },
    })
    return reply.status(201).send(line)
  })

  fastify.patch<{ Params: { id: string } }>('/lines/:id', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = lineSchema.partial().parse(req.body)
    const owned = await prisma.opexLine.findFirst({
      where: {
        id: req.params.id,
        category: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
      },
    })
    if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Line not found in your active company' } })
    return prisma.opexLine.update({
      where: { id: req.params.id },
      data: {
        ...body,
        nextDueDate: body.nextDueDate !== undefined ? (body.nextDueDate ? new Date(body.nextDueDate) : null) : undefined,
      },
    })
  })

  fastify.delete<{ Params: { id: string } }>('/lines/:id', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const owned = await prisma.opexLine.findFirst({
      where: {
        id: req.params.id,
        category: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
      },
    })
    if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Line not found in your active company' } })
    await prisma.opexLine.update({ where: { id: req.params.id }, data: { isActive: false } })
    return reply.status(204).send()
  })

  // â”€â”€â”€ Payments â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  fastify.post('/payments', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({
      lineId:        z.string().min(1),
      periodStart:   z.string(),
      periodEnd:     z.string(),
      expectedCents: z.number().int().nonnegative(),
      actualCents:   z.number().int().nonnegative().nullable().optional(),
      paidAt:        z.string().nullable().optional(),
      paymentRef:    z.string().max(120).nullable().optional(),
      receiptUrl:    z.string().url().nullable().optional(),
      notes:         z.string().nullable().optional(),
    }).parse(req.body)
    const ownedLine = await prisma.opexLine.findFirst({
      where: {
        id: body.lineId,
        category: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
      },
    })
    if (!ownedLine) return reply.status(403).send({ error: { code: 'CROSS_TENANT', message: 'Line does not belong to your active company' } })
    const p = await prisma.opexPayment.create({
      data: {
        ...body,
        periodStart: new Date(body.periodStart),
        periodEnd:   new Date(body.periodEnd),
        paidAt:      body.paidAt ? new Date(body.paidAt) : null,
      },
      include: { line: { include: { category: true } } },
    })

    // Variance flag: actual significantly higher than expected (vendor invoice
    // jumped). > 15% over expected fires `price_drift`. Catches inflated
    // utility bills, surprise software price hikes, etc.
    if (body.actualCents != null && body.expectedCents > 0) {
      const variancePct = (body.actualCents - body.expectedCents) / body.expectedCents
      if (variancePct > 0.15) {
        await flagException({
          kind: 'price_drift',
          severity: variancePct > 0.5 ? 'high' : 'medium',
          title: `OpEx jump: ${p.line.name} +${(variancePct * 100).toFixed(0)}%`,
          description: `Expected PKR ${(body.expectedCents / 100).toLocaleString()}, vendor charged PKR ${((body.actualCents ?? 0) / 100).toLocaleString()} for ${new Date(body.periodStart).toLocaleDateString('en-GB')}â€“${new Date(body.periodEnd).toLocaleDateString('en-GB')}. Either the rate changed (negotiate) or it's a billing error (dispute).`,
          entityType: 'OpexPayment',
          entityId: p.id,
          actorId: req.staffUser!.id,
          amountCents: body.actualCents - body.expectedCents,
          metadata: { lineId: body.lineId, lineName: p.line.name, expected: body.expectedCents, actual: body.actualCents, variancePct },
        })
      }
    }

    return reply.status(201).send(p)
  })

  fastify.patch<{ Params: { id: string } }>('/payments/:id', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({
      actualCents:   z.number().int().nonnegative().nullable().optional(),
      paidAt:        z.string().nullable().optional(),
      paymentRef:    z.string().max(120).nullable().optional(),
      receiptUrl:    z.string().url().nullable().optional(),
      notes:         z.string().nullable().optional(),
    }).parse(req.body)
    const owned = await prisma.opexPayment.findFirst({
      where: {
        id: req.params.id,
        line: { category: { tenantId: req.staffUser!.tenantFilter, deletedAt: null } },
      },
    })
    if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Payment not found in your active company' } })
    return prisma.opexPayment.update({
      where: { id: req.params.id },
      data: {
        ...body,
        paidAt: body.paidAt !== undefined ? (body.paidAt ? new Date(body.paidAt) : null) : undefined,
      },
    })
  })

  // â”€â”€â”€ Live data: payroll snapshot for the Payroll category â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  fastify.get('/payroll-snapshot', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    // Return last 6 months of posted payroll runs; UI renders as a "live" line
    // under the Payroll category instead of manual entry.
    const sixMonthsAgo = new Date(); sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6)
    const runs = await prisma.payrollRun.findMany({
      where: { periodStart: { gte: sixMonthsAgo } },
      orderBy: { periodStart: 'desc' },
      include: { _count: { select: { lines: true } } },
      take: 12,
    })

    // Also project this month — sum unposted clock logs × wage rates
    const monthStart = new Date()
    monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0)
    const monthEnd = new Date(monthStart); monthEnd.setMonth(monthEnd.getMonth() + 1)

    // Budgeted-position total: sums tenantCostShareCents across active
    // positions in this tenant. This is the "live" budget the OpEx page
    // shows under Payroll — edits in workforce/positions update this
    // immediately on next refresh, no manual sync.
    // tenantFilter narrowing: Position.tenantId is non-nullable; for orphan
    // users (filter === null) match nothing.
    const tenantFilter = req.staffUser!.tenantFilter ?? { in: [] as string[] }
    const positions = await prisma.position.findMany({
      where: {
        tenantId: tenantFilter,
        status: { in: ['open', 'filled', 'frozen'] },
      },
      select: {
        monthlySalaryCents: true,
        tenantCostShareCents: true,
        headcount: true,
        status: true,
        department: { select: { name: true, isHeadOffice: true } },
      },
    })

    const budgetedMonthly = positions.reduce(
      (s, p) => s + p.tenantCostShareCents * p.headcount, 0,
    )
    const budgetedGrossMonthly = positions.reduce(
      (s, p) => s + p.monthlySalaryCents * p.headcount, 0,
    )
    const headcountTotal = positions.reduce((s, p) => s + p.headcount, 0)
    const openSeats = positions.filter((p) => p.status === 'open').reduce((s, p) => s + p.headcount, 0)

    return {
      runs: runs.map((r) => ({
        id: r.id,
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        status: r.status,
        totalGrossCents: r.totalGrossCents,
        lineCount: r._count.lines,
      })),
      currentMonth: { start: monthStart, end: monthEnd },
      // Live position-based budget. UI surfaces this above the run history
      // so the operator sees what they're COMMITTED to before they see
      // what's already been paid out.
      budget: {
        monthlyCents:       budgetedMonthly,
        grossMonthlyCents:  budgetedGrossMonthly,
        headcount:          headcountTotal,
        openSeats,
      },
    }
  })

  // â”€â”€â”€ Cash-flow forecast (next 90 days) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  fastify.get('/cashflow', { preHandler: requireAuth(...MANAGERS) }, async () => {
    const now = new Date()
    const horizon = new Date(now); horizon.setDate(horizon.getDate() + 90)

    const lines = await prisma.opexLine.findMany({
      where: { isActive: true, nextDueDate: { gte: now, lte: horizon } },
      include: { category: { select: { name: true, emoji: true } } },
      orderBy: { nextDueDate: 'asc' },
    })

    return lines.map((l) => ({
      id: l.id,
      name: l.name,
      categoryName: l.category.name,
      categoryEmoji: l.category.emoji,
      dueDate: l.nextDueDate,
      amountCents: l.amountCents,
      vendor: l.vendor,
    }))
  })
}

// Cadence â†’ equivalent monthly cents for budget comparison.
function monthlyCents(amountCents: number, cadence: string): number {
  switch (cadence) {
    case 'quarterly': return Math.round(amountCents / 3)
    case 'annual':    return Math.round(amountCents / 12)
    case 'per_use':   return amountCents      // not strictly monthly; show as-is
    case 'monthly':
    default:          return amountCents
  }
}
