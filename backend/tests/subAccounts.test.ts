// Sub-accounts (owner, 2026-10-23): "option to create sub account in chart of
// accounts, e.g in Wages … in name of employees … and also add option to fetch
// report/account statement with balance of subgroups mentioned under main account".
//
// A SUB-LEDGER (lib/subAccounts.ts): entries keep posting to the main account;
// a sub-account only tags amounts of lines.
//   - two companies: B gets 404 on A's sub-accounts, lines and statements;
//   - a tag never exceeds its line, never crosses accounts or companies;
//   - manual lines may name a sub-account; a text edit re-tags at once; a reversal mirrors the tags;
//   - payroll tags each employee on the wages, 2020 and 1350 lines, summing to the line;
//   - the history backfill is idempotent, flags a mismatch once and leaves the trial balance byte-identical;
//   - the statement's sub-account summary (with Unassigned) ties to the account.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { AppError, errorResponse } = await import('../src/lib/errors.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { ensureChartOfAccounts } = await import('../src/lib/chartOfAccounts.js')
const { fmtPktDate } = await import('../src/modules/accounting/dates.js')
const { trialBalance } = await import('../src/modules/accounting/reports.js')
const { accountingRoutes } = await import('../src/modules/accounting/routes.js')
const { setupRoutes } = await import('../src/modules/setup/routes.js')
const { postPayrollAccrual, postPayrollPayment } = await import('../src/modules/hr/ledger.js')
const { backfillPayrollSubLedger } = await import('../src/modules/hr/payrollSubLedgerBackfill.js')

const P = `sa${Date.now()}`
let A = ''
let B = ''
let app: FastifyInstance
const U: Record<string, { id: string; token: string; tenantId: string }> = {}

async function mkUser(key: string, role: string, members: string[]) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@sa.pk`, password: 'x', role: role as 'admin', tenantId: members[0]!,
      isActive: true, accountStatus: 'active',
      tenantMemberships: { create: members.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
  })
  U[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken, tenantId: members[0]! }
}
const acct = async (tenantId: string, code: string) => (await prisma.account.findFirstOrThrow({ where: { tenantId, code }, select: { id: true } })).id
function call(who: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown, tenant?: string) {
  return app.inject({
    method, url: `/api/v1${url}`,
    headers: { authorization: `Bearer ${U[who]!.token}`, 'x-servd-active-tenant': tenant ?? U[who]!.tenantId },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  })
}
const code = (res: { json: () => unknown }) => (res.json() as { error?: { code?: string } }).error?.code
const day = fmtPktDate(new Date(Date.now() - 5 * 86400_000))
const at = new Date(`${day}T12:00:00+05:00`).toISOString()

beforeAll(async () => {
  A = (await prisma.tenant.create({ data: { name: `${P} Foods`, slug: `${P}-a` } })).id
  B = (await prisma.tenant.create({ data: { name: `${P} Viva`, slug: `${P}-b` } })).id
  await ensureChartOfAccounts(A)
  await ensureChartOfAccounts(B)
  await mkUser('ceo', 'admin', [A, B])
  await mkUser('fin', 'finance', [A])
  await mkUser('finB', 'finance', [B])
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await api.register(accountingRoutes, { prefix: '/accounting' })
    await api.register(setupRoutes, { prefix: '/setup' })
  }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)
afterAll(async () => { await app?.close() })

let S1 = ''
let S2 = ''
let entryId = ''

describe('sub-accounts and tags', () => {
  it('finance creates, lists, renames and switches off; company B gets 404', async () => {
    const rent = await acct(A, '6010')
    const c = await call('fin', 'POST', `/setup/chart-of-accounts/${rent}/sub-accounts`, { name: 'Shop 1 rent', code: 'R1' })
    expect(c.statusCode, c.body).toBe(201)
    S1 = c.json().id
    expect(c.json()).toMatchObject({ tenantId: A, accountId: rent, kind: 'manual', isActive: true })
    S2 = (await call('fin', 'POST', `/setup/chart-of-accounts/${rent}/sub-accounts`, { name: 'Shop 2 rent' })).json().id
    expect(code(await call('fin', 'POST', `/setup/chart-of-accounts/${rent}/sub-accounts`, { name: 'Shop 1 rent' }))).toBe('SUB_ACCOUNT_NAME_TAKEN')
    expect((await call('finB', 'POST', `/setup/chart-of-accounts/${rent}/sub-accounts`, { name: 'Mine' })).statusCode).toBe(404)
    expect((await call('finB', 'GET', `/setup/chart-of-accounts/${rent}/sub-accounts`)).statusCode).toBe(404)
    expect((await call('finB', 'PATCH', `/setup/chart-of-accounts/sub-accounts/${S1}`, { name: 'x' })).statusCode).toBe(404)
    const list = await call('fin', 'GET', `/setup/chart-of-accounts/${rent}/sub-accounts`)
    expect((list.json() as Array<{ id: string }>).map((x) => x.id).sort()).toEqual([S1, S2].sort())
    const off = await call('fin', 'PATCH', `/setup/chart-of-accounts/sub-accounts/${S2}`, { isActive: false })
    expect(off.json().isActive).toBe(false)
    expect((await call('fin', 'PATCH', `/setup/chart-of-accounts/sub-accounts/${S2}`, { isActive: true })).json().isActive).toBe(true)
  })

  it('a manual line names a sub-account; tags never exceed the line or cross accounts / companies', async () => {
    const rent = await acct(A, '6010')
    const bank = await acct(A, '1020')
    const res = await call('fin', 'POST', '/accounting/journal', { description: 'Rent', entryDate: at, lines: [
      { accountId: rent, type: 'debit', amountCents: 10_000, subAccountId: S1 }, { accountId: bank, type: 'credit', amountCents: 10_000 },
    ] })
    expect(res.statusCode, res.body).toBe(201)
    entryId = res.json().id
    const line = (res.json().lines as Array<{ id: string; accountId: string }>).find((l) => l.accountId === rent)!
    expect(await prisma.journalLineSubAccount.findMany({ where: { journalLineId: line.id } })).toEqual([expect.objectContaining({ subAccountId: S1, tenantId: A })])
    // A sub-account on the wrong line → refused at post.
    const wrong = await call('fin', 'POST', '/accounting/journal', { description: 'Rent', entryDate: at, lines: [
      { accountId: rent, type: 'debit', amountCents: 1_000 }, { accountId: bank, type: 'credit', amountCents: 1_000, subAccountId: S1 },
    ] })
    expect(code(wrong)).toBe('SUB_ACCOUNT_NOT_ON_ACCOUNT')

    const over = await call('fin', 'PUT', `/accounting/journal/lines/${line.id}/sub-accounts`, { allocations: [{ subAccountId: S1, amountCents: 6_000 }, { subAccountId: S2, amountCents: 5_000 }] })
    expect([over.statusCode, code(over)]).toEqual([422, 'ALLOCATION_EXCEEDS_LINE'])
    const bankLine = (res.json().lines as Array<{ id: string; accountId: string }>).find((l) => l.accountId === bank)!
    expect(code(await call('fin', 'PUT', `/accounting/journal/lines/${bankLine.id}/sub-accounts`, { allocations: [{ subAccountId: S1, amountCents: 100 }] }))).toBe('SUB_ACCOUNT_NOT_ON_ACCOUNT')
    const sB = (await call('finB', 'POST', `/setup/chart-of-accounts/${await acct(B, '6010')}/sub-accounts`, { name: 'B rent' })).json().id
    expect(code(await call('ceo', 'PUT', `/accounting/journal/lines/${line.id}/sub-accounts`, { allocations: [{ subAccountId: sB, amountCents: 100 }] }, A))).toBe('SUB_ACCOUNT_NOT_ON_ACCOUNT')
    expect((await call('finB', 'PUT', `/accounting/journal/lines/${line.id}/sub-accounts`, { allocations: [] })).statusCode).toBe(404)

    const split = await call('fin', 'PUT', `/accounting/journal/lines/${line.id}/sub-accounts`, { allocations: [{ subAccountId: S1, amountCents: 6_000 }, { subAccountId: S2, amountCents: 3_000 }] })
    expect(split.statusCode, split.body).toBe(200)
    expect(await prisma.auditLog.count({ where: { entityId: entryId, action: 'journal.sub_account_tag' } })).toBe(1)
  })

  it('the statement summary ties to the account (Unassigned included); one sub-account\'s own statement; B gets 404', async () => {
    const rent = await acct(A, '6010')
    const st = await call('fin', 'GET', `/accounting/ledger?view=statement&accountId=${rent}&from=${day}&to=${day}`)
    expect(st.statusCode, st.body).toBe(200)
    const rows = st.json().subAccounts as Array<{ id: string | null; closingCents: number; debitCents: number }>
    expect(rows.find((r) => r.id === S1)!.closingCents).toBe(6_000)
    expect(rows.find((r) => r.id === S2)!.closingCents).toBe(3_000)
    expect(rows.find((r) => r.id === null)!.closingCents).toBe(1_000)
    expect(rows.reduce((t, r) => t + r.closingCents, 0)).toBe(st.json().closingCents)
    const one = await call('fin', 'GET', `/accounting/ledger?view=statement&accountId=${rent}&from=${day}&to=${day}&subAccountId=${S1}`)
    expect(one.statusCode, one.body).toBe(200)
    expect(one.json().subAccount.id).toBe(S1)
    expect(one.json().lines.map((l: { debitCents: number }) => l.debitCents)).toEqual([6_000])
    expect(one.json().closingCents).toBe(6_000)
    const csv = await call('fin', 'GET', `/accounting/ledger?view=statement&accountId=${rent}&from=${day}&to=${day}&format=csv`)
    expect(csv.body).toContain('Shop 1 rent')
    expect(csv.body).toContain('Unassigned')
    expect((await call('finB', 'GET', `/accounting/ledger?view=statement&accountId=${rent}&from=${day}&to=${day}&subAccountId=${S1}`)).statusCode).toBe(404)
    expect((await call('finB', 'GET', `/accounting/accounts/${rent}/sub-accounts?from=${day}&to=${day}`)).statusCode).toBe(404)
    const sum = await call('fin', 'GET', `/accounting/accounts/${rent}/sub-accounts?from=${day}&to=${day}`)
    expect(sum.json().subAccounts.length).toBe(3)
  })

  it('a text edit re-tags a line at once; a reversal mirrors the tags so the sub-ledger nets to zero', async () => {
    const e = await prisma.journalEntry.findUniqueOrThrow({ where: { id: entryId }, include: { lines: { include: { account: true } } } })
    const line = e.lines.find((l) => l.account.code === '6010')!
    const t = await call('fin', 'PATCH', `/accounting/journal/${entryId}/text`, { subAccounts: [{ lineId: line.id, subAccountId: S1 }] })
    expect(t.statusCode, t.body).toBe(200)
    expect(await prisma.journalLineSubAccount.findMany({ where: { journalLineId: line.id }, select: { subAccountId: true, amountCents: true } }))
      .toEqual([{ subAccountId: S1, amountCents: 10_000 }])
    const rev = await call('ceo', 'POST', `/accounting/journal/${entryId}/reverse`, { reason: 'Wrong month' }, A)
    expect(rev.statusCode, rev.body).toBe(201)
    const revTags = await prisma.journalLineSubAccount.findMany({ where: { line: { journalEntryId: rev.json().id } } })
    expect(revTags).toEqual([expect.objectContaining({ subAccountId: S1 })])
    const st = await call('fin', 'GET', `/accounting/ledger?view=statement&accountId=${line.accountId}&from=${day}&to=${fmtPktDate(new Date())}&subAccountId=${S1}`)
    expect(st.json().closingCents).toBe(0)
  })
})

describe('payroll: one wages sub-account per employee', () => {
  let runId = ''
  const emp: Record<string, string> = {}
  beforeAll(async () => {
    for (const [k, name] of [['e1', 'Ali Raza'], ['e2', 'Sara Khan']] as const) {
      emp[k] = (await prisma.hrEmployee.create({ data: { tenantId: A, employeeCode: `${P}-${k}`, fullName: name } })).id
    }
    runId = (await prisma.hrPayrollRun.create({ data: { tenantId: A, period: '2026-09', settings: {}, status: 'locked' } })).id
    const slip = (employeeId: string, lines: unknown[], earnings: number, deductions: number) => prisma.hrPayslip.create({ data: {
      runId, tenantId: A, employeeId, inputs: { paymentMethod: 'cash' }, lines: lines as never,
      grossCents: earnings, earningsCents: earnings, deductionsCents: deductions, eobiEmployeeCents: 0, eobiEmployerCents: 0, netCents: earnings - deductions,
    } })
    await slip(emp.e1!, [{ kind: 'earning', code: 'basic', amountCents: 50_000 }, { kind: 'deduction', code: 'tax', amountCents: 2_000 }], 50_000, 2_000)
    await slip(emp.e2!, [{ kind: 'earning', code: 'basic', amountCents: 30_000 }, { kind: 'deduction', code: 'loan', amountCents: 5_000 }], 30_000, 5_000)
  })

  it('the accrual and the payment tag each employee; tags sum to the line', async () => {
    await prisma.$transaction((tx) => postPayrollAccrual(tx, runId, U.ceo!.id))
    const entry = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: A, reference: `hr.payroll.accrual:${runId}` }, include: { lines: { include: { account: true, subAccountAllocations: { include: { subAccount: true } } } } } })
    const byCode = (c: string) => entry.lines.find((l) => l.account.code === c)!
    const wages = byCode('6031')
    expect(wages.subAccountAllocations.map((a) => [a.subAccount.employeeId, Number(a.amountCents)]).sort()).toEqual([[emp.e1, 50_000], [emp.e2, 30_000]].sort())
    expect(wages.subAccountAllocations.every((a) => a.subAccount.kind === 'employee' && a.subAccount.tenantId === A)).toBe(true)
    expect(byCode('2020').subAccountAllocations.reduce((t, a) => t + Number(a.amountCents), 0)).toBe(Number(byCode('2020').amountCents))
    expect(byCode('1350').subAccountAllocations.map((a) => a.subAccount.employeeId)).toEqual([emp.e2])
    expect(byCode('2042').subAccountAllocations).toEqual([])

    await postPayrollPayment(runId, U.ceo!.id, { mode: 'all', method: 'cash' }, new Date(at))
    const pay = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: A, reference: `hr.payroll.payment:${runId}` }, include: { lines: { include: { account: true, subAccountAllocations: true } } } })
    const d2020 = pay.lines.find((l) => l.account.code === '2020')!
    expect(d2020.subAccountAllocations.reduce((t, a) => t + Number(a.amountCents), 0)).toBe(73_000)
    // Each employee's 2020 sub-account nets to zero once paid.
    const sa = await prisma.subAccount.findFirstOrThrow({ where: { accountId: d2020.accountId, employeeId: emp.e1 } })
    const st = await call('fin', 'GET', `/accounting/ledger?view=statement&accountId=${d2020.accountId}&from=2026-09-01&to=${fmtPktDate(new Date())}&subAccountId=${sa.id}`)
    expect(st.json().closingCents).toBe(0)
  })

  it('the history backfill re-tags untagged payroll once, never touches the books, flags a mismatch once', async () => {
    const lineIds = (await prisma.journalLine.findMany({ where: { journalEntry: { tenantId: A, reference: { in: [`hr.payroll.accrual:${runId}`, `hr.payroll.payment:${runId}`] } } }, select: { id: true } })).map((l) => l.id)
    await prisma.journalLineSubAccount.deleteMany({ where: { journalLineId: { in: lineIds } } })
    const asOf = new Date(Date.now() + 86400_000)
    const tbBefore = JSON.stringify(await trialBalance([A], asOf))
    const linesBefore = JSON.stringify(await prisma.journalLine.findMany({ where: { journalEntry: { tenantId: A } }, orderBy: { id: 'asc' } }), (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
    const r = await backfillPayrollSubLedger({ tenantIds: [A] })
    expect(r[0]).toMatchObject({ tenantId: A, runs: 1 })
    expect(r[0]!.mismatched).toEqual([])
    const tagged = await prisma.journalLineSubAccount.count({ where: { journalLineId: { in: lineIds } } })
    expect(tagged).toBe(7) // accrual: wages ×2, 2020 ×2, 1350 ×1; payment: 2020 ×2
    expect(JSON.stringify(await trialBalance([A], asOf))).toBe(tbBefore)
    expect(JSON.stringify(await prisma.journalLine.findMany({ where: { journalEntry: { tenantId: A } }, orderBy: { id: 'asc' } }), (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(linesBefore)
    // Once per company (marker); forced again it adds nothing.
    expect(await backfillPayrollSubLedger({ tenantIds: [A] })).toEqual([])
    await backfillPayrollSubLedger({ tenantIds: [A], force: true })
    expect(await prisma.journalLineSubAccount.count({ where: { journalLineId: { in: lineIds } } })).toBe(tagged)

    // A payslip that no longer matches its posted line: left untagged, flagged.
    await prisma.journalLineSubAccount.deleteMany({ where: { journalLineId: { in: lineIds } } })
    await prisma.hrPayslip.updateMany({ where: { runId, employeeId: emp.e1 }, data: { netCents: 47_000 } })
    const m = await backfillPayrollSubLedger({ tenantIds: [A], force: true })
    expect(m[0]!.mismatched.some((x) => x.endsWith('#2020'))).toBe(true)
    expect(await prisma.exceptionFlag.count({ where: { tenantId: A, kind: 'sub_account_backfill_mismatch' } })).toBeGreaterThan(0)
  })
})
