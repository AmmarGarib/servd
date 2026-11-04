// Payroll books office pay to the company's own "Wages Expense" account (owner, 2026-11-04: "Payroll for October not
// logged in individual sub account of wages expense" → "2343 Wages Expense — Yes").
//   - a new run: office / management pay is debited to Wages Expense (not 6032), tagged per employee, on the
//     sub-account finance already opened in the person's name (adopted, never a second one)
//   - a run accrued before (on 6032): ONE move entry Dr Wages Expense / Cr 6032, tagged per employee, once only;
//     tagging the run again reports no mismatch; reopening the run reverses the move with the accrual
//   - a company with no Wages Expense account keeps 6032 and nothing moves (company B)
//   - labour % counts Wages Expense (and the move nets to zero)
import { describe, it, expect, beforeAll } from 'vitest'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { ensureChartOfAccounts } = await import('../src/lib/chartOfAccounts.js')
const { postPayrollAccrual, reversePayrollAccrual, tagPayrollRunTx, companyWagesExpenseCode } = await import('../src/modules/hr/ledger.js')
const { moveOfficeWagesToWagesExpense } = await import('../src/modules/hr/payrollSubLedgerBackfill.js')
const { labourPctReport } = await import('../src/lib/labour.js')

const P = `wx${Date.now()}`
let A = ''
let B = ''
let ceo = ''
let wx = '' // A's 2343 account id
const emp: Record<string, string> = {}
let anushaSub = ''

async function mkRun(tenantId: string, period: string, slips: Array<[string, number]>) {
  const runId = (await prisma.hrPayrollRun.create({ data: { tenantId, period, settings: {}, status: 'locked' } })).id
  for (const [employeeId, cents] of slips) {
    await prisma.hrPayslip.create({ data: {
      runId, tenantId, employeeId, inputs: { paymentMethod: 'cash' }, lines: [{ kind: 'earning', code: 'basic', amountCents: cents }] as never,
      grossCents: cents, earningsCents: cents, deductionsCents: 0, eobiEmployeeCents: 0, eobiEmployerCents: 0, netCents: cents,
    } })
  }
  return runId
}
const entryOf = (tenantId: string, reference: string) => prisma.journalEntry.findFirst({
  where: { tenantId, reference },
  include: { lines: { include: { account: true, subAccountAllocations: { include: { subAccount: true } } } } },
})

beforeAll(async () => {
  A = (await prisma.tenant.create({ data: { name: `${P} Foods`, slug: `${P}-a` } })).id
  B = (await prisma.tenant.create({ data: { name: `${P} Viva`, slug: `${P}-b` } })).id
  await ensureChartOfAccounts(A)
  await ensureChartOfAccounts(B)
  ceo = (await prisma.user.create({ data: { name: `${P} ceo`, email: `${P}.ceo@wx.pk`, password: 'x', role: 'admin', tenantId: A, isActive: true, accountStatus: 'active' } })).id
  for (const t of [A, B]) {
    const mk = (await prisma.department.create({ data: { tenantId: t, name: 'Marketing' } })).id
    emp[`office${t === A ? 'A' : 'B'}`] = (await prisma.hrEmployee.create({ data: { tenantId: t, employeeCode: `${P}-${t.slice(0, 4)}-o`, fullName: 'Anusha  Siddiqui', departmentId: mk } })).id
    emp[`floor${t === A ? 'A' : 'B'}`] = (await prisma.hrEmployee.create({ data: { tenantId: t, employeeCode: `${P}-${t.slice(0, 4)}-f`, fullName: 'Ali Raza' } })).id
  }
  // A's Wages Expense account exists but is switched off while October is accrued (the old mapping).
  wx = (await prisma.account.create({ data: { tenantId: A, code: '2343', name: 'Wages Expense', type: 'expense', isActive: false, subAccountsEnabled: true } })).id
  anushaSub = (await prisma.subAccount.create({ data: { tenantId: A, accountId: wx, name: 'anusha siddiqui', kind: 'manual' } })).id
})

describe('payroll office wages → the company Wages Expense account', () => {
  let octA = ''
  let octB = ''

  it('before the account is live: payroll books office pay to 6032', async () => {
    expect(await companyWagesExpenseCode(prisma, A)).toBeNull()
    octA = await mkRun(A, '2026-10', [[emp.officeA!, 50_000], [emp.floorA!, 30_000]])
    octB = await mkRun(B, '2026-10', [[emp.officeB!, 40_000]])
    await prisma.$transaction((tx) => postPayrollAccrual(tx, octA, ceo))
    await prisma.$transaction((tx) => postPayrollAccrual(tx, octB, ceo))
    const e = await entryOf(A, `hr.payroll.accrual:${octA}`)
    expect(Number(e!.lines.find((l) => l.account.code === '6032')!.amountCents)).toBe(50_000)
    expect(e!.lines.some((l) => l.account.code === '2343')).toBe(false)
  })

  it('October moves once: Dr Wages Expense / Cr 6032, tagged on the sub-account finance opened in her name', async () => {
    await prisma.account.update({ where: { id: wx }, data: { isActive: true } })
    expect(await companyWagesExpenseCode(prisma, A)).toBe('2343')
    expect(await companyWagesExpenseCode(prisma, B)).toBeNull()

    const r = await moveOfficeWagesToWagesExpense({ tenantIds: [A, B] })
    expect(r).toEqual([{ runId: octA, posted: true }])
    const mv = await entryOf(A, `hr.payroll.wages_reclass:${octA}`)
    const dr = mv!.lines.find((l) => l.type === 'debit')!
    const cr = mv!.lines.find((l) => l.type === 'credit')!
    expect([dr.account.code, Number(dr.amountCents), cr.account.code, Number(cr.amountCents)]).toEqual(['2343', 50_000, '6032', 50_000])
    expect(dr.subAccountAllocations.map((a) => [a.subAccountId, Number(a.amountCents)])).toEqual([[anushaSub, 50_000]])
    // The hand-made sub-account is now hers — no second one beside it.
    expect((await prisma.subAccount.findUniqueOrThrow({ where: { id: anushaSub } })).employeeId).toBe(emp.officeA)
    expect(await prisma.subAccount.count({ where: { accountId: wx } })).toBe(1)

    // Once only; B (no Wages Expense) untouched.
    expect(await moveOfficeWagesToWagesExpense({ tenantIds: [A, B] })).toEqual([])
    expect(await prisma.journalEntry.count({ where: { tenantId: A, reference: `hr.payroll.wages_reclass:${octA}` } })).toBe(1)
    expect(await prisma.journalEntry.count({ where: { tenantId: B, reference: { startsWith: 'hr.payroll.wages_reclass' } } })).toBe(0)

    // Tagging October again follows what its accrual booked (6032): no mismatch.
    expect((await prisma.$transaction((tx) => tagPayrollRunTx(tx, octA))).mismatched).toEqual([])
  })

  it('labour % counts Wages Expense once (the move nets to zero)', async () => {
    const r = await labourPctReport([A], new Date('2020-01-01'), new Date(Date.now() + 86400_000))
    expect(r.labourCents).toBe(80_000)
  })

  it('a new run books office pay straight to Wages Expense, tagged; floor staff stay on 6031', async () => {
    const nov = await mkRun(A, '2026-11', [[emp.officeA!, 52_000], [emp.floorA!, 31_000]])
    await prisma.$transaction((tx) => postPayrollAccrual(tx, nov, ceo))
    const e = await entryOf(A, `hr.payroll.accrual:${nov}`)
    expect(e!.lines.some((l) => l.account.code === '6032')).toBe(false)
    const w = e!.lines.find((l) => l.account.code === '2343')!
    expect(Number(w.amountCents)).toBe(52_000)
    expect(w.subAccountAllocations.map((a) => [a.subAccountId, Number(a.amountCents)])).toEqual([[anushaSub, 52_000]])
    expect(Number(e!.lines.find((l) => l.account.code === '6031')!.amountCents)).toBe(31_000)
    // B still books 6032.
    const novB = await mkRun(B, '2026-11', [[emp.officeB!, 41_000]])
    await prisma.$transaction((tx) => postPayrollAccrual(tx, novB, ceo))
    expect((await entryOf(B, `hr.payroll.accrual:${novB}`))!.lines.some((l) => l.account.code === '6032')).toBe(true)
  })

  it('reopening October reverses the move with the accrual', async () => {
    await prisma.$transaction((tx) => reversePayrollAccrual(tx, octA, ceo, 'reopen for a correction'))
    const rev = await entryOf(A, `hr.payroll.wages_reclass.reversal:${octA}`)
    expect(rev).not.toBeNull()
    expect(rev!.lines.find((l) => l.account.code === '2343')!.type).toBe('credit')
    // Re-approving books the new mapping straight away; nothing left to move.
    await prisma.$transaction((tx) => postPayrollAccrual(tx, octA, ceo))
    expect(await moveOfficeWagesToWagesExpense({ tenantIds: [A] })).toEqual([])
    void octB
  })
})
