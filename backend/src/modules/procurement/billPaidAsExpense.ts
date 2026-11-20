// "This bill was already paid — and booked as an expense" (owner, 2026-11-20: bills stayed Open because the cash was
// handed over through a cash voucher / box spend that booked an EXPENSE instead of a payment of the bill; "Yes, add the
// button to do it in one click").
//
// THE STATE: the purchase is in the books twice — the bill booked it once (stock or expense / Cr 2010) and the cash
// booked it again as an expense (Dr <expense> / Cr cash or the box) — and 2010 still owes a supplier who was paid.
//
// THE FIX, one transaction, both through existing engines (never a second payment path, never a direct 2010 journal):
//   1. the bill's payment — createPaymentTx method 'cash': 'supplier.payment:<id>'  Dr 2010 / Cr 1010, bill Paid /
//      Partially paid, AP sub-ledger and aging follow;
//   2. the correction — 'supplier.bill_expense_correction:<paymentId>'  Dr 1010 / Cr <the account the cost sits in>,
//      under the brand named (the duplicate comes out; 1010 ends where it started, because no cash moves today).
// Net: Dr 2010 / Cr the expense. The box / voucher that really paid is untouched — its cash did leave.
//
// The account is the one the duplicate sits in NOW (finance may have moved it, e.g. into a cost-of-sales account): a
// live expense account of the BILL's company, not register-controlled (422 ACCOUNT_NOT_ALLOWED). The amount is at most
// what the bill still owes (422 OVER_APPLIED). A bill waiting on its buyer's pay-back voucher is refused by
// createPaymentTx (409 BILL_AWAITING_BUYER_PAYBACK). A closed month refuses both entries (nothing saved).
//
// Undo: unapply + void the payment as usual — voidPayment reverses the correction with it (service.ts).
//
// Company: everything is the bill's supplier's company; the caller's scope is checked by the route (guardBill, 404).

import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { fmtPkrCents } from '../../lib/money.js'
import { ACCT, postJournalEntry } from '../accounting/journal.js'
import { billDueCents, createPaymentTx } from './service.js'

export const BILL_EXPENSE_CORRECTION = 'supplier.bill_expense_correction'

export interface PaidAsExpenseInput {
  billId: string
  /** Default: everything the bill still owes. */
  amountCents?: number | null
  /** The expense account the duplicate cost sits in now. */
  accountCode: string
  /** The brand that expense was booked under, if any. */
  conceptId?: string | null
  reason: string
  userId: string
}

/** The expense accounts the correction may credit, for the form. */
export async function correctionAccounts(tenantId: string): Promise<Array<{ code: string; name: string }>> {
  return prisma.account.findMany({
    where: { tenantId, type: 'expense', isActive: true, controlledBy: null },
    select: { code: true, name: true }, orderBy: { code: 'asc' },
  })
}

export async function markBillPaidAsExpense(input: PaidAsExpenseInput) {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM supplier_bills WHERE id = ${input.billId} FOR UPDATE`
    const bill = await tx.supplierBill.findUnique({
      where: { id: input.billId },
      select: { id: true, billNumber: true, kind: true, status: true, supplierId: true, totalCents: true, whtCents: true, paidCents: true, creditedCents: true, supplier: { select: { name: true, tenantId: true } } },
    })
    if (!bill) throw new NotFoundError('SupplierBill', input.billId)
    const tenantId = bill.supplier.tenantId
    if (!tenantId) throw new AppError('SUPPLIER_HAS_NO_COMPANY', 'This supplier has no company yet — assign it first', 422)
    if (bill.kind !== 'bill') throw new AppError('NOT_A_BILL', 'That is a credit note, not a bill', 422)
    if (bill.status !== 'open' && bill.status !== 'partially_paid') throw new AppError('BILL_NOT_OPEN', `Bill ${bill.billNumber} is ${bill.status}`, 422)
    const due = billDueCents(bill)
    const amount = input.amountCents ?? due
    if (amount <= 0) throw new AppError('INVALID_AMOUNT', 'Amount must be positive', 400)
    if (amount > due) throw new AppError('OVER_APPLIED', `Only ${fmtPkrCents(due)} is still due on bill ${bill.billNumber}`, 422)
    const account = await tx.account.findFirst({
      where: { tenantId, code: input.accountCode, type: 'expense', isActive: true, controlledBy: null },
      select: { code: true, name: true },
    })
    if (!account) throw new AppError('ACCOUNT_NOT_ALLOWED', `Account ${input.accountCode} is not a live expense account of this company`, 422)
    if (input.conceptId) {
      const c = await tx.concept.findFirst({ where: { id: input.conceptId, tenantId }, select: { id: true } })
      if (!c) throw new AppError('BRAND_NOT_IN_COMPANY', 'That brand is not one of this company\'s', 422)
    }
    const what = `${bill.supplier.name}, bill ${bill.billNumber}`
    const payment = await createPaymentTx(tx, {
      supplierId: bill.supplierId,
      paymentDate: new Date().toISOString(),
      method: 'cash',
      reference: 'already paid — booked as an expense',
      amountCents: amount,
      notes: input.reason,
      applications: [{ billId: bill.id, amountAppliedCents: amount }],
      createdBy: input.userId,
    })
    const entry = await postJournalEntry({
      tenantId, sourceType: BILL_EXPENSE_CORRECTION, sourceId: payment.id, postedBy: input.userId,
      description: `Paid already, booked as an expense — ${what}, ${fmtPkrCents(amount)}: ${input.reason}`.slice(0, 500),
      lines: [
        { accountCode: ACCT.CASH_ON_HAND, type: 'debit', amountCents: amount, memo: `No cash moved today — offsets the payment of ${what}`.slice(0, 250) },
        { accountCode: account.code, type: 'credit', amountCents: amount, memo: `Duplicate expense removed — ${what} (the bill carries the cost)`.slice(0, 250), conceptId: input.conceptId ?? null },
      ],
    }, { tx })
    const after = await tx.supplierBill.findUniqueOrThrow({ where: { id: bill.id }, select: { status: true } })
    return { billId: bill.id, billNumber: bill.billNumber, tenantId, supplierPaymentId: payment.id, amountCents: amount, accountCode: account.code, accountName: account.name, correctionEntryId: entry.entryId ?? null, status: after.status }
  }, { timeout: 20_000, maxWait: 10_000 })
}
