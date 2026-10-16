// Statutory payroll payables — paid through the ONE tax payments register,
// accrued vs paid from ONE computation, and the one-time reclass out of the
// pre-H7 stand-ins (finance wave B, H7 — accounting/taxPayments.ts,
// accounting/statutory.ts, accounting/statutoryRoutes.ts).
//
//   • An EOBI challan: POST /accounting/sales-tax-return/payments
//     { authority 'eobi' } posts Dr 2043 / Cr the company's bank and binds to
//     the ACTIVE company; another company voiding it is 404; a second one for
//     the month is 409; no input set-off (422); a closed date is 422 and
//     nothing is saved; an operator's own account on 2043 is 422.
//   • Linking a manual entry that debits 2042 works; one that debits 2090 is
//     not a statutory payment (422).
//   • GET /accounting/statutory: accrued (from 'hr.' entries) vs paid per
//     month and scheme — nets to 0 after accrual + payment; B never sees A.
//   • The reclass: preview splits HR's 2090 / 2040 credits per entry (payslip
//     lines, settlement figures, pro rata on drift, reversals subtract); post
//     moves them once ('statutory.reclass:<company>'), 409 after; over the
//     balance 422; B's books never touched.
//   • Close checks warn only for the company with residue / unpaid challans.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { postJournalEntry, reverseJournalEntry } from '../src/modules/accounting/journal.js'
import { parsePktEndOfDay } from '../src/modules/accounting/dates.js'
import { accountingRoutes } from '../src/modules/accounting/routes.js'
import { statutoryRoutes } from '../src/modules/accounting/statutoryRoutes.js'
import { statutoryCloseChecks } from '../src/modules/accounting/statutory.js'
import type { CloseCheckContext } from '../src/modules/accounting/closeCheckTypes.js'

const RUN = Math.random().toString(36).slice(2, 8)
let app: FastifyInstance
const staff: Record<string, { id: string; token: string }> = {}
let tenantA: string, tenantB: string, tenantC: string, tenantD: string, tenantR: string, tenantR2: string
let bankA: string, bankB: string

const pktIso = (d: Date) => new Date(d.getTime() + 5 * 3_600_000).toISOString().slice(0, 10)
const TODAY = pktIso(new Date())
const M2 = TODAY.slice(0, 7)
const M1 = (() => {
  const [y, m] = M2.split('-').map(Number) as [number, number]
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
})()
const lastDay = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`
}
const at = (iso: string) => new Date(`${iso}T10:00:00+05:00`)

async function company(name: string) {
  const id = (await prisma.tenant.create({ data: { name, slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${RUN}` } })).id
  await ensureChartOfAccounts(id)
  return id
}
async function mkStaff(key: string, role: string, tenantId: string, alsoIn: string[] = []) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@statutory.test`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId },
  })
  for (const t of [tenantId, ...alsoIn]) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  staff[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${staff[who]!.token}`, ...headers } })

let seq = 0
async function post(tenantId: string, sourceType: string, sourceId: string, when: Date, lines: Array<{ accountCode: string; type: 'debit' | 'credit'; amountCents: number }>) {
  return postJournalEntry({ tenantId, sourceType, sourceId, description: sourceType, postedBy: 'test', entryDate: when, lines })
}
async function entry(tenantId: string, reference: string) {
  const je = await prisma.journalEntry.findFirst({
    where: { tenantId, reference },
    include: { lines: { include: { account: { select: { code: true, tenantId: true } } } } },
  })
  if (!je) return null
  for (const l of je.lines) expect(l.account.tenantId).toBe(tenantId)
  return je.lines.map((l) => ({ code: l.account.code, type: l.type, amount: Number(l.amountCents) }))
}
const amt = (lines: Array<{ code: string; type: string; amount: number }>, code: string, type: string) =>
  lines.filter((l) => l.code === code && l.type === type).reduce((t, l) => t + l.amount, 0)
async function balance(tenantId: string, code: string) {
  const ls = await prisma.journalLine.findMany({ where: { account: { tenantId, code } }, select: { type: true, amountCents: true } })
  return ls.reduce((t, l) => t + (l.type === 'credit' ? Number(l.amountCents) : -Number(l.amountCents)), 0)
}
async function accountId(tenantId: string, code: string) {
  return (await prisma.account.findFirstOrThrow({ where: { tenantId, code }, select: { id: true } })).id
}
const ctx = (tenantId: string, months: string[]): CloseCheckContext => ({
  db: prisma, tenantId, prevLock: null, newLock: parsePktEndOfDay(lastDay(months[months.length - 1]!)), months, isYearEnd: false,
})
const check = (key: string) => statutoryCloseChecks.find((c) => c.key === key)!

beforeAll(async () => {
  tenantA = await company('Stat A')
  tenantB = await company('Stat B')
  tenantC = await company('Stat C locked')
  tenantD = await company('Stat D own 2043')
  tenantR = await company('Stat R reclass')
  tenantR2 = await company('Stat R2 locked reclass')
  bankA = (await prisma.bankAccount.create({ data: { tenantId: tenantA, name: 'A Operating', accountCode: '1020' } })).id
  bankB = (await prisma.bankAccount.create({ data: { tenantId: tenantB, name: 'B Operating', accountCode: '1020' } })).id
  await mkStaff('finA', 'finance', tenantA)
  await mkStaff('adminA', 'admin', tenantA)
  await mkStaff('mgmtA', 'management', tenantA)
  await mkStaff('adminB', 'admin', tenantB)
  await mkStaff('finAB', 'finance', tenantA, [tenantB])
  await mkStaff('finC', 'finance', tenantC)
  await mkStaff('finD', 'finance', tenantD)
  await mkStaff('finR', 'finance', tenantR)
  await mkStaff('finR2', 'finance', tenantR2)

  // A's M1 payroll accrued EOBI 6,000 and salary tax 2,000 on the new payables.
  await post(tenantA, 'hr.payroll.accrual', randomUUID(), at(`${M1}-28`), [
    { accountCode: '6031', type: 'debit', amountCents: 8_000 },
    { accountCode: '2043', type: 'credit', amountCents: 6_000 },
    { accountCode: '2042', type: 'credit', amountCents: 2_000 },
  ])
  // HR's old challan form (not on the books).
  await prisma.hrRecord.create({
    data: { tenantId: tenantA, section: 'eobi_challan', formVersion: 1, status: 'approved', amountCents: 6_000, effectiveDate: at(`${M1}-01`), startDate: at(`${M2}-01`), data: { scheme: 'EOBI', challanNo: 'PR-02-77' } },
  })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(accountingRoutes, { prefix: '/accounting' })
  await app.register(statutoryRoutes, { prefix: '/accounting/statutory' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

// ─── Paying a challan ─────────────────────────────────────────────────────────

describe('a statutory challan is a tax payment', () => {
  let eobiA: string

  it('EOBI: Dr 2043 / Cr A\'s bank, in the ACTIVE company', async () => {
    const res = await call('finA', 'POST', '/accounting/sales-tax-return/payments', {
      authority: 'eobi', period: M1, paidCents: 6_000, paidAt: `${M2}-01`, bankAccountId: bankA, cprNumber: 'PR-02-001',
    })
    expect(res.statusCode).toBe(201)
    eobiA = res.json().id
    expect(res.json()).toMatchObject({ tenantId: tenantA, authority: 'eobi', paidCents: 6_000, outputSetOffCents: 6_000, bankAccountId: bankA })
    const je = (await entry(tenantA, `salestax.payment:${eobiA}`))!
    expect(amt(je, '2043', 'debit')).toBe(6_000)
    expect(amt(je, '1020', 'credit')).toBe(6_000)
    expect(je).toHaveLength(2)

    // An operator of both companies, working in B: the challan lands in B.
    const inB = await call('finAB', 'POST', '/accounting/sales-tax-return/payments',
      { authority: 'eobi', period: M1, paidCents: 100, paidAt: `${M2}-01` }, { 'x-servd-active-tenant': tenantB })
    expect(inB.statusCode).toBe(201)
    expect(inB.json()).toMatchObject({ tenantId: tenantB, bankAccountId: bankB })
    expect(amt((await entry(tenantB, `salestax.payment:${inB.json().id}`))!, '2043', 'debit')).toBe(100)
  })

  it('B voiding A\'s challan is 404; a second for the month without its own CPR is 422; input set-off is 422', async () => {
    const voidIt = await call('adminB', 'POST', `/accounting/sales-tax-return/payments/${eobiA}/void`, { reason: 'not ours at all' })
    expect(voidIt.statusCode).toBe(404)
    expect(await prisma.salesTaxPayment.count({ where: { id: eobiA } })).toBe(1)

    const again = await call('finA', 'POST', '/accounting/sales-tax-return/payments', { authority: 'eobi', period: M1, paidCents: 10, paidAt: `${M2}-01`, bankAccountId: bankA })
    // A month may take a top-up challan (finance audit 2026-10-17 item 22),
    // but only with its own CPR number — a bare second payment is refused.
    expect(again.statusCode).toBe(422)
    expect(again.json().error.code).toBe('CPR_REQUIRED_FOR_TOP_UP')

    const input = await call('finA', 'POST', '/accounting/sales-tax-return/payments', { authority: 'sessi', period: M1, paidCents: 10, inputSetOffCents: 5, paidAt: `${M2}-01`, bankAccountId: bankA })
    expect(input.statusCode).toBe(422)
    expect(input.json().error.code).toBe('NO_INPUT_SET_OFF')
  })

  it('a closed date is 422 and nothing is saved', async () => {
    await prisma.periodLock.create({ data: { tenantId: tenantC, lockedThrough: parsePktEndOfDay(lastDay(M1)), lockedBy: staff['finC']!.id } })
    const res = await call('finC', 'POST', '/accounting/sales-tax-return/payments', { authority: 'salary_tax', period: M1, paidCents: 700, paidAt: `${M1}-20`, method: 'cash' })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('PERIOD_LOCKED')
    expect(await prisma.salesTaxPayment.count({ where: { tenantId: tenantC } })).toBe(0)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantC } })).toBe(0)
  })

  it('an operator\'s own account on 2043 is a clear 422, nothing saved', async () => {
    await prisma.account.updateMany({ where: { tenantId: tenantD, code: '2043' }, data: { type: 'expense', name: 'Our own EOBI expense' } })
    const res = await call('finD', 'POST', '/accounting/sales-tax-return/payments', { authority: 'eobi', period: M1, paidCents: 500, paidAt: `${M2}-01`, method: 'cash' })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('ACCOUNT_CODE_TAKEN')
    expect(await prisma.salesTaxPayment.count({ where: { tenantId: tenantD } })).toBe(0)
  })
})

// ─── Accrued vs paid ─────────────────────────────────────────────────────────

describe('accrued vs paid — one computation', () => {
  it('EOBI nets to 0 after accrual + payment; salary tax is still owed; the old HR challans are listed', async () => {
    const res = await call('finA', 'GET', `/accounting/statutory?from=${M1}&to=${M2}`)
    expect(res.statusCode).toBe(200)
    const s = res.json()
    expect(s).toMatchObject({ tenantId: tenantA, from: M1, to: M2, canPay: true })
    const m1 = s.months.find((m: { month: string }) => m.month === M1)
    expect(m1.eobi).toMatchObject({ account: '2043', accruedCents: 6_000, legacyAccruedCents: 0, paidCents: 6_000, owedCents: 0, overpaid: false, cleared: true, balanceAtMonthEndCents: 6_000 })
    expect(m1.eobi.payments).toHaveLength(1)
    expect(m1.eobi.payments[0]).toMatchObject({ paidCents: 6_000, cprNumber: 'PR-02-001', linked: false })
    expect(m1.salary_tax).toMatchObject({ account: '2042', accruedCents: 2_000, paidCents: 0, owedCents: 2_000, cleared: false })
    expect(m1.sessi).toMatchObject({ accruedCents: 0, paidCents: 0, owedCents: 0, cleared: false })
    const m2 = s.months.find((m: { month: string }) => m.month === M2)
    expect(m2.eobi.balanceAtMonthEndCents).toBe(0)
    expect(s.totals.eobi).toMatchObject({ accruedCents: 6_000, paidCents: 6_000, owedCents: 0 })
    expect(s.legacyHrChallans).toEqual([expect.objectContaining({ scheme: 'EOBI', month: M1, amountCents: 6_000, challanNo: 'PR-02-77' })])
  })

  it('B sees only its own: an EOBI payment with nothing accrued is overpaid', async () => {
    const res = await call('adminB', 'GET', `/accounting/statutory?from=${M1}&to=${M1}`)
    expect(res.statusCode).toBe(200)
    const m1 = res.json().months[0]
    expect(m1.eobi).toMatchObject({ accruedCents: 0, paidCents: 100, owedCents: -100, overpaid: true })
    expect(m1.salary_tax.accruedCents).toBe(0)
    expect(res.json().legacyHrChallans).toEqual([])
  })

  it('a viewer reads (no Record button); a bad range is 422 / 400', async () => {
    const view = await call('mgmtA', 'GET', '/accounting/statutory')
    expect(view.statusCode).toBe(200)
    expect(view.json().canPay).toBe(false)
    expect(view.json().months).toHaveLength(6)
    expect(view.json().to).toBe(M2)
    expect((await call('finA', 'GET', `/accounting/statutory?from=${M2}&to=${M1}`)).statusCode).toBe(422)
    expect((await call('finA', 'GET', '/accounting/statutory?from=2020-01&to=2026-01')).json().error.code).toBe('RANGE_TOO_LONG')
    expect((await call('finA', 'GET', '/accounting/statutory?from=2026-13')).statusCode).toBe(400)
  })

  it('the unpaid-challan close check warns for A (salary tax of M1), never for B', async () => {
    const a = await check('statutory_unpaid').run(ctx(tenantA, [M1, M2]))
    expect(a).toMatchObject({ key: 'statutory_unpaid', severity: 'warn', overridable: false, cents: 2_000, months: [M1], link: '/accounting/statutory' })
    // Only the last month: its challans are not due yet.
    expect(await check('statutory_unpaid').run(ctx(tenantA, [M1]))).toBeNull()
    // B overpaid — nothing unpaid.
    expect(await check('statutory_unpaid').run(ctx(tenantB, [M1, M2]))).toBeNull()
  })

  it('a manual entry that debits 2042 links as the salary tax challan; one that debits 2090 does not', async () => {
    const tax = await call('adminA', 'POST', '/accounting/journal', {
      description: 'Salary tax paid', entryDate: at(`${M2}-02`).toISOString(),
      lines: [{ accountId: await accountId(tenantA, '2042'), type: 'debit', amountCents: 2_000 }, { accountId: await accountId(tenantA, '1020'), type: 'credit', amountCents: 2_000 }],
    })
    expect(tax.statusCode).toBe(201)
    const cands = await call('finA', 'GET', '/accounting/sales-tax-return/payments/candidates?authority=salary_tax')
    expect(cands.json().entries.map((e: { id: string }) => e.id)).toContain(tax.json().id)
    const link = await call('finA', 'POST', '/accounting/sales-tax-return/payments/link', { journalEntryId: tax.json().id, authority: 'salary_tax', period: M1, cprNumber: 'CPR-9' })
    expect(link.statusCode).toBe(201)
    expect(link.json()).toMatchObject({ tenantId: tenantA, authority: 'salary_tax', linked: true, paidCents: 2_000, outputSetOffCents: 2_000 })

    const old = await call('adminA', 'POST', '/accounting/journal', {
      description: 'EOBI paid from accrued expenses', entryDate: at(`${M2}-02`).toISOString(),
      lines: [{ accountId: await accountId(tenantA, '2090'), type: 'debit', amountCents: 500 }, { accountId: await accountId(tenantA, '1020'), type: 'credit', amountCents: 500 }],
    })
    const refused = await call('finA', 'POST', '/accounting/sales-tax-return/payments/link', { journalEntryId: old.json().id, authority: 'eobi', period: M2 })
    expect(refused.statusCode).toBe(422)
    expect(refused.json().error.code).toBe('NOT_A_TAX_PAYMENT')

    const s = (await call('finA', 'GET', `/accounting/statutory?from=${M1}&to=${M1}`)).json()
    expect(s.months[0].salary_tax).toMatchObject({ accruedCents: 2_000, paidCents: 2_000, owedCents: 0, cleared: true })
    expect(s.months[0].salary_tax.payments[0]).toMatchObject({ linked: true, cprNumber: 'CPR-9' })
    expect(await check('statutory_unpaid').run(ctx(tenantA, [M1, M2]))).toBeNull()
  })
})

// ─── The one-time reclass ────────────────────────────────────────────────────

describe('the one-time reclass out of 2090 / 2040', () => {
  beforeAll(async () => {
    const emp = (await prisma.hrEmployee.create({ data: { tenantId: tenantR, employeeCode: `R-${RUN}`, fullName: 'Rider One' } })).id
    // A payroll run: EOBI employee 500 + employer 2,500, SESSI 1,000 → 2090 4,000; tax 1,500 → 2040.
    const run = await prisma.hrPayrollRun.create({ data: { tenantId: tenantR, period: M1, status: 'locked', settings: {} } })
    await prisma.hrPayslip.create({
      data: {
        runId: run.id, tenantId: tenantR, employeeId: emp, inputs: {}, grossCents: 50_000, earningsCents: 50_000, deductionsCents: 2_000,
        eobiEmployeeCents: 500, eobiEmployerCents: 2_500, netCents: 48_000,
        lines: [
          { kind: 'earning', code: 'basic', amountCents: 50_000 },
          { kind: 'deduction', code: 'eobi_employee', amountCents: 500 },
          { kind: 'deduction', code: 'tax', amountCents: 1_500 },
          { kind: 'employer', code: 'eobi_employer', amountCents: 2_500 },
          { kind: 'employer', code: 'sessi_employer', amountCents: 1_000 },
        ],
      },
    })
    await post(tenantR, 'hr.payroll.accrual', run.id, at(`${lastDay(M1)}`), [
      { accountCode: '6031', type: 'debit', amountCents: 53_500 },
      { accountCode: '2090', type: 'credit', amountCents: 4_000 },
      { accountCode: '2040', type: 'credit', amountCents: 1_500 },
      { accountCode: '2020', type: 'credit', amountCents: 48_000 },
    ])
    // A full & final: EOBI 1,000 + 5,000, SESSI 3,000 → 9,000; tax 2,000.
    const fnf = await prisma.hrRecord.create({
      data: { tenantId: tenantR, section: 'final_settlement', formVersion: 1, status: 'approved', employeeId: emp, data: { eobiEmployee: 1_000, eobiEmployer: 5_000, sessiEmployer: 3_000, incomeTax: 2_000 } },
    })
    await post(tenantR, 'hr.final_settlement.accrual', fnf.id, at(`${M1}-20`), [
      { accountCode: '6031', type: 'debit', amountCents: 11_000 },
      { accountCode: '2090', type: 'credit', amountCents: 9_000 },
      { accountCode: '2040', type: 'credit', amountCents: 2_000 },
    ])
    // A settlement edited after it posted: figures 1,000 but the ledger took 2,000 → split pro rata 60 / 40.
    const drift = await prisma.hrRecord.create({
      data: { tenantId: tenantR, section: 'final_settlement', formVersion: 1, status: 'approved', employeeId: emp, data: { eobiEmployee: 100, eobiEmployer: 500, sessiEmployer: 400 } },
    })
    await post(tenantR, 'hr.final_settlement.accrual', drift.id, at(`${M1}-21`), [
      { accountCode: '6031', type: 'debit', amountCents: 2_000 },
      { accountCode: '2090', type: 'credit', amountCents: 2_000 },
    ])
    // A settlement booked then cancelled: the reversal subtracts.
    const cancelled = await prisma.hrRecord.create({
      data: { tenantId: tenantR, section: 'final_settlement', formVersion: 1, status: 'cancelled', employeeId: emp, data: { eobiEmployee: 600 } },
    })
    await post(tenantR, 'hr.final_settlement.accrual', cancelled.id, at(`${M1}-22`), [
      { accountCode: '6031', type: 'debit', amountCents: 600 },
      { accountCode: '2090', type: 'credit', amountCents: 600 },
    ])
    await reverseJournalEntry(tenantR, 'hr.final_settlement.accrual', cancelled.id, 'cancelled', { entryDate: at(`${M1}-23`) })
    // Finance once paid 1,000 of EOBI straight out of 2090.
    await post(tenantR, 'manual', randomUUID(), at(`${M1}-25`), [
      { accountCode: '2090', type: 'debit', amountCents: 1_000 },
      { accountCode: '1020', type: 'credit', amountCents: 1_000 },
    ])
    // R2: one old accrual, books closed through today.
    const fnf2 = await prisma.hrRecord.create({ data: { tenantId: tenantR2, section: 'final_settlement', formVersion: 1, status: 'approved', data: { eobiEmployee: 1_000 } } })
    await post(tenantR2, 'hr.final_settlement.accrual', fnf2.id, at(`${M1}-20`), [
      { accountCode: '6031', type: 'debit', amountCents: 1_000 },
      { accountCode: '2090', type: 'credit', amountCents: 1_000 },
    ])
    await prisma.periodLock.create({ data: { tenantId: tenantR2, lockedThrough: parsePktEndOfDay(TODAY), lockedBy: staff['finR2']!.id } })
  })

  it('the preview: HR\'s amounts by scheme, the balances, the manual debit and the offer', async () => {
    const res = await call('finR', 'GET', '/accounting/statutory/reclass')
    expect(res.statusCode).toBe(200)
    const p = res.json()
    expect(p).toMatchObject({ tenantId: tenantR, done: null, canPost: true })
    // EOBI 3,000 + 6,000 + 1,200 (+600 − 600); SESSI 1,000 + 3,000 + 800; tax 1,500 + 2,000.
    expect(p.hrSourced).toEqual({ eobiCents: 10_200, sessiCents: 4_800, salaryTaxCents: 3_500 })
    expect(p.balances).toEqual({ accruedExpenses2090Cents: 14_000, withholding2040Cents: 3_500 })
    // EOBI + SESSI (15,000) is more than 2090 holds (14,000): scaled down together.
    expect(p.suggested).toEqual({ eobiCents: 9_520, sessiCents: 4_480, salaryTaxCents: 3_500 })
    expect(p.entries).toHaveLength(5)
    expect(p.entries.find((e: { basis: string }) => e.basis === 'pro_rata')).toMatchObject({ eobiCents: 1_200, sessiCents: 800 })
    expect(p.entries.filter((e: { reversal: boolean }) => e.reversal)).toEqual([expect.objectContaining({ eobiCents: -600, sessiCents: 0 })])
    expect(p.manualDebits).toEqual([expect.objectContaining({ accountCode: '2090', debitCents: 1_000, kind: 'manual' })])

    // The summary shows the month's HR amounts as legacy accrued.
    const s = (await call('finR', 'GET', `/accounting/statutory?from=${M1}&to=${M1}`)).json()
    expect(s.months[0].eobi).toMatchObject({ accruedCents: 0, legacyAccruedCents: 10_200, owedCents: 10_200 })
    expect(s.months[0].salary_tax).toMatchObject({ legacyAccruedCents: 3_500 })
  })

  it('the reclass close check warns for R only', async () => {
    const r = await check('statutory_reclass').run(ctx(tenantR, [M1]))
    expect(r).toMatchObject({ key: 'statutory_reclass', severity: 'warn', overridable: false, cents: 17_500, link: '/accounting/statutory' })
    expect(await check('statutory_reclass').run(ctx(tenantA, [M1]))).toBeNull()
    expect(await check('statutory_reclass').run(ctx(tenantB, [M1]))).toBeNull()
  })

  it('more than HR booked or than 2090 holds is 422; all zero is 422; a viewer is 403; a closed day is 422', async () => {
    const over = await call('finR', 'POST', '/accounting/statutory/reclass', { eobiCents: 10_200, sessiCents: 4_800, salaryTaxCents: 0, note: 'all of it' })
    expect(over.statusCode).toBe(422)
    expect(over.json().error.code).toBe('RECLASS_OVER_BALANCE')
    const tooMuchEobi = await call('finR', 'POST', '/accounting/statutory/reclass', { eobiCents: 10_300, sessiCents: 0, salaryTaxCents: 0, note: 'too much' })
    expect(tooMuchEobi.json().error.code).toBe('RECLASS_OVER_BALANCE')
    const nothing = await call('finR', 'POST', '/accounting/statutory/reclass', { eobiCents: 0, sessiCents: 0, salaryTaxCents: 0, note: 'nothing at all' })
    expect(nothing.statusCode).toBe(422)
    expect(nothing.json().error.code).toBe('NOTHING_TO_RECLASS')
    const viewer = await call('mgmtA', 'POST', '/accounting/statutory/reclass', { eobiCents: 1, sessiCents: 0, salaryTaxCents: 0, note: 'not allowed' })
    expect(viewer.statusCode).toBe(403)
    const locked = await call('finR2', 'POST', '/accounting/statutory/reclass', { eobiCents: 1_000, sessiCents: 0, salaryTaxCents: 0, note: 'books closed' })
    expect(locked.statusCode).toBe(422)
    expect(locked.json().error.code).toBe('PERIOD_LOCKED')
    expect(await prisma.journalEntry.count({ where: { reference: { startsWith: 'statutory.reclass:' } } })).toBe(0)
  })

  it('posts once: Dr 2090 / Dr 2040 / Cr 2043 / Cr 2044 / Cr 2042 in R\'s books; 409 after; B untouched', async () => {
    const bBefore = await prisma.journalEntry.count({ where: { tenantId: tenantB } })
    const res = await call('finR', 'POST', '/accounting/statutory/reclass', { eobiCents: 9_520, sessiCents: 4_480, salaryTaxCents: 3_500, note: 'One-time move to the statutory payables' })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ reference: `statutory.reclass:${tenantR}`, eobiCents: 9_520, sessiCents: 4_480, salaryTaxCents: 3_500, entryDate: TODAY })
    const je = (await entry(tenantR, `statutory.reclass:${tenantR}`))!
    expect(amt(je, '2090', 'debit')).toBe(14_000)
    expect(amt(je, '2040', 'debit')).toBe(3_500)
    expect(amt(je, '2043', 'credit')).toBe(9_520)
    expect(amt(je, '2044', 'credit')).toBe(4_480)
    expect(amt(je, '2042', 'credit')).toBe(3_500)
    expect(await balance(tenantR, '2090')).toBe(0)
    expect(await balance(tenantR, '2040')).toBe(0)
    expect(await prisma.auditLog.count({ where: { action: 'statutory.reclass', tenantId: tenantR } })).toBe(1)

    const again = await call('finR', 'POST', '/accounting/statutory/reclass', { eobiCents: 1, sessiCents: 0, salaryTaxCents: 0, note: 'second time' })
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('RECLASS_DONE')

    const p = (await call('finR', 'GET', '/accounting/statutory/reclass')).json()
    expect(p).toMatchObject({ canPost: false, suggested: { eobiCents: 0, sessiCents: 0, salaryTaxCents: 0 } })
    expect(p.done).toMatchObject({ eobiCents: 9_520, sessiCents: 4_480, salaryTaxCents: 3_500, entryDate: TODAY })
    // Not 'hr.': the move is shown as a reclass, never as accrued.
    const s = (await call('finR', 'GET', `/accounting/statutory?from=${M2}&to=${M2}`)).json()
    expect(s.months[0].eobi).toMatchObject({ accruedCents: 0, reclassCents: 9_520, balanceAtMonthEndCents: 9_520 })
    expect(s.reclass).toMatchObject({ entryDate: TODAY })
    expect(await check('statutory_reclass').run(ctx(tenantR, [M1, M2]))).toBeNull()

    // B: nothing moved, nothing to move, no entry.
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantB } })).toBe(bBefore)
    const b = (await call('adminB', 'GET', '/accounting/statutory/reclass')).json()
    expect(b).toMatchObject({ done: null, hrSourced: { eobiCents: 0, sessiCents: 0, salaryTaxCents: 0 } })
  })
})
