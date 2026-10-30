// HR money on the books (finance gaps Wave A — #2, #9 payroll part, and the
// extra findings of that group):
//
//   - a full & final is booked when approved (balanced, its own company's
//     chart only), its loan recovery clears Staff loans 1350 and the loan
//     register, "Mark paid" clears Wages Payable against the bank picked, and
//     cancelling reverses it (a paid one stays)
//   - the settlement carries the income tax / EOBI / SESSI a payslip takes
//   - it can never pay a month a payroll also pays (a draft run counts; it is
//     approved only once every run with the leaver is locked; payroll then
//     leaves the leaver out; payroll moving after "Calculate" is caught)
//   - payroll is paid cash slips from the safe and bank slips from the bank
//     picked, on the day it was paid (period lock applies)
//   - loans are paid out from the bank or the safe, as the loan says
//
// Two companies: company B gets 404 on company A's rows and cannot attach
// its bank account to A's money.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { linkBankLedgerAccount } from '../src/lib/bankAccounts.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { hrRoutes } from '../src/modules/hr/routes.js'
import { getSettings, saveSettings } from '../src/modules/hr/service.js'
import {
  finalSettlement, computePayslip, settlementNet, settledFromPeriod, mergeSettings, EMPTY_INPUTS, DEFAULT_HR_SETTINGS, pktToday,
} from '../src/modules/hr/logic.js'

const RS = (r: number) => r * 100
const stamp = Date.now()
const D = (s: string) => new Date(`${s}T00:00:00.000Z`)

// ─── pure ───────────────────────────────────────────────────────────────────

describe('full & final figures', () => {
  const s = mergeSettings({
    eobi: { enabled: true, employeePct: 1, employerPct: 5, base: 'fixed', fixedWageCents: RS(40000) },
    sessi: { employerPct: 6, wageCeilingCents: null },
  })
  const emp = { grossSalaryCents: RS(52000), joiningDate: D('2025-01-01'), monthlyTaxCents: RS(1000) }
  const inp = { salaryFrom: D('2026-09-01'), otPayableCents: RS(1500), leaveBalanceDays: 0, loanOutstandingCents: RS(5000), deductionsCents: 0, otherAdjustmentsCents: 0 }

  it('carries the income tax, EOBI and SESSI each month\'s payslip would have taken', () => {
    const r = finalSettlement(emp, D('2026-10-10'), inp, s)
    const sep = computePayslip({ ...emp, lastWorkingDay: D('2026-10-10') }, '2026-09', EMPTY_INPUTS, s)
    const oct = computePayslip({ ...emp, lastWorkingDay: D('2026-10-10') }, '2026-10', EMPTY_INPUTS, s)
    expect(r.months.map((m) => m.period)).toEqual(['2026-09', '2026-10'])
    expect(r.salaryPayable).toBe(sep.grossCents + oct.grossCents)
    expect(r.salaryPayable).toBe(RS(52000) + Math.round(RS(52000) * 10 / 31))
    expect(r.incomeTax).toBe(RS(2000))
    expect(r.eobiEmployee).toBe(RS(800))
    expect(r.eobiEmployer).toBe(RS(4000))
    expect(r.sessiEmployer).toBe(Math.round(RS(52000) * 0.06) + Math.round(Math.round(RS(52000) * 10 / 31) * 0.06))
    // The net takes off what is withheld from the employee, never the employer's cost.
    expect(r.netAmount).toBe(r.salaryPayable + RS(1500) - RS(5000) - RS(2000) - RS(800))
    expect(settlementNet(r)).toBe(r.netAmount)
  })

  it('pays each month at its own salary, and nothing when payroll already paid through the last day', () => {
    const r = finalSettlement(emp, D('2026-10-10'), { ...inp, salaryByPeriod: { '2026-09': RS(50000), '2026-10': RS(62000) } }, s)
    expect(r.salaryPayable).toBe(RS(50000) + Math.round(RS(62000) * 10 / 31))
    const none = finalSettlement(emp, D('2026-10-10'), { ...inp, salaryFrom: D('2026-11-01') }, s)
    expect(none.salaryPayable).toBe(0)
    expect(none.incomeTax + none.eobiEmployee + none.eobiEmployer + none.sessiEmployer).toBe(0)
    // Defaults (EOBI off, no tax) leave the old figures as they were.
    expect(finalSettlement({ grossSalaryCents: RS(62000), joiningDate: D('2025-01-01') }, D('2026-09-10'), { ...inp, salaryFrom: D('2026-08-01'), otPayableCents: 0, loanOutstandingCents: 0 }, DEFAULT_HR_SETTINGS).netAmount)
      .toBe(RS(62000) + Math.round(RS(62000) * 10 / 30))
  })

  it('settles from the first unpaid month, else from the last working day\'s month', () => {
    expect(settledFromPeriod({ endDate: D('2026-10-10'), data: { _salaryFrom: '2026-11-01T00:00:00.000Z' } })).toBe('2026-11')
    expect(settledFromPeriod({ endDate: D('2026-10-10'), data: { _salaryFrom: null } })).toBe('2026-10')
    expect(settledFromPeriod({ endDate: D('2026-10-10'), data: {} })).toBe('2026-10')
  })
})

// ─── through the API ────────────────────────────────────────────────────────

let app: FastifyInstance
let tenantA: string, tenantB: string
let bankA1: string, bankA2: string, bankB: string, codeA2: string
let kitchen: string
const users: Record<string, { id: string; token: string }> = {}
const emps: Record<string, string> = {}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${stamp}@fnf.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
async function mkEmp(key: string, tenantId: string, extra: Record<string, unknown> = {}) {
  const e = await prisma.hrEmployee.create({
    data: { tenantId, employeeCode: `F-${String(Object.keys(emps).length + 1).padStart(4, '0')}`, fullName: key, grossSalaryCents: RS(52000), basicSalaryCents: RS(30000), monthlyTaxCents: RS(1000), joiningDate: D('2026-01-01'), ...extra },
  })
  emps[key] = e.id
  return e.id
}
async function mkBank(tenantId: string, name: string) {
  const accountCode = await linkBankLedgerAccount(tenantId, name)
  const b = await prisma.bankAccount.create({ data: { tenantId, name, bankName: name, accountCode } })
  return { id: b.id, code: accountCode }
}
const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/hr${url}`, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}` } })

type Ln = { type: string; amountCents: number | bigint; account: { code: string } }
async function entry(tenantId: string, reference: string) {
  return prisma.journalEntry.findFirst({ where: { tenantId, reference }, include: { lines: { include: { account: { select: { code: true } } } } } })
}
const amt = (lines: Ln[], code: string, type: 'debit' | 'credit') => lines.filter((l) => l.account.code === code && l.type === type).reduce((a, l) => a + Number(l.amountCents), 0)
const balanced = (lines: Ln[]) => amt(lines.map((l) => ({ ...l, account: { code: 'x' } })), 'x', 'debit') === amt(lines.map((l) => ({ ...l, account: { code: 'x' } })), 'x', 'credit')

/** HR raises it, which signs its HR step (auto); management takes the last. */
async function raise(section: string, data: Record<string, unknown>) {
  const r = await call('hr', 'POST', `/records/${section}`, { data })
  expect(r.statusCode, r.body).toBe(201)
  return r.json() as { id: string; status: string }
}
const decide = (who: string, section: string, id: string, extra: Record<string, unknown> = {}) =>
  call(who, 'POST', `/records/${section}/${id}/decide`, { decision: 'approved', ...extra })
/** HR sends the run to finance and it is checked (here by the CEO) before it is approved (owner, 2026-10-30). */
async function toApprover(runId: string) {
  const sent = await call('hr', 'POST', `/payroll/runs/${runId}/send-to-finance`)
  expect(sent.statusCode, sent.body).toBe(200)
  const passed = await call('ceo', 'POST', `/payroll/runs/${runId}/finance-pass`, {})
  expect(passed.statusCode, passed.body).toBe(200)
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'GS Foods (fnf)', slug: `gs-fnf-${stamp}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Karachi Bites (fnf)', slug: `kb-fnf-${stamp}` } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  // These tests are about the ledger, not attendance: no day is docked for a missing punch.
  for (const t of [tenantA, tenantB]) await saveSettings(t, { ...(await getSettings(t)), absentWithoutPunchFrom: null })
  bankA1 = (await mkBank(tenantA, 'HBL Operations')).id
  const a2 = await mkBank(tenantA, 'Meezan Payroll')
  bankA2 = a2.id; codeA2 = a2.code
  bankB = (await mkBank(tenantB, 'UBL')).id
  kitchen = (await prisma.department.create({ data: { tenantId: tenantA, name: 'Kitchen' } })).id

  await mkUser('ceo', 'admin', tenantA)
  await mkUser('hr', 'hr', tenantA)
  await mkUser('mgmt', 'management', tenantA)
  await mkUser('ceoB', 'admin', tenantB)

  await mkEmp('Leaver', tenantA, { departmentId: kitchen, paymentMethod: 'bank' })
  await mkEmp('Cash Cook', tenantA, { departmentId: kitchen, paymentMethod: 'cash' })
  await mkEmp('Cheque Cook', tenantA, { departmentId: kitchen, paymentMethod: 'cheque' })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(hrRoutes, { prefix: '/hr' })
  await app.ready()

  const settings = await call('hr', 'PUT', '/settings', {
    ...DEFAULT_HR_SETTINGS,
    eobi: { enabled: true, employeePct: 1, employerPct: 5, base: 'fixed', fixedWageCents: RS(40000) },
    sessi: { employerPct: 6, wageCeilingCents: null },
    absentWithoutPunchFrom: null, // about the ledger, not attendance: a day with no punch is not docked
  })
  expect(settings.statusCode).toBe(200)
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('staff loans are paid out from where the loan says', () => {
  let leaverLoan: string

  it('a cash loan credits the safe (1010)', async () => {
    const loan = await raise('loan', { employee: emps['Leaver'], type: 'loan', amount: RS(10000), installments: 4, firstDeduction: '2026-08-01', paidFrom: 'cash' })
    leaverLoan = loan.id
    // Raised by HR: the HR step is already signed (auto), the record waits on management.
    const at = await prisma.hrRecord.findUniqueOrThrow({ where: { id: loan.id } })
    expect([at.status, at.currentStep]).toEqual(['submitted', 1])
    expect((at.approvals as Array<{ auto?: boolean }>)[0]?.auto).toBe(true)
    expect((await decide('mgmt', 'loan', loan.id)).json().status).toBe('approved')
    const e = await entry(tenantA, `hr.loan.disbursement:${loan.id}`)
    expect(amt(e!.lines, '1350', 'debit')).toBe(RS(10000))
    expect(amt(e!.lines, '1010', 'credit')).toBe(RS(10000))
    expect(amt(e!.lines, '1020', 'credit')).toBe(0)
    void leaverLoan
  })

  it('refuses another company\'s bank on the form and at approval; pays from the bank named', async () => {
    const foreign = await call('hr', 'POST', '/records/loan', { data: { employee: emps['Cheque Cook'], type: 'loan', amount: RS(6000), installments: 2, firstDeduction: '2027-06-01', paidFrom: 'bank', bankAccount: bankB } })
    expect(foreign.statusCode).toBe(422)
    const both = await call('hr', 'POST', '/records/loan', { data: { employee: emps['Cheque Cook'], type: 'loan', amount: RS(6000), installments: 2, firstDeduction: '2027-06-01', paidFrom: 'cash', bankAccount: bankA2 } })
    expect(both.statusCode).toBe(422)
    expect(both.json().error.code).toBe('BANK_ACCOUNT_ON_CASH')

    const loan = await raise('loan', { employee: emps['Cheque Cook'], type: 'loan', amount: RS(6000), installments: 2, firstDeduction: '2027-06-01', paidFrom: 'bank', bankAccount: bankA2 })
    // The approver names company B's bank: refused, and nothing approved.
    const bad = await decide('mgmt', 'loan', loan.id, { bankAccountId: bankB })
    expect(bad.statusCode).toBe(422)
    expect(bad.json().error.code).toBe('BANK_ACCOUNT_NOT_IN_COMPANY')
    expect((await prisma.hrRecord.findUniqueOrThrow({ where: { id: loan.id } })).status).toBe('submitted')
    expect(await entry(tenantA, `hr.loan.disbursement:${loan.id}`)).toBeNull()

    expect((await decide('mgmt', 'loan', loan.id)).json().status).toBe('approved')
    const e = await entry(tenantA, `hr.loan.disbursement:${loan.id}`)
    expect(amt(e!.lines, codeA2, 'credit')).toBe(RS(6000))
    // The cancel reversal credits back the same bank.
    expect((await call('hr', 'POST', `/records/loan/${loan.id}/cancel`)).statusCode).toBe(200)
    const rev = await entry(tenantA, `hr.loan.disbursement.reversal:${loan.id}`)
    expect(amt(rev!.lines, codeA2, 'debit')).toBe(RS(6000))
    expect(amt(rev!.lines, '1350', 'credit')).toBe(RS(6000))
  })

  it('the final approval classifies the loan payment (Official / Unofficial) on the entry, in its company', async () => {
    const loan = await raise('loan', { employee: emps['Cheque Cook'], type: 'loan', amount: RS(2000), installments: 1, firstDeduction: '2027-06-01', paidFrom: 'bank', bankAccount: bankA2 })
    expect((await decide('mgmt', 'loan', loan.id, { classification: 'unofficial', taxStatus: 'not_applicable' })).json().status).toBe('approved')
    const e = await entry(tenantA, `hr.loan.disbursement:${loan.id}`)
    expect(await prisma.paymentClassification.findUnique({ where: { journalEntryId: e!.id } })).toMatchObject({ tenantId: tenantA, classification: 'unofficial' })
    expect((await call('hr', 'POST', `/records/loan/${loan.id}/cancel`)).statusCode).toBe(200)
  })

  it('with several banks and none named, a bank loan is refused rather than guessed', async () => {
    const loan = await raise('loan', { employee: emps['Cheque Cook'], type: 'advance', amount: RS(1000), installments: 1, firstDeduction: '2027-06-01' })
    const r = await decide('mgmt', 'loan', loan.id)
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('BANK_ACCOUNT_REQUIRED')
    // The approver picks it.
    expect((await decide('mgmt', 'loan', loan.id, { paidFrom: 'bank', bankAccountId: bankA1 })).json().status).toBe('approved')
    const e = await entry(tenantA, `hr.loan.disbursement:${loan.id}`)
    expect(amt(e!.lines, '1020', 'credit')).toBe(RS(1000))
    expect((await call('hr', 'POST', `/records/loan/${loan.id}/cancel`)).statusCode).toBe(200)
  })
})

describe('payroll is paid from the right place, on the day it was paid', () => {
  let aug: string

  it('locks August, then refuses a foreign bank, an unnamed bank among several, and a closed day', async () => {
    aug = (await call('hr', 'POST', '/payroll/runs', { period: '2026-08' })).json().id
    await toApprover(aug)
    expect((await call('ceo', 'POST', `/payroll/runs/${aug}/approve`)).statusCode).toBe(200)
    expect((await call('ceo', 'POST', `/payroll/runs/${aug}/lock`)).statusCode).toBe(200)

    expect((await call('ceoB', 'POST', `/payroll/runs/${aug}/paid`, { bankAccountId: bankA2 })).statusCode).toBe(404)
    const foreign = await call('ceo', 'POST', `/payroll/runs/${aug}/paid`, { bankAccountId: bankB, paidOn: '2026-09-06' })
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('BANK_ACCOUNT_NOT_IN_COMPANY')
    const unnamed = await call('ceo', 'POST', `/payroll/runs/${aug}/paid`, { paidOn: '2026-09-06' })
    expect(unnamed.statusCode).toBe(422)
    expect(unnamed.json().error.code).toBe('BANK_ACCOUNT_REQUIRED')
    expect((await call('ceo', 'POST', `/payroll/runs/${aug}/paid`, { bankAccountId: bankA2, paidOn: '2999-01-01' })).statusCode).toBe(422)

    const lock = await prisma.periodLock.create({ data: { tenantId: tenantA, lockedThrough: new Date('2026-09-05T18:59:59.999Z'), lockedBy: users['ceo']!.id } })
    try {
      const closed = await call('ceo', 'POST', `/payroll/runs/${aug}/paid`, { bankAccountId: bankA2, paidOn: '2026-09-05' })
      expect(closed.statusCode).toBe(422)
      expect(closed.json().error.code).toBe('PERIOD_LOCKED')
    } finally {
      await prisma.periodLock.delete({ where: { id: lock.id } })
    }
    expect((await prisma.hrPayrollRun.findUniqueOrThrow({ where: { id: aug } })).paidAt).toBeNull()
  })

  it('credits the safe for cash staff and the bank picked for bank and cheque staff, summing to the accrual', async () => {
    const r = await call('mgmt', 'POST', `/payroll/runs/${aug}/paid`, { bankAccountId: bankA2, cashCode: '1010', paidOn: '2026-09-06' })
    expect(r.statusCode, r.body).toBe(200)
    const slips = await prisma.hrPayslip.findMany({ where: { runId: aug }, include: { employee: { select: { fullName: true } } } })
    const net = (name: string) => slips.find((s) => s.employee.fullName === name)!.netCents
    const accrual = await entry(tenantA, `hr.payroll.accrual:${aug}`)
    const pay = await entry(tenantA, `hr.payroll.payment:${aug}`)
    expect(pay!.entryDate.toISOString()).toBe('2026-09-06T00:00:00.000Z')
    expect(amt(pay!.lines, '2020', 'debit')).toBe(amt(accrual!.lines, '2020', 'credit'))
    expect(amt(pay!.lines, '1010', 'credit')).toBe(net('Cash Cook'))
    expect(amt(pay!.lines, codeA2, 'credit')).toBe(net('Leaver') + net('Cheque Cook'))
    expect(balanced(pay!.lines)).toBe(true)
    const payment = (r.json().totals as Record<string, { cash: { staff: number }; bank: { staff: number } }>)['payment']!
    expect(payment.cash.staff).toBe(1)
    expect(payment.bank.staff).toBe(2)
    // Paying twice: refused, one entry.
    expect((await call('mgmt', 'POST', `/payroll/runs/${aug}/paid`, { bankAccountId: bankA2 })).statusCode).toBe(409)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA, reference: `hr.payroll.payment:${aug}` } })).toBe(1)
  })
})

describe('a full & final is booked, paid and never pays a month twice', () => {
  let sep: string, fnf: string
  let calc: Record<string, unknown>

  it('starts after the last payroll that HAS the leaver — a draft one too', async () => {
    sep = (await call('hr', 'POST', '/payroll/runs', { period: '2026-09' })).json().id
    await prisma.hrEmployee.update({ where: { id: emps['Leaver']! }, data: { status: 'resigned', lastWorkingDay: D('2026-10-10') } })
    fnf = (await raise('final_settlement', { employee: emps['Leaver'], lastWorkingDay: '2026-10-10' })).id

    // Company B sees none of it.
    expect((await call('ceoB', 'POST', '/final-settlement/calculate', { employeeId: emps['Leaver'], lastWorkingDay: '2026-10-10' })).statusCode).toBe(404)

    const r = await call('hr', 'POST', '/final-settlement/calculate', { employeeId: emps['Leaver'], lastWorkingDay: '2026-10-10', recordId: fnf })
    expect(r.statusCode, r.body).toBe(200)
    calc = r.json()
    expect(calc['paidThrough']).toBe('2026-09')
    expect(calc['paidThroughStatus']).toBe('draft')
    expect(calc['salaryFrom']).toBe('2026-10-01T00:00:00.000Z')
    expect(calc['salaryPayable']).toBe(Math.round(RS(52000) * 10 / 31))
    // 10,000 over 4: August (locked) and September (draft) each took 2,500.
    expect(calc['loanRecovery']).toBe(RS(5000))
    expect(calc['incomeTax']).toBe(RS(1000))
    expect(calc['eobiEmployee']).toBe(RS(400))
    expect(calc['eobiEmployer']).toBe(RS(2000))
    expect(calc['sessiEmployer']).toBe(Math.round(Math.round(RS(52000) * 10 / 31) * 0.06))

    const keys = ['salaryPayable', 'otPayable', 'leaveEncashment', 'loanRecovery', 'incomeTax', 'eobiEmployee', 'eobiEmployer', 'sessiEmployer']
    const saved = await call('hr', 'PATCH', `/records/final_settlement/${fnf}`, { data: { ...Object.fromEntries(keys.map((k) => [k, calc[k]])), deductions: 0, otherAdjustments: 0 } })
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.json().amountCents).toBe(calc['netAmount'])
  })

  it('is approved only once every payroll with the leaver is locked', async () => {
    const at = await prisma.hrRecord.findUniqueOrThrow({ where: { id: fnf } })
    expect([at.status, at.currentStep]).toEqual(['submitted', 1]) // HR step signed by raising
    const open = await decide('mgmt', 'final_settlement', fnf)
    expect(open.statusCode).toBe(409)
    expect(open.json().error.code).toBe('FNF_PAYROLL_OPEN')
    expect(await entry(tenantA, `hr.final_settlement.accrual:${fnf}`)).toBeNull()

    await toApprover(sep)
    expect((await call('ceo', 'POST', `/payroll/runs/${sep}/approve`)).statusCode).toBe(200)
    expect((await call('ceo', 'POST', `/payroll/runs/${sep}/lock`)).statusCode).toBe(200)
    const ok = await decide('mgmt', 'final_settlement', fnf)
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().status).toBe('approved')
    expect(ok.json().data._salaryFrom).toBe('2026-10-01T00:00:00.000Z')
  })

  it('books a balanced accrual in its own company\'s chart only, recovering the loan to zero', async () => {
    const e = await entry(tenantA, `hr.final_settlement.accrual:${fnf}`)
    expect(e).not.toBeNull()
    expect(balanced(e!.lines)).toBe(true)
    const net = calc['netAmount'] as number
    const salary = calc['salaryPayable'] as number
    const sessi = calc['sessiEmployer'] as number
    expect(amt(e!.lines, '6030', 'debit')).toBe(salary + RS(2000) + sessi) // Kitchen wages + employer EOBI / SESSI
    // Statutory payables (H7): EOBI employee + employer to 2043, SESSI to
    // 2044, salary tax to 2042 — nothing to the old 2090 / 2040 stand-ins.
    expect(amt(e!.lines, '2043', 'credit')).toBe(RS(400) + RS(2000))
    expect(amt(e!.lines, '2044', 'credit')).toBe(sessi)
    expect(amt(e!.lines, '2042', 'credit')).toBe(RS(1000))
    expect(amt(e!.lines, '2090', 'credit') + amt(e!.lines, '2040', 'credit')).toBe(0)
    expect(amt(e!.lines, '6036', 'debit')).toBe(0) // under a year of service: no gratuity
    expect(amt(e!.lines, '1350', 'credit')).toBe(RS(5000))
    expect(amt(e!.lines, '2020', 'credit')).toBe(net)
    expect(net).toBe(salary - RS(5000) - RS(1000) - RS(400))
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantB, reference: `hr.final_settlement.accrual:${fnf}` } })).toBe(0)

    // The loan register and 1350 agree: nothing outstanding, and the loan's
    // debit is cleared by August, September and the settlement.
    const detail = (await call('hr', 'GET', `/employees/${emps['Leaver']}`)).json()
    expect(detail.loans[0].outstandingCents).toBe(0)
    const staffLoans = await prisma.journalLine.findMany({ where: { account: { code: '1350', tenantId: tenantA }, journalEntry: { tenantId: tenantA } } })
    const bal = staffLoans.reduce((a, l) => a + (l.type === 'debit' ? 1 : -1) * Number(l.amountCents), 0)
    expect(bal).toBe(0)
  })

  it('leaves the leaver out of the next payroll', async () => {
    const oct = await call('hr', 'POST', '/payroll/runs', { period: '2026-10' })
    expect(oct.statusCode).toBe(201)
    const slips = await prisma.hrPayslip.findMany({ where: { runId: oct.json().id }, select: { employeeId: true } })
    expect(slips.map((s) => s.employeeId)).not.toContain(emps['Leaver'])
    expect(slips.map((s) => s.employeeId)).toContain(emps['Cash Cook'])
  })

  it('is paid once, from the bank picked, on the day paid — company B gets 404', async () => {
    expect((await call('ceoB', 'POST', `/final-settlement/${fnf}/paid`, { bankAccountId: bankB })).statusCode).toBe(404)
    expect((await call('hr', 'POST', `/final-settlement/${fnf}/paid`, { bankAccountId: bankA2 })).statusCode).toBe(403)
    const foreign = await call('mgmt', 'POST', `/final-settlement/${fnf}/paid`, { bankAccountId: bankB })
    expect(foreign.statusCode).toBe(422)
    expect((await call('mgmt', 'POST', `/final-settlement/${fnf}/paid`, { bankAccountId: bankA2, paidOn: '2999-01-01' })).statusCode).toBe(422)

    const today = pktToday().toISOString().slice(0, 10)
    const r = await call('mgmt', 'POST', `/final-settlement/${fnf}/paid`, { bankAccountId: bankA2, paidOn: today })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().data._paidFrom.code).toBe(codeA2)
    const pay = await entry(tenantA, `hr.final_settlement.payment:${fnf}`)
    expect(amt(pay!.lines, '2020', 'debit')).toBe(calc['netAmount'])
    expect(amt(pay!.lines, codeA2, 'credit')).toBe(calc['netAmount'])
    expect(pay!.entryDate.toISOString().slice(0, 10)).toBe(today)

    expect((await call('mgmt', 'POST', `/final-settlement/${fnf}/paid`, { bankAccountId: bankA2 })).statusCode).toBe(409)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA, reference: `hr.final_settlement.payment:${fnf}` } })).toBe(1)
    // Paid: it stays.
    const cancel = await call('hr', 'POST', `/records/final_settlement/${fnf}/cancel`)
    expect(cancel.statusCode).toBe(409)
    expect(cancel.json().error.code).toBe('FNF_PAID')
    // The record lists what it posted.
    const view = (await call('hr', 'GET', `/records/final_settlement/${fnf}`)).json()
    expect(view.postings.map((p: { reference: string }) => p.reference.split(':')[0]).sort()).toEqual(['hr.final_settlement.accrual', 'hr.final_settlement.payment'])
  })

  it('refuses a settlement worked out before payroll moved, and reverses one cancelled', async () => {
    await prisma.hrEmployee.update({ where: { id: emps['Cash Cook']! }, data: { status: 'resigned', lastWorkingDay: D('2026-10-20') } })
    const oct = await prisma.hrPayrollRun.findFirstOrThrow({ where: { tenantId: tenantA, period: '2026-10' } })
    const stale = (await raise('final_settlement', { employee: emps['Cash Cook'], lastWorkingDay: '2026-10-20' })).id
    const c1 = (await call('hr', 'POST', '/final-settlement/calculate', { employeeId: emps['Cash Cook'], lastWorkingDay: '2026-10-20', recordId: stale })).json()
    expect(c1.salaryFrom).toBe('2026-11-01T00:00:00.000Z') // the October draft has them
    expect(c1.salaryPayable).toBe(0)
    // October is deleted instead of locked: the settlement would leave
    // October unpaid, so its approval is refused.
    expect((await call('hr', 'DELETE', `/payroll/runs/${oct.id}`)).statusCode).toBe(204)
    const r = await decide('mgmt', 'final_settlement', stale)
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('FNF_STALE')
    expect((await call('hr', 'POST', `/records/final_settlement/${stale}/cancel`)).statusCode).toBe(200)

    // Worked out again, it pays October and is booked; cancelled, it is reversed.
    const id = (await raise('final_settlement', { employee: emps['Cash Cook'], lastWorkingDay: '2026-10-20' })).id
    const c2 = (await call('hr', 'POST', '/final-settlement/calculate', { employeeId: emps['Cash Cook'], lastWorkingDay: '2026-10-20', recordId: id })).json()
    expect(c2.salaryFrom).toBe('2026-10-01T00:00:00.000Z')
    expect(c2.salaryPayable).toBe(Math.round(RS(52000) * 20 / 31))
    await call('hr', 'PATCH', `/records/final_settlement/${id}`, { data: { salaryPayable: c2.salaryPayable, incomeTax: c2.incomeTax, eobiEmployee: c2.eobiEmployee, eobiEmployer: c2.eobiEmployer, sessiEmployer: c2.sessiEmployer } })
    expect((await decide('mgmt', 'final_settlement', id)).json().status).toBe('approved')
    const booked = await entry(tenantA, `hr.final_settlement.accrual:${id}`)
    expect(balanced(booked!.lines)).toBe(true)
    // Approved, it cannot be edited — the books hold these figures.
    expect((await call('hr', 'PATCH', `/records/final_settlement/${id}`, { data: { salaryPayable: 1 } })).statusCode).toBe(409)

    expect((await call('hr', 'POST', `/records/final_settlement/${id}/cancel`)).statusCode).toBe(200)
    const rev = await entry(tenantA, `hr.final_settlement.accrual.reversal:${id}`)
    expect(rev).not.toBeNull()
    expect(amt(rev!.lines, '2020', 'debit')).toBe(amt(booked!.lines, '2020', 'credit'))
    expect(amt(rev!.lines, '6030', 'credit')).toBe(amt(booked!.lines, '6030', 'debit'))
    // Cancelled, payroll pays them again.
    const run = (await call('hr', 'POST', '/payroll/runs', { period: '2026-10' })).json()
    const slips = await prisma.hrPayslip.findMany({ where: { runId: run.id }, select: { employeeId: true } })
    expect(slips.map((s) => s.employeeId)).toContain(emps['Cash Cook'])
    expect((await call('hr', 'DELETE', `/payroll/runs/${run.id}`)).statusCode).toBe(204)
  })

  it('refuses a settlement that would leave the leaver owing, and one dated in a closed period', async () => {
    await prisma.hrEmployee.update({ where: { id: emps['Cheque Cook']! }, data: { status: 'resigned', lastWorkingDay: D('2026-10-05') } })
    const owing = (await raise('final_settlement', { employee: emps['Cheque Cook'], lastWorkingDay: '2026-10-05' })).id
    await call('hr', 'PATCH', `/records/final_settlement/${owing}`, { data: { salaryPayable: RS(1000), deductions: RS(5000) } })
    const neg = await decide('mgmt', 'final_settlement', owing)
    expect(neg.statusCode).toBe(422)
    expect(neg.json().error.code).toBe('FNF_NEGATIVE')
    expect((await call('hr', 'POST', `/records/final_settlement/${owing}/cancel`)).statusCode).toBe(200)

    const id = (await raise('final_settlement', { employee: emps['Cheque Cook'], lastWorkingDay: '2026-10-05' })).id
    const c = (await call('hr', 'POST', '/final-settlement/calculate', { employeeId: emps['Cheque Cook'], lastWorkingDay: '2026-10-05', recordId: id })).json()
    await call('hr', 'PATCH', `/records/final_settlement/${id}`, { data: { salaryPayable: c.salaryPayable, incomeTax: c.incomeTax, eobiEmployee: c.eobiEmployee, eobiEmployer: c.eobiEmployer, sessiEmployer: c.sessiEmployer } })
    const lock = await prisma.periodLock.create({ data: { tenantId: tenantA, lockedThrough: new Date(pktToday().getTime() + 86_400_000 - 5 * 3_600_000 - 1), lockedBy: users['ceo']!.id } })
    try {
      const closed = await decide('mgmt', 'final_settlement', id)
      expect(closed.statusCode).toBe(422)
      expect(closed.json().error.code).toBe('PERIOD_LOCKED')
      expect((await prisma.hrRecord.findUniqueOrThrow({ where: { id } })).status).toBe('submitted')
    } finally {
      await prisma.periodLock.delete({ where: { id: lock.id } })
    }
    expect((await decide('mgmt', 'final_settlement', id)).json().status).toBe('approved')
  })

  it('books settlements approved before approval booked them, once', async () => {
    const legacyEmp = await mkEmp('Old Leaver', tenantA, { status: 'resigned', lastWorkingDay: D('2026-07-31') })
    const legacy = await prisma.hrRecord.create({
      data: { tenantId: tenantA, section: 'final_settlement', formVersion: 0, employeeId: legacyEmp, status: 'approved', endDate: D('2026-07-31'), amountCents: RS(9000), data: { salaryPayable: RS(10000), deductions: RS(1000), netAmount: RS(9000) } },
    })
    const broken = await prisma.hrRecord.create({
      data: { tenantId: tenantA, section: 'final_settlement', formVersion: 0, employeeId: legacyEmp, status: 'approved', endDate: D('2026-07-31'), amountCents: RS(500), data: {} },
    })
    expect((await call('hr', 'POST', '/final-settlement/post-unposted')).statusCode).toBe(403)
    // Company B's run books only company B's.
    expect((await call('ceoB', 'POST', '/final-settlement/post-unposted')).json().posted).toEqual([])

    const r = (await call('ceo', 'POST', '/final-settlement/post-unposted')).json()
    expect(r.posted).toContain(legacy.id)
    expect(r.failed.map((f: { id: string }) => f.id)).toEqual([broken.id])
    const e = await entry(tenantA, `hr.final_settlement.accrual:${legacy.id}`)
    expect(e!.entryDate.toISOString()).toBe(pktToday().toISOString())
    expect(amt(e!.lines, '6031', 'debit')).toBe(RS(9000)) // no department: front of house
    expect(amt(e!.lines, '2020', 'credit')).toBe(RS(9000))

    const again = (await call('ceo', 'POST', '/final-settlement/post-unposted')).json()
    expect(again.posted).toEqual([])
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA, reference: `hr.final_settlement.accrual:${legacy.id}` } })).toBe(1)
  })

  it('cancelling a settlement booked before H7 reverses its 2090 / 2040 lines, and a replacement then books (2043 / 2044 / 2042)', async () => {
    const who = await mkEmp('Era Leaver', tenantA, { departmentId: kitchen, status: 'resigned', lastWorkingDay: D('2026-10-15') })
    // Approved and booked by the old code: EOBI / SESSI to 2090, tax to 2040.
    const old = await prisma.hrRecord.create({
      data: {
        tenantId: tenantA, section: 'final_settlement', formVersion: 0, employeeId: who, status: 'approved', endDate: D('2026-10-15'), amountCents: RS(20000),
        data: { salaryPayable: RS(22000), incomeTax: RS(1000), eobiEmployee: RS(1000), eobiEmployer: RS(2000), sessiEmployer: RS(500), netAmount: RS(20000), _salaryFrom: '2026-10-01T00:00:00.000Z' },
      },
    })
    await postJournalEntry({
      tenantId: tenantA, sourceType: 'hr.final_settlement.accrual', sourceId: old.id, description: 'Full & final (old)', postedBy: users['ceo']!.id,
      lines: [
        { accountCode: '6030', type: 'debit', amountCents: RS(24500) },
        { accountCode: '2090', type: 'credit', amountCents: RS(3500) },
        { accountCode: '2040', type: 'credit', amountCents: RS(1000) },
        { accountCode: '2020', type: 'credit', amountCents: RS(20000) },
      ],
    })
    expect((await call('hr', 'POST', `/records/final_settlement/${old.id}/cancel`)).statusCode).toBe(200)
    const rev = await entry(tenantA, `hr.final_settlement.accrual.reversal:${old.id}`)
    expect(rev).not.toBeNull()
    expect(amt(rev!.lines, '2090', 'debit')).toBe(RS(3500))
    expect(amt(rev!.lines, '2040', 'debit')).toBe(RS(1000))
    expect(amt(rev!.lines, '2020', 'debit')).toBe(RS(20000))
    expect(amt(rev!.lines, '2043', 'debit') + amt(rev!.lines, '2044', 'debit') + amt(rev!.lines, '2042', 'debit')).toBe(0)

    // The replacement books: the cancelled sibling's reversal is found under
    // its real reference ('…accrual.reversal:<id>'), so no FNF_ALREADY_APPROVED.
    const id = (await raise('final_settlement', { employee: who, lastWorkingDay: '2026-10-15' })).id
    const c = (await call('hr', 'POST', '/final-settlement/calculate', { employeeId: who, lastWorkingDay: '2026-10-15', recordId: id })).json()
    await call('hr', 'PATCH', `/records/final_settlement/${id}`, { data: { salaryPayable: c.salaryPayable, incomeTax: c.incomeTax, eobiEmployee: c.eobiEmployee, eobiEmployer: c.eobiEmployer, sessiEmployer: c.sessiEmployer } })
    const ok = await decide('mgmt', 'final_settlement', id)
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().status).toBe('approved')
    const booked = await entry(tenantA, `hr.final_settlement.accrual:${id}`)
    expect(balanced(booked!.lines)).toBe(true)
    expect(amt(booked!.lines, '2043', 'credit')).toBe(c.eobiEmployee + c.eobiEmployer)
    expect(amt(booked!.lines, '2044', 'credit')).toBe(c.sessiEmployer)
    expect(amt(booked!.lines, '2042', 'credit')).toBe(c.incomeTax)
    expect(amt(booked!.lines, '2090', 'credit') + amt(booked!.lines, '2040', 'credit')).toBe(0)

    // Cancel and replace once more: still one live settlement at a time.
    expect((await call('hr', 'POST', `/records/final_settlement/${id}/cancel`)).statusCode).toBe(200)
    const third = (await raise('final_settlement', { employee: who, lastWorkingDay: '2026-10-15' })).id
    const c3 = (await call('hr', 'POST', '/final-settlement/calculate', { employeeId: who, lastWorkingDay: '2026-10-15', recordId: third })).json()
    await call('hr', 'PATCH', `/records/final_settlement/${third}`, { data: { salaryPayable: c3.salaryPayable, incomeTax: c3.incomeTax, eobiEmployee: c3.eobiEmployee, eobiEmployer: c3.eobiEmployer, sessiEmployer: c3.sessiEmployer } })
    expect((await decide('mgmt', 'final_settlement', third)).json().status).toBe('approved')
    expect(await entry(tenantA, `hr.final_settlement.accrual:${third}`)).not.toBeNull()
  })
})
