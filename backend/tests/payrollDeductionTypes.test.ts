// Deduction types (owner, 2026-10-30: "Make sub categories for deductions column, e.g: Late, Advances, loan, IPD,
// etc to select by HR").
//
//   - types per company in HR settings (defaults Late coming, Advance, Loan, IPD (medical), Other); HR adds,
//     renames, switches off; a used type's posting cannot change (409 DEDUCTION_TYPE_IN_USE)
//   - PATCH /hr/payroll/payslips/:id {deductionItems} on a DRAFT adds one `ded:<key>` line each; kept through
//     Recalculate; refused when not draft (409 RUN_NOT_DRAFT); an unknown / switched-off / other company's type 422
//   - Gross (full month) − tax − deductions − EOBI = net; the accrual balances; `recovery` types credit 1350 and
//     count against the loan; `deduction` types net off the wages expense
//   - company B: 404 on A's payslip, A's types not usable on B's payslip
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { hrRoutes } from '../src/modules/hr/routes.js'
import { getSettings, saveSettings, loansFor, ALL_RUN_STATUSES } from '../src/modules/hr/service.js'
import { postPayrollAccrual } from '../src/modules/hr/ledger.js'
import { toCents } from '../src/lib/money.js'

const stamp = Date.now()
const P = `pdt${stamp}`
const RS = (r: number) => r * 100
const D = (s: string) => new Date(`${s}T00:00:00.000Z`)
let app: FastifyInstance
const T: Record<'A' | 'B', string> = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: string }> = {}
const E: Record<string, string> = {}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@pdt.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as never, tenantId, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: [{ tenant: { connect: { id: tenantId } }, role: 'member' }] },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name!, email: u.email!, role: u.role }
}
function auth(key: string) {
  const u = U[key]!
  return { authorization: `Bearer ${issueStaffSession({ id: u.id, name: u.name, email: u.email, role: u.role as never }).accessToken}` }
}
const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, payload: payload as never, headers: auth(who) })
const code = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code

type Line = { kind: string; code: string; label: string; amountCents: number; posting?: string; note?: string }
type Slip = { id: string; employeeId: string; netCents: number; deductionsCents: number; earningsCents: number; eobiEmployeeCents: number; lines: Line[]; inputs: Record<string, unknown> }
async function runOf(who: string, id: string) {
  const r = await call(who, 'GET', `/hr/payroll/runs/${id}`)
  expect(r.statusCode, r.body).toBe(200)
  return r.json() as { run: { status: string }; payslips: Slip[]; deductionTypes: Array<{ key: string; label: string; posting: string; active: boolean }> }
}

let runA = '', runB = '', loanId = ''

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: `${P} A`, slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: `${P} B`, slug: `${P}-b` } })).id
  for (const t of [T.A, T.B]) {
    await ensureChartOfAccounts(t)
    await saveSettings(t, { ...(await getSettings(t)), absentWithoutPunchFrom: null })
  }
  await mkUser('hr', 'hr', T.A)
  await mkUser('hrB', 'hr', T.B)
  E['cook'] = (await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-1`, fullName: 'Cook', grossSalaryCents: RS(60000), monthlyTaxCents: RS(1000), joiningDate: D('2025-01-01'), paymentMethod: 'bank' } })).id
  E['bCook'] = (await prisma.hrEmployee.create({ data: { tenantId: T.B, employeeCode: `${P}-2`, fullName: 'B cook', grossSalaryCents: RS(50000), monthlyTaxCents: 0, joiningDate: D('2025-01-01'), paymentMethod: 'bank' } })).id
  // An advance of Rs 20,000 whose installments start after the test month: all of it is outstanding.
  loanId = (await prisma.hrRecord.create({ data: { tenantId: T.A, section: 'loan', formVersion: 0, employeeId: E['cook']!, status: 'approved', category: 'advance', amountCents: RS(20000), quantity: 10, effectiveDate: D('2027-12-01'), data: {} } })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: (err as Error).message } })
  })
  await app.register(async (api) => { await api.register(hrRoutes, { prefix: '/hr' }) }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  for (const t of [T.A, T.B]) {
    await prisma.hrPayrollRun.deleteMany({ where: { tenantId: t } }).catch(() => {})
    await prisma.hrRecord.deleteMany({ where: { tenantId: t } }).catch(() => {})
    await prisma.hrEmployee.deleteMany({ where: { tenantId: t } }).catch(() => {})
  }
  await app?.close()
})

describe('deduction types per company', () => {
  it('starts with the default list; HR adds, renames and switches off — company B sees its own only', async () => {
    const list = await call('hr', 'GET', '/hr/deduction-types')
    expect(list.statusCode, list.body).toBe(200)
    const keys = (list.json().types as Array<{ key: string; posting: string }>)
    expect(keys.map((t) => t.key)).toEqual(['late', 'advance', 'loan', 'ipd', 'other'])
    expect(keys.find((t) => t.key === 'advance')!.posting).toBe('recovery')
    expect(keys.find((t) => t.key === 'ipd')!.posting).toBe('deduction')

    const add = await call('hr', 'POST', '/hr/deduction-types', { label: 'Mess charges', posting: 'deduction' })
    expect(add.statusCode, add.body).toBe(201)
    expect(code(await call('hr', 'POST', '/hr/deduction-types', { label: 'mess charges', posting: 'deduction' }))).toBe('DEDUCTION_TYPE_EXISTS')
    const ren = await call('hr', 'PATCH', '/hr/deduction-types/ipd', { label: 'IPD (hospital)' })
    expect(ren.statusCode, ren.body).toBe(200)
    expect(ren.json().label).toBe('IPD (hospital)')
    const off = await call('hr', 'PATCH', `/hr/deduction-types/${add.json().key}`, { active: false })
    expect(off.json().active).toBe(false)

    const b = (await call('hrB', 'GET', '/hr/deduction-types')).json().types as Array<{ key: string; label: string }>
    expect(b.map((t) => t.key)).not.toContain(add.json().key)
    expect(b.find((t) => t.key === 'ipd')!.label).toBe('IPD (medical)')
    expect((await call('hrB', 'PATCH', `/hr/deduction-types/${add.json().key}`, { active: true })).statusCode).toBe(404)
    // The ordinary settings save keeps the types.
    const s = await call('hr', 'GET', '/hr/settings')
    const { deductionTypes: _t, gratuity: _g, absentWithoutPunchFrom: _a, punchOvertimeFrom: _p, defaultRota: _r, officeNetworks: _o, standardDayHours: _sd, otMinimumMinutes: _om, ...rest } = s.json()
    expect((await call('hr', 'PUT', '/hr/settings', rest)).statusCode).toBe(200)
    expect((await getSettings(T.A)).deductionTypes.find((t) => t.key === 'ipd')!.label).toBe('IPD (hospital)')
  })
})

describe('deduction lines on a draft payslip', () => {
  it('HR adds typed lines; Gross − tax − deductions − EOBI = net; kept through Recalculate', async () => {
    runA = (await call('hr', 'POST', '/hr/payroll/runs', { period: '2027-03' })).json().id
    runB = (await call('hrB', 'POST', '/hr/payroll/runs', { period: '2027-03' })).json().id
    const before = (await runOf('hr', runA))
    expect(before.deductionTypes.map((t) => t.key)).toContain('advance')
    const slip = before.payslips.find((s) => s.employeeId === E['cook'])!
    const r = await call('hr', 'PATCH', `/hr/payroll/payslips/${slip.id}`, {
      deductionItems: [
        { typeKey: 'advance', amountCents: RS(5000), note: 'March advance' },
        { typeKey: 'ipd', amountCents: RS(1500) },
        { typeKey: 'late', amountCents: RS(300) },
      ],
    })
    expect(r.statusCode, r.body).toBe(200)
    const s = r.json() as Slip
    const ded = s.lines.filter((l) => l.code.startsWith('ded:'))
    expect(ded.map((l) => [l.code, l.amountCents, l.posting])).toEqual([
      ['ded:advance', RS(5000), 'recovery'], ['ded:ipd', RS(1500), 'deduction'], ['ded:late', RS(300), 'deduction'],
    ])
    expect(ded[0]!.note).toBe('March advance')
    expect(ded[1]!.label).toBe('IPD (hospital)')
    expect(ded[2]!.label).toBe('Late coming (added by HR)')
    // The full month (no absences): Gross − tax − deductions − EOBI = net.
    const tax = s.lines.filter((l) => l.code === 'tax').reduce((a, l) => a + l.amountCents, 0)
    const others = s.lines.filter((l) => l.kind === 'deduction' && l.code !== 'tax' && l.code !== 'eobi_employee').reduce((a, l) => a + l.amountCents, 0)
    expect(s.earningsCents - tax - others - s.eobiEmployeeCents).toBe(s.netCents)
    expect(s.netCents).toBe(RS(60000) - RS(1000) - RS(6800))
    // The recovery is split over the advance and counts against it.
    const loans = await loansFor(T.A, E['cook']!, { runStatuses: ALL_RUN_STATUSES })
    expect(loans.find((l) => l.id === loanId)!.outstandingCents).toBe(RS(15000))

    // Recalculate keeps HR's lines.
    expect((await call('hr', 'POST', `/hr/payroll/runs/${runA}/recalculate`)).statusCode).toBe(200)
    const again = (await runOf('hr', runA)).payslips.find((x) => x.employeeId === E['cook'])!
    expect(again.lines.filter((l) => l.code.startsWith('ded:')).map((l) => l.amountCents)).toEqual([RS(5000), RS(1500), RS(300)])
    expect(again.netCents).toBe(s.netCents)
  })

  it('refuses a recovery above what is owed, an unknown / switched-off type, and another company', async () => {
    const slip = (await runOf('hr', runA)).payslips.find((s) => s.employeeId === E['cook'])!
    const items = (slip.inputs['deductionItems'] as Array<{ id: string; typeKey: string; amountCents: number }>).map((d) => ({ id: d.id, typeKey: d.typeKey, amountCents: d.amountCents }))
    const over = await call('hr', 'PATCH', `/hr/payroll/payslips/${slip.id}`, { deductionItems: [...items, { typeKey: 'loan', amountCents: RS(16000) }] })
    expect(over.statusCode).toBe(422)
    expect(code(over)).toBe('LOAN_OVER_OUTSTANDING')
    const unknown = await call('hr', 'PATCH', `/hr/payroll/payslips/${slip.id}`, { deductionItems: [{ typeKey: 'nope', amountCents: RS(1) }] })
    expect(code(unknown)).toBe('DEDUCTION_TYPE_UNKNOWN')
    const offKey = (await getSettings(T.A)).deductionTypes.find((t) => !t.active)!.key
    expect(code(await call('hr', 'PATCH', `/hr/payroll/payslips/${slip.id}`, { deductionItems: [{ typeKey: offKey, amountCents: RS(1) }] }))).toBe('DEDUCTION_TYPE_UNKNOWN')
    // Company B: A's payslip is 404; A's custom type does not exist for B's payslip.
    expect((await call('hrB', 'PATCH', `/hr/payroll/payslips/${slip.id}`, { deductionItems: [] })).statusCode).toBe(404)
    const bSlip = (await runOf('hrB', runB)).payslips[0]!
    expect(code(await call('hrB', 'PATCH', `/hr/payroll/payslips/${bSlip.id}`, { deductionItems: [{ typeKey: offKey, amountCents: RS(1) }] }))).toBe('DEDUCTION_TYPE_UNKNOWN')
    expect((await call('hr', 'GET', `/hr/payroll/runs/${runB}`)).statusCode).toBe(404)
  })

  it('a used type keeps its posting; the export lists deductions by type', async () => {
    expect(code(await call('hr', 'PATCH', '/hr/deduction-types/advance', { posting: 'deduction' }))).toBe('DEDUCTION_TYPE_IN_USE')
    const x = await call('hr', 'GET', `/hr/payroll/runs/${runA}/export.csv?kind=deductions`)
    expect(x.statusCode, x.body).toBe(200)
    expect(x.body).toContain('Type')
    expect(x.body).toContain('Total — Advance')
    expect(x.body).toContain('IPD (hospital)')
    const reg = await call('hr', 'GET', `/hr/payroll/runs/${runA}/export.csv?kind=register`)
    expect(reg.body).toContain('Ded: Advance')
  })

  it('the accrual balances: recovery credits 1350, a deduction type nets off wages', async () => {
    const slip = (await runOf('hr', runA)).payslips.find((s) => s.employeeId === E['cook'])!
    const res = await prisma.$transaction((tx) => postPayrollAccrual(tx, runA, U['hr']!.id))
    expect(res).not.toBeNull()
    const lines = await prisma.journalLine.findMany({ where: { journalEntryId: res!.entryId }, select: { type: true, amountCents: true, account: { select: { code: true } } } })
    const net = (c: string) => lines.filter((l) => l.account.code === c).reduce((a, l) => a + (l.type === 'debit' ? 1 : -1) * toCents(l.amountCents), 0)
    expect(lines.reduce((a, l) => a + (l.type === 'debit' ? 1 : -1) * toCents(l.amountCents), 0)).toBe(0)
    expect(net('1350')).toBe(-RS(5000))
    expect(net('2042')).toBe(-RS(1000))
    expect(net('2020')).toBe(-slip.netCents)
    // Wages for the whole run: each payslip's earnings less its pay-reducing lines (IPD + typed Late here).
    const slips = (await runOf('hr', runA)).payslips
    const wages = slips.reduce((a, s) => a + s.earningsCents, 0) - RS(1500) - RS(300)
    expect(net('6031')).toBe(wages)
  })

  it('refused once the run is not a draft', async () => {
    await prisma.hrPayrollRun.update({ where: { id: runA }, data: { status: 'finance_review' } })
    const slip = (await runOf('hr', runA)).payslips[0]!
    const r = await call('hr', 'PATCH', `/hr/payroll/payslips/${slip.id}`, { deductionItems: [] })
    expect(r.statusCode).toBe(409)
    expect(code(r)).toBe('RUN_NOT_DRAFT')
  })
})
