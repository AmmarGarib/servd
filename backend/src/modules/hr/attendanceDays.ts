// Working days and punch overtime (owner, 2026-10-22) — read from ONE place
// so payroll, the full & final, the Attendance & Leaves report and the
// attendance register agree.
//
// Rule A — absent without a punch. From the company's HR setting
// `absentWithoutPunchFrom` (default 2026-11-01; October pays as is, H52), a
// WORKING day with no standing attendance record counts as absent (1) and is
// docked by payroll, unless HR corrects it (any standing record for the day —
// a punch, an approved correction, a manual day the CEO approved — wins).
//   working day = the rota (rota.ts rotaFor) gives the person a SHIFT that day
//                 (a roster shift, a swap or a /scheduling exception), it is
//                 not a holiday for their branch (HR 'holiday' records, blank
//                 branch = all), it is on/after the setting's date, inside
//                 the window the caller passes (already clipped to the days
//                 employed), and it is OVER (before today, Karachi).
// A weekly off, a rota day off, full-day leave, a holiday, and a day with NO
// rota at all (no roster covers the person: servd cannot tell their weekly
// off) are never working days. Approved leave (incl. a half day) still
// covers the day in logic.ts attendanceInputs.
//
// Rule B — punch overtime. From `punchOvertimeFrom` (default 2026-11-01), a
// day's overtime is the time worked (the day's attendance record: paired
// in/out punches; a corrected or hand-keyed day uses its check-in/check-out)
// AFTER the end of the person's rota shift that day; on a day with no rota
// shift, the time beyond `standardDayHours` (default 9). Extra under
// `otMinimumMinutes` (default 30) is ignored. It is priced like approved OT
// (logic.ts overtimeCents at the HR multiplier, the month it was worked) and
// NEVER paid on its own (rule C): service.ts availableOvertime offers it as
// `punch:<attendanceRecordId>` for HR to add to a draft payslip / full &
// final. An approved overtime request for the same person and day wins: the
// punch OT of that day is not offered (and an approved request for a day
// whose punch OT is already paid is not offered either — never paid twice).

import type { HrRecord } from '@prisma/client'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { getFormat, STANDING_ATTENDANCE, type Db } from './service.js'
import { attendanceKeys, type PunchEntry } from './attendance.js'
import { rotaFor, toMinutes, ymd, type RotaCell } from './rota.js'
import { overtimeCents, periodOf, pktToday, type HrSettings } from './logic.js'

const DAY_MS = 86_400_000
const dayUTC = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
const settingDay = (v: string | null | undefined): number | null => {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null
  const t = Date.parse(`${v}T00:00:00.000Z`)
  return Number.isNaN(t) ? null : t
}
/** The longest span ever counted as worked (attendance.ts MISSING_PUNCH_AFTER_MS). */
const MAX_INTERVAL_MIN = 16 * 60

type Emp = { id: string; userId: string | null }

/** The rota over [fromMs, toMs] in chunks of at most 62 days (rotaFor reads ≤ 400). */
async function rotaCells(tenantId: string, emps: Emp[], fromMs: number, toMs: number): Promise<Map<string, RotaCell>> {
  const out = new Map<string, RotaCell>()
  if (!emps.length || fromMs > toMs) return out
  for (let a = fromMs; a <= toMs; a += 62 * DAY_MS) {
    const b = Math.min(toMs, a + 61 * DAY_MS)
    for (const c of await rotaFor(tenantId, emps, ymd(new Date(a)), ymd(new Date(b)))) out.set(`${c.employeeId}:${c.date}`, c)
  }
  return out
}

// ─── Rule A ─────────────────────────────────────────────────────────────────

/**
 * Each employee's working days in [from, to] (one company) that rule A may
 * mark absent — as UTC-midnight ms. logic.ts attendanceInputs counts one as
 * absent when it has no standing record and no approved leave.
 */
export async function noPunchWorkingDays(
  tenantId: string,
  emps: Array<Emp & { locationId: string | null }>,
  from: Date, to: Date, s: HrSettings, today = pktToday(),
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>()
  const start = settingDay(s.absentWithoutPunchFrom)
  if (start == null || !emps.length) return out
  const lo = Math.max(dayUTC(from), start)
  const hi = Math.min(dayUTC(to), dayUTC(today) - DAY_MS)
  if (lo > hi) return out
  const [holidays, holidayFmt, workLocs, cells] = await Promise.all([
    prisma.hrRecord.findMany({
      where: { tenantId, section: 'holiday', status: 'approved', startDate: { gte: new Date(lo), lte: new Date(hi + DAY_MS - 1) } },
      select: { startDate: true, data: true },
    }),
    getFormat(tenantId, 'holiday'),
    prisma.hrWorkLocation.findMany({ where: { tenantId, employeeId: { in: emps.map((e) => e.id) } }, select: { employeeId: true, locationId: true } }),
    rotaCells(tenantId, emps, lo, hi),
  ])
  const locKey = holidayFmt.fields.find((f) => f.type === 'location')?.key ?? 'location'
  // day → branches it is a holiday at ('*' = every branch).
  const holidayAt = new Map<number, Set<string>>()
  for (const h of holidays) {
    if (!h.startDate) continue
    const loc = ((h.data ?? {}) as Record<string, unknown>)[locKey]
    const d = dayUTC(h.startDate)
    const set = holidayAt.get(d) ?? new Set<string>()
    set.add(typeof loc === 'string' && loc ? loc : '*')
    holidayAt.set(d, set)
  }
  for (const e of emps) {
    const branches = new Set<string>([...(e.locationId ? [e.locationId] : []), ...workLocs.filter((w) => w.employeeId === e.id).map((w) => w.locationId)])
    const days: number[] = []
    for (let d = lo; d <= hi; d += DAY_MS) {
      const cell = cells.get(`${e.id}:${ymd(new Date(d))}`)
      if (cell?.kind !== 'shift') continue
      const hol = holidayAt.get(d)
      if (hol && (hol.has('*') || Array.from(branches).some((b) => hol.has(b)))) continue
      days.push(d)
    }
    out.set(e.id, days)
  }
  return out
}

// ─── Rule B ─────────────────────────────────────────────────────────────────

export interface Interval { start: number; end: number }

/**
 * The time a day's attendance record says was worked, as minutes from 00:00
 * Karachi of the record's day. A punched day (time clock / kiosk) pairs each
 * in with the next out — a later in replaces an unclosed one (a forgotten
 * clock-out has no hours, attendance.ts); a corrected or hand-keyed day uses
 * its check-in → check-out (an out at or before the in is past midnight).
 */
export function workedIntervals(rec: Pick<HrRecord, 'startDate' | 'data'>, keys: { checkIn: string; checkOut: string }): Interval[] {
  if (!rec.startDate) return []
  const d = (rec.data ?? {}) as Record<string, unknown>
  const dayStart = dayUTC(rec.startDate) - 5 * 3_600_000
  const punches = Array.isArray(d['_punches']) ? (d['_punches'] as PunchEntry[]) : []
  const out: Interval[] = []
  const add = (a: number, b: number) => { if (b > a && b - a <= MAX_INTERVAL_MIN) out.push({ start: a, end: b }) }
  if (['clock', 'kiosk'].includes(String(d['_source'] ?? '')) && punches.length) {
    let open: number | null = null
    for (const p of [...punches].sort((x, y) => x.at.localeCompare(y.at))) {
      const m = (Date.parse(p.at) - dayStart) / 60_000
      if (Number.isNaN(m)) continue
      if (p.type === 'in') open = m
      else if (open != null) { add(open, m); open = null }
    }
    return out
  }
  const a = toMinutes(d[keys.checkIn]), b = toMinutes(d[keys.checkOut])
  if (a == null || b == null) return out
  add(a, b > a ? b : b + 1440)
  return out
}

/** End of the day's rota shift (minutes from 00:00 of the day); null when the day has no shift. */
export function shiftEndMinutes(cell: RotaCell | null | undefined): number | null {
  if (cell?.kind !== 'shift' || !cell.segments.length) return null
  let end: number | null = null
  for (const s of cell.segments) {
    const a = toMinutes(s.start), b = toMinutes(s.end)
    if (a == null || b == null) continue
    const e = b > a ? b : b + 1440
    end = end == null ? e : Math.max(end, e)
  }
  return end
}

export type PunchOtBasis = 'after_shift' | 'beyond_standard_day'

/** Overtime minutes on one day (rule B); 0 under the minimum. */
export function punchOvertimeMinutes(intervals: Interval[], cell: RotaCell | null | undefined, s: Pick<HrSettings, 'standardDayHours' | 'otMinimumMinutes'>): { minutes: number; basis: PunchOtBasis } {
  const end = shiftEndMinutes(cell)
  let minutes: number
  let basis: PunchOtBasis
  if (end != null) {
    basis = 'after_shift'
    minutes = intervals.reduce((a, iv) => a + Math.max(0, iv.end - Math.max(iv.start, end)), 0)
  } else {
    basis = 'beyond_standard_day'
    const worked = intervals.reduce((a, iv) => a + (iv.end - iv.start), 0)
    minutes = Math.max(0, worked - Math.max(0, s.standardDayHours) * 60)
  }
  minutes = Math.floor(minutes)
  return { minutes: minutes >= Math.max(0, s.otMinimumMinutes) ? minutes : 0, basis }
}

export interface PunchOt {
  /** The payslip / settlement id for it: `punch:<attendanceRecordId>`. */
  id: string
  attendanceRecordId: string
  employeeId: string
  date: string
  minutes: number
  hours: number
  basis: PunchOtBasis
  amountCents: number
}

export const PUNCH_OT_PREFIX = 'punch:'

/**
 * Punch overtime of these attendance records (one company; standing records
 * only — the caller filters), inside the rule's window (from the setting's
 * date, days already over). Priced at each employee's gross.
 */
export async function punchOvertimeForRecords(
  tenantId: string,
  records: Array<Pick<HrRecord, 'id' | 'employeeId' | 'startDate' | 'data'>>,
  emps: Array<Emp & { grossSalaryCents: number }>,
  s: HrSettings, today = pktToday(),
): Promise<Map<string, PunchOt>> {
  const out = new Map<string, PunchOt>()
  const start = settingDay(s.punchOvertimeFrom)
  if (start == null) return out
  const last = dayUTC(today) - DAY_MS
  const empById = new Map(emps.map((e) => [e.id, e]))
  const mine = records.filter((r) => r.startDate && r.employeeId && empById.has(r.employeeId) && dayUTC(r.startDate) >= start && dayUTC(r.startDate) <= last)
  if (!mine.length) return out
  const keys = attendanceKeys((await getFormat(tenantId, 'attendance')).fields)
  const withTime = mine.map((r) => ({ r, iv: workedIntervals(r, keys) })).filter((x) => x.iv.length)
  if (!withTime.length) return out
  const days = withTime.map((x) => dayUTC(x.r.startDate!))
  const people = Array.from(new Set(withTime.map((x) => x.r.employeeId!))).map((id) => empById.get(id)!)
  const cells = await rotaCells(tenantId, people, Math.min(...days), Math.max(...days))
  for (const { r, iv } of withTime) {
    const date = ymd(r.startDate!)
    const { minutes, basis } = punchOvertimeMinutes(iv, cells.get(`${r.employeeId}:${date}`), s)
    if (minutes <= 0) continue
    const hours = Math.round((minutes / 60) * 100) / 100
    const emp = empById.get(r.employeeId!)!
    out.set(r.id, {
      id: `${PUNCH_OT_PREFIX}${r.id}`, attendanceRecordId: r.id, employeeId: emp.id, date, minutes, hours, basis,
      amountCents: overtimeCents(hours, emp.grossSalaryCents, s, s.otMultiplier, periodOf(r.startDate!)),
    })
  }
  return out
}

/** Punch overtime of these employees (one company) over [from, to], read
 *  from their standing attendance records. When a day was recorded more than
 *  once, the latest record stands (as payroll reads attendance). */
export async function punchOvertimeRows(
  tenantId: string, emps: Array<Emp & { grossSalaryCents: number }>, from: Date, to: Date, s: HrSettings,
  q: Db = prisma, today = pktToday(),
): Promise<PunchOt[]> {
  const start = settingDay(s.punchOvertimeFrom)
  if (start == null || !emps.length) return []
  const lo = Math.max(dayUTC(from), start)
  const hi = Math.min(dayUTC(to), dayUTC(today) - DAY_MS)
  if (lo > hi) return []
  const rows = await q.hrRecord.findMany({
    where: { tenantId, section: 'attendance', employeeId: { in: emps.map((e) => e.id) }, status: STANDING_ATTENDANCE, startDate: { gte: new Date(lo), lte: new Date(hi) } },
    select: { id: true, employeeId: true, startDate: true, data: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })
  const latest = new Map<string, (typeof rows)[number]>()
  for (const r of rows) latest.set(`${r.employeeId}:${ymd(r.startDate!)}`, r)
  const found = await punchOvertimeForRecords(tenantId, Array.from(latest.values()), emps, s, today)
  return Array.from(found.values()).sort((a, b) => a.date.localeCompare(b.date))
}
