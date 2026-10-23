// HR payroll → the books. HR payroll is the only payroll now, so it carries
// the postings the old /payroll used to make.
//
//   lock     Dr wages (by department) + employer EOBI/SESSI
//            Cr wages payable 2020 (net), salary tax 2042, EOBI 2043
//               (employee + employer), SESSI/PESSI 2044, staff loans 1350
//               (installments recovered)
//   paid     Dr wages payable / Cr the safe (cash slips) and the bank picked
//            (bank and cheque slips), on the day it was paid
//   loan     Dr staff loans / Cr the bank or the safe it was paid from — when
//            a loan gets final approval; Cr 1355 Cash advances for a staff
//            advance moved from an unsettled cash request (H3)
//   F&F      approval: the same accrual as a payslip, for the leaver's last
//            salary, OT, leave encashment, gratuity (Dr 6036) and adjustments,
//            less the loan it recovers; paid: Dr wages payable / Cr the bank
//            or the safe
//
// The accrual balances by construction: net = earnings − every deduction, and
// the wage debit is earnings less the deductions that reduce pay (absence,
// unpaid leave, lates, other), so the withheld items (EOBI employee, tax, loan)
// land on the credit side and nothing else.
//
// Statutory payables (accountant default H7, 2026-10-13): 2042 salary tax
// (s.149), 2043 EOBI, 2044 SESSI / PESSI — paid over through Accounting →
// Statutory payments (accounting/taxPayments.ts). Entries posted before this
// release credited 2090 / 2040; they are never edited, and a cancel of such an
// F&F reverses exactly those lines (reverseJournalEntry flips the original).

import type { HrRecord, Prisma } from '@prisma/client'
import { classifyPaymentTx, type ClassificationInput } from '../accounting/paymentsRegister.js'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { ACCT, postJournalEntry, type JournalLineInput } from '../accounting/journal.js'
import { assertTemplateAccounts } from '../../lib/chartOfAccounts.js'
import { toCents } from '../../lib/money.js'
import { moneyAccountCode } from '../../lib/bankAccounts.js'
import { loansFor, ALL_RUN_STATUSES } from './service.js'
import { allocateLoanCents, settlementParts, settlementNet, pktToday } from './logic.js'
import { tagEntryByEmployeeTx } from '../../lib/subAccounts.js'

type Tx = Prisma.TransactionClient

export const STAFF_LOANS = ACCT.STAFF_LOANS
// Where withheld and employer statutory money waits until it is paid over —
// for payroll AND full & final, from these constants only (H7).
const SALARY_TAX_PAYABLE = ACCT.SALARY_TAX_PAYABLE      // 2042 income tax withheld (s.149)
const EOBI_PAYABLE = ACCT.EOBI_PAYABLE                  // 2043 EOBI employee + employer
const SOCIAL_SECURITY_PAYABLE = ACCT.SOCIAL_SECURITY_PAYABLE // 2044 SESSI / PESSI employer

/** Every code an entry posts to must be the template's own account in the
 *  company's chart (an operator who took 2043 for something else → 422
 *  ACCOUNT_CODE_TAKEN, and the caller's transaction — the lock, the approval —
 *  rolls back). */
async function assertLineAccounts(tx: Tx, tenantId: string, lines: JournalLineInput[]) {
  await assertTemplateAccounts(tx, tenantId, lines.map((l) => l.accountCode))
}

export const FNF_ACCRUAL = 'hr.final_settlement.accrual'
export const FNF_PAYMENT = 'hr.final_settlement.payment'

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
    const eobiEmployer = sum((l) => l.kind === 'employer' && l.code === 'eobi_employer')
    add(wages, earned + employer)
    add(EOBI_PAYABLE, -(sum((l) => l.code === 'eobi_employee') + eobiEmployer))
    // Every other employer contribution a payslip carries is SESSI / PESSI.
    add(SOCIAL_SECURITY_PAYABLE, -(employer - eobiEmployer))
    add(SALARY_TAX_PAYABLE, -sum((l) => l.code === 'tax'))
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
  await assertLineAccounts(tx, run.tenantId, lines)
  const res = await postJournalEntry({
    tenantId: run.tenantId,
    sourceType: 'hr.payroll.accrual',
    sourceId: run.id,
    description: `Payroll ${run.period}`,
    entryDate: new Date(Date.UTC(y, m, 0)),
    postedBy,
    lines,
  }, { tx })
  // Per-employee wages sub-ledger (2026-10-23), in the posting's transaction.
  await tagPayrollRunTx(tx, run.id)
  return res
}

// ─── Per-employee sub-ledger (owner, 2026-10-23) ─────────────────────────────
//
// "in Wages there should be option to add subaccount in name of employees to
// keep wages records in the name of employees". Every payroll and full & final
// posting tags, per employee (lib/subAccounts.ts — never changing a line):
//   accrual  the wages expense line(s) 6030 / 6031 / 6032 / 6035 (earned pay +
//            employer EOBI / SESSI, as posted), 6036 gratuity (F&F), the
//            2020 wages-payable credit (net pay) and the 1350 staff-loan
//            recovery;
//   payment  the 2020 wages-payable debit (net pay).
// The withheld statutory lines (2042 / 2043 / 2044) stay untagged (paid over as
// a whole). A line is tagged only when the employees' figures add up EXACTLY
// to it; otherwise it is left alone and reported (`mismatched`).

type Shares = Map<string, { type: 'debit' | 'credit'; byEmployee: Map<string, number> }>
function share(m: Shares, code: string, type: 'debit' | 'credit', emp: string, cents: number) {
  const cur = m.get(code) ?? { type, byEmployee: new Map<string, number>() }
  cur.byEmployee.set(emp, (cur.byEmployee.get(emp) ?? 0) + cents)
  m.set(code, cur)
}

/** What each employee is in a payroll run's accrual and payment, per account code. */
export async function payrollRunShares(tx: Tx, runId: string): Promise<{ accrual: Shares; payment: Shares }> {
  const slips = await tx.hrPayslip.findMany({ where: { runId }, include: { employee: { select: { departmentId: true } } } })
  const deptIds = Array.from(new Set(slips.map((s) => s.employee.departmentId).filter(Boolean) as string[]))
  const depts = deptIds.length ? await tx.department.findMany({ where: { id: { in: deptIds } }, select: { id: true, name: true } }) : []
  const deptName = new Map(depts.map((d) => [d.id, d.name]))
  const accrual: Shares = new Map()
  const payment: Shares = new Map()
  for (const s of slips) {
    const lines = s.lines as unknown as Line[]
    const sum = (f: (l: Line) => boolean) => lines.filter(f).reduce((a, l) => a + l.amountCents, 0)
    const wages = wageAccountFor(s.employee.departmentId ? deptName.get(s.employee.departmentId) : null)
    const earned = sum((l) => l.kind === 'earning') - sum((l) => l.kind === 'deduction' && PAY_REDUCING.has(l.code))
    share(accrual, wages, 'debit', s.employeeId, earned + sum((l) => l.kind === 'employer'))
    share(accrual, ACCT.WAGES_PAYABLE, 'credit', s.employeeId, s.netCents)
    share(accrual, STAFF_LOANS, 'credit', s.employeeId, sum((l) => l.code === 'loan'))
    share(payment, ACCT.WAGES_PAYABLE, 'debit', s.employeeId, s.netCents)
  }
  return { accrual, payment }
}

/** Tag a payroll run's accrual and payment entries (and mirror onto their reversals). Idempotent. */
export async function tagPayrollRunTx(tx: Tx, runId: string): Promise<{ mismatched: string[] }> {
  const run = await tx.hrPayrollRun.findUnique({ where: { id: runId }, select: { tenantId: true } })
  if (!run) return { mismatched: [] }
  const { accrual, payment } = await payrollRunShares(tx, runId)
  return tagSourceEntriesTx(tx, run.tenantId, [[`hr.payroll.accrual:${runId}`, accrual], [`hr.payroll.payment:${runId}`, payment]])
}

const SETTLEMENT_TAG_CODES: readonly string[] = [ACCT.WAGES_KITCHEN, ACCT.WAGES_FOH, ACCT.WAGES_MANAGEMENT, ACCT.WAGES_RIDERS, ACCT.GRATUITY, ACCT.WAGES_PAYABLE, STAFF_LOANS]

/** A full & final names one employee: each of its wage / gratuity / 2020 / 1350 lines is that employee's. Idempotent. */
export async function tagSettlementTx(tx: Tx, recId: string): Promise<{ mismatched: string[] }> {
  const rec = await tx.hrRecord.findUnique({ where: { id: recId }, select: { tenantId: true, employeeId: true } })
  if (!rec?.employeeId) return { mismatched: [] }
  const entries: Array<[string, Shares]> = []
  for (const ref of [`${FNF_ACCRUAL}:${recId}`, `${FNF_PAYMENT}:${recId}`]) {
    const e = await tx.journalEntry.findFirst({ where: { tenantId: rec.tenantId, reference: ref }, select: { lines: { select: { type: true, amountCents: true, account: { select: { code: true } } } } } })
    if (!e) continue
    const m: Shares = new Map()
    for (const l of e.lines) if (SETTLEMENT_TAG_CODES.includes(l.account.code)) share(m, l.account.code, l.type, rec.employeeId, toCents(l.amountCents))
    entries.push([ref, m])
  }
  return tagSourceEntriesTx(tx, rec.tenantId, entries)
}

async function tagSourceEntriesTx(tx: Tx, tenantId: string, entries: Array<[string, Shares]>): Promise<{ mismatched: string[] }> {
  const { mirrorAllocationsTx } = await import('../../lib/subAccounts.js')
  const mismatched: string[] = []
  for (const [reference, shares] of entries) {
    const e = await tx.journalEntry.findFirst({ where: { tenantId, reference }, select: { id: true } })
    if (!e) continue
    const r = await tagEntryByEmployeeTx(tx, tenantId, e.id, shares)
    mismatched.push(...r.mismatched.map((c) => `${reference}#${c}`))
    // A reversal already on the books (a reopened run, a cancelled settlement) carries the same tags.
    const at = reference.indexOf(':')
    const rev = await tx.journalEntry.findFirst({ where: { tenantId, reference: `${reference.slice(0, at)}.reversal:${reference.slice(at + 1)}` }, select: { id: true } })
    if (rev) await mirrorAllocationsTx(tx, e.id, rev.id)
  }
  return { mismatched }
}

/** What an accrual entry credited to Wages Payable (2020), net of any debit
 *  to it, or null when nothing was posted under that reference. */
async function accruedWagesPayable(tx: Tx, tenantId: string, reference: string): Promise<number | null> {
  const entry = await tx.journalEntry.findFirst({ where: { tenantId, reference }, select: { id: true } })
  if (!entry) return null
  const lines = await tx.journalLine.findMany({
    where: { journalEntryId: entry.id, account: { code: ACCT.WAGES_PAYABLE } },
    select: { type: true, amountCents: true },
  })
  return lines.reduce((a, l) => {
    const amt = toCents(l.amountCents)
    return a + (l.type === 'credit' ? amt : -amt)
  }, 0)
}

/** How a payroll was paid. `split` (the default): cash slips from the safe
 *  (or the POS drawer), bank and cheque slips from the bank named — or the
 *  company's only bank. `all` is the old one-source call ({from}) kept for
 *  existing clients: the whole run from the bank or the safe. */
export type PayrollPayFrom =
  | { mode: 'split'; bankAccountId?: string | null; cashCode?: '1010' }
  | { mode: 'all'; method: 'bank' | 'cash'; bankAccountId?: string | null }

const isCashPaid = (method: unknown) => method === 'cash'

export async function postPayrollPayment(runId: string, paidBy: string, from: PayrollPayFrom, paidOn: Date = pktToday(), classification: ClassificationInput | null = null) {
  return prisma.$transaction(async (tx) => {
    // The payment date is the run's paid date: the entry lands in the month
    // the money actually left (a payment recorded late is dated when it was
    // paid, and the period lock applies to that day).
    const n = await tx.hrPayrollRun.updateMany({ where: { id: runId, status: 'locked', paidAt: null }, data: { paidAt: paidOn } })
    if (n.count === 0) throw new AppError('NOT_PAYABLE', 'Only a locked payroll that has not been paid can be marked paid', 409)
    const run = await tx.hrPayrollRun.findUniqueOrThrow({ where: { id: runId } })
    // Pay exactly what the lock accrued to Wages Payable — never a separate
    // sum. Summing only the positive nets paid PKR 5,000 more than was accrued
    // when one payslip was negative, and left 2020 in debit (audit PPL-07).
    const reference = `hr.payroll.accrual:${run.id}`
    let net = await accruedWagesPayable(tx, run.tenantId, reference)
    if (net == null) {
      // Locked before locking posted the accrual (before 2026-09-24): book it
      // now, in this transaction, so the payment clears a real liability
      // instead of marking the run paid with nothing reaching the ledger
      // (audit HR-R6). An empty month posts nothing and pays nothing.
      await postPayrollAccrual(tx, run.id, paidBy)
      net = (await accruedWagesPayable(tx, run.tenantId, reference)) ?? 0
    }
    if (net < 0) throw new AppError('PAYROLL_UNBALANCED', `Payroll ${run.period} accrued a negative wages payable — reopen and recalculate it`, 409)

    // Who was paid how: the method snapshotted when the month was calculated,
    // else (a run calculated before that was kept) the employee's method now.
    const slips = await tx.hrPayslip.findMany({ where: { runId }, select: { netCents: true, inputs: true, employee: { select: { paymentMethod: true } } } })
    let cashCents = 0, cashStaff = 0, bankStaff = 0
    if (from.mode === 'all') {
      // The old one-source call: the whole accrual from one place.
      if (from.method === 'cash') { cashCents = net; cashStaff = slips.length } else bankStaff = slips.length
    } else {
      for (const sl of slips) {
        const snap = ((sl.inputs ?? {}) as Record<string, unknown>)['paymentMethod']
        const method = typeof snap === 'string' ? snap : sl.employee.paymentMethod
        if (isCashPaid(method)) { cashCents += Math.max(0, sl.netCents); cashStaff++ } else bankStaff++
      }
    }
    // The bank takes the rest of the accrual, so the two always add up to it.
    const bankCents = net - cashCents
    if (bankCents < 0) throw new AppError('PAYROLL_UNBALANCED', `Payroll ${run.period}: the cash payslips come to more than was accrued — reopen and recalculate it`, 409)

    if (from.mode === 'all' && from.method === 'cash' && from.bankAccountId) {
      throw new AppError('BANK_ACCOUNT_ON_CASH', 'A cash payment does not use a bank account', 422)
    }
    const cashCode = from.mode === 'split' ? (from.cashCode ?? ACCT.CASH_ON_HAND) : ACCT.CASH_ON_HAND
    // The bank is resolved when it is used — or named (a named bank of another
    // company is refused even when nobody is paid by bank).
    const bank = bankCents > 0 || from.bankAccountId
      ? await moneyAccountCode(tx, run.tenantId, { method: 'bank', bankAccountId: from.bankAccountId ?? null })
      : null

    let entryId: string | null = null
    if (net > 0) {
      const lines: JournalLineInput[] = [{ accountCode: ACCT.WAGES_PAYABLE, type: 'debit', amountCents: net, memo: 'Wages paid (net)' }]
      if (bank && bank.code === cashCode) {
        lines.push({ accountCode: cashCode, type: 'credit', amountCents: net, memo: `Paid to ${cashStaff + bankStaff} staff` })
      } else {
        if (cashCents > 0) lines.push({ accountCode: cashCode, type: 'credit', amountCents: cashCents, memo: `Paid in cash — ${cashStaff} staff` })
        if (bankCents > 0) lines.push({ accountCode: bank!.code, type: 'credit', amountCents: bankCents, memo: `Bank transfer to staff — ${bankStaff} staff` })
      }
      const res = await postJournalEntry({
        tenantId: run.tenantId,
        sourceType: 'hr.payroll.payment',
        sourceId: run.id,
        description: `Payroll ${run.period} paid`,
        entryDate: paidOn,
        postedBy: paidBy,
        lines,
      }, { tx })
      entryId = res.entryId
      // Internal payment classification (2026-10-20): a label on the entry, same transaction.
      await classifyPaymentTx(tx, { journalEntryId: entryId, input: classification, setById: paidBy })
      // Per-employee wages sub-ledger (2026-10-23).
      await tagPayrollRunTx(tx, run.id)
    }
    // What was paid from where, for the payroll screen.
    const payment = {
      paidOn: paidOn.toISOString(), entryId,
      bank: { code: bank?.code ?? null, bankAccountId: bank?.bankAccountId ?? null, cents: bankCents, staff: bankStaff },
      cash: { code: cashCode, cents: cashCents, staff: cashStaff },
    }
    return tx.hrPayrollRun.update({
      where: { id: run.id },
      data: { totals: { ...((run.totals ?? {}) as Record<string, unknown>), payment } as Prisma.InputJsonValue },
    })
  })
}

/**
 * Where a loan is paid out from: the loan's own "Paid from" (bank | cash) and
 * bank account, else the way the employee is paid — cash staff from the safe,
 * bank and cheque staff from the bank (the company's only bank, or 422 when it
 * has several and none was named).
 *
 * A staff advance moved from an unsettled cash request (paidFrom
 * 'cash_request', legacy rows only — see advanceLoan.ts;
 * the loan form's choices are bank | cash) paid nothing out today: the money
 * left the petty-cash box when the request was paid, and has waited on 1355
 * Cash advances since. The loan takes it over: Cr 1355.
 */
async function loanPayingAccount(tx: Tx, rec: HrRecord): Promise<{ method: 'bank' | 'cash' | 'cash_request'; code: string; bankAccountId: string | null }> {
  const d = (rec.data ?? {}) as Record<string, unknown>
  if (d['paidFrom'] === 'cash_request') return { method: 'cash_request', code: ACCT.CASH_ADVANCES, bankAccountId: null }
  const named = typeof d['bankAccount'] === 'string' && d['bankAccount'] ? d['bankAccount'] : null
  let method: 'bank' | 'cash'
  if (d['paidFrom'] === 'bank' || d['paidFrom'] === 'cash') method = d['paidFrom']
  else if (named) method = 'bank'   // a bank picked (e.g. by the approver) says where it came from
  else {
    const emp = rec.employeeId ? await tx.hrEmployee.findFirst({ where: { id: rec.employeeId, tenantId: rec.tenantId }, select: { paymentMethod: true } }) : null
    method = emp?.paymentMethod === 'cash' ? 'cash' : 'bank'
  }
  if (method === 'cash' && named) {
    throw new AppError('BANK_ACCOUNT_ON_CASH', 'This loan says it is paid in cash but names a bank account — pick one', 422)
  }
  const bankAccountId = method === 'bank' ? named : null
  const pay = await moneyAccountCode(tx, rec.tenantId, { method, bankAccountId })
  return { method, ...pay }
}

/** A loan paid out to an employee on final approval. The cancel reversal
 *  (reverseJournalEntry) flips these lines, so it credits back the same place. */
export async function postLoanDisbursement(tx: Tx, rec: HrRecord, postedBy: string) {
  const amount = rec.amountCents ?? 0
  if (amount <= 0) return null
  const pay = await loanPayingAccount(tx, rec)
  const fromCashRequest = pay.method === 'cash_request'
  const lines: JournalLineInput[] = [
    { accountCode: STAFF_LOANS, type: 'debit', amountCents: amount, memo: fromCashRequest ? 'Staff advance' : 'Staff loan' },
    {
      accountCode: pay.code, type: 'credit', amountCents: amount,
      memo: fromCashRequest ? 'Moved from an unsettled cash request' : pay.method === 'cash' ? 'Paid to employee in cash' : 'Paid to employee by bank',
    },
  ]
  if (fromCashRequest) await assertLineAccounts(tx, rec.tenantId, lines)
  const res = await postJournalEntry({
    tenantId: rec.tenantId,
    sourceType: 'hr.loan.disbursement',
    sourceId: rec.id,
    description: fromCashRequest ? 'Unsettled cash request moved to a staff advance' : 'Staff loan / advance paid out',
    postedBy,
    lines,
  }, { tx })
  const cur = await tx.hrRecord.findUniqueOrThrow({ where: { id: rec.id }, select: { data: true } })
  await tx.hrRecord.update({
    where: { id: rec.id },
    data: { data: { ...((cur.data ?? {}) as Record<string, unknown>), _paidFrom: { method: pay.method, code: pay.code, bankAccountId: pay.bankAccountId } } as Prisma.InputJsonValue },
  })
  return res
}

// ─── Full & final ───────────────────────────────────────────────────────────

/** One full & final's money work at a time, for the rest of the transaction:
 *  approval, payment, cancel and the backfill never interleave on it. */
export async function lockSettlement(tx: Tx, id: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`hr.final_settlement:${id}`}))`
}

/**
 * Book an approved full & final (finance gaps #2). Dated `entryDate` — the
 * approval day in Karachi by default — so a last working day in a month whose
 * books are closed does not block it; a closed approval day is 422
 * PERIOD_LOCKED from postJournalEntry and nothing is saved.
 *
 *   Dr wages (the leaver's department)  salary + OT + leave encashment
 *                                       + other adjustments − deductions
 *                                       + employer EOBI / SESSI
 *   Dr Gratuity 6036                    gratuity at exit (H6)
 *   Cr EOBI payable 2043                EOBI employee + employer
 *   Cr SESSI / PESSI payable 2044       employer SESSI
 *   Cr Salary tax payable 2042          income tax withheld
 *   Cr Staff loans 1350                 the loan recovered — never more than
 *                                       the employee still owes
 *   Cr Wages payable 2020               the net paid to the leaver (gratuity
 *                                       included)
 *
 * The same accounts and netting as a payslip's accrual. The loan split is
 * written to the record (data._loans) so the loan register (loansFor) and
 * 1350 agree. Idempotent: an entry already posted is returned as it is.
 */
export async function postFinalSettlementAccrual(tx: Tx, rec: HrRecord, postedBy: string, opts: { entryDate?: Date } = {}) {
  await lockSettlement(tx, rec.id)
  const existing = await tx.journalEntry.findFirst({ where: { tenantId: rec.tenantId, reference: `${FNF_ACCRUAL}:${rec.id}` }, select: { id: true } })
  if (existing) return { entryId: existing.id, posted: false }
  if (!rec.employeeId) throw new AppError('NO_EMPLOYEE', 'This settlement names no employee', 422)
  // One booked settlement per leaver (the backfill can meet an old duplicate):
  // serialised per employee, refused when another one is on the books and not
  // reversed. A cancelled one's reversal is posted under
  // '<FNF_ACCRUAL>.reversal:<id>' (journal references are always
  // sourceType:sourceId), so a replacement after a cancel books normally.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`hr.fnf.emp:${rec.tenantId}:${rec.employeeId}`}::text))`
  const siblings = await tx.hrRecord.findMany({
    where: { tenantId: rec.tenantId, employeeId: rec.employeeId, section: 'final_settlement', id: { not: rec.id } },
    select: { id: true },
  })
  if (siblings.length) {
    const refs = await tx.journalEntry.findMany({
      where: {
        tenantId: rec.tenantId,
        reference: { in: siblings.flatMap((x) => [`${FNF_ACCRUAL}:${x.id}`, `${FNF_ACCRUAL}.reversal:${x.id}`]) },
      },
      select: { reference: true },
    })
    const have = new Set(refs.map((r) => r.reference))
    const stillBooked = siblings.some((x) => have.has(`${FNF_ACCRUAL}:${x.id}`) && !have.has(`${FNF_ACCRUAL}.reversal:${x.id}`))
    if (stillBooked) {
      throw new AppError('FNF_ALREADY_APPROVED', 'Another full & final settlement of this employee is already on the books — cancel that one first if it is wrong', 409)
    }
  }
  const emp = await tx.hrEmployee.findFirst({ where: { id: rec.employeeId, tenantId: rec.tenantId }, select: { fullName: true, employeeCode: true, departmentId: true } })
  if (!emp) throw new AppError('NO_EMPLOYEE', 'This settlement\'s employee is not in its company', 422)

  const p = settlementParts(rec.data)
  const net = settlementNet(p)
  if (rec.amountCents != null && rec.amountCents !== net) {
    throw new AppError('FNF_UNBALANCED', `The settlement's figures come to Rs ${(net / 100).toFixed(2)}, not the Rs ${(rec.amountCents / 100).toFixed(2)} saved as its net — recalculate it`, 409)
  }
  if (net < 0) {
    throw new AppError('FNF_NEGATIVE', `${emp.fullName} would owe Rs ${(-net / 100).toFixed(2)} — lower the loan recovery (what is not recovered stays on Staff loans) or the deductions`, 422)
  }
  const negative = (['salaryPayable', 'otPayable', 'leaveEncashment', 'gratuity', 'deductions', 'loanRecovery', 'incomeTax', 'eobiEmployee', 'eobiEmployer', 'sessiEmployer'] as const).filter((k) => p[k] < 0)
  if (negative.length) throw new AppError('NEGATIVE_AMOUNT', `${negative.join(', ')} cannot be negative`, 422)

  // The loan recovered, split oldest first and never past what each loan
  // still owes after payroll and any other settlement.
  let loans: Array<{ loanId: string; cents: number }> = []
  if (p.loanRecovery > 0) {
    const open = await loansFor(rec.tenantId, rec.employeeId, { runStatuses: ALL_RUN_STATUSES, exceptSettlementId: rec.id })
    const split = allocateLoanCents(open.map((l) => ({ loanId: l.id, outstandingCents: l.outstandingCents })), p.loanRecovery)
    if (!split) {
      const owed = open.reduce((a, l) => a + l.outstandingCents, 0)
      throw new AppError('LOAN_OVER_OUTSTANDING', owed > 0
        ? `The loan recovery is more than the Rs ${(owed / 100).toFixed(2)} ${emp.fullName} still owes`
        : `${emp.fullName} has no loan outstanding to recover`, 422)
    }
    loans = split
  }

  const dept = emp.departmentId ? await tx.department.findUnique({ where: { id: emp.departmentId }, select: { name: true } }) : null
  const signed = new Map<string, number>()
  const add = (code: string, v: number) => signed.set(code, (signed.get(code) ?? 0) + v)
  add(wageAccountFor(dept?.name), p.salaryPayable + p.otPayable + p.leaveEncashment + p.otherAdjustments - p.deductions + p.eobiEmployer + p.sessiEmployer)
  add(ACCT.GRATUITY, p.gratuity)
  add(EOBI_PAYABLE, -(p.eobiEmployee + p.eobiEmployer))
  add(SOCIAL_SECURITY_PAYABLE, -p.sessiEmployer)
  add(SALARY_TAX_PAYABLE, -p.incomeTax)
  add(STAFF_LOANS, -p.loanRecovery)
  add(ACCT.WAGES_PAYABLE, -net)
  const drift = Array.from(signed.values()).reduce((a, v) => a + v, 0)
  if (drift !== 0) throw new AppError('FNF_UNBALANCED', `The settlement does not balance by ${drift} paisa — recalculate it`, 409)

  const lines = toLines(signed, `Full & final ${emp.employeeCode}`)
  if (lines.length >= 2) await assertLineAccounts(tx, rec.tenantId, lines)
  const res = lines.length < 2 ? null : await postJournalEntry({
    tenantId: rec.tenantId,
    sourceType: FNF_ACCRUAL,
    sourceId: rec.id,
    description: `Full & final settlement — ${emp.fullName} (${emp.employeeCode})`,
    entryDate: opts.entryDate ?? pktToday(),
    postedBy,
    lines,
  }, { tx })
  if (res) await tagSettlementTx(tx, rec.id)
  const cur = await tx.hrRecord.findUniqueOrThrow({ where: { id: rec.id }, select: { data: true } })
  await tx.hrRecord.update({
    where: { id: rec.id },
    data: { data: { ...((cur.data ?? {}) as Record<string, unknown>), _loans: loans } as Prisma.InputJsonValue },
  })
  return res
}

/**
 * The leaver is paid: Dr Wages payable 2020 (exactly what the accrual put
 * there) / Cr the bank named — or the company's only bank — or the safe,
 * dated the day it was paid (the period lock applies to that day). A
 * settlement approved before it was booked is booked first, in the same
 * transaction. Paying twice is refused (409); one entry ever.
 */
export async function postFinalSettlementPayment(
  recId: string, paidBy: string,
  opts: { cash: boolean; bankAccountId?: string | null; paidOn: Date; dateKey?: string | null; classification?: ClassificationInput | null },
) {
  return prisma.$transaction(async (tx) => {
    await lockSettlement(tx, recId)
    let rec = await tx.hrRecord.findUnique({ where: { id: recId } })
    if (!rec || rec.section !== 'final_settlement') throw new AppError('NOT_FOUND', 'Full & final settlement not found', 404)
    if (rec.status !== 'approved') throw new AppError('NOT_APPROVED', 'Only an approved settlement can be paid', 409)
    if (((rec.data ?? {}) as Record<string, unknown>)['_paidAt']) throw new AppError('ALREADY_PAID', 'This settlement has already been paid', 409)
    const pay = await moneyAccountCode(tx, rec.tenantId, { method: opts.cash ? 'cash' : 'bank', bankAccountId: opts.bankAccountId ?? null })

    const reference = `${FNF_ACCRUAL}:${rec.id}`
    if (!(await tx.journalEntry.findFirst({ where: { tenantId: rec.tenantId, reference }, select: { id: true } }))) {
      await postFinalSettlementAccrual(tx, rec, paidBy)
      rec = await tx.hrRecord.findUniqueOrThrow({ where: { id: recId } })
    }
    const net = (await accruedWagesPayable(tx, rec.tenantId, reference)) ?? 0
    if (net < 0) throw new AppError('FNF_UNBALANCED', 'This settlement accrued a negative wages payable', 409)
    let entryId: string | null = null
    if (net > 0) {
      const res = await postJournalEntry({
        tenantId: rec.tenantId,
        sourceType: FNF_PAYMENT,
        sourceId: rec.id,
        description: 'Full & final settlement paid',
        entryDate: opts.paidOn,
        postedBy: paidBy,
        lines: [
          { accountCode: ACCT.WAGES_PAYABLE, type: 'debit', amountCents: net, memo: 'Full & final paid (net)' },
          { accountCode: pay.code, type: 'credit', amountCents: net, memo: opts.cash ? 'Paid in cash' : 'Paid by bank' },
        ],
      }, { tx })
      entryId = res.entryId
      await classifyPaymentTx(tx, { journalEntryId: entryId, input: opts.classification ?? null, setById: paidBy })
      await tagSettlementTx(tx, rec.id)
    }
    const d = (rec.data ?? {}) as Record<string, unknown>
    return tx.hrRecord.update({
      where: { id: rec.id },
      data: {
        effectiveDate: opts.paidOn,
        data: {
          ...d,
          ...(opts.dateKey && { [opts.dateKey]: opts.paidOn.toISOString() }),
          _paidAt: new Date().toISOString(), _paidOn: opts.paidOn.toISOString(), _paidBy: paidBy, _paidCents: net,
          _paidFrom: { method: opts.cash ? 'cash' : 'bank', code: pay.code, bankAccountId: pay.bankAccountId },
          _paymentEntryId: entryId,
        } as Prisma.InputJsonValue,
      },
    })
  })
}
