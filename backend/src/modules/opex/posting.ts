// OpEx payment → the ledger (owner decision 23). The OpEx tracker keeps the
// budget, the cadence and the due dates; the LEDGER holds the actuals. When a
// payment is marked paid it posts, from the line's own bank account:
//
//   Dr 6xxx  the category's expense account   (tagged with the line's brand)
//   Cr the bank account's chart code (Configuration → Bank accounts),
//      1010 cash on hand for a cash-paid line, else 1020
//
// sourceType 'opex.payment', keyed on the payment id, kept in step through
// syncSourcePosting: editing the amount or the date reverses and reposts,
// un-marking it paid reverses it, saving it unchanged does nothing.
//
// What never posts here:
//   • The payroll category / payroll-sourced lines — HR payroll books wages
//     (hr/ledger.ts); posting them here would count wages twice.
//   • A category with no company — refused (the ledger is per company).
// A category the expense mapping can't place (accounting/expenseCategories.ts)
// is refused until the operator names the 6xxx account on the payment.

import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { ACCT } from '../accounting/journal.js'
import { syncSourcePosting, liveRevision, type SyncOutcome } from '../accounting/sourcePosting.js'
import { expenseCodeForCategoryName, isPayrollCategory, assertExpenseCode } from '../accounting/expenseCategories.js'

type Tx = Prisma.TransactionClient | PrismaClient

export const OPEX_SOURCE = 'opex.payment'

export type OpexLedgerStatus = 'posted' | 'unposted' | 'payroll' | 'not_paid'

export async function syncOpexPaymentPosting(
  paymentId: string,
  opts: { tx?: Tx; postedBy?: string; expenseAccountCode?: string | null } = {},
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

  // Expense account: named on the payment, else the category's own column
  // (once the schema carries it), else what this payment already posted to,
  // else the category-name mapping.
  const column = (category as unknown as Record<string, unknown>)['expenseAccountCode']
  const { live } = await liveRevision(tenantId, OPEX_SOURCE, p.id, db)
  const expenseCode =
    opts.expenseAccountCode
    ?? (typeof column === 'string' && column ? column : null)
    ?? live?.lines.find((l) => l.type === 'debit')?.accountCode
    ?? expenseCodeForCategoryName(category.name)
    ?? expenseCodeForCategoryName(line.name)
  if (!expenseCode) {
    throw new AppError(
      'CATEGORY_NOT_MAPPED',
      `Say which expense account "${category.name}" is paid from — pick the 6xxx account on the payment`,
      422,
    )
  }
  await assertExpenseCode(tenantId, expenseCode)

  // Credit: the line's bank account's chart code.
  let creditCode: string
  if (line.bankAccountId) {
    const bank = await db.bankAccount.findFirst({ where: { id: line.bankAccountId, tenantId }, select: { accountCode: true, name: true } })
    if (!bank) throw new AppError('BANK_ACCOUNT_NOT_IN_COMPANY', 'The line\'s bank account is not this company\'s', 422)
    if (!bank.accountCode) throw new AppError('BANK_ACCOUNT_NOT_LINKED', `Link "${bank.name}" to a chart code first (Configuration → Bank accounts)`, 422)
    creditCode = bank.accountCode
  } else {
    creditCode = line.paymentMethod === 'cash' ? ACCT.CASH_ON_HAND : ACCT.BANK
  }

  const amount = p.actualCents!
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
