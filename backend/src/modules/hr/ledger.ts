// HR payroll → the books. HR payroll is the only payroll now, so it carries
// the postings the old /payroll used to make.
//
//   lock     Dr wages (by department) + employer EOBI/SESSI
//            Cr wages payable (net), tax withheld, statutory payable,
//               staff loans (installments recovered)
//   paid     Dr wages payable / Cr bank or cash
//   loan     Dr staff loans / Cr bank — when a loan gets final approval
//
// The accrual balances by construction: net = earnings − every deduction, and
// the wage debit is earnings less the deductions that reduce pay (absence,
// unpaid leave, lates, other), so the withheld items (EOBI employee, tax, loan)
// land on the credit side and nothing else.

import type { HrRecord, Prisma } from '@prisma/client'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { ACCT, postJournalEntry, type JournalLineInput } from '../accounting/journal.js'

type Tx = Prisma.TransactionClient

export const STAFF_LOANS = '1350'
const STATUTORY_PAYABLE = '2090' // Accrued Expenses — EOBI and SESSI until paid over
const TAX_PAYABLE = ACCT.WHT_PAYABLE

interface Line { kind: 'earning' | 'deduction' | 'employer'; code: string; amountCents: number }

/** Deductions that are pay not earned, rather than money withheld for someone. */
const PAY_REDUCING = new Set(['absence', 'unpaid_leave', 'late', 'other'])

/** Which wages account a department's pay lands on. Unknown → front of house. */
export function wageAccountFor(department: string | null | undefined): string {
  const d = (department ?? '').toLowerCase()
  if (/kitchen|boh|back of house|cook|chef|culinary|bakery|pastry/.test(d)) return ACCT.WAGES_KITCHEN
  if (/rider|deliver|dispatch|driver/.test(d)) return ACCT.WAGES_RIDERS
  if (/manage|admin|finance|account|hr|human|office|marketing|procure|executive/.test(d)) return ACCT.WAGES_MANAGEMENT
  return ACCT.WAGES_FOH
}

/** Signed amounts per account (debit +, credit −) into balanced journal lines. */
function toLines(signed: Map<string, number>, memo: string): JournalLineInput[] {
  const out: JournalLineInput[] = []
  for (const [accountCode, v] of signed) {
    if (v > 0) out.push({ accountCode, type: 'debit', amountCents: v, memo })
    else if (v < 0) out.push({ accountCode, type: 'credit', amountCents: -v, memo })
  }
  return out
}

export async function postPayrollAccrual(tx: Tx, runId: string, postedBy: string) {
  const run = await tx.hrPayrollRun.findUnique({ where: { id: runId } })
  if (!run) throw new AppError('NOT_FOUND', 'Payroll not found', 404)
  const slips = await tx.hrPayslip.findMany({ where: { runId }, include: { employee: { select: { departmentId: true } } } })
  const deptIds = Array.from(new Set(slips.map((s) => s.employee.departmentId).filter(Boolean) as string[]))
  const depts = await tx.department.findMany({ where: { id: { in: deptIds } }, select: { id: true, name: true } })
  const deptName = new Map(depts.map((d) => [d.id, d.name]))

  const signed = new Map<string, number>()
  const add = (code: string, v: number) => signed.set(code, (signed.get(code) ?? 0) + v)
  for (const s of slips) {
    const lines = s.lines as unknown as Line[]
    const sum = (f: (l: Line) => boolean) => lines.filter(f).reduce((a, l) => a + l.amountCents, 0)
    const wages = wageAccountFor(s.employee.departmentId ? deptName.get(s.employee.departmentId) : null)
    const earned = sum((l) => l.kind === 'earning') - sum((l) => l.kind === 'deduction' && PAY_REDUCING.has(l.code))
    const employer = sum((l) => l.kind === 'employer')
    add(wages, earned + employer)
    add(STATUTORY_PAYABLE, -(sum((l) => l.code === 'eobi_employee') + employer))
    add(TAX_PAYABLE, -sum((l) => l.code === 'tax'))
    add(STAFF_LOANS, -sum((l) => l.code === 'loan'))
    add(ACCT.WAGES_PAYABLE, -s.netCents)
  }
  const drift = Array.from(signed.values()).reduce((a, v) => a + v, 0)
  if (drift !== 0) {
    // A payslip whose net is not earnings less deductions. Refuse rather than
    // post an entry that does not balance.
    throw new AppError('PAYROLL_UNBALANCED', `Payroll ${run.period} does not balance by ${drift} paisa — recalculate it`, 409)
  }
  const [y, m] = run.period.split('-').map(Number) as [number, number]
  const lines = toLines(signed, `Payroll ${run.period}`)
  if (lines.length < 2) return null // nothing to post (an empty month)
  return postJournalEntry({
    tenantId: run.tenantId,
    sourceType: 'hr.payroll.accrual',
    sourceId: run.id,
    description: `Payroll ${run.period}`,
    entryDate: new Date(Date.UTC(y, m, 0)),
    postedBy,
    lines,
  }, { tx })
}

export async function postPayrollPayment(runId: string, paidBy: string, fromAccount: string) {
  return prisma.$transaction(async (tx) => {
    const n = await tx.hrPayrollRun.updateMany({ where: { id: runId, status: 'locked', paidAt: null }, data: { paidAt: new Date() } })
    if (n.count === 0) throw new AppError('NOT_PAYABLE', 'Only a locked payroll that has not been paid can be marked paid', 409)
    const run = await tx.hrPayrollRun.findUniqueOrThrow({ where: { id: runId } })
    const net = (await tx.hrPayslip.aggregate({ where: { runId, netCents: { gt: 0 } }, _sum: { netCents: true } }))._sum.netCents ?? 0
    if (net > 0) {
      await postJournalEntry({
        tenantId: run.tenantId,
        sourceType: 'hr.payroll.payment',
        sourceId: run.id,
        description: `Payroll ${run.period} paid`,
        postedBy: paidBy,
        lines: [
          { accountCode: ACCT.WAGES_PAYABLE, type: 'debit', amountCents: net, memo: 'Wages paid (net)' },
          { accountCode: fromAccount, type: 'credit', amountCents: net, memo: fromAccount === ACCT.BANK ? 'Bank transfer to staff' : 'Paid in cash' },
        ],
      }, { tx })
    }
    return run
  })
}

/** A loan paid out to an employee on final approval. */
export async function postLoanDisbursement(tx: Tx, rec: HrRecord, postedBy: string) {
  const amount = rec.amountCents ?? 0
  if (amount <= 0) return null
  return postJournalEntry({
    tenantId: rec.tenantId,
    sourceType: 'hr.loan.disbursement',
    sourceId: rec.id,
    description: 'Staff loan / advance paid out',
    postedBy,
    lines: [
      { accountCode: STAFF_LOANS, type: 'debit', amountCents: amount, memo: 'Staff loan' },
      { accountCode: ACCT.BANK, type: 'credit', amountCents: amount, memo: 'Paid to employee' },
    ],
  }, { tx })
}
