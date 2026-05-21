// Workforce positions â€” budgeted seats (filled or not).
//
// Endpoints:
//   GET    /positions/departments                â€” list (auto-seed defaults on first call)
//   POST   /positions/departments                â€” create
//   PATCH  /positions/departments/:id            â€” rename / archive / reorder
//
//   GET    /positions/shift-bands                â€” list
//   POST   /positions/shift-bands                â€” create
//   PATCH  /positions/shift-bands/:id            â€” edit
//
//   GET    /positions                            â€” list (filterable by concept, dept, status)
//   GET    /positions/summary                    â€” rollups by tenant / concept / department
//   POST   /positions                            â€” create
//   PATCH  /positions/:id                        â€” edit (salary, headcount, status, fill)
//   DELETE /positions/:id                        â€” archive (soft, sets status='archived')
//
// Cost-share model: monthlySalaryCents = gross; tenantCostShareCents = what
// the current tenant's P&L bears. /summary returns totals using cost-share
// (what shows up in OpEx) and gross (what gets paid out to humans).

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS } from '../auth/middleware.js'

// Position.tenantId is non-nullable so we can't pass `null` through to
// Prisma's where clause (TS rejects it). In practice tenantFilter is only
// null for orphan users without any tenant â€” in that case we fail closed by
// returning a filter that matches nothing (`{ in: [] }`).
function tenantWhere(req: FastifyRequest): string | { in: string[] } {
  const f = req.staffUser!.tenantFilter
  if (f === null) return { in: [] }
  return f
}

const positionSchema = z.object({
  conceptId:            z.string().uuid().nullable().optional(),
  departmentId:         z.string().uuid().nullable().optional(),
  shiftBandId:          z.string().uuid().nullable().optional(),
  title:                z.string().min(1).max(120),
  monthlySalaryCents:   z.number().int().nonnegative(),
  tenantCostShareCents: z.number().int().nonnegative().optional(),
  costShareNote:        z.string().max(280).nullable().optional(),
  headcount:            z.number().int().positive().default(1),
  filledByUserId:       z.string().nullable().optional(),
  status:               z.enum(['open', 'filled', 'frozen', 'archived']).default('open'),
  notes:                z.string().max(500).nullable().optional(),
})

export async function positionRoutes(fastify: FastifyInstance) {

  // â”€â”€â”€ Departments â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  fastify.get('/departments', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const tenantId = req.staffUser!.tenantId!
    return prisma.department.findMany({
      where: { tenantId, archivedAt: null },
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
    })
  })

  fastify.post<{ Body: { name: string; emoji?: string; isHeadOffice?: boolean; order?: number } }>(
    '/departments',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = z.object({
        name: z.string().min(1).max(80),
        emoji: z.string().max(8).optional(),
        isHeadOffice: z.boolean().default(false),
        order: z.number().int().default(0),
      }).parse(req.body)
      return prisma.department.create({
        data: { ...body, tenantId: req.staffUser!.tenantId! },
      })
    },
  )

  fastify.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/departments/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = z.object({
        name: z.string().min(1).max(80).optional(),
        emoji: z.string().max(8).nullable().optional(),
        isHeadOffice: z.boolean().optional(),
        order: z.number().int().optional(),
        archivedAt: z.string().nullable().optional(),
      }).parse(req.body)
      return prisma.department.update({
        where: { id: req.params.id, tenantId: tenantWhere(req) },
        data: {
          ...body,
          archivedAt: body.archivedAt === undefined ? undefined : body.archivedAt ? new Date(body.archivedAt) : null,
        },
      })
    },
  )

  // â”€â”€â”€ Shift bands â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  fastify.get('/shift-bands', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    return prisma.shiftBand.findMany({
      where: { tenantId: req.staffUser!.tenantId!, archivedAt: null },
      orderBy: [{ order: 'asc' }, { startTime: 'asc' }],
    })
  })

  fastify.post<{ Body: { name: string; startTime: string; endTime: string; order?: number } }>(
    '/shift-bands',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = z.object({
        name: z.string().min(1).max(40),
        startTime: z.string().regex(/^\d{2}:\d{2}$/),
        endTime: z.string().regex(/^\d{2}:\d{2}$/),
        order: z.number().int().default(0),
      }).parse(req.body)
      return prisma.shiftBand.create({
        data: { ...body, tenantId: req.staffUser!.tenantId! },
      })
    },
  )

  fastify.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/shift-bands/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = z.object({
        name: z.string().optional(),
        startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        endTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        order: z.number().int().optional(),
        archivedAt: z.string().nullable().optional(),
      }).parse(req.body)
      return prisma.shiftBand.update({
        where: { id: req.params.id, tenantId: tenantWhere(req) },
        data: {
          ...body,
          archivedAt: body.archivedAt === undefined ? undefined : body.archivedAt ? new Date(body.archivedAt) : null,
        },
      })
    },
  )

  // â”€â”€â”€ Positions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  fastify.get<{ Querystring: { conceptId?: string; departmentId?: string; status?: string } }>(
    '/',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const { conceptId, departmentId, status } = req.query
      return prisma.position.findMany({
        where: {
          tenantId: tenantWhere(req),
          ...(conceptId ? { conceptId } : {}),
          ...(departmentId ? { departmentId } : {}),
          // By default hide archived; opt in with status=archived or status=all
          ...(status && status !== 'all' ? { status: status as 'open' | 'filled' | 'frozen' | 'archived' } : {}),
          ...(status ? {} : { status: { not: 'archived' as const } }),
        },
        include: {
          concept:    { select: { id: true, name: true, slug: true } },
          department: { select: { id: true, name: true, emoji: true, isHeadOffice: true } },
          shiftBand:  { select: { id: true, name: true, startTime: true, endTime: true } },
          filledBy:   { select: { id: true, name: true, email: true } },
        },
        orderBy: [
          { department: { order: 'asc' } },
          { shiftBand:  { order: 'asc' } },
          { monthlySalaryCents: 'desc' },
        ],
      })
    },
  )

  // Roll-up totals. Used by the workforce hub header AND the OpEx + projections
  // pages to show "live budgeted payroll" without re-implementing the math.
  fastify.get('/summary', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const positions = await prisma.position.findMany({
      where: {
        tenantId: tenantWhere(req),
        status: { in: ['open', 'filled', 'frozen'] }, // archived excluded
      },
      include: {
        concept:    { select: { id: true, name: true } },
        department: { select: { id: true, name: true, emoji: true, isHeadOffice: true } },
      },
    })

    let totalGrossMonthly = 0
    let totalTenantShareMonthly = 0
    const byConcept = new Map<string, { id: string | null; name: string; grossCents: number; shareCents: number; count: number }>()
    const byDepartment = new Map<string, { id: string; name: string; emoji: string | null; isHeadOffice: boolean; grossCents: number; shareCents: number; count: number }>()
    const byStatus = { open: 0, filled: 0, frozen: 0 }

    for (const p of positions) {
      const gross = p.monthlySalaryCents * p.headcount
      const share = p.tenantCostShareCents * p.headcount
      totalGrossMonthly += gross
      totalTenantShareMonthly += share

      const cKey = p.conceptId ?? 'tenant'
      const cName = p.concept?.name ?? 'Tenant-wide / Head Office'
      const cBucket = byConcept.get(cKey) ?? { id: p.conceptId, name: cName, grossCents: 0, shareCents: 0, count: 0 }
      cBucket.grossCents += gross
      cBucket.shareCents += share
      cBucket.count += p.headcount
      byConcept.set(cKey, cBucket)

      if (p.department) {
        const dBucket = byDepartment.get(p.department.id) ?? {
          id: p.department.id,
          name: p.department.name,
          emoji: p.department.emoji,
          isHeadOffice: p.department.isHeadOffice,
          grossCents: 0, shareCents: 0, count: 0,
        }
        dBucket.grossCents += gross
        dBucket.shareCents += share
        dBucket.count += p.headcount
        byDepartment.set(p.department.id, dBucket)
      }

      if (p.status === 'open' || p.status === 'filled' || p.status === 'frozen') {
        byStatus[p.status] += p.headcount
      }
    }

    return {
      totalPositions: positions.length,
      totalHeadcount: positions.reduce((s, p) => s + p.headcount, 0),
      totalGrossMonthlyCents: totalGrossMonthly,
      totalTenantShareMonthlyCents: totalTenantShareMonthly,
      annualisedTenantShareCents: totalTenantShareMonthly * 12,
      byConcept: Array.from(byConcept.values()).sort((a, b) => b.shareCents - a.shareCents),
      byDepartment: Array.from(byDepartment.values()).sort((a, b) => b.shareCents - a.shareCents),
      byStatus,
    }
  })

  fastify.post('/', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const body = positionSchema.parse(req.body)
    // Default cost-share to gross if not provided.
    const tenantCostShareCents = body.tenantCostShareCents ?? body.monthlySalaryCents
    return prisma.position.create({
      data: {
        ...body,
        tenantCostShareCents,
        tenantId: req.staffUser!.tenantId!,
      },
    })
  })

  fastify.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = positionSchema.partial().parse(req.body)
      return prisma.position.update({
        where: { id: req.params.id, tenantId: tenantWhere(req) },
        data: body,
      })
    },
  )

  fastify.delete<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    // Soft-archive so historical reports still resolve names/salaries.
    await prisma.position.update({
      where: { id: req.params.id, tenantId: tenantWhere(req) },
      data: { status: 'archived' },
    })
    return { ok: true }
  })
}

