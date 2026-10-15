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
//
// D1 (spec §8, amendment A15) — the cost share is retired once the CEO has run
// the head-office setup wizard (headOfficeSetupApplied): shared seats live in
// the head office at 100% and the % split carries the cost, so the API strips
// tenantCostShareCents / costShareNote from input and keeps share = gross.
// Until then the input is accepted as before, and a salary edit that does not
// name a share scales the share by new/old salary (the seat's ratio stays —
// no silent planning change before the wizard normalises it).

import { scopeTenantWhere } from '../../lib/tenantScope.js'
import { assertInt4Fits, zInt4Cents } from '../../lib/money.js'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, HR_TEAM } from '../auth/middleware.js'
import type { UserRole } from '@prisma/client'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { budgetedLabour, PLAN_LABELS } from '../../lib/labour-budget.js'
import { headOfficeSetupApplied } from '../headOffices/books.js'
import { contributionRoutes } from './contributions.js'
import { moduleGateForNewRoles } from '../opex/moduleGate.js'

// Position.tenantId is non-nullable so we can't pass `null` through to
// Prisma's where clause (TS rejects it). In practice tenantFilter is only
// null for orphan users without any tenant â€” in that case we fail closed by
// returning a filter that matches nothing (`{ in: [] }`).

// Who (wave 3, UI-07 / UI-09):
//   POSITION_READERS — the manager tiers, HR and finance. Positions (budget)
//     is a page of HR's 'staff_directory' module, and the same seats are the
//     budgeted payroll on Finance's OpEx and CapEx → Workforce pages (THE
//     labour rule, projections/labour.ts). Both roles got 403 on every read.
//   POSITION_EDITORS — the manager tiers plus HR: the Positions page lives in
//     the HR workspace HR owns, a seat's title is an HR designation and its
//     department comes from HR → Org setup. Finance reads the budget; it does
//     not set headcount or salaries.
//   Inter-company contributions (./contributions.ts) are a PLANNING figure
//     (what one company bears for another, netted into the budget); they post
//     nothing. Money that moves between two companies' books is an
//     inter-company transfer (Accounting → Inter-company, modules/intercompany).
//     Reads follow POSITION_READERS, writes stay MANAGERS (member of both).
export const POSITION_READERS = Array.from(new Set([...MANAGERS, 'hr', 'finance'])) as UserRole[]
export const POSITION_EDITORS = HR_TEAM
// /positions is not a central module-gated prefix, so the roles newly let in
// must also hold the module whose page they use (W3B-RV-1): HR
// 'staff_directory' (Workforce → Positions), finance 'capital' (CapEx →
// Workforce, OpEx's budgeted payroll). Editing is HR's page only. Manager
// tiers pass exactly as before.
export const POSITION_READ_MODULES = ['staff_directory', 'capital'] as const
const POSITION_READ_GUARD = [requireAuth(...POSITION_READERS), moduleGateForNewRoles(POSITION_READ_MODULES)]
const POSITION_EDIT_GUARD = [requireAuth(...POSITION_EDITORS), moduleGateForNewRoles(['staff_directory'])]

/** The active company, or 422 — department / shift-band lists are per company. */
function activeCompany(req: FastifyRequest): string {
  const t = req.staffUser!.tenantId
  if (!t) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company first', 422)
  return t
}

const positionSchema = z.object({
  conceptId:            z.string().uuid().nullable().optional(),
  departmentId:         z.string().uuid().nullable().optional(),
  shiftBandId:          z.string().uuid().nullable().optional(),
  title:                z.string().min(1).max(120).optional(),
  /** HR designation (HrOrgUnit kind=designation). Sets the title. */
  designationId:        z.string().uuid().nullable().optional(),
  monthlySalaryCents:   zInt4Cents('Monthly salary'),
  tenantCostShareCents: zInt4Cents('Cost share').optional(),
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

  fastify.get('/departments', { preHandler: POSITION_READ_GUARD }, async (req) => {
    const tenantId = req.staffUser!.tenantId
    if (!tenantId) return []
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

  fastify.get('/shift-bands', { preHandler: POSITION_READ_GUARD }, async (req) => {
    const tenantId = req.staffUser!.tenantId
    if (!tenantId) return []
    return prisma.shiftBand.findMany({
      where: { tenantId, archivedAt: null },
      orderBy: [{ order: 'asc' }, { startTime: 'asc' }],
    })
  })

  fastify.post<{ Body: { name: string; startTime: string; endTime: string; order?: number } }>(
    '/shift-bands',
    { preHandler: POSITION_EDIT_GUARD },
    async (req) => {
      const tenantId = activeCompany(req)
      const body = z.object({
        name: z.string().min(1).max(40),
        startTime: z.string().regex(/^\d{2}:\d{2}$/),
        endTime: z.string().regex(/^\d{2}:\d{2}$/),
        order: z.number().int().default(0),
      }).parse(req.body)
      return prisma.shiftBand.create({
        data: { ...body, tenantId },
      })
    },
  )

  fastify.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/shift-bands/:id',
    { preHandler: POSITION_EDIT_GUARD },
    async (req) => {
      const body = z.object({
        name: z.string().optional(),
        startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        endTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        order: z.number().int().optional(),
        archivedAt: z.string().nullable().optional(),
      }).parse(req.body)
      // Foreign or missing → 404 (an update on a non-matching where threw
      // P2025, which surfaced as a 500).
      const band = await prisma.shiftBand.findFirst({ where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) }, select: { id: true } })
      if (!band) throw new NotFoundError('ShiftBand', req.params.id)
      return prisma.shiftBand.update({
        where: { id: band.id },
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
    { preHandler: POSITION_READ_GUARD },
    async (req) => {
      const { conceptId, departmentId, status } = req.query
      const applied = await headOfficeSetupApplied()
      const rows = await prisma.position.findMany({
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
      if (!applied) return rows
      // D1: after the head-office setup a head-office department is one that
      // lives in a head office; Department.isHeadOffice is no longer read.
      const hoTenants = new Set((await prisma.tenant.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.tenantId))] }, kind: 'head_office' }, select: { id: true },
      })).map((t) => t.id))
      return rows.map((r) => (r.department ? { ...r, department: { ...r.department, isHeadOffice: hoTenants.has(r.tenantId) } } : r))
    },
  )

  // Roll-up totals for the Workforce → Positions header. The figures come
  // from budgetedLabour() (lib/labour-budget.ts), the same function OpEx, the
  // pro-forma and projections use: frozen seats are left out of the budget and
  // inter-company contributions net off.
  fastify.get('/summary', { preHandler: POSITION_READ_GUARD }, async (req) => {
    const f = (await scopeTenantWhere(req, 'read')).tenantId
    const tenantIds = typeof f === 'string' ? [f] : f.in
    // One labour rule (projections/labour.ts): open + filled seats at the
    // company's cost share, JV contribution netted (owner decision 25).
    const { monthlyLabourCents } = await import('../projections/labour.js')
    const perCompany = await Promise.all(tenantIds.map((t) => monthlyLabourCents(t)))
    const seatsCents = perCompany.reduce((a, l) => a + l.seatsCents, 0)
    const b = await budgetedLabour(tenantIds)
    const net = seatsCents + b.outgoingContributionMonthlyCents - b.incomingContributionMonthlyCents
      + b.headOfficeChargesMonthlyCents - b.rechargedOutMonthlyCents
    return {
      totalPositions: b.positions,
      totalHeadcount: perCompany.reduce((a, l) => a + l.headcount, 0),
      totalGrossMonthlyCents:       perCompany.reduce((a, l) => a + l.grossSalaryCents, 0),
      totalTenantShareMonthlyCents: seatsCents,
      netMonthlyCents:              net,
      incomingContributionMonthlyCents: b.incomingContributionMonthlyCents,
      outgoingContributionMonthlyCents: b.outgoingContributionMonthlyCents,
      // D1 (after the head-office setup): this scope's head-office charges
      // (plan) and, for a head office in scope, what it recharges out.
      headOfficeChargesMonthlyCents: b.headOfficeChargesMonthlyCents,
      headOfficeCharges: b.headOfficeCharges,
      rechargedOutMonthlyCents: b.rechargedOutMonthlyCents,
      labels: PLAN_LABELS,
      annualisedTenantShareCents: seatsCents * 12,
      annualisedNetCents:         net * 12,
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

  /**
   * The department, brand, shift band and filling login must be this
   * company's. `keepShiftBandId` is the seat's current band: re-sending it
   * unchanged (the edit form always sends it) is not refused if it has since
   * been archived — only a NEW band must be a live band of this company.
   */
  async function checkSeatRefs(tenantId: string, body: { departmentId?: string | null; filledByUserId?: string | null; conceptId?: string | null; shiftBandId?: string | null }, keepShiftBandId?: string | null) {
    // Another company's band attached here would come back through GET
    // /positions (include shiftBand) — a cross-company attach is 422
    // (W3B-RV-3).
    if (body.shiftBandId) {
      const band = await prisma.shiftBand.findFirst({ where: { id: body.shiftBandId, tenantId }, select: { archivedAt: true } })
      if (!band || (band.archivedAt && body.shiftBandId !== keepShiftBandId)) {
        throw new AppError('SHIFT_BAND_NOT_IN_COMPANY', 'That shift band is not in this company', 422)
      }
    }
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

  fastify.post('/', { preHandler: POSITION_EDIT_GUARD }, async (req) => {
    const { designationId, ...parsed } = positionSchema.parse(req.body)
    const tenantId = req.staffUser!.tenantId
    if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before adding a position', 422)
    const applied = await headOfficeSetupApplied()
    // After the head-office setup the cost share is not an input (share = gross).
    const { tenantCostShareCents: shareIn, costShareNote, ...rest } = parsed
    const body = applied ? rest : { ...rest, costShareNote }
    await checkSeatRefs(tenantId, body)
    const title = await seatTitle(tenantId, { title: body.title, designationId })
    if (!title) throw new AppError('TITLE_REQUIRED', 'Pick the designation this seat is for', 400)
    // Default cost-share to gross if not provided (always gross after setup).
    const tenantCostShareCents = applied ? body.monthlySalaryCents : (shareIn ?? body.monthlySalaryCents)
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
    { preHandler: POSITION_EDIT_GUARD },
    async (req) => {
      const { designationId, ...parsed } = positionSchema.partial().parse(req.body)
      const seat = await prisma.position.findFirst({
        where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) },
        select: { id: true, tenantId: true, shiftBandId: true, monthlySalaryCents: true, tenantCostShareCents: true },
      })
      if (!seat) throw new NotFoundError('Position', req.params.id)
      const applied = await headOfficeSetupApplied()
      const { tenantCostShareCents: shareIn, costShareNote, ...rest } = parsed
      const salaryChanged = rest.monthlySalaryCents !== undefined && rest.monthlySalaryCents !== seat.monthlySalaryCents
      let share: number | undefined
      if (applied) {
        // After setup: share is never an input; it follows the salary.
        if (rest.monthlySalaryCents !== undefined) share = rest.monthlySalaryCents
      } else if (shareIn !== undefined) {
        share = shareIn
      } else if (salaryChanged) {
        // A15: keep the seat's share ratio (share × new / old) until the wizard
        // normalises it; a seat with no salary before takes the new gross.
        // Ratio first (share × (new / old)) so the product never leaves the
        // safe-integer range; the result is INT4-checked before the write.
        share = seat.monthlySalaryCents > 0
          ? Math.round(seat.tenantCostShareCents * (rest.monthlySalaryCents! / seat.monthlySalaryCents))
          : rest.monthlySalaryCents!
      }
      if (share !== undefined) assertInt4Fits(share, 'Cost share')
      const body = applied ? rest : { ...rest, ...(costShareNote !== undefined && { costShareNote }) }
      await checkSeatRefs(seat.tenantId, body, seat.shiftBandId)
      const title = await seatTitle(seat.tenantId, { title: body.title, designationId })
      return prisma.position.update({
        where: { id: seat.id },
        data: { ...body, ...(share !== undefined && { tenantCostShareCents: share }), ...(title !== undefined && { title }) },
      })
    },
  )

  fastify.delete<{ Params: { id: string } }>('/:id', { preHandler: POSITION_EDIT_GUARD }, async (req) => {
    // Soft-archive so historical reports still resolve names/salaries.
    // Another company's seat (or a missing one) is 404, not a P2025 500.
    const seat = await prisma.position.findFirst({ where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) }, select: { id: true } })
    if (!seat) throw new NotFoundError('Position', req.params.id)
    await prisma.position.update({
      where: { id: seat.id },
      data: { status: 'archived' },
    })
    return { ok: true }
  })
}

