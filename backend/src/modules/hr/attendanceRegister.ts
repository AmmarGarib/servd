// Attendance register (owner, 2026-10-21: "Attendance record should be formatted this way").
// A VIEW and an export over the existing attendance HrRecord rows — no second store. Punches stay in
// attendanceTracking.ts / attendance.ts; the rota (rota.ts) is the one way to get a day's shift.
//
// Columns, in this order (owner):
//   Attendance Date | Attendance Day | Shift Code | Employee ID | Employee Name | Department | Time In | Time Out |
//   Late In | Early Out | OT Hours | Source | Location | Branch | Status | Remarks
// OT Hours = APPROVED overtime records for the employee and date (approvedHours, else quantity — the same reading
// payroll's prefill uses), whether or not payroll has paid them; on a day with no approved request, the punch
// overtime of that day's record (owner, 2026-10-22 — attendanceDays.ts rule B; paid only when HR adds it).

import type { FastifyRequest } from 'fastify'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'
import { AppError } from '../../lib/errors.js'
import { csv } from '../accounting/csv.js'
import { fromMatrix, type ReportColumnType } from '../../lib/reportExport.js'
import { getFormat, employeeLabelsAcross, getSettings } from './service.js'
import { attendanceKeys, minutesLate, flagMissingPunches, type PunchEntry } from './attendance.js'
import { rotaFor, ymd, toMinutes, type RotaCell } from './rota.js'
import { punchOvertimeForRecords } from './attendanceDays.js'

export const ATTENDANCE_REGISTER_COLUMNS = [
  'Attendance Date', 'Attendance Day', 'Shift Code', 'Employee ID', 'Employee Name', 'Department', 'Time In', 'Time Out',
  'Late In', 'Early Out', 'OT Hours', 'Source', 'Location', 'Branch', 'Status', 'Remarks',
] as const

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const STATUS_LABEL: Record<string, string> = {
  present: 'Present', late: 'Late', absent: 'Absent', half_day: 'Half day', missing_punch: 'Missing punch',
  off_day: 'Off day', holiday: 'Holiday', early_departure: 'Early departure',
}
/** Records that are not part of the register: cancelled, rejected or never submitted. */
const EXCLUDED = ['draft', 'rejected', 'cancelled']
const MAX_ROWS = 5000

export interface RegisterQuery { from?: string; to?: string; employeeId?: string; locationId?: string; status?: string }
export interface RegisterRow { id: string; employeeId: string | null; manual: boolean; values: string[]; /** The GPS fix at check-in, for a map link. */ checkIn: { lat: number; lng: number } | null }
export interface Register { columns: readonly string[]; rows: RegisterRow[] }

/** Minutes as H:MM; blank for none. */
export const hmm = (mins: number | null | undefined): string =>
  mins != null && mins > 0 ? `${Math.floor(mins / 60)}:${String(Math.round(mins % 60)).padStart(2, '0')}` : ''

const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

function sourceText(d: Record<string, unknown>, status: string, punches: PunchEntry[]): string {
  const src = str(d['_source'])
  let s: string
  if (d['_manual'] || src === 'hr') s = 'Manual (HR)'
  else if (src === 'kiosk') s = 'Kiosk (old)'
  else if (src === 'correction') s = 'Manual (HR)'
  else {
    const p = punches[0]?.source ?? src
    s = p === 'tablet' ? 'Tablet' : p === 'kiosk' ? 'Kiosk (old)' : p === 'clock' ? 'Time clock' : src === 'tablet' ? 'Tablet' : src ? 'Time clock' : 'Manual (HR)'
  }
  // The admin's wording (lib/hr.ts recordStatusText): a manual day waiting for the CEO.
  if (d['_manual'] && status === 'submitted') return `${s} — waiting for CEO`
  // An out-of-area punch day waiting for the HOD (owner, 2026-10-22); a day servd clocked out at 12:00 AM.
  if (d['_outOfAreaHold'] && status === 'submitted') return `${s} — outside the work location, waiting for the manager`
  if (d['_autoClockedOut']) return `${s} — clocked out by servd at 12:00 AM`
  return s
}

export async function buildAttendanceRegister(req: FastifyRequest, q: RegisterQuery = {}): Promise<Register> {
  if (q.from && !isDay(q.from)) throw new AppError('VALIDATION_ERROR', 'from is a date (YYYY-MM-DD)', 400)
  if (q.to && !isDay(q.to)) throw new AppError('VALIDATION_ERROR', 'to is a date (YYYY-MM-DD)', 400)
  if (q.from && q.to && q.to < q.from) throw new AppError('VALIDATION_ERROR', '"to" is before "from"', 400)
  if (q.from && q.to && (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 > 92) throw new AppError('RANGE_TOO_LONG', 'Pick at most 92 days', 400)
  const w = await scopeTenantWhere(req, 'read')
  const tenantIds = typeof w.tenantId === 'string' ? [w.tenantId] : w.tenantId.in
  if (!tenantIds.length) return { columns: ATTENDANCE_REGISTER_COLUMNS, rows: [] }
  // Days punched in and never out show as missing punches (the records list does the same).
  await Promise.all(tenantIds.map((t) => flagMissingPunches(t)))

  const records = await prisma.hrRecord.findMany({
    where: {
      tenantId: { in: tenantIds }, section: 'attendance', status: { notIn: EXCLUDED },
      ...(q.employeeId && { employeeId: q.employeeId }),
      ...(q.status && { category: q.status }),
      ...((q.from || q.to) && { startDate: { ...(q.from && { gte: new Date(`${q.from}T00:00:00.000Z`) }), ...(q.to && { lte: new Date(`${q.to}T00:00:00.000Z`) }) } }),
    },
    include: { employee: { select: { id: true, tenantId: true, userId: true, employeeCode: true, fullName: true, departmentId: true, designationId: true, gradeId: true, locationId: true, managerId: true } } },
    take: MAX_ROWS,
  })

  const keysByTenant = new Map<string, ReturnType<typeof attendanceKeys>>()
  const locKeyByTenant = new Map<string, string>()
  for (const t of new Set(records.map((r) => r.tenantId))) {
    const fmt = await getFormat(t, 'attendance')
    keysByTenant.set(t, attendanceKeys(fmt.fields))
    locKeyByTenant.set(t, fmt.fields.find((f) => f.type === 'location')?.key ?? 'location')
  }
  const branchOf = (r: (typeof records)[number]) => str((r.data as Record<string, unknown>)[locKeyByTenant.get(r.tenantId)!])
  const kept = q.locationId ? records.filter((r) => branchOf(r) === q.locationId) : records

  const emps = kept.flatMap((r) => (r.employee ? [r.employee] : []))
  const [label, shifts, overtime, locations] = await Promise.all([
    employeeLabelsAcross(emps),
    prisma.hrRecord.findMany({
      where: { tenantId: { in: tenantIds }, section: 'shift', id: { in: Array.from(new Set(kept.map((r) => r.refId).filter((x): x is string => !!x))) } },
      select: { id: true, data: true },
    }),
    emps.length
      ? prisma.hrRecord.findMany({
          where: {
            tenantId: { in: tenantIds }, section: 'overtime', status: 'approved', employeeId: { in: Array.from(new Set(emps.map((e) => e.id))) },
            startDate: { gte: kept.reduce((m, r) => (r.startDate && r.startDate < m ? r.startDate : m), kept[0]!.startDate ?? new Date()), lte: kept.reduce((m, r) => (r.startDate && r.startDate > m ? r.startDate : m), kept[0]!.startDate ?? new Date()) },
          },
          select: { employeeId: true, startDate: true, quantity: true, data: true },
        })
      : Promise.resolve([]),
    (async () => {
      const ids = new Set<string>()
      for (const r of kept) {
        const b = branchOf(r); if (b) ids.add(b)
        for (const p of (((r.data as Record<string, unknown>)['_punches'] as PunchEntry[] | undefined) ?? [])) if (p.locationId) ids.add(p.locationId)
      }
      if (!ids.size) return []
      return prisma.location.findMany({ where: { id: { in: Array.from(ids) }, tenantId: { in: tenantIds } }, select: { id: true, name: true } })
    })(),
  ])
  const otHours = new Map<string, number>()
  for (const o of overtime) {
    if (!o.employeeId || !o.startDate) continue
    const a = (o.data as Record<string, unknown>)['approvedHours']
    const key = `${o.employeeId}:${ymd(o.startDate)}`
    otHours.set(key, (otHours.get(key) ?? 0) + (typeof a === 'number' ? a : o.quantity ?? 0))
  }
  // Punch OT of each standing record (a manual day still waiting for the CEO does not count), per company.
  const punchOt = new Map<string, number>()
  for (const t of new Set(kept.map((r) => r.tenantId))) {
    const mine = kept.filter((r) => r.tenantId === t && r.employee && r.status !== 'submitted')
    if (!mine.length) continue
    const people = Array.from(new Map(mine.map((r) => [r.employee!.id, r.employee!])).values())
    const grossOf = new Map((await prisma.hrEmployee.findMany({ where: { tenantId: t, id: { in: people.map((e) => e.id) } }, select: { id: true, grossSalaryCents: true } })).map((e) => [e.id, e.grossSalaryCents]))
    const found = await punchOvertimeForRecords(t, mine, people.map((e) => ({ id: e.id, userId: e.userId, grossSalaryCents: grossOf.get(e.id) ?? 0 })), await getSettings(t))
    for (const [recordId, p] of found) punchOt.set(recordId, p.hours)
  }
  const locName = new Map(locations.map((l) => [l.id, l.name]))
  // Where the person actually was at check-in (owner, 2026-10-21: "It should opt current location of the staff at
  // time of checkin"): the GPS fix the time clock recorded with the punch (ClockLog lat/lng), in the record's company.
  const inLogIds = kept.flatMap((r) => {
    const first = ((((r.data ?? {}) as Record<string, unknown>)['_punches'] as PunchEntry[] | undefined) ?? []).find((p) => p.type === 'in')
    return first?.clockLogId ? [first.clockLogId] : []
  })
  const fixes = inLogIds.length
    ? await prisma.clockLog.findMany({ where: { id: { in: inLogIds }, tenantId: { in: tenantIds } }, select: { id: true, lat: true, lng: true } })
    : []
  const fixById = new Map(fixes.filter((f) => f.lat != null && f.lng != null).map((f) => [f.id, { lat: f.lat!, lng: f.lng! }]))
  const shiftById = new Map(shifts.map((s) => [s.id, s.data as Record<string, unknown>]))

  // The rota answers the days whose record names no shift or no expected end (a hand-keyed day). One call per company.
  const needRota = kept.filter((r) => {
    const d = r.data as Record<string, unknown>
    const exp = (d['_expected'] ?? {}) as Record<string, unknown>
    const linked = r.refId ? shiftById.get(r.refId) : undefined
    return r.employee && r.startDate && (!linked || (!exp['end'] && !linked['end']))
  })
  const cells = new Map<string, RotaCell>()
  for (const t of new Set(needRota.map((r) => r.tenantId))) {
    const mine = needRota.filter((r) => r.tenantId === t)
    const days = mine.map((r) => ymd(r.startDate!)).sort()
    const empList = Array.from(new Map(mine.map((r) => [r.employee!.id, { id: r.employee!.id, userId: r.employee!.userId }])).values())
    for (const c of await rotaFor(t, empList, days[0]!, days[days.length - 1]!)) cells.set(`${c.employeeId}:${c.date}`, c)
  }

  const rows = kept.map((r) => {
    const d = (r.data ?? {}) as Record<string, unknown>
    const k = keysByTenant.get(r.tenantId)!
    const date = r.startDate ? ymd(r.startDate) : ''
    const cell = r.employee && date ? cells.get(`${r.employee.id}:${date}`) : undefined
    const seg = cell?.kind === 'shift' ? cell.segments : []
    const linked = r.refId ? shiftById.get(r.refId) : undefined
    const exp = (d['_expected'] ?? {}) as Record<string, unknown>
    const timeIn = str(d[k.checkIn]), timeOut = str(d[k.checkOut])
    // Shift code: the linked shift's code, else its name; the rota's shift name for a day that names none.
    const shiftCode = linked ? str(linked['code']) || str(linked['name']) : seg[0]?.shiftName ?? ''
    // Early out: against the end punch time recorded, else the linked shift's, else the rota's last segment.
    const end = str(exp['end']) || (linked ? str(linked['end']) : '') || seg[seg.length - 1]?.end || ''
    let early = ''
    if (timeOut && toMinutes(end) != null) {
      const diff = minutesLate(timeOut, end)
      if (diff != null && diff < 0) early = hmm(-diff)
    }
    const punches = ((d['_punches'] as PunchEntry[] | undefined) ?? [])
    const firstIn = punches.find((p) => p.type === 'in')
    const manual = !!d['_manual']
    const fix = !manual && firstIn?.clockLogId ? fixById.get(firstIn.clockLogId) ?? null : null
    const location = manual || !firstIn ? '' : checkInPlace(fix, firstIn, locName)
    const approvedH = r.employee && date ? otHours.get(`${r.employee.id}:${date}`) : undefined
    const otH = approvedH ?? punchOt.get(r.id) ?? 0
    const ot = otH > 0 ? otH.toFixed(2) : ''
    const values = [
      date, r.startDate ? WEEKDAY_NAMES[r.startDate.getUTCDay()]! : '', shiftCode, r.employee?.employeeCode ?? '', r.employee?.fullName ?? '',
      label(r.employee?.departmentId) ?? '', timeIn, timeOut, hmm(r.quantity), early, ot, sourceText(d, r.status, punches), location,
      locName.get(branchOf(r)) ?? '', STATUS_LABEL[r.category ?? ''] ?? (r.category ?? ''), str(d['remarks']),
    ]
    return { id: r.id, employeeId: r.employeeId, manual, values, checkIn: fix }
  })
  rows.sort((a, b) => a.values[0]!.localeCompare(b.values[0]!) || a.values[3]!.localeCompare(b.values[3]!))
  return { columns: ATTENDANCE_REGISTER_COLUMNS, rows }
}

/** Distance in words: "120 m" / "3.4 km". */
const distText = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`)

/**
 * The Location column: the GPS position at check-in ("24.86072, 67.00109"), then how far that was from the work
 * location it was measured against — or, with no fix (kiosk PIN, location refused), what the punch recorded.
 */
export function checkInPlace(fix: { lat: number; lng: number } | null, p: PunchEntry, locName: Map<string, string>): string {
  const near = p.locationId ? locName.get(p.locationId) ?? '' : ''
  const away = p.geofenceDistanceM != null && near ? `${distText(p.geofenceDistanceM)} from ${near}` : near
  if (fix) {
    const at = `${fix.lat.toFixed(5)}, ${fix.lng.toFixed(5)}`
    const note = [p.outOfArea ? 'out of area' : '', away].filter(Boolean).join(', ')
    return note ? `${at} (${note})` : at
  }
  return p.outOfArea ? 'Out of area (no location shared)' : near ? `${near} (no GPS)` : 'No location shared'
}

/** The register as the report exporter wants it (CSV text + columns/rows for Excel and PDF). */
export function registerTable(reg: Register, from?: string, to?: string) {
  const head = [...reg.columns]
  const body = reg.rows.map((r) => r.values)
  return {
    title: 'Attendance register',
    ...(from || to ? { period: `${from ?? '…'} to ${to ?? '…'}` } : {}),
    ...fromMatrix(head, body, head.map(() => 'text' as ReportColumnType)),
    csv: csv([head, ...body]),
  }
}
