// Closed books are the CEO's (owner, 2026-10-16): "only CEO will be able to
// reopen the closed month or make/delete/cancel any journal entries, or make
// changes in closed books of accounts" — closed months only; open months work
// as before.
//
//   • A CLOSED month (PeriodLock.lockedThrough) refuses every posting dated in
//     it, the CEO's included (journal.ts PERIOD_LOCKED) — unchanged.
//   • Reopening is CEO-only (accounting/routes.ts period-close/reopen). The
//     reopened window — up to the lock that was lifted — is remembered here
//     (Setting `ledger.reopenedThrough:<tenantId>`) until the CEO closes
//     through it again. While it is open, only the CEO posts into it.
//   • Cancelling / reversing / deleting an entry DATED in a closed or reopened
//     month is the CEO's too (reverseJournalEntry), whatever day the reversal
//     itself is dated.
// Automatic postings ('system': backfills, workers) are not a person making a
// change and are not refused here — they keep their own rules.
//
// FINANCE IN A MONTH REOPENED AT ITS REQUEST (owner, 2026-11-24: "Build both"). When the CEO reopens a period by
// APPROVING finance's request (accounting/periodReopen.ts), the window is also marked open to finance (Setting
// `ledger.reopenedForFinance:<tenantId>`): a login of role `finance` holding `accounting` in that company posts,
// edits and cancels entries dated in the REOPENED window, as in an open month. Months still closed stay refused for
// everyone, and a window the CEO reopened directly stays the CEO's. The mark goes when the books are closed again.
import type { Prisma, PrismaClient } from '@prisma/client'
import { AppError } from '../../lib/errors.js'
import { fmtPktDate, pktToday } from './dates.js'

type Db = PrismaClient | Prisma.TransactionClient

export const reopenedThroughKey = (tenantId: string) => `ledger.reopenedThrough:${tenantId}`

/** The end of the month(s) the CEO reopened and has not closed again, or null. */
export async function reopenedThrough(db: Db, tenantId: string): Promise<Date | null> {
  const row = await db.setting.findUnique({ where: { key: reopenedThroughKey(tenantId) } })
  if (!row?.value) return null
  const d = new Date(row.value)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Remember a reopened window (the later of the stored one and `through`). */
export async function rememberReopened(db: Db, tenantId: string, through: Date): Promise<void> {
  // Never today or later: an old lock "through today" (the retired daily
  // close) must not take today's open trading away from finance.
  const endOfYesterday = new Date(pktToday().from.getTime() - 1)
  const capped = through > endOfYesterday ? endOfYesterday : through
  const cur = await reopenedThrough(db, tenantId)
  const value = (cur && cur > capped ? cur : capped).toISOString()
  await db.setting.upsert({ where: { key: reopenedThroughKey(tenantId) }, create: { key: reopenedThroughKey(tenantId), value }, update: { value } })
}

/** The CEO closed the books again through `lockedThrough`: forget what that covers. */
export async function forgetReopened(db: Db, tenantId: string, lockedThrough: Date): Promise<void> {
  const cur = await reopenedThrough(db, tenantId)
  if (cur && cur <= lockedThrough) await db.setting.deleteMany({ where: { key: { in: [reopenedThroughKey(tenantId), reopenedForFinanceKey(tenantId)] } } })
}

export const reopenedForFinanceKey = (tenantId: string) => `ledger.reopenedForFinance:${tenantId}`

/** Mark the reopened window open to finance (the CEO approved finance's request to reopen). */
export async function allowFinanceInReopened(db: Db, tenantId: string, requestId: string): Promise<void> {
  const key = reopenedForFinanceKey(tenantId)
  await db.setting.upsert({ where: { key }, create: { key, value: requestId }, update: { value: requestId } })
}

/** Is the reopened window of this company open to finance? */
export async function reopenedOpenToFinance(db: Db, tenantId: string): Promise<boolean> {
  if (!(await reopenedThrough(db, tenantId))) return false
  return !!(await db.setting.findUnique({ where: { key: reopenedForFinanceKey(tenantId) } }))?.value
}

/**
 * May this person work in the company's REOPENED window? The CEO and automatic postings always; a `finance` login of
 * the company holding `accounting`, only while the window was reopened at finance's request.
 */
export async function mayWorkReopened(db: Db, tenantId: string, actor: string | null | undefined): Promise<boolean> {
  if (!actor || actor === 'system') return true
  const u = await db.user.findUnique({ where: { id: actor }, select: { role: true, accountStatus: true, isActive: true, tenantId: true, moduleAllow: true, moduleDeny: true } })
  if (!u) return false
  if (u.role === 'admin') return true
  if (u.role !== 'finance' || u.accountStatus !== 'active' || !u.isActive) return false
  if (!(await reopenedOpenToFinance(db, tenantId))) return false
  if (u.tenantId !== tenantId && !(await db.tenantMember.findFirst({ where: { userId: actor, tenantId }, select: { tenantId: true } }))) return false
  const { effectiveModulesForUser } = await import('../../lib/moduleAccess.js')
  return (await effectiveModulesForUser(u)).has('accounting')
}

/**
 * The latest "closed books" date FOR THIS PERSON: the closed month(s), plus the reopened window unless they may work
 * in it (mayWorkReopened). Use it wherever a non-CEO is refused on closed books.
 */
export async function closedBooksThroughFor(db: Db, tenantId: string, actor: string | null | undefined): Promise<Date | null> {
  if (await mayWorkReopened(db, tenantId, actor)) {
    const lock = await db.periodLock.findFirst({ where: { tenantId }, orderBy: { lockedThrough: 'desc' }, select: { lockedThrough: true } })
    return lock?.lockedThrough ?? null
  }
  return closedBooksThrough(db, tenantId)
}

async function isCeo(db: Db, actor: string | null | undefined): Promise<'system' | boolean> {
  if (!actor || actor === 'system') return 'system'
  const u = await db.user.findUnique({ where: { id: actor }, select: { role: true } })
  return u?.role === 'admin'
}

/** The latest date that is closed or reopened (a "closed books" date), or null. */
export async function closedBooksThrough(db: Db, tenantId: string): Promise<Date | null> {
  const lock = await db.periodLock.findFirst({ where: { tenantId }, orderBy: { lockedThrough: 'desc' }, select: { lockedThrough: true } })
  const re = await reopenedThrough(db, tenantId)
  if (!lock) return re
  if (!re) return lock.lockedThrough
  return re > lock.lockedThrough ? re : lock.lockedThrough
}

/** A posting dated into a reopened month: the CEO's only. (A closed month is refused before this.) */
export async function assertMayPostIntoReopened(db: Db, tenantId: string, entryDate: Date, actor: string | null | undefined): Promise<void> {
  const re = await reopenedThrough(db, tenantId)
  if (!re || entryDate > re) return
  if (await mayWorkReopened(db, tenantId, actor)) return
  if ((await isCeo(db, actor)) === false) {
    throw new AppError('CEO_ONLY_CLOSED_BOOKS',
      `${fmtPktDate(entryDate)} is in a month the CEO reopened — only the CEO can post into it. Post it in the open month, or ask the CEO.`, 403)
  }
}

/** Cancelling / reversing an entry dated in a closed or reopened month: the CEO's only. */
export async function assertMayUndoEntry(db: Db, tenantId: string, originalDate: Date, actor: string | null | undefined): Promise<void> {
  const through = await closedBooksThroughFor(db, tenantId, actor)
  if (!through || originalDate > through) return
  if ((await isCeo(db, actor)) === false) {
    throw new AppError('CEO_ONLY_CLOSED_BOOKS',
      `This entry is dated ${fmtPktDate(originalDate)}, in closed books — only the CEO can cancel or reverse it.`, 403)
  }
}
