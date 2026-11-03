// Marketing intern / designer tracker (owner, 2026-11-03) — Part 2. Contract: ./README.md.
//
//   /marketing-tracker/*   the manager side: TRACKER_ROLES + the per-person `marketing_tracker` module (the CEO always).
//                          One record per intern / designer (an HR employee of the company), their cards (where their
//                          linked login is a resource), on-time vs late, revisions, weekly check-in notes, monthly
//                          reviews (Share makes one visible to the intern), and an attendance summary read from HR.
//   /marketing-progress/me the person's OWN page (interns, and marketing staff who are tracked): their cards, their
//                          weekly notes at once, and ONLY the reviews that were shared — never anyone else's.
//
// Attendance is HR's: hr/service.ts attendanceWithin (the ONE reading payroll uses — absences incl. working days
// with no punch, half days, lates) + the standing attendance records for days present. Never ClockLog.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, type ScopeMode } from '../../lib/tenantScope.js'
import { STANDING_ATTENDANCE, attendanceWithin, getSettings } from '../hr/service.js'
import { periodOf, periodStart, periodEnd, nextPeriod } from '../hr/logic.js'
import { PROGRESS_ROLES, TRACKER_ROLES } from './access.js'
import { CARD_INCLUDE, cardDto, outcomeOf } from './cards.js'
import { isYmd, mondayOf, pktDay } from './week.js'

const DAY = 86_400_000
const ymdDate = (v: string) => new Date(`${v}T00:00:00.000Z`)

// ── Reads shared by both sides ──────────────────────────────────────────────

type TrackeeRow = { id: string; tenantId: string; employee: { id: string; userId: string | null; fullName: string; employeeCode: string } }

/** The cards the person (by their linked login) is a resource on, in the trackee's company, plus stats. */
async function cardsOf(t: TrackeeRow) {
  if (!t.employee.userId) return { cards: [], stats: { total: 0, onTime: 0, late: 0, open: 0, publishedLate: 0, revisions: 0 } }
  const now = new Date()
  const rows = await prisma.contentEvent.findMany({
    where: { tenantId: t.tenantId, boardId: { not: null }, resources: { some: { userId: t.employee.userId } } },
    include: CARD_INCLUDE,
    orderBy: { startDate: 'desc' },
    take: 500,
  })
  const cards = rows.map((c) => cardDto(c, now))
  const stats = { total: cards.length, onTime: 0, late: 0, open: 0, publishedLate: 0, revisions: 0 }
  for (const c of rows) {
    const o = outcomeOf(c, now)
    if (o === 'on_time') stats.onTime++
    else if (o === 'open') stats.open++
    else { stats.late++; if (o === 'published_late') stats.publishedLate++ }
    stats.revisions += c.revisionCount
  }
  return { cards, stats }
}

/** Days present / late / absent from HR attendance over [from, to] (Karachi days, ≤ 186 days). */
export async function attendanceSummary(tenantId: string, employeeId: string, from: string, to: string) {
  const fromD = ymdDate(from)
  const toD = ymdDate(to)
  if (toD < fromD) throw new AppError('BAD_RANGE', 'The end date is before the start date', 422)
  if (toD.getTime() - fromD.getTime() > 186 * DAY) throw new AppError('RANGE_TOO_LONG', 'Pick at most six months', 422)
  const s = await getSettings(tenantId)
  let absentDays = 0
  let lateCount = 0
  let unpaidLeaveDays = 0
  // attendanceWithin reads one month at a time (its window is clipped to a month).
  for (let p = periodOf(fromD); p <= periodOf(toD); p = nextPeriod(p)) {
    const a = fromD > periodStart(p) ? fromD : periodStart(p)
    const b = toD < periodEnd(p) ? toD : periodEnd(p)
    const r = await attendanceWithin(tenantId, employeeId, a, b, s)
    absentDays += r.absentDays; lateCount += r.lateCount; unpaidLeaveDays += r.unpaidLeaveDays
  }
  const records = await prisma.hrRecord.findMany({
    where: { tenantId, section: 'attendance', employeeId, status: STANDING_ATTENDANCE, startDate: { gte: fromD, lte: new Date(toD.getTime() + DAY - 1) } },
    select: { startDate: true, category: true },
  })
  const presentDays = new Set<string>()
  let halfDays = 0
  for (const r of records) {
    if (!r.startDate) continue
    if (r.category === 'present' || r.category === 'late') presentDays.add(r.startDate.toISOString().slice(0, 10))
    else if (r.category === 'half_day') halfDays++
  }
  return { from, to, present: presentDays.size + halfDays * 0.5, late: lateCount, absent: absentDays, halfDays, unpaidLeaveDays, records: records.length }
}

const TRACKEE_SELECT = {
  id: true, tenantId: true, roleLabel: true, startDate: true, endDate: true, active: true, createdAt: true,
  employee: { select: { id: true, userId: true, fullName: true, employeeCode: true, status: true } },
} as const

async function trackeeInScope(req: FastifyRequest, id: string, mode: ScopeMode) {
  const t = await prisma.marketingTrackee.findFirst({ where: { id, ...(await scopeTenantWhere(req, mode)) }, select: TRACKEE_SELECT })
  if (!t) throw new NotFoundError('MarketingTrackee', id)
  return t
}

function defaultRange(): { from: string; to: string } {
  const to = pktDay(new Date())
  const from = new Date(Date.parse(`${to}T00:00:00.000Z`) - 29 * DAY).toISOString().slice(0, 10)
  return { from, to }
}

const zMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'A month as YYYY-MM')
const zYmd = z.string().refine(isYmd, 'A date as YYYY-MM-DD')

// ── Manager side ────────────────────────────────────────────────────────────

export async function marketingTrackerRoutes(fastify: FastifyInstance) {
  const guard = { preHandler: requireAuth(...TRACKER_ROLES) }

  // GET /marketing-tracker — every intern / designer record in view, with headline stats.
  fastify.get<{ Querystring: { includeInactive?: string } }>('/', guard, async (req) => {
    const rows = await prisma.marketingTrackee.findMany({
      where: { ...(await scopeTenantWhere(req, 'read')), ...(req.query.includeInactive === '1' ? {} : { active: true }) },
      select: TRACKEE_SELECT,
      orderBy: { createdAt: 'asc' },
    })
    return Promise.all(rows.map(async (t) => ({ ...t, hrLinked: true, loginLinked: !!t.employee.userId, stats: (await cardsOf(t)).stats })))
  })

  // GET /marketing-tracker/employees?q= — the ACTIVE company's HR employees (the "add a record" picker; name + code only).
  fastify.get<{ Querystring: { q?: string } }>('/employees', guard, async (req) => {
    const q = req.query.q?.trim()
    return prisma.hrEmployee.findMany({
      where: { ...(await scopeTenantWhere(req, 'create')), status: { in: ['active', 'on_leave'] }, ...(q ? { fullName: { contains: q, mode: 'insensitive' as const } } : {}) },
      select: { id: true, fullName: true, employeeCode: true, userId: true },
      orderBy: { fullName: 'asc' },
      take: 50,
    })
  })

  // POST /marketing-tracker {employeeId, roleLabel, startDate, endDate?} — the employee must be of the ACTIVE company.
  fastify.post('/', guard, async (req, reply) => {
    const body = z.object({
      employeeId: z.string().min(1), roleLabel: z.string().trim().min(1).max(80),
      startDate: zYmd, endDate: zYmd.nullish(),
    }).strict().parse(req.body)
    const emp = await prisma.hrEmployee.findFirst({ where: { id: body.employeeId, ...(await scopeTenantWhere(req, 'create')) }, select: { id: true, tenantId: true } })
    if (!emp) throw new NotFoundError('HrEmployee', body.employeeId)
    if (body.endDate && body.endDate < body.startDate) throw new AppError('BAD_RANGE', 'The end date is before the start date', 422)
    const dup = await prisma.marketingTrackee.findUnique({ where: { tenantId_employeeId: { tenantId: emp.tenantId, employeeId: emp.id } }, select: { id: true } })
    if (dup) throw new AppError('ALREADY_TRACKED', 'This person already has a tracker record', 409, { id: dup.id })
    const t = await prisma.marketingTrackee.create({
      data: { tenantId: emp.tenantId, employeeId: emp.id, roleLabel: body.roleLabel, startDate: ymdDate(body.startDate), endDate: body.endDate ? ymdDate(body.endDate) : null, createdById: req.staffUser!.id },
      select: TRACKEE_SELECT,
    })
    return reply.status(201).send(t)
  })

  // PATCH /marketing-tracker/:id {roleLabel?, startDate?, endDate?, active?}
  fastify.patch<{ Params: { id: string } }>('/:id', guard, async (req) => {
    const body = z.object({ roleLabel: z.string().trim().min(1).max(80).optional(), startDate: zYmd.optional(), endDate: zYmd.nullish(), active: z.boolean().optional() }).strict().parse(req.body)
    const t = await trackeeInScope(req, req.params.id, 'write')
    return prisma.marketingTrackee.update({
      where: { id: t.id },
      data: {
        ...(body.roleLabel !== undefined ? { roleLabel: body.roleLabel } : {}),
        ...(body.startDate !== undefined ? { startDate: ymdDate(body.startDate) } : {}),
        ...(body.endDate !== undefined ? { endDate: body.endDate ? ymdDate(body.endDate) : null } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
      },
      select: TRACKEE_SELECT,
    })
  })

  // GET /marketing-tracker/:id?from=&to= — the whole record: cards + stats, notes, every review, attendance.
  fastify.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>('/:id', guard, async (req) => {
    const t = await trackeeInScope(req, req.params.id, 'read')
    const range = isYmd(req.query.from) && isYmd(req.query.to) ? { from: req.query.from, to: req.query.to } : defaultRange()
    const [work, checkIns, reviews, attendance] = await Promise.all([
      cardsOf(t),
      prisma.marketingCheckIn.findMany({ where: { trackeeId: t.id, tenantId: t.tenantId }, orderBy: [{ weekStart: 'desc' }, { createdAt: 'desc' }] }),
      prisma.marketingReview.findMany({ where: { trackeeId: t.id, tenantId: t.tenantId }, orderBy: { month: 'desc' } }),
      attendanceSummary(t.tenantId, t.employee.id, range.from, range.to),
    ])
    const authors = await authorNames([...checkIns.map((c) => c.authorId), ...reviews.map((r) => r.authorId)])
    return {
      ...t, ...work,
      checkIns: checkIns.map((c) => ({ ...c, authorName: authors.get(c.authorId) ?? null })),
      reviews: reviews.map((r) => ({ ...r, authorName: authors.get(r.authorId) ?? null })),
      attendance,
      warnings: t.employee.userId ? [] : ['This HR record has no login linked — cards cannot be matched to it until HR links one.'],
    }
  })

  // GET /marketing-tracker/:id/attendance?from&to
  fastify.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>('/:id/attendance', guard, async (req) => {
    const t = await trackeeInScope(req, req.params.id, 'read')
    const range = isYmd(req.query.from) && isYmd(req.query.to) ? { from: req.query.from, to: req.query.to } : defaultRange()
    return attendanceSummary(t.tenantId, t.employee.id, range.from, range.to)
  })

  // POST /marketing-tracker/:id/check-ins {note, weekOf?} — visible to the person at once.
  fastify.post<{ Params: { id: string } }>('/:id/check-ins', guard, async (req, reply) => {
    const body = z.object({ note: z.string().trim().min(1).max(4000), weekOf: zYmd.optional() }).strict().parse(req.body)
    const t = await trackeeInScope(req, req.params.id, 'write')
    const c = await prisma.marketingCheckIn.create({
      data: { tenantId: t.tenantId, trackeeId: t.id, weekStart: ymdDate(mondayOf(body.weekOf ?? pktDay(new Date()))), note: body.note, authorId: req.staffUser!.id },
    })
    return reply.status(201).send(c)
  })

  // POST /marketing-tracker/:id/reviews {month, strengths, improvements, recommendation} — one per month; hidden from
  // the person until shared.
  fastify.post<{ Params: { id: string } }>('/:id/reviews', guard, async (req, reply) => {
    const body = z.object({
      month: zMonth, strengths: z.string().trim().min(1).max(4000), improvements: z.string().trim().min(1).max(4000),
      recommendation: z.enum(['keep', 'extend', 'end']),
    }).strict().parse(req.body)
    const t = await trackeeInScope(req, req.params.id, 'write')
    const dup = await prisma.marketingReview.findUnique({ where: { trackeeId_month: { trackeeId: t.id, month: body.month } }, select: { id: true } })
    if (dup) throw new AppError('REVIEW_EXISTS', 'There is already a review for that month — edit it instead', 409, { id: dup.id })
    const r = await prisma.marketingReview.create({ data: { tenantId: t.tenantId, trackeeId: t.id, ...body, authorId: req.staffUser!.id } })
    return reply.status(201).send(r)
  })

  // PATCH /marketing-tracker/reviews/:reviewId {strengths?, improvements?, recommendation?}
  fastify.patch<{ Params: { reviewId: string } }>('/reviews/:reviewId', guard, async (req) => {
    const body = z.object({
      strengths: z.string().trim().min(1).max(4000).optional(), improvements: z.string().trim().min(1).max(4000).optional(),
      recommendation: z.enum(['keep', 'extend', 'end']).optional(),
    }).strict().parse(req.body)
    const r = await prisma.marketingReview.findFirst({ where: { id: req.params.reviewId, ...(await scopeTenantWhere(req, 'write')) }, select: { id: true } })
    if (!r) throw new NotFoundError('MarketingReview', req.params.reviewId)
    return prisma.marketingReview.update({ where: { id: r.id }, data: body })
  })

  // POST /marketing-tracker/reviews/:reviewId/share {shared?: boolean} — make it visible to the person (or hide again).
  fastify.post<{ Params: { reviewId: string } }>('/reviews/:reviewId/share', guard, async (req) => {
    const { shared } = z.object({ shared: z.boolean().default(true) }).strict().parse(req.body ?? {})
    const r = await prisma.marketingReview.findFirst({ where: { id: req.params.reviewId, ...(await scopeTenantWhere(req, 'write')) }, select: { id: true, sharedAt: true } })
    if (!r) throw new NotFoundError('MarketingReview', req.params.reviewId)
    return prisma.marketingReview.update({ where: { id: r.id }, data: { sharedAt: shared ? (r.sharedAt ?? new Date()) : null } })
  })
}

async function authorNames(ids: string[]): Promise<Map<string, string | null>> {
  const uniq = Array.from(new Set(ids))
  if (!uniq.length) return new Map()
  const users = await prisma.user.findMany({ where: { id: { in: uniq } }, select: { id: true, name: true } })
  return new Map(users.map((u) => [u.id, u.name]))
}

// ── The person's own page ───────────────────────────────────────────────────

export async function marketingProgressRoutes(fastify: FastifyInstance) {
  // GET /marketing-progress/me — the caller's OWN record(s) only: their cards, their weekly notes, their SHARED reviews.
  fastify.get('/me', { preHandler: requireAuth(...PROGRESS_ROLES) }, async (req) => {
    const me = req.staffUser!.id
    const records = await prisma.marketingTrackee.findMany({
      where: { ...(await scopeTenantWhere(req, 'read')), employee: { userId: me } },
      select: TRACKEE_SELECT,
      orderBy: { createdAt: 'asc' },
    })
    if (records.length === 0) return { records: [] }
    return {
      records: await Promise.all(records.map(async (t) => {
        const [work, checkIns, reviews] = await Promise.all([
          cardsOf(t),
          prisma.marketingCheckIn.findMany({ where: { trackeeId: t.id, tenantId: t.tenantId }, orderBy: [{ weekStart: 'desc' }, { createdAt: 'desc' }] }),
          prisma.marketingReview.findMany({ where: { trackeeId: t.id, tenantId: t.tenantId, sharedAt: { not: null } }, orderBy: { month: 'desc' } }),
        ])
        const authors = await authorNames([...checkIns.map((c) => c.authorId), ...reviews.map((r) => r.authorId)])
        return {
          id: t.id, roleLabel: t.roleLabel, startDate: t.startDate, endDate: t.endDate, active: t.active,
          ...work,
          checkIns: checkIns.map((c) => ({ id: c.id, weekStart: c.weekStart, note: c.note, createdAt: c.createdAt, authorName: authors.get(c.authorId) ?? null })),
          reviews: reviews.map((r) => ({ id: r.id, month: r.month, strengths: r.strengths, improvements: r.improvements, recommendation: r.recommendation, sharedAt: r.sharedAt, authorName: authors.get(r.authorId) ?? null })),
        }
      })),
    }
  })
}
