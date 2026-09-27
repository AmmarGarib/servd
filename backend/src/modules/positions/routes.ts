// Workforce positions â€” budgeted seats (filled or not).
//
// Endpoints:
//   GET    /positions/departments                — list (read-only; written in HR → Org setup)
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

import { scopeTenantWhere } from '../../lib/tenantScope.js'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { budgetedLabour } from '../../lib/labour-budget.js'
import { contributionRoutes } from './contributions.js'

// Position.tenantId is non-nullable so we can't pass `null` through to
// Prisma's where clause (TS rejects it). In practice tenantFilter is only
// null for orphan users without any tenant â€” in that case we fail closed by
// returning a filter that matches nothing (`{ in: [] }`).

const positionSchema = z.object({
  conceptId:            z.string().uuid().nullable().optional(),
  departmentId:         z.string().uuid().nullable().optional(),
  shiftBandId:          z.string().uuid().nullable().optional(),
  title:                z.string().min(1).max(120).optional(),
  /** HR designation (HrOrgUnit kind=designation). Sets the title. */
  designationId:        z.string().uuid().nullable().optional(),
  monthlySalaryCents:   z.number().int().nonnegative(),
  tenantCostShareCents: z.number().int().nonnegative().optional(),
  costShareNote:        z.string().max(280).nullable().optional(),
  headcount:            z.number().int().positive().default(1),
  filledByUserId:       z.string().nullable().optional(),
  status:               z.enum(['open', 'filled', 'frozen', 'archived']).default('open'),
  notes:                z.string().max(500).nullable().optional(),
})

export async function positionRoutes(fastify: FastifyInstance) {

  // Mount inter-tenant contributions sub-routes at /positions/contributions/*
  await fastify.register(contributionRoutes, { prefix: '/contributions' })

  // ─── Departments ───────────────────────────────────────────────────────────

  fastify.get('/departments', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const tenantId = req.staffUser!.tenantId!
    return prisma.department.findMany({
      where: { tenantId, archivedAt: null },
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
    })
  })

  // Departments are WRITTEN in one place only: HR → Org setup
  // (/hr/org/departments — 409 on a duplicate name, archive refused while
  // current employees are in it). Positions only reads them. (Decision on
  // item 76: HR org setup is the canonical department master.)

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
        where: { id: req.params.id, ...(await scopeTenantWhere(req, 'read')) },
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
          ...(await scopeTenantWhere(req, 'read')),
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

  // Roll-up totals for the Workforce → Positions header. The figures come
  // from budgetedLabour() (lib/labour-budget.ts), the same function OpEx, the
  // pro-forma and projections use: frozen seats are left out of the budget and
  // inter-company contributions net off.
  fastify.get('/summary', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const f = (await scopeTenantWhere(req, 'read')).tenantId
    const tenantIds = typeof f === 'string' ? [f] : f.in
    const b = await budgetedLabour(tenantIds)
    return {
      totalPositions: b.positions,
      totalHeadcount: b.headcount,
      totalGrossMonthlyCents:       b.grossMonthlyCents,
      totalTenantShareMonthlyCents: b.shareMonthlyCents,
      netMonthlyCents:              b.netMonthlyCents,
      incomingContributionMonthlyCents: b.incomingContributionMonthlyCents,
      outgoingContributionMonthlyCents: b.outgoingContributionMonthlyCents,
      annualisedTenantShareCents: b.shareMonthlyCents * 12,
      annualisedNetCents:         b.netMonthlyCents * 12,
      // Frozen seats are shown, never budgeted.
      frozenShareMonthlyCents: b.frozenShareMonthlyCents,
      byConcept: b.byConcept,
      byDepartment: b.byDepartment,
      byStatus: { open: b.openSeats, filled: b.filledSeats, frozen: b.frozenSeats },
      contributions: b.contributions,
    }
  })

  // A seat's title is an HR designation (decision on item 76: the job title
  // lives on HrEmployee.designationId and the designation list is HR's). A
  // title that is not one of the company's designations is refused, so the
  // three names for one job — seat title, login job title, HR designation —
  // cannot drift apart again.
  async function seatTitle(tenantId: string, body: { title?: string; designationId?: string | null }): Promise<string | undefined> {
    if (body.designationId) {
      const unit = await prisma.hrOrgUnit.findFirst({ where: { id: body.designationId, tenantId, kind: 'designation' } })
      if (!unit) throw new AppError('UNKNOWN_DESIGNATION', 'That designation is not in this company', 422)
      return unit.name
    }
    if (body.title === undefined) return undefined
    const unit = await prisma.hrOrgUnit.findFirst({ where: { tenantId, kind: 'designation', name: { equals: body.title.trim(), mode: 'insensitive' } } })
    if (!unit) throw new AppError('UNKNOWN_DESIGNATION', `"${body.title}" is not a designation — add it in HR → Org setup first`, 422)
    return unit.name
  }

  /** The department and the filling login must be this company's. */
  async function checkSeatRefs(tenantId: string, body: { departmentId?: string | null; filledByUserId?: string | null; conceptId?: string | null }) {
    if (body.departmentId && !await prisma.department.findFirst({ where: { id: body.departmentId, OR: [{ tenantId }, { tenantId: null }] }, select: { id: true } })) {
      throw new AppError('DEPARTMENT_NOT_IN_COMPANY', 'That department is not in this company', 422)
    }
    if (body.conceptId && !await prisma.concept.findFirst({ where: { id: body.conceptId, tenantId, deletedAt: null }, select: { id: true } })) {
      throw new AppError('BRAND_NOT_IN_COMPANY', 'That brand does not belong to this company', 422)
    }
    if (body.filledByUserId && !await prisma.user.findFirst({
      where: { id: body.filledByUserId, deletedAt: null, OR: [{ tenantId }, { tenantMemberships: { some: { tenantId } } }] }, select: { id: true },
    })) {
      throw new AppError('USER_NOT_IN_COMPANY', 'That login does not belong to this company', 422)
    }
  }

  fastify.post('/', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const { designationId, ...body } = positionSchema.parse(req.body)
    const tenantId = req.staffUser!.tenantId
    if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before adding a position', 422)
    await checkSeatRefs(tenantId, body)
    const title = await seatTitle(tenantId, { title: body.title, designationId })
    if (!title) throw new AppError('TITLE_REQUIRED', 'Pick the designation this seat is for', 400)
    // Default cost-share to gross if not provided.
    const tenantCostShareCents = body.tenantCostShareCents ?? body.monthlySalaryCents
    return prisma.position.create({
      data: {
        ...body,
        title,
        tenantCostShareCents,
        tenantId,
      },
    })
  })

  fastify.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const { designationId, ...body } = positionSchema.partial().parse(req.body)
      const seat = await prisma.position.findFirst({ where: { id: req.params.id, ...(await scopeTenantWhere(req, 'read')) }, select: { id: true, tenantId: true } })
      if (!seat) throw new NotFoundError('Position', req.params.id)
      await checkSeatRefs(seat.tenantId, body)
      const title = await seatTitle(seat.tenantId, { title: body.title, designationId })
      return prisma.position.update({
        where: { id: seat.id },
        data: { ...body, ...(title !== undefined && { title }) },
      })
    },
  )

  fastify.delete<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    // Soft-archive so historical reports still resolve names/salaries.
    await prisma.position.update({
      where: { id: req.params.id, ...(await scopeTenantWhere(req, 'read')) },
      data: { status: 'archived' },
    })
    return { ok: true }
  })
}

