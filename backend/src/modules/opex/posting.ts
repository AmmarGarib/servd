// OpEx payment → the ledger (owner decision 23). The OpEx tracker keeps the
// budget, the cadence and the due dates; the LEDGER holds the actuals. When a
// payment is marked paid it posts:
//
//   Dr 6xxx  the category's expense account   (tagged with the line's brand)
//   Cr where the money came from — lib/bankAccounts.ts moneyAccountCode, the
//      one resolver: 1010 cash on hand for a cash payment; else the named bank
//      account's chart code (a live, linked bank of the CATEGORY's company),
//      or the company's only bank, or 1020 when it has none — and 422
//      BANK_ACCOUNT_REQUIRED when it has two or more and none is named.
//
// sourceType 'opex.payment', keyed on the payment id, kept in step through
// syncSourcePosting: a change to the amount, the paid date or either account
// reverses the live entry and reposts; un-marking it paid reverses it; a save
// that changes none of those (a note, a reference, a receipt) does nothing.
// It runs inside the payment's own transaction, so a closed month (PERIOD_
// LOCKED) or any other refusal saves nothing.
//
// Which expense account, in order:
//   1. the code named on THIS payment (an explicit correction);
//   2. what this payment already posted to — so changing a category's account
//      only moves NEW payments, never re-books old ones on an unrelated edit;
//   3. the category's own account (OpexCategory.expenseAccountCode);
//   4. the name map's suggestion (accounting/expenseCategories.ts).
// None of them → 422 CATEGORY_NOT_MAPPED until the account is named. A code
// named on a payment of a category with no account is saved to the category in
// the same transaction, so the next period posts without asking.
//
// Where the money came from, in order: what THIS payment names (payFrom /
// bankAccountId — an explicit correction); else what it already posted to
// (the same rule as CapEx's live credit — an amount fix never moves a
// payment to another bank); else the line's bank account and method.
//
// What never posts here:
//   • The payroll category / payroll-sourced lines — HR payroll books wages
//     (hr/ledger.ts); posting them here would count wages twice.
//   • A category with no company — refused (the ledger is per company).

import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { moneyAccountCode } from '../../lib/bankAccounts.js'
import { syncSourcePosting, liveRevision, type SyncOutcome } from '../accounting/sourcePosting.js'
import { expenseCodeForCategoryName, isPayrollCategory, assertExpenseCode } from '../accounting/expenseCategories.js'
import { toCents } from '../../lib/money.js'

type Tx = Prisma.TransactionClient | PrismaClient

export const OPEX_SOURCE = 'opex.payment'

export type OpexLedgerStatus = 'posted' | 'unposted' | 'payroll' | 'not_paid'

/** Where one payment's money came from, when the operator says so on the payment. */
export interface OpexPayFrom {
  payFrom?: 'bank' | 'cash'
  bankAccountId?: string | null
}

/**
 * The moneyAccountCode input for an OpEx payment. A company card or an auto
 * debit draws on a bank account, so every method but cash is bank money (the
 * resolver's 'card' means card-sale money in 1030 — a receivable, never what
 * pays an expense). A line's bank account wins over its method, as before.
 */
export function opexMoneyInput(
  line: { paymentMethod: string | null; bankAccountId: string | null },
  override?: OpexPayFrom,
): { method: 'cash' | 'bank_transfer'; bankAccountId: string | null } {
  const payFrom = override?.payFrom ?? (override?.bankAccountId ? 'bank' : undefined)
  if (payFrom === 'cash') return { method: 'cash', bankAccountId: override?.bankAccountId ?? null }
  if (payFrom === 'bank') {
    return { method: 'bank_transfer', bankAccountId: override?.bankAccountId ?? line.bankAccountId ?? null }
  }
  if (line.bankAccountId) return { method: 'bank_transfer', bankAccountId: line.bankAccountId }
  return { method: line.paymentMethod === 'cash' ? 'cash' : 'bank_transfer', bankAccountId: null }
}

export async function syncOpexPaymentPosting(
  paymentId: string,
  opts: { tx?: Tx; postedBy?: string; expenseAccountCode?: string | null } & OpexPayFrom = {},
): Promise<{ status: OpexLedgerStatus; outcome: SyncOutcome | null; entryId: string | null }> {
  const db = (opts.tx ?? prisma) as typeof prisma
  const p = await db.opexPayment.findUnique({
    where: { id: paymentId },
    include: { line: { include: { category: true } } },
  })
  if (!p) throw new AppError('NOT_FOUND', 'OpEx payment not found', 404)
  const { line } = p
  const category = line.category

  if (isPayrollCategory(category.name) || line.source === 'payroll') {
    return { status: 'payroll', outcome: null, entryId: null }
  }
  const tenantId = category.tenantId
  const paid = !!p.paidAt && (p.actualCents ?? 0) > 0
  if (!tenantId) {
    if (!paid) return { status: 'not_paid', outcome: null, entryId: null }
    throw new AppError('CATEGORY_HAS_NO_COMPANY', 'This OpEx category is not bound to a company, so its payment cannot reach the books — recreate it under the company', 422)
  }

  if (!paid) {
    const r = await syncSourcePosting({ tenantId, sourceType: OPEX_SOURCE, id: p.id, desired: null, postedBy: opts.postedBy, reason: 'OpEx payment no longer marked paid', tx: opts.tx })
    return { status: 'not_paid', outcome: r.outcome, entryId: null }
  }

  const { live } = await liveRevision(tenantId, OPEX_SOURCE, p.id, db)
  const liveDebit = live?.lines.find((l) => l.type === 'debit')?.accountCode
  const liveCredit = live?.lines.find((l) => l.type === 'credit')?.accountCode

  const named = opts.expenseAccountCode || null
  const expenseCode = named ?? liveDebit ?? category.expenseAccountCode ?? expenseCodeForCategoryName(category.name)
  if (!expenseCode) {
    throw new AppError(
      'CATEGORY_NOT_MAPPED',
      `Say which expense account "${category.name}" is booked to — pick the 6xxx account (it is remembered for the category)`,
      422,
    )
  }
  await assertExpenseCode(tenantId, expenseCode)
  // Named on a payment of a category that has no account yet: remember it.
  if (named && !category.expenseAccountCode) {
    await db.opexCategory.updateMany({ where: { id: category.id, expenseAccountCode: null }, data: { expenseAccountCode: named } })
  }

  const explicitMoney = opts.payFrom !== undefined || !!opts.bankAccountId
  const creditCode = !explicitMoney && liveCredit
    ? liveCredit
    : (await moneyAccountCode(db, tenantId, opexMoneyInput(line, explicitMoney ? opts : undefined))).code

  const amount = toCents(p.actualCents!)
  const conceptId = line.conceptId ?? category.conceptId ?? null
  const memo = `${line.name}${line.vendor ? ` — ${line.vendor}` : ''} (${p.periodStart.toISOString().slice(0, 10)}–${p.periodEnd.toISOString().slice(0, 10)})${p.paymentRef ? ` ref ${p.paymentRef}` : ''}`.slice(0, 250)
  const r = await syncSourcePosting({
    tenantId,
    sourceType: OPEX_SOURCE,
    id: p.id,
    desired: {
      description: `OpEx paid: ${category.name} — ${line.name}`,
      entryDate: p.paidAt!,
      lines: [
        { accountCode: expenseCode, type: 'debit',  amountCents: amount, memo, conceptId },
        { accountCode: creditCode,  type: 'credit', amountCents: amount, memo },
      ],
    },
    postedBy: opts.postedBy,
    reason: 'OpEx payment changed',
    tx: opts.tx,
  })
  return { status: 'posted', outcome: r.outcome, entryId: r.entryId }
}
