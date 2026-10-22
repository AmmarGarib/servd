// HR attendance tracking (owner, 2026-10-15: "a new module that gives the hr team attendance tracking … keep record
// of time and gives that time to hr formats"). Read-only views over what the time clock already writes — the
// ClockLog punch log and each day's HR attendance record (hr/attendance.ts). No second store, no second calculation:
// month totals are the Attendance & Leaves format (hr/reports.ts).
//
//   GET /hr/attendance-tracking/today?locationId=      who is in / out / not in yet / missing a punch / on leave
//   GET /hr/attendance-tracking/punches?from&to&employeeId&outOfArea=1&page&pageSize   the punch log
//
// HR team and managers (no pay is shown). Company-scoped through scopeTenantWhere(req, 'read'); a foreign
// employeeId / locationId simply matches nothing.

import type { FastifyInstance } from 'fastify'
import type { HrRecord, UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS } from '../auth/middleware.js'
import { AppError } from '../../lib/errors.js'
import { scopeTenantWhere, type TenantIdWhere } from '../../lib/tenantScope.js'
import { getFormat, employeeLabelsAcross, ATTENDANCE_DAY_TAKEN, isOutOfAreaHold } from './service.js'
import { pktToday } from './logic.js'
import { attendanceKeys, isMissedClockOut, lastInOf, type PunchEntry } from './attendance.js'
import { isHalfDayLeave } from './rota.js'

const HR_TEAM = ['admin', 'owner', 'management', 'hr'] as UserRole[]
const READERS = Array.from(new Set([...HR_TEAM, ...MANAGERS])) as UserRole[]
const MAX_RANGE_DAYS = 62
const DAY_MS = 86_400_000

const idsOf = (w: TenantIdWhere): string[] => (typeof w.tenantId === 'string' ? [w.tenantId] : w.tenantId.in)
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))

export type TodayStatus = 'in' | 'out' | 'not_in' | 'missing_punch' | 'on_leave' | 'recorded'

interface PunchView {
  type: 'in' | 'out'
  at: string
  source: string
  locationId: string | null
  location: string | null
  matched: boolean | null
  distanceM: number | null
  outOfArea: boolean
}

const punchesOf = (r: Pick<HrRecord, 'data'> | null | undefined): PunchEntry[] =>
  ((((r?.data ?? {}) as Record<string, unknown>)['_punches'] as PunchEntry[] | undefined) ?? [])

/** Location names for every id, in these companies only. */
async function locationNames(tenantIds: string[], ids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
  const want = Array.from(new Set(Array.from(ids).filter((x): x is string => !!x)))
  if (!want.length) return new Map()
  const rows = await prisma.location.findMany({ where: { id: { in: want }, tenantId: { in: tenantIds } }, select: { id: true, name: true } })
  return new Map(rows.map((l) => [l.id, l.name]))
}

const view = (p: PunchEntry, names: Map<string, string>): PunchView => ({
  type: p.type, at: p.at, source: p.source, locationId: p.locationId ?? null, location: p.locationId ? names.get(p.locationId) ?? null : null,
  matched: p.geofenceMatched ?? null, distanceM: p.geofenceDistanceM ?? null, outOfArea: !!p.outOfArea,
})

/** The Today board: every current employee of the scope with their day so far. */
export async function todayBoard(tenantIds: string[], opts: { locationId?: string | null; now?: Date } = {}) {
  const now = opts.now ?? new Date()
  const today = pktToday(now)
  const yesterday = new Date(today.getTime() - DAY_MS)
  const emps = await prisma.hrEmployee.findMany({
    where: {
      tenantId: { in: tenantIds }, status: { in: ['active', 'on_leave'] },
      ...(opts.locationId && { OR: [{ workLocations: { some: { locationId: opts.locationId } } }, { locationId: opts.locationId }] }),
    },
    select: {
      id: true, tenantId: true, employeeCode: true, fullName: true, status: true, departmentId: true, designationId: true, gradeId: true, locationId: true, managerId: true,
      workLocations: { select: { locationId: true, isPrimary: true, radiusMetres: true, location: { select: { name: true, latitude: true, longitude: true } } }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }] },
    },
    orderBy: [{ employeeCode: 'asc' }],
  })
  const empIds = emps.map((e) => e.id)
  const [records, leaves, label] = await Promise.all([
    empIds.length ? prisma.hrRecord.findMany({
      where: { tenantId: { in: tenantIds }, section: 'attendance', employeeId: { in: empIds }, status: ATTENDANCE_DAY_TAKEN, startDate: { in: [today, yesterday] } }, // incl. days waiting for the manager / the CEO: the board shows who is in
      orderBy: { createdAt: 'desc' },
    }) : [],
    empIds.length ? prisma.hrRecord.findMany({
      where: { tenantId: { in: tenantIds }, section: 'leave', status: 'approved', employeeId: { in: empIds }, startDate: { lte: today }, endDate: { gte: today } },
      select: { employeeId: true, startDate: true, endDate: true, quantity: true, category: true },
    }) : [],
    employeeLabelsAcross(emps),
  ])
  const keys = new Map<string, ReturnType<typeof attendanceKeys>>()
  for (const t of new Set(emps.map((e) => e.tenantId))) keys.set(t, attendanceKeys((await getFormat(t, 'attendance')).fields))
  const names = await locationNames(tenantIds, records.flatMap((r) => punchesOf(r).map((p) => p.locationId)))

  const rows = emps.map((e) => {
    const k = keys.get(e.tenantId)!
    const mine = records.filter((r) => r.employeeId === e.id)
    const todayRec = mine.find((r) => r.startDate?.getTime() === today.getTime()) ?? null
    // A closing shift that started yesterday and is still open counts as today's "in".
    const carried = !todayRec ? mine.find((r) => {
      if (r.startDate?.getTime() !== yesterday.getTime()) return false
      const d = r.data as Record<string, unknown>
      return ['clock', 'kiosk'].includes(String(d['_source'])) && !d[k.checkOut] && !d['_missedOut'] && !isMissedClockOut(lastInOf(r), now)
    }) ?? null : null
    const rec = todayRec ?? carried
    const d = (rec?.data ?? {}) as Record<string, unknown>
    const onLeave = e.status === 'on_leave' || leaves.some((l) => l.employeeId === e.id && !isHalfDayLeave(l))
    let status: TodayStatus
    if (!rec) status = onLeave ? 'on_leave' : 'not_in'
    else if (rec.category === 'missing_punch' || d['_missedOut']) status = 'missing_punch'
    else if (!['clock', 'kiosk'].includes(String(d['_source']))) status = 'recorded' // keyed or corrected by HR
    else status = d[k.checkOut] ? 'out' : 'in'
    const punches = punchesOf(rec).map((p) => view(p, names))
    return {
      employeeId: e.id, tenantId: e.tenantId, employeeCode: e.employeeCode, fullName: e.fullName,
      department: label(e.departmentId), designation: label(e.designationId),
      workLocations: e.workLocations.map((w) => ({ locationId: w.locationId, name: w.location.name, isPrimary: w.isPrimary, radiusMetres: w.radiusMetres, hasPin: w.location.latitude != null && w.location.longitude != null })),
      status,
      attendanceStatus: rec?.category ?? null,
      lateMinutes: rec?.quantity ?? null,
      checkIn: (d[k.checkIn] as string | null | undefined) ?? null,
      checkOut: (d[k.checkOut] as string | null | undefined) ?? null,
      carriedFromYesterday: !!carried,
      outOfArea: !!d['_outOfArea'] || punches.some((p) => p.outOfArea),
      /** An out-of-area day waiting for the manager (HOD) — not in pay until approved. */
      waitingForManager: !!rec && rec.status === 'submitted' && isOutOfAreaHold(rec),
      onLeave,
      punches,
    }
  })
  const count = (s: TodayStatus) => rows.filter((r) => r.status === s).length
  return {
    date: ymd(today),
    totals: { employees: rows.length, in: count('in'), out: count('out'), notIn: count('not_in'), missingPunch: count('missing_punch'), onLeave: count('on_leave'), recorded: count('recorded'), outOfArea: rows.filter((r) => r.outOfArea).length },
    rows,
  }
}

export interface PunchLogRow extends PunchView {
  id: string
  date: string
  employeeId: string | null
  employeeCode: string | null
  fullName: string
  userId: string | null
  tenantId: string
  attendanceRecordId: string | null
  attendanceStatus: string | null
}

/**
 * The punch log: every punch in the Karachi days [from, to], newest first. Employee punches (login and kiosk) come
 * from the day's attendance record, which keeps a copy of each; login punches that made no attendance (a login with
 * no employee record, a hand-keyed day) come from ClockLog.
 */
export async function punchLog(tenantIds: string[], q: { from: string; to: string; employeeId?: string | null; outOfAreaOnly?: boolean; page?: number; pageSize?: number }) {
  const fromDay = new Date(`${q.from}T00:00:00.000Z`)
  const toDay = new Date(`${q.to}T00:00:00.000Z`)
  const fromAt = new Date(fromDay.getTime() - 5 * 3_600_000)
  const toAt = new Date(toDay.getTime() + DAY_MS - 5 * 3_600_000 - 1)
  const records = await prisma.hrRecord.findMany({
    where: {
      tenantId: { in: tenantIds }, section: 'attendance', status: ATTENDANCE_DAY_TAKEN, startDate: { gte: fromDay, lte: toDay },
      ...(q.employeeId && { employeeId: q.employeeId }),
    },
    include: { employee: { select: { id: true, employeeCode: true, fullName: true, userId: true } } },
  })
  const fromRecords = new Set<string>()
  const out: Array<Omit<PunchLogRow, 'location'> & { location?: string | null }> = []
  for (const r of records) {
    for (const [i, p] of punchesOf(r).entries()) {
      if (p.clockLogId) fromRecords.add(p.clockLogId)
      out.push({
        id: p.clockLogId ?? `${r.id}:${i}`, date: r.startDate ? ymd(r.startDate) : ymd(pktToday(new Date(p.at))),
        employeeId: r.employee?.id ?? r.employeeId, employeeCode: r.employee?.employeeCode ?? null, fullName: r.employee?.fullName ?? '',
        userId: r.employee?.userId ?? null, tenantId: r.tenantId, attendanceRecordId: r.id, attendanceStatus: r.category,
        type: p.type, at: p.at, source: p.source, locationId: p.locationId ?? null,
        matched: p.geofenceMatched ?? null, distanceM: p.geofenceDistanceM ?? null, outOfArea: !!p.outOfArea,
      })
    }
  }
  // Login punches with no attendance copy, in these companies (a legacy row with no company is left out: it cannot
  // be placed in one). For one employee: that employee's login, in their company.
  let userFilter: { userId: string } | null = null
  if (q.employeeId) {
    const emp = await prisma.hrEmployee.findFirst({ where: { id: q.employeeId, tenantId: { in: tenantIds } }, select: { userId: true } })
    userFilter = emp?.userId ? { userId: emp.userId } : null
  }
  const logs = !q.employeeId || userFilter ? await prisma.clockLog.findMany({
    where: { tenantId: { in: tenantIds }, recordedAt: { gte: fromAt, lte: toAt }, ...(userFilter ?? {}), ...(fromRecords.size && { id: { notIn: Array.from(fromRecords) } }) },
    include: { user: { select: { id: true, name: true } } },
  }) : []
  const empByUser = new Map<string, { id: string; employeeCode: string; fullName: string; tenantId: string }>()
  if (logs.length) {
    const linked = await prisma.hrEmployee.findMany({ where: { tenantId: { in: tenantIds }, userId: { in: Array.from(new Set(logs.map((l) => l.userId))) } }, select: { id: true, employeeCode: true, fullName: true, userId: true, tenantId: true } })
    for (const e of linked) if (e.userId) empByUser.set(`${e.tenantId}:${e.userId}`, e)
  }
  for (const l of logs) {
    const e = empByUser.get(`${l.tenantId}:${l.userId}`)
    out.push({
      id: l.id, date: ymd(pktToday(l.recordedAt)), employeeId: e?.id ?? null, employeeCode: e?.employeeCode ?? null, fullName: e?.fullName ?? l.user.name,
      userId: l.userId, tenantId: l.tenantId!, attendanceRecordId: null, attendanceStatus: null,
      type: l.type === 'out' ? 'out' : 'in', at: l.recordedAt.toISOString(), source: 'clock', locationId: l.locationId,
      matched: l.geofenceMatched, distanceM: l.geofenceDistanceM, outOfArea: !!l.outOfArea,
    })
  }
  const filtered = (q.outOfAreaOnly ? out.filter((r) => r.outOfArea) : out).sort((a, b) => b.at.localeCompare(a.at))
  const pageSize = Math.min(Math.max(q.pageSize ?? 100, 1), 500)
  const page = Math.max(q.page ?? 1, 1)
  const slice = filtered.slice((page - 1) * pageSize, page * pageSize)
  const names = await locationNames(tenantIds, slice.map((r) => r.locationId))
  return {
    from: q.from, to: q.to, page, pageSize, total: filtered.length,
    rows: slice.map((r) => ({ ...r, location: r.locationId ? names.get(r.locationId) ?? null : null })) as PunchLogRow[],
  }
}

export async function attendanceTrackingRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { locationId?: string } }>('/attendance-tracking/today', { preHandler: requireAuth(...READERS) }, async (req) => {
    const tenantIds = idsOf(await scopeTenantWhere(req, 'read'))
    return todayBoard(tenantIds, { locationId: req.query.locationId || null })
  })

  fastify.get<{ Querystring: { from?: string; to?: string; employeeId?: string; outOfArea?: string; page?: string; pageSize?: string } }>(
    '/attendance-tracking/punches', { preHandler: requireAuth(...READERS) }, async (req) => {
      const today = ymd(pktToday())
      const from = req.query.from ?? today
      const to = req.query.to ?? from
      if (!isDay(from) || !isDay(to)) throw new AppError('VALIDATION_ERROR', 'from and to are dates (YYYY-MM-DD)', 400)
      if (to < from) throw new AppError('VALIDATION_ERROR', '"to" is before "from"', 400)
      if ((Date.parse(to) - Date.parse(from)) / DAY_MS > MAX_RANGE_DAYS) throw new AppError('RANGE_TOO_LONG', `Pick at most ${MAX_RANGE_DAYS} days`, 400)
      const tenantIds = idsOf(await scopeTenantWhere(req, 'read'))
      return punchLog(tenantIds, {
        from, to, employeeId: req.query.employeeId || null,
        outOfAreaOnly: req.query.outOfArea === '1' || req.query.outOfArea === 'true',
        page: Number(req.query.page) || 1, pageSize: Number(req.query.pageSize) || 100,
      })
    })
}
