// Cash vouchers still HELD on 1357 → one expense entry (owner, 2026-10-16).
//
// Owner (Ammar, CEO): "Don't post any entry in 1357 … only book one entry when
// confirmed by finance." Every voucher paid since the one-entry rule books its
// expense at pay (CashVoucher.bookedAtPay). Vouchers paid under the
// 2026-10-15 hold flow (expenseOnVerify true, bookedAtPay false) whose
// documents were not yet verified still sit on 1357 — their pay was
// Dr 1357 / Cr 1011 | 1010 | the bank. This converts each of them ONCE:
//
//   'cashvoucher.hold_convert:<voucherId>'
//     Dr <the voucher's expense account> (resolveSpendAccount of its category,
//        an explicit 6xxx allowed) / Cr 1357, the held amount, both lines
//        under the brand the live hold debited 1357 with (so 1357 nets per
//        brand); the hold must be live and equal the voucher's amount,
//   dated TODAY (a closed or night-locked day is never written into),
//   in the voucher's own company.
//
// In the same transaction the voucher becomes bookedAtPay = true and
// postedJournalEntryId = that entry, so finance's documents check afterwards
// books NOTHING (cashRequestSettle.ts markDocsChecked) and every reader treats
// it as a one-entry voucher. Change or an overspend is a manual journal, like
// any one-entry voucher. The entry is keyed per voucher and the claim is
// conditional on the voucher still being held, so a re-run (every boot, and
// finance's documents check) never books it twice.
//
// NOT converted — flagged for finance instead ('cash_voucher_hold_unconverted'
// in the voucher's company, CEO + finance hear it) and left held:
//   • its category is missing / unknown / a stock (cost-of-sales) category, or
//     its explicit account is not an expense account;
//   • its purpose looks like equipment (CapEx), or the holder recorded stock /
//     CapEx spend lines;
//   • its hold is not on the books (a box pay whose movement was never booked);
//   • the posting is refused (PERIOD_LOCKED, CEO_ONLY_CLOSED_BOOKS, an inactive
//     account …) — the whole transaction rolls back, never half-converted.
// Finance fixes the cause (e.g. sets the category) and the next boot or its
// documents check converts it; or corrects it by manual journal.

import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { flagException } from '../../lib/exceptions.js'
import { ACCT, postJournalEntry } from '../accounting/journal.js'
import { resolveSpendAccount } from '../accounting/expenseCategories.js'
import { CASH_VOUCHER_PAY_ENTRY, categoryRefOf } from '../accounting/pettyCashPosting.js'
import { liveRevision } from '../accounting/sourcePosting.js'
import { assertTemplateAccounts } from '../../lib/chartOfAccounts.js'
import { assertNotEquipmentLine } from '../fixedAssets/classes.js'

type Tx = Prisma.TransactionClient

/** The entry key prefix of a converted hold: 'cashvoucher.hold_convert:<voucherId>'. */
export const CASH_VOUCHER_HOLD_CONVERT_SOURCE = 'cashvoucher.hold_convert'
/** The flag kind raised when a held voucher cannot be converted. */
export const HOLD_UNCONVERTED_KIND = 'cash_voucher_hold_unconverted' as const

/** A voucher still held on 1357: paid under the hold flow, documents not yet verified. */
export const heldVoucherWhere = (tenantId: string): Prisma.CashVoucherWhereInput => ({
  tenantId, status: 'disbursed', expenseOnVerify: true, bookedAtPay: false, postedAt: null,
  OR: [{ pettyCashMovementId: { not: null } }, { payJournalEntryId: { not: null } }],
})

export type HoldConversion =
  | { outcome: 'converted'; entryId: string; accountCode: string; amountCents: number }
  | { outcome: 'not_held' }
  | { outcome: 'refused'; code: string; reason: string }

/** Why a held voucher cannot become one expense entry — before anything is written. Null = convertible. */
async function blockerOf(db: Tx | typeof prisma, v: {
  id: string; tenantId: string; number: string; purpose: string; category: string | null; amountCents: number
  pettyCashMovementId: string | null; payJournalEntryId: string | null
}): Promise<{ code: string; reason: string } | null> {
  let code: string
  try {
    code = (await resolveSpendAccount(db, v.tenantId, categoryRefOf(v.category), { allowExplicit: true })).code
  } catch (err) {
    const e = err as AppError
    return { code: e.code ?? 'CATEGORY_UNRESOLVED', reason: `its expense account cannot be resolved (${e.message})` }
  }
  try {
    assertNotEquipmentLine({ description: `${v.number}: ${v.purpose}`.slice(0, 200), expenseAccountCode: code, notEquipment: false }, { role: '' })
  } catch (err) {
    return { code: 'USE_CAPEX', reason: `it looks like equipment (${(err as Error).message})` }
  }
  const nonExpense = await db.pettyCashSpendLine.count({ where: { tenantId: v.tenantId, kind: { not: 'expense' }, settlement: { voucherId: v.id } } })
  if (nonExpense > 0) return { code: 'STOCK_OR_CAPEX_LINES', reason: 'the holder recorded stock or CapEx spend lines' }
  // The hold must be on the books, LIVE (never reversed), and hold exactly the
  // voucher's amount on 1357 — or Cr 1357 would have no (or a different) Dr
  // behind it and 1357 would not clear.
  const hold = await heldOnLedger(db, v)
  if ('code' in hold) return hold
  return null
}

/**
 * The live 1357 debit of the voucher's hold pay: its petty-cash movement's
 * 'pettycash.spend:<movementId>' (a lineless 1357 spend), else its
 * 'cashvoucher.pay:<voucherId>' (paid from cash on hand / a bank). The amount
 * and the brand the hold debited 1357 with — what the conversion credits back.
 */
async function heldOnLedger(db: Tx | typeof prisma, v: {
  id: string; tenantId: string; amountCents: number; pettyCashMovementId: string | null; payJournalEntryId: string | null
}): Promise<{ cents: number; conceptId: string | null } | { code: string; reason: string }> {
  let source: { type: string; id: string }
  if (v.pettyCashMovementId) {
    const m = await db.pettyCashMovement.findUnique({ where: { id: v.pettyCashMovementId }, select: { journalEntryId: true, accountCode: true } })
    if (!m?.journalEntryId || m.accountCode !== ACCT.VOUCHERS_AWAITING_DOCS) {
      return { code: 'HOLD_NOT_BOOKED', reason: 'its petty-cash pay is not on the books as a 1357 hold' }
    }
    source = { type: 'pettycash.spend', id: v.pettyCashMovementId }
  } else if (v.payJournalEntryId) {
    source = { type: CASH_VOUCHER_PAY_ENTRY, id: v.id }
  } else {
    return { code: 'HOLD_NOT_BOOKED', reason: 'its pay is not on the books' }
  }
  const { live } = await liveRevision(v.tenantId, source.type, source.id, db)
  const held = (live?.lines ?? []).filter((l) => l.accountCode === ACCT.VOUCHERS_AWAITING_DOCS)
  const net = held.reduce((t, l) => t + (l.type === 'debit' ? l.amountCents : -l.amountCents), 0)
  if (!live || held.length === 0) {
    return { code: 'HOLD_NOT_BOOKED', reason: 'its pay is not on the books as a live 1357 hold (missing or reversed)' }
  }
  if (net !== v.amountCents) {
    return { code: 'HOLD_AMOUNT_MISMATCH', reason: `its 1357 hold is PKR ${(net / 100).toFixed(2)}, not the voucher's PKR ${(v.amountCents / 100).toFixed(2)}` }
  }
  const brands = [...new Set(held.map((l) => l.conceptId ?? null))]
  if (brands.length !== 1) return { code: 'HOLD_SPLIT', reason: 'its 1357 hold is split across brands' }
  return { cents: net, conceptId: brands[0] ?? null }
}

/**
 * Convert held voucher `voucherId` (see the header). Never throws for a
 * voucher that cannot be converted: it is flagged (once while the flag is
 * open) and left held — outcome 'refused'.
 */
export async function convertHeldVoucher(voucherId: string, opts: { actorId?: string | null } = {}): Promise<HoldConversion> {
  const v = await prisma.cashVoucher.findUnique({
    where: { id: voucherId },
    select: {
      id: true, tenantId: true, number: true, purpose: true, payeeName: true, category: true, amountCents: true,
      status: true, expenseOnVerify: true, bookedAtPay: true, postedAt: true, pettyCashMovementId: true, payJournalEntryId: true,
    },
  })
  if (!v || v.status !== 'disbursed' || !v.expenseOnVerify || v.bookedAtPay || v.postedAt || (!v.pettyCashMovementId && !v.payJournalEntryId)) {
    return { outcome: 'not_held' }
  }
  const refuse = async (code: string, reason: string): Promise<HoldConversion> => {
    await flagUnconverted(v, code, reason, opts.actorId ?? null)
    return { outcome: 'refused', code, reason }
  }
  const blocker = await blockerOf(prisma, v)
  if (blocker) return refuse(blocker.code, blocker.reason)

  try {
    const done = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM cash_vouchers WHERE id = ${v.id} FOR UPDATE`
      // The claim: only a voucher still held converts, exactly once.
      const claimed = await tx.cashVoucher.updateMany({
        where: { id: v.id, tenantId: v.tenantId, status: 'disbursed', expenseOnVerify: true, bookedAtPay: false, postedAt: null },
        data: { bookedAtPay: true },
      })
      if (claimed.count === 0) return null
      // Re-read under the lock: finance may have changed the category since the pre-check.
      const cur = await tx.cashVoucher.findUniqueOrThrow({ where: { id: v.id }, select: { category: true, purpose: true, amountCents: true } })
      const live = { ...v, ...cur }
      const recheck = await blockerOf(tx, live)
      if (recheck) throw new AppError(recheck.code, recheck.reason, 409)
      const account = (await resolveSpendAccount(tx, v.tenantId, categoryRefOf(live.category), { allowExplicit: true })).code
      const hold = await heldOnLedger(tx, live)
      if ('code' in hold) throw new AppError(hold.code, hold.reason, 409)
      // Both lines under the brand the hold debited 1357 with, so 1357 nets per brand.
      const concept = hold.conceptId
      await assertTemplateAccounts(tx, v.tenantId, [account, ACCT.VOUCHERS_AWAITING_DOCS])
      const memo = `${v.number} paid to ${v.payeeName} — expense booked (no longer held awaiting documents)`.slice(0, 250)
      const posted = await postJournalEntry({
        tenantId: v.tenantId,
        sourceType: CASH_VOUCHER_HOLD_CONVERT_SOURCE,
        sourceId: v.id,
        description: `Cash voucher ${v.number} — expense booked: ${v.purpose}`.slice(0, 250),
        postedBy: opts.actorId ?? 'system',
        entryDate: new Date(),
        lines: [
          { accountCode: account, type: 'debit', amountCents: hold.cents, memo, conceptId: concept },
          { accountCode: ACCT.VOUCHERS_AWAITING_DOCS, type: 'credit', amountCents: hold.cents, memo, conceptId: concept },
        ],
      }, { tx })
      await tx.cashVoucher.update({ where: { id: v.id }, data: { postedJournalEntryId: posted.entryId } })
      return { entryId: posted.entryId, account }
    }, { timeout: 20_000, maxWait: 10_000 })
    if (!done) return { outcome: 'not_held' }
    await resolveUnconvertedFlags(v.id)
    return { outcome: 'converted', entryId: done.entryId, accountCode: done.account, amountCents: v.amountCents }
  } catch (err) {
    const e = err as AppError
    return refuse(e.code ?? 'POSTING_REFUSED', `the entry was refused (${(e.message ?? String(err)).slice(0, 300)})`)
  }
}

/** Every company's held vouchers, converted (boot). Per-company totals for the log. */
export async function convertHeldVouchers(tenantIds?: string[]): Promise<Array<{ tenantId: string; converted: number; refused: number }>> {
  const ids = tenantIds ?? (await prisma.tenant.findMany({ where: { deletedAt: null }, select: { id: true } })).map((t) => t.id)
  const out: Array<{ tenantId: string; converted: number; refused: number }> = []
  for (const tenantId of ids) {
    const held = await prisma.cashVoucher.findMany({ where: heldVoucherWhere(tenantId), select: { id: true }, orderBy: { disbursedAt: 'asc' } })
    let converted = 0
    let refused = 0
    for (const h of held) {
      const r = await convertHeldVoucher(h.id)
      if (r.outcome === 'converted') converted++
      else if (r.outcome === 'refused') refused++
    }
    if (held.length) out.push({ tenantId, converted, refused })
  }
  return out
}

async function flagUnconverted(
  v: { id: string; tenantId: string; number: string; amountCents: number },
  code: string, reason: string, actorId: string | null,
): Promise<void> {
  const open = await prisma.exceptionFlag.findFirst({
    where: { tenantId: v.tenantId, kind: HOLD_UNCONVERTED_KIND, entityType: 'CashVoucher', entityId: v.id, status: { in: ['open', 'acknowledged'] } },
    select: { id: true },
  })
  if (open) return
  await flagException({
    tenantId: v.tenantId,
    kind: HOLD_UNCONVERTED_KIND,
    severity: 'high',
    title: `Cash voucher ${v.number} is still held on 1357 — its expense is not booked`.slice(0, 200),
    description: `${v.number} (PKR ${(v.amountCents / 100).toFixed(2)}) was paid under the old hold flow and could not be booked as one expense entry: ${reason}. `
      + 'Fix the cause (for example pick its expense account in "Check the documents & book" on Finance → Cash vouchers, which books it) '
      + 'or correct it with a manual journal (Finance → Journal).',
    entityType: 'CashVoucher',
    entityId: v.id,
    actorId,
    amountCents: v.amountCents,
    metadata: { code, reason },
  })
}

async function resolveUnconvertedFlags(voucherId: string): Promise<void> {
  try {
    await prisma.exceptionFlag.updateMany({
      where: { kind: HOLD_UNCONVERTED_KIND, entityType: 'CashVoucher', entityId: voucherId, status: { in: ['open', 'acknowledged'] } },
      data: { status: 'resolved', resolvedAt: new Date(), resolution: 'Converted to one expense entry' },
    })
  } catch (err) {
    console.warn(`[cashVoucher] could not resolve the hold flag of ${voucherId}: ${(err as Error).message}`)
  }
}
