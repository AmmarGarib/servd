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
// and PIN (hr/kioskPin.ts). Their punch goes straight to attendance: ClockLog
// requires a login until it gets employeeId/tenantId columns (see the report).

import { serviceClient as prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { recordPunch, attendanceKeys, type PunchEntry, type PunchResult } from '../hr/attendance.js'
import { verifyKioskPin } from '../hr/kioskPin.js'
import { getFormat, STANDING_ATTENDANCE } from '../hr/service.js'
import { pktToday } from '../hr/logic.js'
import { enforceClockInPolicy } from './policy.js'

export interface Actor { id: string; role: string; tenantId: string | null; name?: string | null }
export interface PunchBody { lat?: number; lng?: number; selfieUrl?: string }

function activeCompany(actor: Actor): string {
  if (!actor.tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company first — a punch belongs to one company', 422)
  return actor.tenantId
}

const attendanceOut = (r: PunchResult | null) => r && r.recordId ? { recordId: r.recordId, status: r.status, lateMinutes: r.lateMinutes, ...(r.skipped && { note: r.skipped }) } : null

export async function clockIn(actor: Actor, body: PunchBody, ip?: string) {
  const tenantId = activeCompany(actor)
  // Already clocked in? Return the open punch rather than stacking a second
  // 'in', which would leave an unpaired record and skew the hours pairing.
  const last = await prisma.clockLog.findFirst({ where: { userId: actor.id }, orderBy: { recordedAt: 'desc' }, select: { type: true, recordedAt: true } })
  if (last?.type === 'in') return { alreadyClockedIn: true, since: last.recordedAt }

  const verdict = await enforceClockInPolicy(tenantId, actor.role, body)
  const log = await prisma.clockLog.create({
    data: {
      userId: actor.id, type: 'in', lat: body.lat ?? null, lng: body.lng ?? null, selfieUrl: body.selfieUrl ?? null,
      geofenceMatched: verdict.geofenceMatched, geofenceDistanceM: verdict.geofenceDistanceM, ipAddress: ip ?? null,
    },
  })
  const emp = await prisma.hrEmployee.findFirst({ where: { userId: actor.id, tenantId } })
  const att = emp
    ? await recordPunch({
        tenantId, employeeId: emp.id, kind: 'in', at: log.recordedAt, source: 'clock', actorUserId: actor.id, clockLogId: log.id,
        geofenceMatched: verdict.geofenceMatched, geofenceDistanceM: verdict.geofenceDistanceM, locationId: verdict.locationId, selfieUrl: body.selfieUrl ?? null,
      })
    : null
  return {
    clockedInAt: log.recordedAt, geofenceMatched: verdict.geofenceMatched, geofenceDistanceM: verdict.geofenceDistanceM,
    location: verdict.locationName, hrLinked: !!emp, attendance: attendanceOut(att),
  }
}

export async function clockOut(actor: Actor, body: PunchBody = {}, ip?: string) {
  const last = await prisma.clockLog.findFirst({ where: { userId: actor.id }, orderBy: { recordedAt: 'desc' }, select: { type: true } })
  if (last?.type !== 'in') return { notClockedIn: true }
  const log = await prisma.clockLog.create({
    data: { userId: actor.id, type: 'out', lat: body.lat ?? null, lng: body.lng ?? null, selfieUrl: body.selfieUrl ?? null, ipAddress: ip ?? null },
  })
  // Close the open day wherever it is: the active company's record first, then
  // any other company this login is an employee in (they clocked in there).
  const emps = await prisma.hrEmployee.findMany({ where: { userId: actor.id, status: { in: ['active', 'on_leave'] } } })
  emps.sort((a, b) => Number(b.tenantId === actor.tenantId) - Number(a.tenantId === actor.tenantId))
  let att: PunchResult | null = null
  for (const e of emps) {
    const r = await recordPunch({ tenantId: e.tenantId, employeeId: e.id, kind: 'out', at: log.recordedAt, source: 'clock', actorUserId: actor.id, clockLogId: log.id })
    if (r.recordId) { att = r; break }
  }
  return { clockedOutAt: log.recordedAt, attendance: attendanceOut(att) }
}

/** Is this employee's day open (in, no out) in this company? */
async function dayIsOpen(tenantId: string, employeeId: string): Promise<boolean> {
  const today = pktToday()
  const k = attendanceKeys((await getFormat(tenantId, 'attendance')).fields)
  const rows = await prisma.hrRecord.findMany({
    where: { tenantId, section: 'attendance', employeeId, status: STANDING_ATTENDANCE, startDate: { in: [today, new Date(today.getTime() - 86_400_000)] } },
  })
  return rows.some((r) => {
    const d = r.data as Record<string, unknown>
    return ['clock', 'kiosk'].includes(String(d['_source'])) && !d[k.checkOut]
  })
}

/** A kiosk punch by someone without a login: in if their day is not open, out if it is. */
export async function kioskPunch(device: Actor, body: PunchBody & { employeeCode: string; pin: string; action?: 'in' | 'out' }) {
  const tenantId = activeCompany(device)
  const emp = await verifyKioskPin(tenantId, body.employeeCode, body.pin)
  if (emp.userId) throw new AppError('HAS_LOGIN', 'You have a servd login — clock in with it instead of the kiosk PIN', 409)
  const kind = body.action ?? ((await dayIsOpen(tenantId, emp.id)) ? 'out' : 'in')
  const verdict = kind === 'in' ? await enforceClockInPolicy(tenantId, null, body) : null
  const r = await recordPunch({
    tenantId, employeeId: emp.id, kind, source: 'kiosk', actorUserId: device.id,
    geofenceMatched: verdict?.geofenceMatched ?? null, geofenceDistanceM: verdict?.geofenceDistanceM ?? null,
    locationId: verdict?.locationId ?? null, selfieUrl: body.selfieUrl ?? null,
  })
  if (kind === 'out' && r.skipped === 'no_open_day') throw new AppError('NOT_CLOCKED_IN', 'You are not clocked in today', 409)
  return { employee: { id: emp.id, fullName: emp.fullName, employeeCode: emp.employeeCode }, action: kind, at: new Date(), attendance: attendanceOut(r), location: verdict?.locationName ?? null }
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
 * from the attendance record. ClockLog has no company yet, so a login's
 * punches are those of people who belong to the company.
 */
export async function punchReport(tenantIds: string[], day: string): Promise<PunchRow[]> {
  const date = new Date(`${day}T00:00:00.000Z`)
  const from = new Date(date.getTime() - 5 * 3_600_000)
  const to = new Date(from.getTime() + 86_400_000 - 1)
  const [logs, records] = await Promise.all([
    prisma.clockLog.findMany({
      where: { recordedAt: { gte: from, lte: to }, user: { OR: [{ tenantId: { in: tenantIds } }, { tenantMemberships: { some: { tenantId: { in: tenantIds } } } }] } },
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
