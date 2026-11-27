// An intern's own check-in / check-out records their attendance (owner, 2026-11-27: "Intern attendance not being
// recorded by checking in" — REPLACES "interns do not clock in"). Called by the ONE time clock (timeclock/service.ts)
// for a login linked to an intern (`Intern.userId`) of the punch's company — never a second clock.
//   in  → the Karachi day's row is created `present` with the check-in time, source 'clock';
//   out → the check-out time goes on the row of the day the in was made.
// What HR or the supervisor marked always wins: a row they wrote keeps its status and its times (only an EMPTY time is
// filled in). Skipped, never an error for the person punching: an intern not active, a day outside the internship, a
// month whose stipend payroll has left draft (locked). HR and the supervisor still mark / correct any day as before.
import { prisma } from '../../lib/prisma.js'
import { pktHHMM } from './attendance.js'
import { withinInternship } from './internAccess.js'
import { attendanceLocked } from './internPayroll.js'

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
  const key = { internId_date: { internId: intern.id, date: day } }
  const row = await prisma.internAttendance.findUnique({ where: key })
  if (!row) {
    // An out with no row (the in was skipped, or HR removed nothing — there is no delete): the day is still present.
    const made = await prisma.internAttendance.upsert({
      where: key,
      create: { tenantId: intern.tenantId, internId: intern.id, date: day, status: 'present', source: 'clock', markedById: input.userId, ...(input.kind === 'in' ? { checkIn: hhmm } : { checkOut: hhmm }) },
      update: {},
    })
    return { recorded: true, status: made.status }
  }
  const mine = row.source === 'clock'
  const data = input.kind === 'in'
    ? (row.checkIn ? {} : { checkIn: hhmm })          // the day's FIRST in is the check-in time
    : (mine || !row.checkOut ? { checkOut: hhmm } : {}) // the latest out, unless HR typed one
  if (Object.keys(data).length) await prisma.internAttendance.update({ where: { id: row.id }, data })
  return { recorded: true, status: row.status }
}
