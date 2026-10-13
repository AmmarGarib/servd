// A cash request's unsettled advance becomes an HR staff advance (accountant
// default H3, 2026-10-13): money paid from a petty-cash box waits on 1355 Cash
// advances until receipts settle it; what is still unsettled after the
// settle days moves to the holder as a staff advance on 1350, recovered by
// payroll like any other loan.
//
// This is HR's ONE loan register — the advance is an ordinary approved
// 'loan' record (category 'advance'), so loansFor, payroll installments, the
// F&F recovery and Staff loans 1350 all see it with no special case. Only two
// things differ, both keyed on data.paidFrom 'cash_request' (a value the loan
// form cannot send — its choices are bank | cash):
//   - the disbursement credits 1355, not a bank or the safe (ledger.ts
//     loanPayingAccount): Dr 1350 Staff loans / Cr 1355 Cash advances, under
//     'hr.loan.disbursement:<recordId>';
//   - HR cannot cancel it (routes.ts → 409 LOAN_FROM_CASH_REQUEST): it is
//     undone from the cash request, or the request would read 'converted'
//     while 1355 held the advance again.
//
// The caller (trustops cash requests: the CEO's convert, the overdue worker)
// runs this inside its own transaction, claims the request and audits the
// conversion; the request and the employee must belong to `tenantId`.

import type { Prisma } from '@prisma/client'
import { AppError } from '../../lib/errors.js'
import { assertInt4Fits } from '../../lib/money.js'
import { getFormat } from './service.js'
import { postLoanDisbursement } from './ledger.js'
import { pktToday, type ApprovalEntry } from './logic.js'

type Tx = Prisma.TransactionClient

export const CASH_REQUEST_PAID_FROM = 'cash_request'

/** The first day of the month after today in Karachi — the first payroll the advance is recovered in. */
function firstOfNextPktMonth(): Date {
  const t = pktToday()
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1))
}

export async function createLoanFromCashAdvanceTx(tx: Tx, a: {
  tenantId: string
  employeeId: string
  amountCents: number
  installments: number
  /** Who decided it — a user id, or 'system' for the overdue worker. */
  approvedById: string
  cashVoucherId: string
  /** The request's number (CV-00001), for the record and the note. */
  number: string
}): Promise<{ recordId: string }> {
  if (!a.tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'A staff advance belongs to one company', 422)
  if (!(Number.isInteger(a.amountCents) && a.amountCents > 0)) throw new AppError('BAD_AMOUNT', 'The advance must be more than zero', 400)
  assertInt4Fits(a.amountCents, 'The staff advance')
  if (!(Number.isInteger(a.installments) && a.installments >= 1 && a.installments <= 120)) {
    throw new AppError('BAD_INSTALLMENTS', 'The number of installments must be a whole number from 1 to 120', 400)
  }

  // One advance per cash request, ever: serialised on the request, and an
  // existing one is returned (its disbursement posted if it was not).
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`hr.loan.cash_request:${a.tenantId}:${a.cashVoucherId}`}::text))`
  const existing = await tx.hrRecord.findFirst({
    where: { tenantId: a.tenantId, section: 'loan', data: { path: ['cashVoucherId'], equals: a.cashVoucherId } },
  })
  if (existing) {
    if (existing.employeeId !== a.employeeId) {
      throw new AppError('ADVANCE_EXISTS', 'This cash request was already moved to another employee\'s staff advance', 409)
    }
    if (existing.status === 'approved') await postLoanDisbursement(tx, existing, a.approvedById)
    return { recordId: existing.id }
  }

  const emp = await tx.hrEmployee.findFirst({ where: { id: a.employeeId, tenantId: a.tenantId }, select: { id: true } })
  if (!emp) throw new AppError('EMPLOYEE_NOT_IN_COMPANY', 'That employee is not in the cash request\'s company', 422)

  const fmt = await getFormat(a.tenantId, 'loan')
  const by = a.approvedById === 'system'
    ? null
    : await tx.user.findUnique({ where: { id: a.approvedById }, select: { name: true, email: true } })
  const now = new Date()
  const firstDeduction = firstOfNextPktMonth()
  const note = `Unsettled cash request ${a.number} moved to a staff advance`
  const approvals = [{
    step: 'ceo', role: 'management', decision: 'approved' as const, byUserId: a.approvedById,
    byName: by?.name ?? by?.email ?? (a.approvedById === 'system' ? 'servd (overdue cash request)' : 'Unknown'),
    at: now.toISOString(), note,
  }] satisfies ApprovalEntry[]
  // The loan format's own keys, so HR's screens show it like any loan.
  const data = {
    employee: a.employeeId, type: 'advance', amount: a.amountCents, date: pktToday().toISOString(),
    installments: a.installments, firstDeduction: firstDeduction.toISOString(), reason: note,
    paidFrom: CASH_REQUEST_PAID_FROM, bankAccount: null,
    cashVoucherId: a.cashVoucherId, cashVoucherNumber: a.number,
  }
  const rec = await tx.hrRecord.create({
    data: {
      tenantId: a.tenantId, section: 'loan', formVersion: fmt.version,
      employeeId: a.employeeId, category: 'advance', amountCents: a.amountCents, quantity: a.installments,
      startDate: pktToday(), effectiveDate: firstDeduction,
      status: 'approved', stage: fmt.stages[0] ?? null,
      currentStep: Math.max(0, fmt.workflow.length - 1),
      approvals,
      data,
      createdById: a.approvedById,
    },
  })
  // Dr 1350 Staff loans / Cr 1355 Cash advances (ledger.ts), in this transaction.
  await postLoanDisbursement(tx, rec, a.approvedById)
  return { recordId: rec.id }
}
