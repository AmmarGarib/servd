// The time clock — the one place a punch is taken (decision 32).
//
// A punch is checked against the company's clock-in policy (policy.ts),
// written to the ClockLog punch log (for a login), and turned into that day's
// HR attendance record (hr/attendance.ts) for the employee record linked in
// the ACTIVE company — one login may be an employee in each company, and the
// company is the one they are punching for. A login with no employee record
// (the CEO, an agency user) still punches; it just has no attendance.
//
// Staff WITHOUT a login punch at a shared kiosk with their HR employee code
// and PIN (hr/kioskPin.ts), with the tablet's GPS. Their punch goes straight to
// attendance (ClockLog is the punch log of logins).
//
// Where (owner, 2026-10-15): every punch is measured against the employee's
// own work locations (policy.ts) and is NEVER refused for where it was taken —
// out of area is recorded on the ClockLog (tenantId, locationId, outOfArea) and
// on the day's attendance, and flagged for HR when the geofence is on.

import { serviceClient as prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { requireTenantId } from '../../lib/tenantScope.js'
import { recordPunch, attendanceKeys, closeMissedDays, isMissedClockOut, lastInOf, type PunchEntry, type PunchResult } from '../hr/attendance.js'
import { verifyKioskPin } from '../hr/kioskPin.js'
import { getFormat, STANDING_ATTENDANCE, ATTENDANCE_DAY_TAKEN } from '../hr/service.js'
import { pktToday } from '../hr/logic.js'
import { enforceClockInPolicy, flagOutOfArea, type ClockInVerdict } from './policy.js'

export interface Actor { id: string; role: string; tenantId: string | null; name?: string | null }
export interface PunchBody { lat?: number; lng?: number; selfieUrl?: string }

const activeCompany = (actor: Actor): string => requireTenantId(actor.tenantId, 'a punch belongs to one company')

/** What the punch screen shows about where the punch was taken. */
const whereOut = (v: ClockInVerdict | null) => v && (v.geofenceMatched != null || v.outOfArea != null)
  ? { locationId: v.locationId, location: v.locationName, distanceM: v.geofenceDistanceM, radiusM: v.radiusM, matched: v.geofenceMatched, outOfArea: !!v.outOfArea, reason: v.outOfArea ? v.outOfAreaReason : null, flagged: !!(v.enforced && v.outOfArea) }
  : null

/** The verdict's columns on the punch log and the attendance punch. */
const verdictCols = (v: ClockInVerdict | null) => ({
  geofenceMatched: v?.geofenceMatched ?? null, geofenceDistanceM: v?.geofenceDistanceM ?? null,
  locationId: v?.locationId ?? null, outOfArea: v?.outOfArea ?? null,
})

const attendanceOut = (r: PunchResult | null) => r && r.recordId ? { recordId: r.recordId, status: r.status, lateMinutes: r.lateMinutes, ...(r.skipped && { note: r.skipped }) } : null

/**
 * This login's open clock-in — the last punch-log row when it is an in — and
 * whether it is a forgotten clock-out by now (hr/attendance isMissedClockOut).
 * clockIn, clockOut and GET /time-clock/status all read it, so the status
 * the tablet shows and what a punch does always agree.
 */
export async function openClockIn(userId: string, now = new Date()): Promise<{ since: Date; missed: boolean; tenantId: string | null } | null> {
  const last = await prisma.clockLog.findFirst({ where: { userId }, orderBy: { recordedAt: 'desc' }, select: { type: true, recordedAt: true, tenantId: true } })
  if (last?.type !== 'in') return null
  return { since: last.recordedAt, missed: isMissedClockOut(last.recordedAt, now), tenantId: last.tenantId }
}

/** Close the day a forgotten clock-out left open, in every company this
 *  login is an employee of: missing_punch, no hours, for HR to correct. */
async function closeMissedOutFor(userId: string, at: Date) {
  const emps = await prisma.hrEmployee.findMany({ where: { userId, status: { in: ['active', 'on_leave'] } }, select: { id: true, tenantId: true } })
  for (const e of emps) await closeMissedDays(e.tenantId, e.id, at)
}

const MISSED_OUT_NOTE = 'Your last clock-in was never clocked out. That day is flagged for HR as a missed punch and counts no hours until it is corrected.'

export async function clockIn(actor: Actor, body: PunchBody, ip?: string) {
  const tenantId = activeCompany(actor)
  // Already clocked in? Return the open punch rather than stacking a second
  // 'in', which would leave an unpaired record and skew the hours pairing —
  // unless that in is a forgotten clock-out (yesterday's, say): then it is
  // closed as a missed punch and today's in goes ahead.
  const now = new Date()
  const open = await openClockIn(actor.id, now)
  if (open && !open.missed) return { alreadyClockedIn: true, since: open.since }

  const emp = await prisma.hrEmployee.findFirst({ where: { userId: actor.id, tenantId } })
  const verdict = await enforceClockInPolicy(tenantId, actor.role, body, { employeeId: emp?.id ?? null, kind: 'in' })
  if (open?.missed) await closeMissedOutFor(actor.id, now)
  const log = await prisma.clockLog.create({
    data: {
      userId: actor.id, type: 'in', lat: body.lat ?? null, lng: body.lng ?? null, selfieUrl: body.selfieUrl ?? null,
      ipAddress: ip ?? null, tenantId, ...verdictCols(verdict),
    },
  })
  const att = emp
    ? await recordPunch({
        tenantId, employeeId: emp.id, kind: 'in', at: log.recordedAt, source: 'clock', actorUserId: actor.id, clockLogId: log.id,
        ...verdictCols(verdict), outOfAreaReason: verdict.outOfAreaReason, selfieUrl: body.selfieUrl ?? null,
      })
    : null
  await flagOutOfArea({ tenantId, employeeId: emp?.id ?? null, userId: actor.id, name: emp?.fullName ?? actor.name ?? null, kind: 'in', at: log.recordedAt, verdict })
  return {
    clockedInAt: log.recordedAt, geofenceMatched: verdict.geofenceMatched, geofenceDistanceM: verdict.geofenceDistanceM,
    location: verdict.locationName, where: whereOut(verdict), hrLinked: !!emp, attendance: attendanceOut(att),
    ...(open?.missed && { missedClockOut: { since: open.since, note: MISSED_OUT_NOTE } }),
  }
}

export async function clockOut(actor: Actor, body: PunchBody = {}, ip?: string) {
  const now = new Date()
  const open = await openClockIn(actor.id, now)
  if (!open) return { notClockedIn: true }
  if (open.missed) {
    // Pairing this out with an in from yesterday would book a 25-hour shift.
    // No out is written; the open day is closed as a missed punch for HR.
    await closeMissedOutFor(actor.id, now)
    return { notClockedIn: true, missedClockOut: { since: open.since, note: MISSED_OUT_NOTE } }
  }
  // The out belongs to the company of the in it closes (a legacy in with no
  // company: the active one). It is measured there when the device sent a fix.
  const tenantId = open.tenantId ?? actor.tenantId
  const emps = await prisma.hrEmployee.findMany({ where: { userId: actor.id, status: { in: ['active', 'on_leave'] } } })
  const empThere = tenantId ? emps.find((e) => e.tenantId === tenantId) ?? null : null
  const verdict = tenantId ? await enforceClockInPolicy(tenantId, actor.role, body, { employeeId: empThere?.id ?? null, kind: 'out' }) : null
  const log = await prisma.clockLog.create({
    data: {
      userId: actor.id, type: 'out', lat: body.lat ?? null, lng: body.lng ?? null, selfieUrl: body.selfieUrl ?? null, ipAddress: ip ?? null,
      tenantId: tenantId ?? null, ...verdictCols(verdict),
    },
  })
  // Close the open day wherever it is: the in's company first, then any other
  // company this login is an employee in (they clocked in there).
  emps.sort((a, b) => Number(b.tenantId === tenantId) - Number(a.tenantId === tenantId))
  let att: PunchResult | null = null
  for (const e of emps) {
    const measured = e.tenantId === tenantId ? verdict : null
    const r = await recordPunch({
      tenantId: e.tenantId, employeeId: e.id, kind: 'out', at: log.recordedAt, source: 'clock', actorUserId: actor.id, clockLogId: log.id,
      ...verdictCols(measured), outOfAreaReason: measured?.outOfAreaReason ?? null,
    })
    if (r.recordId) { att = r; break }
  }
  if (tenantId && verdict) await flagOutOfArea({ tenantId, employeeId: empThere?.id ?? null, userId: actor.id, name: empThere?.fullName ?? actor.name ?? null, kind: 'out', at: log.recordedAt, verdict })
  return { clockedOutAt: log.recordedAt, where: whereOut(verdict), attendance: attendanceOut(att) }
}

/**
 * This employee's day in this company, as the kiosk sees it:
 *   open    an in with no out that is still a shift — the next punch is the out;
 *   missed  an in with no out that isMissedClockOut() calls forgotten;
 *   none    nothing open — the next punch is the in.
 */
async function openDayState(tenantId: string, employeeId: string, now = new Date()): Promise<'open' | 'missed' | 'none'> {
  const today = pktToday(now)
  const k = attendanceKeys((await getFormat(tenantId, 'attendance')).fields)
  const rows = await prisma.hrRecord.findMany({
    where: { tenantId, section: 'attendance', employeeId, status: ATTENDANCE_DAY_TAKEN, startDate: { in: [today, new Date(today.getTime() - 86_400_000)] } },
  })
  const open = rows.filter((r) => {
    const d = r.data as Record<string, unknown>
    return ['clock', 'kiosk'].includes(String(d['_source'])) && !d[k.checkOut] && !d['_missedOut']
  })
  if (open.some((r) => !isMissedClockOut(lastInOf(r), now))) return 'open'
  return open.length ? 'missed' : 'none'
}

const KIOSK_MISSED_OUT = 'Your last clock-in was never clocked out, so this punch cannot close it — that day is flagged for HR to correct. If you are starting a shift now, punch again to clock in.'

/**
 * A kiosk punch by someone without a login: in if their day is not open, out
 * if it is. The kiosks send no action, so the server decides — and it never
 * turns a refused clock-out into a clock-in (audit HR-R2: the closer's 02:05
 * punch became an in, and every shift after that was booked as the hours
 * between shifts). When the open in is a forgotten clock-out, the punch is
 * taken as the out it most likely is: the day is closed as a missed punch for
 * HR and the person is told to punch again if they are starting a shift. Only
 * when nothing is open is the punch an in.
 */
export async function kioskPunch(device: Actor, body: PunchBody & { employeeCode: string; pin: string; action?: 'in' | 'out' }) {
  const tenantId = activeCompany(device)
  const emp = await verifyKioskPin(tenantId, body.employeeCode, body.pin)
  if (emp.userId) throw new AppError('HAS_LOGIN', 'You have a servd login — clock in with it instead of the kiosk PIN', 409)
  const kind = body.action ?? ((await openDayState(tenantId, emp.id)) === 'none' ? 'in' : 'out')
  // The tablet's GPS (lat/lng in the body) is measured against the
  // employee's own work locations, for an in and — when it sent a fix — an out.
  const verdict = await enforceClockInPolicy(tenantId, null, body, { employeeId: emp.id, kind })
  const at = new Date()
  const r = await recordPunch({
    tenantId, employeeId: emp.id, kind, at, source: 'kiosk', actorUserId: device.id,
    ...verdictCols(verdict), outOfAreaReason: verdict.outOfAreaReason, selfieUrl: body.selfieUrl ?? null,
  })
  if (kind === 'out' && r.skipped === 'no_open_day') throw new AppError('NOT_CLOCKED_IN', 'You are not clocked in today', 409)
  if (kind === 'out' && r.skipped === 'missed_out') throw new AppError('MISSED_CLOCK_OUT', KIOSK_MISSED_OUT, 409, { recordId: r.recordId })
  if (r.recordId) await flagOutOfArea({ tenantId, employeeId: emp.id, userId: null, name: emp.fullName, kind, at, verdict })
  return { employee: { id: emp.id, fullName: emp.fullName, employeeCode: emp.employeeCode }, action: kind, at, attendance: attendanceOut(r), location: verdict.locationName ?? null, where: whereOut(verdict) }
}

// ─── The punch report ────────────────────────────────────────────────────────

export interface PunchRow {
  key: string
  name: string
  employeeId: string | null
  employeeCode: string | null
  userId: string | null
  role: string | null
  punches: Array<PunchEntry & { lat?: number | null; lng?: number | null }>
  attendance: { id: string; status: string | null; lateMinutes: number | null; checkIn: unknown; checkOut: unknown; source: unknown } | null
}

/**
 * Every punch on a Karachi calendar day in these companies, one row per
 * person, with the attendance record it produced beside it. Login punches
 * come from ClockLog (selfie and geofence verdict included); kiosk punches
 * from the attendance record. A login's punch belongs to the company stamped
 * on it (ClockLog.tenantId); a legacy row with no company falls back to the
 * people who belong to the company.
 */
export async function punchReport(tenantIds: string[], day: string): Promise<PunchRow[]> {
  const date = new Date(`${day}T00:00:00.000Z`)
  const from = new Date(date.getTime() - 5 * 3_600_000)
  const to = new Date(from.getTime() + 86_400_000 - 1)
  const [logs, records] = await Promise.all([
    prisma.clockLog.findMany({
      where: {
        recordedAt: { gte: from, lte: to },
        OR: [
          { tenantId: { in: tenantIds } },
          // Legacy punches from before ClockLog had a company — only when the column is empty.
          { tenantId: null, user: { OR: [{ tenantId: { in: tenantIds } }, { tenantMemberships: { some: { tenantId: { in: tenantIds } } } }] } },
        ],
      },
      include: { user: { select: { id: true, name: true, role: true } } },
      orderBy: { recordedAt: 'asc' },
    }),
    prisma.hrRecord.findMany({
      where: { tenantId: { in: tenantIds }, section: 'attendance', status: STANDING_ATTENDANCE, startDate: date },
      include: { employee: { select: { id: true, fullName: true, employeeCode: true, userId: true } } },
      orderBy: { createdAt: 'asc' },
    }),
  ])
  const keysByTenant = new Map<string, ReturnType<typeof attendanceKeys>>()
  for (const t of new Set(records.map((r) => r.tenantId))) keysByTenant.set(t, attendanceKeys((await getFormat(t, 'attendance')).fields))
  const rows = new Map<string, PunchRow>()
  const userToKey = new Map<string, string>()
  for (const r of records) {
    if (!r.employee) continue
    const k = keysByTenant.get(r.tenantId)!
    const d = r.data as Record<string, unknown>
    const key = `e:${r.employee.id}`
    if (r.employee.userId) userToKey.set(r.employee.userId, key)
    rows.set(key, {
      key, name: r.employee.fullName, employeeId: r.employee.id, employeeCode: r.employee.employeeCode, userId: r.employee.userId, role: null,
      // Kiosk punches live only here; login punches are listed from ClockLog.
      punches: ((d['_punches'] as PunchEntry[] | undefined) ?? []).filter((p) => p.source === 'kiosk'),
      attendance: { id: r.id, status: r.category, lateMinutes: r.quantity, checkIn: d[k.checkIn] ?? null, checkOut: d[k.checkOut] ?? null, source: d['_source'] ?? 'hr' },
    })
  }
  for (const l of logs) {
    const key = userToKey.get(l.userId) ?? `u:${l.userId}`
    const row = rows.get(key) ?? { key, name: l.user.name, employeeId: null, employeeCode: null, userId: l.userId, role: l.user.role, punches: [], attendance: null }
    row.role = l.user.role
    row.punches.push({
      type: l.type === 'out' ? 'out' : 'in', at: l.recordedAt.toISOString(), source: 'clock', clockLogId: l.id,
      geofenceMatched: l.geofenceMatched, geofenceDistanceM: l.geofenceDistanceM, selfieUrl: l.selfieUrl, lat: l.lat, lng: l.lng,
      locationId: l.locationId, outOfArea: l.outOfArea,
    })
    rows.set(key, row)
  }
  for (const r of rows.values()) r.punches.sort((a, b) => a.at.localeCompare(b.at))
  return Array.from(rows.values()).sort((a, b) => a.name.localeCompare(b.name))
}

/** Pair a row's punches into in → out spans. */
export function spans(punches: Array<{ type: 'in' | 'out'; at: string; geofenceMatched?: boolean | null; selfieUrl?: string | null }>) {
  const out: Array<{ inAt: string; outAt: string | null; geofenceOk: boolean; selfieUrl: string | null }> = []
  for (const p of punches) {
    if (p.type === 'in') out.push({ inAt: p.at, outAt: null, geofenceOk: p.geofenceMatched !== false, selfieUrl: p.selfieUrl ?? null })
    else {
      const open = [...out].reverse().find((s) => !s.outAt)
      if (open) open.outAt = p.at
    }
  }
  return out
}
