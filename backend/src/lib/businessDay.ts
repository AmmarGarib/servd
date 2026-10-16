// The business day of a till shift (owner, 2026-10-16, late shift: "A shift
// closing before 5:00 am books to the business day it opened on, for the night
// audit, the tax return and month end").
//
// THE one rule. A shift's business day is the later of
//   • the Karachi day it opened on, and
//   • the Karachi day of its close less the cut-off (05:00 PKT),
// so a dinner till opened on 31 Oct and closed at 00:40 on 1 Nov is 31 Oct; a
// till closed at 06:00 the next day (after the cut-off) stays on its close day
// as before. Readers:
//   • the shift-close posting's entryDate (accounting/shiftPosting.ts) — and
//     through it the P&L, the sales-tax return and the month close, which read
//     the ledger by entryDate, and the night audit's day lock (dayLockOf);
//   • the night audit's shift checks (nightAudit/checks.ts), its daily report
//     and its activity days, and sales_bank_unmatched (reconciliation/service.ts);
//   • the close checklist's unposted shifts and a refused shift posting's
//     document date (accounting/closeChecks.ts).
// Orders, payments and every other document keep their own Karachi calendar
// dates — only a till shift spans the night.

import type { Prisma, PrismaClient } from '@prisma/client'
import { fmtPktDate, parsePktEndOfDay } from '../modules/accounting/dates.js'
import { shiftOfCompany } from './tenantScope.js'

/** The business-day cut-off, hours after midnight Karachi time. */
export const BUSINESS_DAY_CUTOFF_HOURS = 5
const CUTOFF_MS = BUSINESS_DAY_CUTOFF_HOURS * 3_600_000

/** The Karachi business day 'YYYY-MM-DD' of a closed shift (null while it is open). */
export function shiftBusinessDay(shift: { openedAt: Date; closedAt: Date | null }): string | null {
  if (!shift.closedAt) return null
  const opened = fmtPktDate(shift.openedAt)
  const closedDay = fmtPktDate(shift.closedAt)
  const closedLessCutoff = fmtPktDate(new Date(shift.closedAt.getTime() - CUTOFF_MS))
  const day = closedLessCutoff > opened ? closedLessCutoff : opened
  // Never after the close's own day (a row closed before it opened is bad data: its close day).
  return day > closedDay ? closedDay : day
}

/**
 * The instant a closed shift is dated by in the books: its close when that is
 * on its business day, else the last moment (23:59:59.999 PKT) of the business
 * day it opened on. Null while the shift is open.
 */
export function shiftBusinessDate(shift: { openedAt: Date; closedAt: Date | null }): Date | null {
  const day = shiftBusinessDay(shift)
  if (!day || !shift.closedAt) return null
  return day === fmtPktDate(shift.closedAt) ? shift.closedAt : parsePktEndOfDay(day)
}

/**
 * The closedAt range that holds every shift whose business date may fall in
 * [from, to] (a close up to the cut-off after `to` can still belong to it).
 * Filter the rows with `inBusinessWindow` afterwards.
 */
export function shiftCloseCandidateRange(from: Date, to: Date): { gte: Date; lte: Date } {
  return { gte: from, lte: new Date(to.getTime() + CUTOFF_MS) }
}

/** Is the closed shift's business date inside [from, to]? */
export function inBusinessWindow(shift: { openedAt: Date; closedAt: Date | null }, from: Date | null, to: Date): boolean {
  const d = shiftBusinessDate(shift)
  if (!d) return false
  return d.getTime() <= to.getTime() && (from === null || d.getTime() >= from.getTime())
}

/**
 * The company's closed shifts whose BUSINESS date is in [from, to] — the one
 * query behind the night audit's shift checks, its daily report and
 * sales_bank_unmatched.
 */
export async function closedShiftsOfBusinessDays(
  db: Prisma.TransactionClient | PrismaClient, tenantId: string, from: Date, to: Date,
): Promise<Array<{ id: string; openedAt: Date; closedAt: Date | null }>> {
  const rows = await db.shift.findMany({
    where: { status: 'closed', closedAt: shiftCloseCandidateRange(from, to), ...shiftOfCompany({ tenantId: { in: [tenantId] } }) },
    select: { id: true, openedAt: true, closedAt: true },
    orderBy: { openedAt: 'asc' },
  })
  return rows.filter((s) => inBusinessWindow(s, from, to))
}
