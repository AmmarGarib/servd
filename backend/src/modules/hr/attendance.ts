// Attendance from punches (owner decision 32).
//
// The time clock is the capture device; the HR 'attendance' record is what
// payroll, reports and the dashboard read. A punch — the signed-in time clock,
// the tablet, or the shared kiosk PIN for staff without a login — writes that
// day's attendance record for the person in THAT company:
//
//   first in    creates the day: present, or late when the check-in is past
//               the rostered start (rota.ts) by more than the HR setting
//               lateGraceMinutes. The minutes late go on the record.
//   out         closes the day (the last out stands).
//   no out      a day whose in is 16 h old with no out becomes missing_punch.
//   missed out  an in left open past isMissedClockOut() — 16 h, or 12 h once
//               the business day has turned at 06:00 Karachi (a closing shift
//               past midnight still pairs) — is a forgotten clock-out, never a
//               shift: the day is closed as missing_punch (data._missedOut)
//               with NO hours, the next in opens a new day, and a late out
//               does not pair with it (that booked 25-hour shifts — audit
//               PPL-03). HR fixes it with an attendance_correction.
//
// HR corrects exceptions through an approved attendance_correction, which
// rewrites the day. A row HR keyed or edited by hand is never overwritten by a
// punch. ClockLog stays the raw punch log; the record keeps a copy of the
// punches it was built from (data._punches) so the row can be read on its own.
//
// Where (owner, 2026-10-15): each punch carries the work location it was measured at, its distance and whether it
// was out of area (timeclock/policy.ts). When the company's geofence is on, an out-of-area punch marks the day
// (data._outOfArea = true; the punch itself has outOfArea: true) — allowed, never refused, flagged for HR.

import type { Prisma, HrRecord } from '@prisma/client'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { getFormat, getSettings, STANDING_ATTENDANCE, ATTENDANCE_DAY_TAKEN } from './service.js'
import { pktToday } from './logic.js'
import { rotaDay, toMinutes, ymd, type RotaCell } from './rota.js'
import type { HrField } from './forms.js'

type Tx = Prisma.TransactionClient

/** Where a day's row came from. Only these are rewritten by a punch. */
const PUNCH_SOURCES = ['clock', 'kiosk']
/** An in with no out for this long is a missing punch — and the longest span
 *  that is ever counted as a shift. */
export const MISSING_PUNCH_AFTER_MS = 16 * 3_600_000
/** An in that is at least this old is a missed clock-out too once the
 *  business day has turned (DAY_TURNS_AT_PKT_HOUR): 18:00 yesterday to 09:00
 *  today is a forgotten out. */
export const MISSED_OUT_NEXT_DAY_MS = 12 * 3_600_000
/** The business day turns at 06:00 Karachi time, not at midnight: a closing
 *  shift that runs past midnight (14:00 to 02:00, 15:00 to 03:15) is still
 *  tonight's shift, so its out pairs and the kiosk reads it as an out (audit
 *  HR-R1). Restaurants here close by 04:00; 06:00 leaves room for the clean-up. */
export const DAY_TURNS_AT_PKT_HOUR = 6

/**
 * Is an in still open at `now` a forgotten clock-out rather than a shift in
 * progress? The ONE rule — the time clock, the kiosk, the status the tablet
 * shows and the tip pool all ask it.
 *
 *   - 16 h or more: always (the longest span ever counted as a shift);
 *   - 12 h or more AND now is past 06:00 Karachi on a later calendar day than
 *     the in — the business day it was worked in is over.
 *
 * So 14:00 → 02:00 and 15:00 → 03:15 are shifts; 18:00 → 09:00 is not; a
 * 05:30 breakfast in is still a shift at 17:30 the same day.
 */
export function isMissedClockOut(inAt: Date, now = new Date()): boolean {
  const age = now.getTime() - inAt.getTime()
  if (age >= MISSING_PUNCH_AFTER_MS) return true
  if (age < MISSED_OUT_NEXT_DAY_MS) return false
  const dayAfterInTurns = pktToday(inAt).getTime() + 86_400_000 + (DAY_TURNS_AT_PKT_HOUR - 5) * 3_600_000
  return now.getTime() >= dayAfterInTurns
}

export interface PunchEntry {
  type: 'in' | 'out'
  at: string
  source: string
  clockLogId?: string | null
  geofenceMatched?: boolean | null
  geofenceDistanceM?: number | null
  locationId?: string | null
  selfieUrl?: string | null
  /** Outside the work locations / no location while the geofence is on (null = not judged). */
  outOfArea?: boolean | null
  outOfAreaReason?: string | null
}

/** Karachi wall-clock time of an instant, HH:MM. */
export function pktHHMM(at: Date): string {
  const k = new Date(at.getTime() + 5 * 3_600_000)
  return `${String(k.getUTCHours()).padStart(2, '0')}:${String(k.getUTCMinutes()).padStart(2, '0')}`
}

/** The attendance format's keys for what logic writes, whatever HR renamed. */
export function attendanceKeys(fields: HrField[]) {
  const bound = (slot: string, fallback: string) => fields.find((f) => f.bind === slot)?.key ?? fallback
  const times = fields.filter((f) => f.type === 'time')
  return {
    employee: bound('employeeId', 'employee'),
    date: bound('startDate', 'date'),
    status: bound('category', 'status'),
    late: bound('quantity', 'lateMinutes'),
    shift: bound('refId', 'shift'),
    checkIn: fields.find((f) => f.key === 'checkIn')?.key ?? times[0]?.key ?? 'checkIn',
    checkOut: fields.find((f) => f.key === 'checkOut')?.key ?? times[1]?.key ?? 'checkOut',
  }
}

/**
 * Minutes a check-in is past the rostered start. Negative = early. The
 * difference is taken the short way round the clock, so a 23:50 check-in for
 * a 00:00 start is 10 minutes early, not 23 h 50 late.
 */
export function minutesLate(checkIn: string, start: string): number | null {
  const a = toMinutes(checkIn), b = toMinutes(start)
  if (a == null || b == null) return null
  let d = a - b
  if (d > 720) d -= 1440
  if (d < -720) d += 1440
  return d
}

/** present or late for a check-in against the day's rota. */
export function statusFor(checkIn: string | null, cell: RotaCell | null, graceMinutes: number): { status: 'present' | 'late'; lateMinutes: number | null } {
  const start = cell?.kind === 'shift' ? cell.segments[0]?.start : undefined
  if (!checkIn || !start) return { status: 'present', lateMinutes: null }
  const late = minutesLate(checkIn, start)
  if (late != null && late > graceMinutes) return { status: 'late', lateMinutes: late }
  return { status: 'present', lateMinutes: null }
}

const isPunchOwned = (r: HrRecord) => PUNCH_SOURCES.includes(String(((r.data ?? {}) as Record<string, unknown>)['_source'] ?? ''))

/** The latest in on a day's record (its creation time if the punches are gone). */
export function lastInOf(r: Pick<HrRecord, 'data' | 'createdAt'>): Date {
  const ins = ((((r.data ?? {}) as Record<string, unknown>)['_punches'] as PunchEntry[] | undefined) ?? []).filter((x) => x.type === 'in')
  return ins.length ? new Date(ins[ins.length - 1]!.at) : r.createdAt
}

/** A punch-owned day with an in and no out, not already closed as missed. */
function isOpenDay(r: HrRecord, checkOutKey: string): boolean {
  const d = (r.data ?? {}) as Record<string, unknown>
  return isPunchOwned(r) && !d[checkOutKey] && !d['_missedOut']
}

/** The write that closes a day as a missed clock-out: missing_punch, no out,
 *  and a note of the in that was never closed (HR corrects it). */
function missedOutData(d: Record<string, unknown>, statusKey: string, lastIn: Date, at: Date, refusedOut: boolean) {
  return {
    ...d,
    [statusKey]: 'missing_punch',
    _missedOut: { lastIn: lastIn.toISOString(), flaggedAt: at.toISOString(), ...(refusedOut && { refusedOutAt: at.toISOString() }) },
  }
}

/**
 * Close every open day of this employee whose last in is a missed clock-out
 * by `at` (isMissedClockOut). Runs before a new in, so today's in opens a new
 * day instead of being swallowed by yesterday's. Returns the closed record ids.
 */
export async function closeMissedDays(tenantId: string, employeeId: string, at = new Date()): Promise<string[]> {
  const today = pktToday(at)
  const rows = await prisma.hrRecord.findMany({
    where: { tenantId, section: 'attendance', employeeId, status: ATTENDANCE_DAY_TAKEN, startDate: { gte: new Date(today.getTime() - 40 * 86_400_000), lte: today } },
  })
  if (rows.length === 0) return []
  const k = attendanceKeys((await getFormat(tenantId, 'attendance')).fields)
  const closed: string[] = []
  for (const r of rows) {
    if (!isOpenDay(r, k.checkOut)) continue
    const lastIn = lastInOf(r)
    if (!isMissedClockOut(lastIn, at)) continue
    const n = await prisma.hrRecord.updateMany({
      where: { id: r.id, updatedAt: r.updatedAt },
      data: { category: 'missing_punch', data: missedOutData(r.data as Record<string, unknown>, k.status, lastIn, at, false) as Prisma.InputJsonValue },
    })
    if (n.count) closed.push(r.id)
  }
  return closed
}

async function lockDay(tx: Tx, employeeId: string, day: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`hr-attendance:${employeeId}:${day}`}))`
}

/** The day's standing attendance record — the latest, which is the one payroll reads. */
function dayRecord(tx: Tx, tenantId: string, employeeId: string, day: Date) {
  return tx.hrRecord.findFirst({
    where: { tenantId, section: 'attendance', employeeId, status: ATTENDANCE_DAY_TAKEN, startDate: day },
    orderBy: { createdAt: 'desc' },
  })
}

export interface PunchInput {
  tenantId: string
  employeeId: string
  kind: 'in' | 'out'
  at?: Date
  source: 'clock' | 'kiosk'
  actorUserId?: string | null
  clockLogId?: string | null
  geofenceMatched?: boolean | null
  geofenceDistanceM?: number | null
  locationId?: string | null
  selfieUrl?: string | null
  outOfArea?: boolean | null
  outOfAreaReason?: string | null
}

export interface PunchResult {
  recordId: string | null
  status: string | null
  lateMinutes: number | null
  skipped?: 'not_employed' | 'hand_keyed' | 'no_open_day' | 'missed_out'
}

/** Write one punch into the day's attendance record. */
export async function recordPunch(p: PunchInput): Promise<PunchResult> {
  const at = p.at ?? new Date()
  const emp = await prisma.hrEmployee.findFirst({ where: { id: p.employeeId, tenantId: p.tenantId } })
  if (!emp || !['active', 'on_leave'].includes(emp.status)) return { recordId: null, status: null, lateMinutes: null, skipped: 'not_employed' }
  const today = pktToday(at)
  const hhmm = pktHHMM(at)
  const entry: PunchEntry = {
    type: p.kind, at: at.toISOString(), source: p.source, clockLogId: p.clockLogId ?? null,
    geofenceMatched: p.geofenceMatched ?? null, geofenceDistanceM: p.geofenceDistanceM ?? null,
    locationId: p.locationId ?? null, selfieUrl: p.selfieUrl ?? null,
    ...(p.outOfArea != null && { outOfArea: p.outOfArea }),
    ...(p.outOfArea && p.outOfAreaReason && { outOfAreaReason: p.outOfAreaReason }),
  }
  /** The day is marked once any of its punches is out of area. */
  const markOutOfArea = (d: Record<string, unknown>) => { if (p.outOfArea) d['_outOfArea'] = true }
  const fmt = await getFormat(p.tenantId, 'attendance')
  const k = attendanceKeys(fmt.fields)

  if (p.kind === 'in') {
    // A day left open by a forgotten clock-out is closed first (no hours), so
    // this in opens today rather than reviving yesterday.
    await closeMissedDays(p.tenantId, emp.id, at)
    const [settings, cell] = await Promise.all([getSettings(p.tenantId), rotaDay(p.tenantId, emp, ymd(today))])
    return prisma.$transaction(async (tx) => {
      await lockDay(tx, emp.id, ymd(today))
      const cur = await dayRecord(tx, p.tenantId, emp.id, today)
      if (cur && !isPunchOwned(cur)) return { recordId: cur.id, status: cur.category, lateMinutes: cur.quantity, skipped: 'hand_keyed' as const }
      if (cur) {
        // Back in after a break (a split shift): the first in stands, the day
        // is open again until the next out.
        const d = { ...(cur.data as Record<string, unknown>) }
        d['_punches'] = [...((d['_punches'] as PunchEntry[] | undefined) ?? []), entry]
        d[k.checkOut] = null
        markOutOfArea(d)
        // The day was closed as a missed clock-out earlier today: it opens
        // again for this in (the forgotten in stays unpaired — no hours), and
        // the note is kept for HR.
        if (d['_missedOut']) {
          d['_missedOutHistory'] = [...((d['_missedOutHistory'] as unknown[] | undefined) ?? []), d['_missedOut']]
          delete d['_missedOut']
        }
        const category = cur.category === 'missing_punch' ? String(d['_inStatus'] ?? 'present') : cur.category
        await tx.hrRecord.update({ where: { id: cur.id }, data: { category, data: d as Prisma.InputJsonValue } })
        return { recordId: cur.id, status: category, lateMinutes: cur.quantity }
      }
      const { status, lateMinutes } = statusFor(hhmm, cell, settings.lateGraceMinutes)
      const firstShift = cell.kind === 'shift' ? cell.segments[0] : undefined
      const data: Record<string, unknown> = {
        [k.employee]: emp.id, [k.date]: today.toISOString(), [k.status]: status, [k.late]: lateMinutes,
        [k.checkIn]: hhmm, [k.checkOut]: null,
        ...(firstShift?.shiftId && { [k.shift]: firstShift.shiftId }),
        ...(p.locationId && { location: p.locationId }),
        ...(cell.kind === 'off' && { remarks: 'Punched in on a rostered day off' }),
        ...(cell.kind === 'leave' && { remarks: 'Punched in on an approved leave day' }),
        _source: p.source, _inStatus: status, _punches: [entry],
        _expected: cell.kind === 'shift' ? { start: firstShift?.start, end: firstShift?.end, source: cell.source } : { kind: cell.kind },
        ...(p.outOfArea && { _outOfArea: true }),
      }
      const rec = await tx.hrRecord.create({
        data: {
          tenantId: p.tenantId, section: 'attendance', formVersion: fmt.version, employeeId: emp.id,
          startDate: today, category: status, quantity: lateMinutes, refId: firstShift?.shiftId ?? null,
          status: 'approved', data: data as Prisma.InputJsonValue, createdById: p.actorUserId ?? null,
        },
      })
      return { recordId: rec.id, status, lateMinutes }
    })
  }

  // out: close the open day — today's, or yesterday's for a shift that ran
  // past midnight.
  const yesterday = new Date(today.getTime() - 86_400_000)
  return prisma.$transaction(async (tx) => {
    // Oldest day first, the same order an in takes its one lock in.
    await lockDay(tx, emp.id, ymd(yesterday))
    await lockDay(tx, emp.id, ymd(today))
    const open = await tx.hrRecord.findMany({
      where: { tenantId: p.tenantId, section: 'attendance', employeeId: emp.id, status: ATTENDANCE_DAY_TAKEN, startDate: { in: [today, yesterday] } },
      orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
    })
    const cur = open.find((r) => isOpenDay(r, k.checkOut))
    if (!cur) return { recordId: null, status: null, lateMinutes: null, skipped: 'no_open_day' as const }
    const lastIn = lastInOf(cur)
    if (isMissedClockOut(lastIn, at)) {
      // A forgotten clock-out: this out does not pair with an in that old
      // (it booked a 25-hour shift). The day is closed as missing_punch with
      // no hours, and the out is not added to its punches.
      await tx.hrRecord.update({
        where: { id: cur.id },
        data: { category: 'missing_punch', data: missedOutData(cur.data as Record<string, unknown>, k.status, lastIn, at, true) as Prisma.InputJsonValue },
      })
      return { recordId: cur.id, status: 'missing_punch', lateMinutes: cur.quantity, skipped: 'missed_out' as const }
    }
    const d = { ...(cur.data as Record<string, unknown>) }
    d['_punches'] = [...((d['_punches'] as PunchEntry[] | undefined) ?? []), entry]
    d[k.checkOut] = hhmm
    markOutOfArea(d)
    const category = cur.category === 'missing_punch' ? String(d['_inStatus'] ?? 'present') : cur.category
    d[k.status] = category
    await tx.hrRecord.update({ where: { id: cur.id }, data: { category, data: d as Prisma.InputJsonValue } })
    return { recordId: cur.id, status: category, lateMinutes: cur.quantity }
  })
}

/**
 * Days with an in and no out, whose last in is at least 16 hours old, become
 * missing_punch — HR sees them as exceptions and the person corrects them
 * with an attendance_correction. A later out never closes them
 * (isMissedClockOut). Idempotent; run before attendance is read and before
 * payroll is calculated.
 */
export async function flagMissingPunches(tenantId: string, now = new Date()): Promise<number> {
  const since = new Date(pktToday(now).getTime() - 40 * 86_400_000)
  const rows = await prisma.hrRecord.findMany({
    where: { tenantId, section: 'attendance', status: STANDING_ATTENDANCE, category: { in: ['present', 'late'] }, startDate: { gte: since } },
  })
  const candidates = rows.filter(isPunchOwned)
  if (candidates.length === 0) return 0
  const k = attendanceKeys((await getFormat(tenantId, 'attendance')).fields)
  let n = 0
  for (const r of candidates) {
    const d = r.data as Record<string, unknown>
    if (d[k.checkOut]) continue
    const ins = ((d['_punches'] as PunchEntry[] | undefined) ?? []).filter((x) => x.type === 'in')
    const lastIn = ins.length ? new Date(ins[ins.length - 1]!.at) : r.createdAt
    if (now.getTime() - lastIn.getTime() < MISSING_PUNCH_AFTER_MS) continue
    const claimed = await prisma.hrRecord.updateMany({
      where: { id: r.id, category: r.category, updatedAt: r.updatedAt },
      data: { category: 'missing_punch', data: { ...d, [k.status]: 'missing_punch' } as Prisma.InputJsonValue },
    })
    n += claimed.count
  }
  return n
}

/**
 * An approved attendance_correction rewrites that day's attendance: the
 * corrected times replace the punched ones, and present or late is worked out
 * again against the rota. With no record for the day (the person never
 * punched) one is created. Runs inside the approving transaction.
 */
export async function applyAttendanceCorrection(tx: Tx, rec: HrRecord): Promise<void> {
  if (!rec.employeeId || !rec.startDate) return
  const emp = await tx.hrEmployee.findFirst({ where: { id: rec.employeeId, tenantId: rec.tenantId } })
  if (!emp) return
  const c = (rec.data ?? {}) as Record<string, unknown>
  const inT = toMinutes(c['correctedIn']) != null ? String(c['correctedIn']) : null
  const outT = toMinutes(c['correctedOut']) != null ? String(c['correctedOut']) : null
  if (!inT && !outT) return
  const day = new Date(Date.UTC(rec.startDate.getUTCFullYear(), rec.startDate.getUTCMonth(), rec.startDate.getUTCDate()))
  const [fmt, settings, cell] = await Promise.all([getFormat(rec.tenantId, 'attendance'), getSettings(rec.tenantId), rotaDay(rec.tenantId, emp, ymd(day))])
  const k = attendanceKeys(fmt.fields)
  await lockDay(tx, emp.id, ymd(day))
  const cur = await dayRecord(tx, rec.tenantId, emp.id, day)
  const d: Record<string, unknown> = { ...((cur?.data ?? {}) as Record<string, unknown>) }
  const before = cur ? { checkIn: d[k.checkIn] ?? null, checkOut: d[k.checkOut] ?? null, status: cur.category, lateMinutes: cur.quantity } : null
  if (inT) d[k.checkIn] = inT
  if (outT) d[k.checkOut] = outT
  const checkIn = typeof d[k.checkIn] === 'string' ? d[k.checkIn] as string : null
  const { status, lateMinutes } = checkIn ? statusFor(checkIn, cell, settings.lateGraceMinutes) : { status: (cur?.category ?? 'present') as string, lateMinutes: cur?.quantity ?? null }
  const firstShift = cell.kind === 'shift' ? cell.segments[0] : undefined
  Object.assign(d, {
    [k.employee]: emp.id, [k.date]: day.toISOString(), [k.status]: status, [k.late]: lateMinutes,
    _source: 'correction', _correctionId: rec.id, _corrected: before,
  })
  if (cur) {
    await tx.hrRecord.update({ where: { id: cur.id }, data: { category: status, quantity: lateMinutes, data: d as Prisma.InputJsonValue } })
  } else {
    if (firstShift?.shiftId) d[k.shift] = firstShift.shiftId
    await tx.hrRecord.create({
      data: {
        tenantId: rec.tenantId, section: 'attendance', formVersion: fmt.version, employeeId: emp.id,
        startDate: day, category: status, quantity: lateMinutes, refId: firstShift?.shiftId ?? null,
        status: 'approved', data: d as Prisma.InputJsonValue, createdById: rec.createdById,
      },
    })
  }
}

/** The employee record a login punches as in a company, if HR has linked one. */
export function linkedEmployee(userId: string, tenantId: string) {
  return prisma.hrEmployee.findFirst({ where: { userId, tenantId } })
}
