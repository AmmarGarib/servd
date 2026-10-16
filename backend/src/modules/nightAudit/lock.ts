// The night audit's day lock — SALES postings only (owner, 2026-10-16: "Night
// run/Audit/Day close is only for sales module, it does not apply on all
// other modules"). Contract: ./README.md §4.1.
//
// SALES_SOURCES + SALES_SOURCE_PREFIXES are the ONE definition of "a sales
// posting" (orders / tickets, their payments and tenders, voids, cancels,
// refunds, till shifts and the deposit of till cash). postJournalEntry
// (accounting/journal.ts) refuses a sales posting dated into a day the night
// audit locked (audited or closed) with 422 DAY_AUDITED; every other source —
// supplier bills, petty cash, payroll, manual journals, depreciation,
// inter-company, gift-card sales, card payouts, bank adjustments — never reads
// the table. The month-end period lock is separate and unchanged.
//
// Explicitly NOT sales (pinned by tests/nightAuditLock.test.ts):
// card.settlement, reconciliation.adjustment, pettycash.till_topup,
// ledger.till_clearing_split, ic.*, giftcard.*, supplier.*, pettycash.*,
// hr.*, fixed_asset.*, manual. Reservation deposits (reservation,
// reservation.deposit_capture) are outside too (owner question Q6).

import type { Prisma, PrismaClient } from '@prisma/client'
import { AppError } from '../../lib/errors.js'
import { fmtPktDate } from '../accounting/dates.js'

type Db = Prisma.TransactionClient | PrismaClient

/** Exact sales source types. */
export const SALES_SOURCES: ReadonlySet<string> = new Set([
  'order',                    // orders/returnedFood.ts
  'shift.close',
  'deposit.drop',             // till cash to the bank
  'raast.unreceived',         // Raast sale money written off
  'cod.rider_debt', 'cod.rider_debt.reversal',
  'loyalty.earn', 'loyalty.redeem', // booked with the order
])

/** Sales source-type prefixes. */
export const SALES_SOURCE_PREFIXES: readonly string[] = [
  'order.',      // order.complete, order.refund, order.refund_wallet, order.refund_giftcard,
                 // order.cancel_unwind, order.cogs_late, order.cancel_settle, order.legacy_return
  'order_item.', // order_item.return, order_item.box_given, order_item.box_given_undo
  'pos.',        // pos.card_failed, pos.payout, pos.void_waste
]

/** Is a posting of this source type part of the SALES module (the night audit's scope)? */
export function isSalesSource(sourceType: string | null | undefined): boolean {
  if (!sourceType) return false
  if (SALES_SOURCES.has(sourceType)) return true
  return SALES_SOURCE_PREFIXES.some((p) => sourceType.startsWith(p))
}

/** LIKE-escape (backslash is Postgres' default escape). */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

/**
 * The LIKE patterns of `journal_entries.reference` ('<sourceType>:<sourceId>')
 * that a sales posting carries. Use with `reference LIKE ANY(${patterns})`.
 */
export function salesReferenceSqlPatterns(): string[] {
  return [
    ...[...SALES_SOURCES].map((s) => `${likeEscape(s)}:%`),
    ...SALES_SOURCE_PREFIXES.map((p) => `${likeEscape(p)}%`),
  ]
}

export type LockedDayStatus = 'audited' | 'closed'

/** The night-audit lock on the PKT day of `at` in `tenantId`'s books, or null when the day is open. */
export async function dayLockOf(db: Db, tenantId: string, at: Date): Promise<{ day: string; status: LockedDayStatus } | null> {
  const day = fmtPktDate(at)
  const row = await db.nightAuditDay.findUnique({
    where: { tenantId_businessDate: { tenantId, businessDate: day } },
    select: { status: true },
  })
  if (!row || row.status === 'open') return null
  return { day, status: row.status }
}

/** The note a sales posting moved out of a locked day carries (withLateNote). */
export function salesDayLateNote(day: string): string {
  return `dated ${day}, posted late (the night audit locked that sales day)`
}

/**
 * The date a SALES posting whose natural date is `natural` takes: its own
 * while that sales day is open, else NOW with the night-audit note (a retry
 * of a refund refused on a day that has since been audited posts today
 * instead of being refused forever). Today is never locked.
 */
export async function salesPostingDate(db: Db, tenantId: string, natural: Date): Promise<{ entryDate: Date; memoNote?: string }> {
  const lock = await dayLockOf(db, tenantId, natural)
  return lock ? { entryDate: new Date(), memoNote: salesDayLateNote(lock.day) } : { entryDate: natural }
}

/**
 * postJournalEntry's day guard: a SALES posting dated into an audited or
 * closed day is refused (422 DAY_AUDITED { day, status }). A non-sales source
 * returns at once without reading anything.
 */
export async function assertSalesDayOpenTx(db: Db, tenantId: string, at: Date, sourceType: string): Promise<void> {
  if (!isSalesSource(sourceType)) return
  const lock = await dayLockOf(db, tenantId, at)
  if (!lock) return
  throw new AppError(
    'DAY_AUDITED',
    `Cannot post a sale into ${lock.day} — the night audit locked that sales day. It posts today, or the CEO reopens the day.`,
    422,
    { day: lock.day, status: lock.status },
  )
}
