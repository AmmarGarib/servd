// /scheduling — the weekly rota grid.
//
// Owner decision 33: standing shifts and weekly offs are set in HR (the shift
// master and approved roster records). This grid is GENERATED from them
// (hr/rota.ts) — managers store only the EXCEPTIONS here: a different time on
// a day, an extra shift, or a day off. An approved HR shift_swap moves a day
// on its own; there is no swap request here any more (HR's shift_swap is the
// only one). The week is costed from HR salaries (gross ÷ working days ÷
// hours per day), never from User.hourlyRateCents.
//
// People on the grid are the company's current HR employees whose branch
// serves this brand (or who have no branch). Everything is company-scoped:
// the brand is resolved through its owning company first.
//
// scheduled_shifts is keyed by login (userId) until it gets an employeeId
// column (see the report), so an exception can only be stored for someone
// with a login; staff without one follow their HR roster.

import type { FastifyInstance } from 'fastify'
import type { UserRole } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { assertConceptOwned, scopeTenantWhere } from '../../lib/tenantScope.js'
import { moveToTrash, trashReasonOf } from '../../lib/trash.js'
import { takeSnapshot } from '../trash/snapshot.js'
import { rotaFor, shiftMaster, cellMinutes, toMinutes, segmentMinutes, ymd, OFF_MARK, approvedLeaveOn, leaveSpan, isHalfDayLeave as isHalfDay } from '../hr/rota.js'
import { employeeLabels, getSettings } from '../hr/service.js'
import { hourlyRateCents, payDaysFor, periodOf } from '../hr/logic.js'

/** Who plans the rota and sees what it costs. */
export const ROTA_PLANNERS = Array.from(new Set([...MANAGERS, 'hr'])) as UserRole[]

const HHMM = z.string().regex(/^\d{2}:\d{2}$/, 'time must be HH:MM')
const exceptionSchema = z.object({
  employeeId: z.string().uuid(),
  conceptId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  /** Take the day off instead of setting hours. */
  off: z.boolean().optional(),
  /** Hours from an HR shift instead of typed times. */
  shiftId: z.string().uuid().optional(),
  startTime: HHMM.optional(),
  endTime: HHMM.optional(),
  role: z.string().max(60).optional(),
  notes: z.string().max(300).optional(),
})

/** Monday..Sunday (UTC dates) of the week containing `weekStart`. */
function weekBounds(weekStart: string): { mon: Date; sun: Date } {
  const anchor = new Date(`${weekStart.slice(0, 10)}T00:00:00.000Z`)
  const mon = new Date(anchor.getTime() - ((anchor.getUTCDay() + 6) % 7) * 86_400_000)
  const sun = new Date(mon.getTime() + 6 * 86_400_000)
  return { mon, sun }
}

/** [startA, endA) overlaps [startB, endB), each possibly past midnight. */
function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  const a0 = toMinutes(aStart)!, b0 = toMinutes(bStart)!
  const a1 = a0 + segmentMinutes(aStart, aEnd), b1 = b0 + segmentMinutes(bStart, bEnd)
  return a0 < b1 && b0 < a1
}

/** The company's current employees who work for this brand. */
async function gridEmployees(tenantId: string, conceptId: string) {
  const [emps, links] = await Promise.all([
    prisma.hrEmployee.findMany({ where: { tenantId, status: { in: ['active', 'on_leave'] } }, orderBy: { fullName: 'asc' } }),
    prisma.conceptLocation.findMany({ where: { conceptId }, select: { locationId: true } }),
  ])
  const locs = new Set(links.map((l) => l.locationId))
  return emps.filter((e) => !e.locationId || locs.size === 0 || locs.has(e.locationId))
}

// approvedLeaveOn (hr/rota.ts) — the one leave check the rota and a shift
// swap share (audit PPL-12 / HR-R5).

function onLeave(name: string, leave: { id: string; startDate: Date | null; endDate: Date | null }) {
  const span = leaveSpan(leave)
  return new AppError('ON_LEAVE', `${name} is on approved leave (${span}) — shorten or cancel the leave in HR before rostering them that day`, 409, { leaveId: leave.id })
}

/** An exception row, or 404 when it is not in the operator's companies. */
async function exceptionInScope(req: Parameters<typeof scopeTenantWhere>[0], id: string) {
  const row = await prisma.scheduledShift.findFirst({
    where: { id, concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
    include: { concept: { select: { tenantId: true } } },
  })
  if (!row) throw new NotFoundError('ScheduledShift', id)
  return row
}

export async function schedulingRoutes(fastify: FastifyInstance) {
  // GET /scheduling?conceptId=X&weekStart=YYYY-MM-DD — the generated week.
  fastify.get<{ Querystring: { conceptId: string; weekStart?: string } }>('/', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const concept = await assertConceptOwned(req, req.query.conceptId, 'read')
    if (!concept.tenantId) throw new NotFoundError('Concept', req.query.conceptId)
    const { mon, sun } = weekBounds(req.query.weekStart ?? new Date().toISOString())
    const emps = await gridEmployees(concept.tenantId, concept.id)
    const [cells, label, shifts] = await Promise.all([
      rotaFor(concept.tenantId, emps, ymd(mon), ymd(sun)),
      employeeLabels(concept.tenantId, emps),
      shiftMaster(concept.tenantId),
    ])
    return {
      weekStart: ymd(mon),
      weekEnd: ymd(sun),
      conceptId: concept.id,
      staff: emps.map((e) => ({
        id: e.id, name: e.fullName, employeeCode: e.employeeCode, designation: label(e.designationId),
        // An exception needs a login until scheduled_shifts is keyed by employee.
        canHaveExceptions: !!e.userId,
      })),
      cells: cells.map((c) => ({ ...c, minutes: cellMinutes(c) })),
      shifts: Array.from(shifts.values()),
    }
  })

  // POST /scheduling — store an exception for one person on one day.
  fastify.post('/', { preHandler: requireAuth(...ROTA_PLANNERS) }, async (req, reply) => {
    const body = exceptionSchema.parse(req.body)
    const concept = await assertConceptOwned(req, body.conceptId, 'create')
    const emp = await prisma.hrEmployee.findFirst({ where: { id: body.employeeId, tenantId: concept.tenantId ?? '', status: { in: ['active', 'on_leave'] } } })
    if (!emp) throw new AppError('EMPLOYEE_NOT_IN_COMPANY', 'That person is not a current employee of this brand\'s company', 422)
    if (!emp.userId) {
      throw new AppError('NO_LOGIN_FOR_EXCEPTION', `${emp.fullName} has no servd login, so a one-day change cannot be stored for them yet — change their standing shift in HR → Roster, or approve a shift swap`, 422)
    }
    const date = new Date(`${body.date}T00:00:00.000Z`)
    const sameDay = await prisma.scheduledShift.findMany({ where: { userId: emp.userId, date, concept: { tenantId: concept.tenantId } } })

    if (body.off) {
      // A day off replaces whatever was planned for that day.
      const [, row] = await prisma.$transaction([
        prisma.scheduledShift.deleteMany({ where: { id: { in: sameDay.map((x) => x.id) } } }),
        prisma.scheduledShift.create({ data: { userId: emp.userId, conceptId: concept.id, date, startTime: '00:00', endTime: '00:00', role: OFF_MARK, notes: body.notes ?? null } }),
      ])
      return reply.status(201).send(row)
    }

    let start = body.startTime, end = body.endTime
    if (body.shiftId) {
      const s = (await shiftMaster(concept.tenantId!)).get(body.shiftId)
      if (!s) throw new AppError('UNKNOWN_SHIFT', 'That shift is not in this company\'s shift master', 422)
      start = s.start; end = s.end
    }
    if (!start || !end) throw new AppError('TIMES_REQUIRED', 'Give a start and end time, pick a shift, or mark the day off', 400)
    if (start === end) throw new AppError('BAD_TIMES', 'A shift cannot start and end at the same time', 400)
    const leave = await approvedLeaveOn(concept.tenantId!, emp.id, date)
    if (leave) throw onLeave(emp.fullName, leave)
    const clash = sameDay.find((x) => x.role !== OFF_MARK && overlaps(start!, end!, x.startTime, x.endTime))
    if (clash) throw new AppError('SHIFT_CONFLICT', `${emp.fullName} is already down for ${clash.startTime}–${clash.endTime} that day`, 409)
    const offRows = sameDay.filter((x) => x.role === OFF_MARK).map((x) => x.id)
    const [, row] = await prisma.$transaction([
      // Working after all: a day-off exception for the same day goes.
      prisma.scheduledShift.deleteMany({ where: { id: { in: offRows } } }),
      prisma.scheduledShift.create({
        data: { userId: emp.userId, conceptId: concept.id, date, startTime: start, endTime: end, role: body.role ?? null, notes: body.notes ?? null },
      }),
    ])
    return reply.status(201).send(row)
  })

  // PATCH /scheduling/:id — change an exception's hours or notes.
  fastify.patch<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...ROTA_PLANNERS) }, async (req) => {
    const body = z.object({ startTime: HHMM.optional(), endTime: HHMM.optional(), role: z.string().max(60).nullable().optional(), notes: z.string().max(300).nullable().optional() }).parse(req.body)
    const row = await exceptionInScope(req, req.params.id)
    if (row.role === OFF_MARK) throw new AppError('DAY_OFF', 'This is a day off — remove it and add hours instead', 409)
    const start = body.startTime ?? row.startTime, end = body.endTime ?? row.endTime
    if (start === end) throw new AppError('BAD_TIMES', 'A shift cannot start and end at the same time', 400)
    // The person behind the login, in the shift's company: their leave
    // refuses a change of hours too.
    const emp = row.concept.tenantId ? await prisma.hrEmployee.findFirst({ where: { tenantId: row.concept.tenantId, userId: row.userId }, select: { id: true, fullName: true } }) : null
    const leave = emp ? await approvedLeaveOn(row.concept.tenantId!, emp.id, row.date) : null
    if (emp && leave) throw onLeave(emp.fullName, leave)
    const others = await prisma.scheduledShift.findMany({ where: { userId: row.userId, date: row.date, id: { not: row.id }, OR: [{ role: null }, { role: { not: OFF_MARK } }], concept: { tenantId: row.concept.tenantId } } })
    const clash = others.find((x) => overlaps(start, end, x.startTime, x.endTime))
    if (clash) throw new AppError('SHIFT_CONFLICT', `Already down for ${clash.startTime}–${clash.endTime} that day`, 409)
    return prisma.scheduledShift.update({
      where: { id: row.id },
      data: { startTime: start, endTime: end, ...(body.role !== undefined && { role: body.role }), ...(body.notes !== undefined && { notes: body.notes }) },
    })
  })

  // DELETE /scheduling/:id — drop an exception; the day goes back to the roster.
  fastify.delete<{ Params: { id: string } }>('/:id', { preHandler: requireAuth(...ROTA_PLANNERS) }, async (req, reply) => {
    const row = await exceptionInScope(req, req.params.id)
    // Trash (owner, 2026-10-15): the exception and its swap requests (which
    // cascade) are kept in the entry. Bulk replaces (copy-week, autofill)
    // are regenerated by their own action and stay out (spec Q4).
    const { concept, ...shift } = row
    const [swaps, who] = await Promise.all([
      prisma.shiftSwapRequest.findMany({ where: { shiftId: row.id } }),
      prisma.user.findUnique({ where: { id: row.userId }, select: { name: true } }),
    ])
    await prisma.$transaction(async (tx) => {
      await moveToTrash(tx, req, {
        type: 'scheduled_shift', entityId: row.id, tenantId: concept.tenantId, conceptId: row.conceptId,
        title: `${who?.name ?? 'Shift'} — ${ymd(row.date)} ${row.startTime}–${row.endTime}`,
        subtitle: row.role === OFF_MARK ? 'Day off' : row.role,
        parent: { type: 'brand', id: row.conceptId }, reason: trashReasonOf(req),
        snapshot: takeSnapshot('ScheduledShift', shift, { ShiftSwapRequest: swaps }),
      })
      await tx.scheduledShift.delete({ where: { id: row.id } })
    })
    return reply.status(204).send()
  })

  // POST /scheduling/copy-week — repeat last week's EXCEPTIONS (the roster
  // repeats by itself). Skips a day that already has an exception.
  fastify.post('/copy-week', { preHandler: requireAuth(...ROTA_PLANNERS) }, async (req) => {
    const body = z.object({
      conceptId: z.string().uuid(),
      sourceWeekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      targetWeekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).parse(req.body)
    const concept = await assertConceptOwned(req, body.conceptId, 'create')
    const src = weekBounds(body.sourceWeekStart)
    const dst = weekBounds(body.targetWeekStart)
    const offset = dst.mon.getTime() - src.mon.getTime()
    const [rows, existing] = await Promise.all([
      prisma.scheduledShift.findMany({ where: { conceptId: concept.id, date: { gte: src.mon, lte: src.sun } } }),
      prisma.scheduledShift.findMany({ where: { concept: { tenantId: concept.tenantId }, date: { gte: dst.mon, lte: dst.sun } }, select: { userId: true, date: true } }),
    ])
    const taken = new Set(existing.map((x) => `${x.userId}:${ymd(x.date)}`))
    // Only people still employed here.
    const currentEmps = await prisma.hrEmployee.findMany({ where: { tenantId: concept.tenantId ?? '', status: { in: ['active', 'on_leave'] }, userId: { not: null } }, select: { id: true, userId: true } })
    const current = new Set(currentEmps.map((e) => e.userId!))
    // …and never onto someone's approved leave: a copied shift is skipped.
    const empOfUser = new Map(currentEmps.map((e) => [e.userId!, e.id]))
    const leaves = await prisma.hrRecord.findMany({
      where: { tenantId: concept.tenantId ?? '', section: 'leave', status: 'approved', employeeId: { in: currentEmps.map((e) => e.id) }, startDate: { lte: dst.sun }, endDate: { gte: dst.mon } },
      select: { employeeId: true, startDate: true, endDate: true, quantity: true },
    })
    const onLeaveDay = (userId: string, date: Date) => leaves.some((l) => l.employeeId === empOfUser.get(userId) && !isHalfDay(l) && l.startDate! <= date && l.endDate! >= date)
    let created = 0, skipped = 0
    for (const r of rows) {
      const date = new Date(r.date.getTime() + offset)
      if (!current.has(r.userId) || taken.has(`${r.userId}:${ymd(date)}`) || (r.role !== OFF_MARK && onLeaveDay(r.userId, date))) { skipped++; continue }
      await prisma.scheduledShift.create({ data: { userId: r.userId, conceptId: r.conceptId, date, startTime: r.startTime, endTime: r.endTime, role: r.role, notes: r.notes } })
      created++
    }
    return { created, copied: created, skipped }
  })

  // GET /scheduling/labor-cost?conceptId=X&weekStart=YYYY-MM-DD — the
  // generated week priced at each person's HR hourly rate.
  fastify.get<{ Querystring: { conceptId: string; weekStart: string } }>('/labor-cost', { preHandler: requireAuth(...ROTA_PLANNERS) }, async (req) => {
    const concept = await assertConceptOwned(req, req.query.conceptId, 'read')
    if (!concept.tenantId) throw new NotFoundError('Concept', req.query.conceptId)
    const { mon, sun } = weekBounds(req.query.weekStart ?? new Date().toISOString())
    const emps = await gridEmployees(concept.tenantId, concept.id)
    const [cells, settings] = await Promise.all([rotaFor(concept.tenantId, emps, ymd(mon), ymd(sun)), getSettings(concept.tenantId)])
    const byEmployee = emps.map((e) => {
      const minutes = cells.filter((c) => c.employeeId === e.id).reduce((a, c) => a + cellMinutes(c), 0)
      const hours = minutes / 60
      const rate = hourlyRateCents(e.grossSalaryCents, settings, periodOf(mon))
      return {
        employeeId: e.id, name: e.fullName,
        hours: Math.round(hours * 100) / 100,
        rateCents: Math.round(rate),
        totalCents: Math.round(hours * rate),
        rateUnset: e.grossSalaryCents <= 0,
      }
    }).filter((x) => x.hours > 0)
    return {
      totalHours: Math.round(byEmployee.reduce((a, x) => a + x.hours, 0) * 100) / 100,
      totalCents: byEmployee.reduce((a, x) => a + x.totalCents, 0),
      byEmployee,
      basis: `HR gross salary ÷ ${payDaysFor(settings, periodOf(mon))} days ÷ ${settings.hoursPerDay} hours`,
    }
  })
}
