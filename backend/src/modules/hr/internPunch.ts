// An intern's own check-in / check-out records their attendance (owner, 2026-11-27: "Intern attendance not being
// recorded by checking in" — REPLACES "interns do not clock in"). Called by the ONE time clock (timeclock/service.ts)
// for a login linked to an intern (`Intern.userId`) of the punch's company — never a second clock.
//   in  → the Karachi day's row is created `present` with the check-in time, source 'clock';
//   out → the check-out time goes on the row of the day the in was made.
// What HR or the supervisor marked always wins: a row they wrote keeps its status and its times (only an EMPTY time is
// filled in). Skipped, never an error for the person punching: an intern not active, a day outside the internship, a
// month whose stipend payroll has left draft (locked). HR and the supervisor still mark / correct any day as before.
import { prisma } from '../../lib/prisma.js'
import { pktHHMM, minutesLate } from './attendance.js'
import { getSettings } from './service.js'
import { ENROLLED, withinInternship } from './internAccess.js'
import { attendanceLocked } from './internPayroll.js'

/**
 * LATE (owner, 2026-11-27: "Mark interns late if they check in after their working hours"). The intern's start time is
 * the FIRST time written in their "Working hours" ("9:00 – 17:00", "9am to 5pm", "10.30-6"); none written → the
 * company default rota's start (HR → Settings), none there → never late. A check-in more than the company's late
 * grace minutes (HR settings, the staff rule) after it is `late`, else `present`. A label only: the stipend never
 * docks a late day.
 */
export function startTimeOf(workingHours: string | null | undefined): string | null {
  const m = /(\d{1,2})(?:\s*[:.]\s*(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?/i.exec(workingHours ?? '')
  if (!m) return null
  let h = Number(m[1])
  const min = Number(m[2] ?? 0)
  const ap = (m[3] ?? '').toLowerCase().replace(/\./g, '')
  if (ap === 'pm' && h < 12) h += 12
  if (ap === 'am' && h === 12) h = 0
  if (h > 23 || min > 59) return null
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

type LateRule = { defaultStart: string | null; grace: number }
async function lateRuleOf(tenantId: string): Promise<LateRule> {
  const s = await getSettings(tenantId)
  return { defaultStart: s.defaultRota?.start ?? null, grace: s.lateGraceMinutes }
}
function statusOfCheckIn(workingHours: string | null, checkIn: string, rule: LateRule): 'present' | 'late' {
  const start = startTimeOf(workingHours) ?? rule.defaultStart
  if (!start) return 'present'
  const late = minutesLate(checkIn, start)
  return late != null && late > rule.grace ? 'late' : 'present'
}

const pktDay = (at: Date) => { const k = new Date(at.getTime() + 5 * 3_600_000); return new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate())) }

/** The active intern this login is, in that company (null = not an intern there). */
export const internOfLogin = (userId: string, tenantId: string) =>
  prisma.intern.findFirst({ where: { userId, tenantId, status: 'active' } })

export async function recordInternPunch(input: { userId: string; tenantId: string; kind: 'in' | 'out'; at: Date; inAt?: Date | null }): Promise<{ recorded: boolean; status?: string; skipped?: string }> {
  const intern = await internOfLogin(input.userId, input.tenantId)
  if (!intern) return { recorded: false, skipped: 'NOT_AN_INTERN' }
  // An out closes the day its in opened (a shift past midnight stays on the in's day).
  const day = pktDay(input.kind === 'out' && input.inAt ? input.inAt : input.at)
  if (!withinInternship(intern, day)) return { recorded: false, skipped: 'OUTSIDE_INTERNSHIP' }
  if (await attendanceLocked(prisma, intern, day)) return { recorded: false, skipped: 'IN_PAYROLL' }
  const hhmm = pktHHMM(input.at)
  const rule = await lateRuleOf(intern.tenantId)
  const key = { internId_date: { internId: intern.id, date: day } }
  const row = await prisma.internAttendance.findUnique({ where: key })
  if (!row) {
    // An out with no row (the in was skipped, or HR removed nothing — there is no delete): the day is still present.
    const made = await prisma.internAttendance.upsert({
      where: key,
      create: { tenantId: intern.tenantId, internId: intern.id, date: day, status: input.kind === 'in' ? statusOfCheckIn(intern.workingHours, hhmm, rule) : 'present', source: 'clock', markedById: input.userId, ...(input.kind === 'in' ? { checkIn: hhmm } : { checkOut: hhmm }) },
      update: {},
    })
    return { recorded: true, status: made.status }
  }
  const mine = row.source === 'clock'
  const data = input.kind === 'in'
    // the day's FIRST in is the check-in time; on a day the clock wrote it also decides present / late
    ? (row.checkIn ? {} : { checkIn: hhmm, ...(mine && { status: statusOfCheckIn(intern.workingHours, hhmm, rule) }) })
    : (mine || !row.checkOut ? { checkOut: hhmm } : {}) // the latest out, unless HR typed one
  if (Object.keys(data).length) await prisma.internAttendance.update({ where: { id: row.id }, data })
  return { recorded: true, status: (data as { status?: string }).status ?? row.status }
}

/**
 * Back-fill (owner, 2026-11-27: "Back-fill missed days for interns automatically"): every past check-in an intern's
 * login made on the time clock (`clock_logs`, the punch's company — a legacy punch with no company counts for the
 * intern's) that has NO attendance row becomes one — present, the day's first check-in and last check-out, source
 * 'clock'. Runs at every API boot, per company, and only ever ADDS a missing day: a day HR, the supervisor or an
 * earlier run wrote is never touched; days outside the internship and months whose stipend payroll has left draft are
 * skipped. A day with no check-in stays unmarked (HR marks it). Present / late follows the late rule above — and a
 * day the CLOCK wrote earlier (never HR's) is re-read against it, so days recorded before the rule are labelled too.
 */
export async function backfillInternPunches(): Promise<Array<{ tenantId: string; interns: number; days: number }>> {
  const out: Array<{ tenantId: string; interns: number; days: number }> = []
  const interns = await prisma.intern.findMany({ where: { userId: { not: null }, status: { in: ENROLLED } } })
  const byTenant = new Map<string, typeof interns>()
  for (const i of interns) byTenant.set(i.tenantId, [...(byTenant.get(i.tenantId) ?? []), i])
  for (const [tenantId, list] of byTenant) {
    let touched = 0, days = 0
    const rule = await lateRuleOf(tenantId)
    for (const intern of list) {
      const logs = await prisma.clockLog.findMany({
        where: { userId: intern.userId!, OR: [{ tenantId }, { tenantId: null }], recordedAt: { gte: intern.startDate } },
        orderBy: { recordedAt: 'asc' }, select: { type: true, recordedAt: true },
      })
      // One entry per Karachi day that has a check-in: its first in, and the last out that closed an in of that day.
      const perDay = new Map<number, { day: Date; checkIn: string; checkOut: string | null }>()
      let open: number | null = null
      for (const l of logs) {
        if (l.type === 'in') {
          const day = pktDay(l.recordedAt)
          open = day.getTime()
          if (!perDay.has(open)) perDay.set(open, { day, checkIn: pktHHMM(l.recordedAt), checkOut: null })
        } else if (open !== null) {
          perDay.get(open)!.checkOut = pktHHMM(l.recordedAt)
          open = null
        }
      }
      // Days the clock wrote before: present ↔ late by today's rule (unlocked months only).
      const clockRows = await prisma.internAttendance.findMany({ where: { internId: intern.id, source: 'clock', status: { in: ['present', 'late'] }, checkIn: { not: null } } })
      const lockedMonth = new Map<string, boolean>()
      for (const r of clockRows) {
        const want = statusOfCheckIn(intern.workingHours, r.checkIn!, rule)
        if (want === r.status) continue
        const month = r.date.toISOString().slice(0, 7)
        if (!lockedMonth.has(month)) lockedMonth.set(month, await attendanceLocked(prisma, intern, r.date))
        if (lockedMonth.get(month)) continue
        await prisma.internAttendance.update({ where: { id: r.id }, data: { status: want } })
      }
      if (perDay.size === 0) continue
      const have = new Set((await prisma.internAttendance.findMany({ where: { internId: intern.id }, select: { date: true } })).map((r) => r.date.getTime()))
      const locked = new Map<string, boolean>()
      const rows = []
      for (const d of perDay.values()) {
        if (have.has(d.day.getTime()) || !withinInternship(intern, d.day)) continue
        const month = d.day.toISOString().slice(0, 7)
        if (!locked.has(month)) locked.set(month, await attendanceLocked(prisma, intern, d.day))
        if (locked.get(month)) continue
        rows.push({ tenantId, internId: intern.id, date: d.day, status: statusOfCheckIn(intern.workingHours, d.checkIn, rule), checkIn: d.checkIn, checkOut: d.checkOut, source: 'clock', note: 'From the time clock (back-filled)', markedById: intern.userId })
      }
      if (rows.length) {
        const r = await prisma.internAttendance.createMany({ data: rows, skipDuplicates: true })
        if (r.count) { touched += 1; days += r.count }
      }
    }
    if (days) out.push({ tenantId, interns: touched, days })
  }
  return out
}
