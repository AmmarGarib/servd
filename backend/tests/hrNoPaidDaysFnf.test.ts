// Owner, 2026-10-16: "skip tax when no paid days, apply absences in F&F".
//
//   - a month with no paid days (absent / unpaid leave every day employed)
//     takes no income tax and no EOBI / SESSI (the fixed-base EOBI employee
//     share would otherwise make the net negative and block the run); the
//     payslip says why on a zero line; the run approves, locks and its
//     accrual balances. A normal month is unchanged.
//   - a full & final docks the final month(s) for absences, half days and
//     approved unpaid leave exactly as payroll does (days after the last
//     working day and days on paid leave are not docked); an approved
//     settlement never changes when attendance is added later.
//   - two companies: company B cannot calculate company A's leaver (404), and
//     A's attendance never touches B's settlement.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { hrRoutes } from '../src/modules/hr/routes.js'
import {
  DEFAULT_HR_SETTINGS, computePayslip, finalSettlement, mergeSettings, EMPTY_INPUTS, NO_TAX_NO_PAID_DAYS, NO_EOBI_NO_PAID_DAYS,
} from '../src/modules/hr/logic.js'
import { settlementAttendance, getSettings } from '../src/modules/hr/service.js'

const RS = (r: number) => r * 100
const stamp = Date.now()
const D = (s: string) => new Date(`${s}T00:00:00.000Z`)

let app: FastifyInstance
let tenantA: string, tenantB: string
const users: Record<string, { id: string; token: string }> = {}
const emps: Record<string, string> = {}
const unpaidType: Record<string, string> = {}
const paidType: Record<string, string> = {}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${stamp}@nopaid.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
async function mkEmp(key: string, tenantId: string, extra: Record<string, unknown> = {}) {
  const e = await prisma.hrEmployee.create({
    data: { tenantId, employeeCode: `NP-${String(Object.keys(emps).length + 1).padStart(4, '0')}`, fullName: key, grossSalaryCents: RS(52000), monthlyTaxCents: RS(1000), joiningDate: D('2026-01-01'), paymentMethod: 'bank', ...extra },
  })
  emps[key] = e.id
  return e.id
}
const rec = (tenantId: string, section: string, employeeId: string | null, data: Record<string, unknown>) =>
  prisma.hrRecord.create({ data: { tenantId, section, formVersion: 0, employeeId, status: 'approved', ...data } })
const att = (tenantId: string, employeeId: string, day: string, status: string) =>
  rec(tenantId, 'attendance', employeeId, { startDate: D(day), category: status })
const leave = (tenantId: string, employeeId: string, typeId: string, from: string, to: string, quantity: number) =>
  rec(tenantId, 'leave', employeeId, { startDate: D(from), endDate: D(to), refId: typeId, quantity })

const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/hr${url}`, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}` } })

type Ln = { type: string; amountCents: number | bigint; account: { code: string } }
const entry = (tenantId: string, reference: string) =>
  prisma.journalEntry.findFirst({ where: { tenantId, reference }, include: { lines: { include: { account: { select: { code: true } } } } } })
const balanced = (lines: Ln[]) => lines.reduce((a, l) => a + (l.type === 'debit' ? 1 : -1) * Number(l.amountCents), 0) === 0
const amt = (lines: Ln[], code: string, type: 'debit' | 'credit') => lines.filter((l) => l.account.code === code && l.type === type).reduce((a, l) => a + Number(l.amountCents), 0)

const SETTINGS = {
  ...DEFAULT_HR_SETTINGS,
  eobi: { enabled: true, employeePct: 1, employerPct: 5, base: 'fixed', fixedWageCents: RS(40000) },
  sessi: { employerPct: 6, wageCeilingCents: null },
}
const FNF_KEYS = ['salaryPayable', 'otPayable', 'leaveEncashment', 'gratuity', 'loanRecovery', 'incomeTax', 'eobiEmployee', 'eobiEmployer', 'sessiEmployer']

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: `NoPaid A ${stamp}`, slug: `nopaid-a-${stamp}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: `NoPaid B ${stamp}`, slug: `nopaid-b-${stamp}` } })).id
  for (const t of [tenantA, tenantB]) {
    await ensureChartOfAccounts(t)
    unpaidType[t] = (await rec(t, 'leave_type', null, { category: 'unpaid', data: { name: 'Unpaid' } })).id
    paidType[t] = (await rec(t, 'leave_type', null, { category: 'paid', data: { name: 'Annual' } })).id
  }
  await mkUser('ceo', 'admin', tenantA)
  await mkUser('hr', 'hr', tenantA)
  await mkUser('mgmt', 'management', tenantA)
  await mkUser('hrB', 'hr', tenantB)

  // July 2026 (31 days): one person absent or on unpaid leave all month.
  const away = await mkEmp('Away', tenantA)
  for (let d = 1; d <= 15; d++) await att(tenantA, away, `2026-07-${String(d).padStart(2, '0')}`, 'absent')
  await leave(tenantA, away, unpaidType[tenantA]!, '2026-07-16', '2026-07-31', 16)
  await mkEmp('Normal', tenantA)
  // Leaves on 20 Aug; on the July payroll, then settled by a full & final.
  const leaver = await mkEmp('Leaver', tenantA, { status: 'resigned', lastWorkingDay: D('2026-08-20') })
  await att(tenantA, leaver, '2026-08-05', 'absent')
  await att(tenantA, leaver, '2026-08-06', 'half_day')
  await leave(tenantA, leaver, unpaidType[tenantA]!, '2026-08-10', '2026-08-11', 2)
  await leave(tenantA, leaver, paidType[tenantA]!, '2026-08-13', '2026-08-13', 1)
  await att(tenantA, leaver, '2026-08-13', 'absent') // on paid leave: not docked
  await att(tenantA, leaver, '2026-08-25', 'absent') // after leaving: not docked
  // Company B's leaver, same dates, no absences.
  await mkEmp('Leaver B', tenantB, { status: 'resigned', lastWorkingDay: D('2026-08-20') })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(hrRoutes, { prefix: '/hr' })
  await app.ready()
  expect((await call('hr', 'PUT', '/settings', SETTINGS)).statusCode).toBe(200)
  expect((await call('hrB', 'PUT', '/settings', SETTINGS)).statusCode).toBe(200)
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('no paid days → no tax, EOBI or SESSI (pure)', () => {
  const s = mergeSettings(SETTINGS as never)
  const emp = { grossSalaryCents: RS(31000), monthlyTaxCents: RS(1000), joiningDate: null, lastWorkingDay: null }

  it('a month with no paid days takes nothing statutory and says why; net is not negative', () => {
    const r = computePayslip(emp, '2026-07', { ...EMPTY_INPUTS, absentDays: 20, unpaidLeaveDays: 11 }, s)
    expect(r.basis.paidDays).toBe(0)
    expect(r.grossCents).toBe(0)
    expect(r.lines.find((l) => l.code === 'tax')).toEqual({ kind: 'deduction', code: 'tax', label: NO_TAX_NO_PAID_DAYS, amountCents: 0 })
    expect(r.lines.find((l) => l.code === 'eobi_employee')).toMatchObject({ label: NO_EOBI_NO_PAID_DAYS, amountCents: 0 })
    expect(r.lines.some((l) => l.kind === 'employer')).toBe(false)
    expect(r.eobiEmployeeCents).toBe(0)
    expect(r.eobiEmployerCents).toBe(0)
    expect(r.netCents).toBe(0)
    expect(r.warnings).toEqual([])
  })

  it('half a paid day is a paid month: tax and EOBI are taken as before', () => {
    const r = computePayslip(emp, '2026-07', { ...EMPTY_INPUTS, absentDays: 30.5 }, s)
    expect(r.basis.paidDays).toBe(0.5)
    const by = Object.fromEntries(r.lines.map((l) => [l.code, l.amountCents]))
    expect(by).toMatchObject({ tax: RS(1000), eobi_employee: RS(400), eobi_employer: RS(2000) })
  })

  it('a normal month is unchanged', () => {
    const r = computePayslip(emp, '2026-07', EMPTY_INPUTS, s)
    expect(r.lines.map((l) => [l.code, l.label, l.amountCents])).toEqual([
      ['salary', 'Salary — 31 of 31 days × Rs 1,000.00/day', RS(31000)],
      ['eobi_employee', 'EOBI employee (1%)', RS(400)],
      ['tax', 'Income tax', RS(1000)],
      ['eobi_employer', 'EOBI employer (5%)', RS(2000)],
      ['sessi_employer', 'SESSI employer (6%)', RS(1860)],
    ])
    expect(r.netCents).toBe(RS(31000 - 400 - 1000))
  })

  it('a full & final docks its months for absences and unpaid leave; a month with none paid takes no tax', () => {
    const base = { salaryFrom: D('2026-08-01'), otPayableCents: 0, leaveBalanceDays: 0, loanOutstandingCents: 0, deductionsCents: 0, otherAdjustmentsCents: 0 }
    const e = { grossSalaryCents: RS(31000), joiningDate: D('2026-01-01'), monthlyTaxCents: RS(1000) }
    const plain = finalSettlement(e, D('2026-08-20'), base, s)
    expect(plain.salaryPayable).toBe(RS(20000))
    const docked = finalSettlement(e, D('2026-08-20'), { ...base, attendanceByPeriod: { '2026-08': { absentDays: 1.5, unpaidLeaveDays: 2 } } }, s)
    expect(docked.salaryPayable).toBe(RS(16500))
    expect(docked.months[0]!.basis).toMatchObject({ employedDays: 20, absentDays: 1.5, unpaidLeaveDays: 2, paidDays: 16.5 })
    expect(docked.incomeTax).toBe(RS(1000))
    const none = finalSettlement(e, D('2026-08-20'), { ...base, attendanceByPeriod: { '2026-08': { absentDays: 20, unpaidLeaveDays: 0 } } }, s)
    expect(none.salaryPayable).toBe(0)
    expect(none.incomeTax + none.eobiEmployee + none.eobiEmployer + none.sessiEmployer).toBe(0)
    expect(none.netAmount).toBe(0)
  })
})

describe('payroll: a month with no paid days', () => {
  it('approves and locks with no tax for the absent person; the accrual balances; others unchanged', async () => {
    const r = await call('hr', 'POST', '/payroll/runs', { period: '2026-07' })
    expect(r.statusCode, r.body).toBe(201)
    const runId = r.json().id as string
    const slips = await prisma.hrPayslip.findMany({ where: { runId } })
    const of = (k: string) => slips.find((sl) => sl.employeeId === emps[k])!
    const lines = (k: string) => of(k).lines as Array<{ kind: string; code: string; label: string; amountCents: number }>

    const away = of('Away')
    expect((away.inputs as Record<string, unknown>)['payBasis']).toMatchObject({ employedDays: 31, absentDays: 15, unpaidLeaveDays: 16, paidDays: 0 })
    expect(away.grossCents).toBe(0)
    expect(away.netCents).toBe(0)
    expect(away.eobiEmployeeCents).toBe(0)
    expect(away.eobiEmployerCents).toBe(0)
    expect(lines('Away').find((l) => l.code === 'tax')).toMatchObject({ label: NO_TAX_NO_PAID_DAYS, amountCents: 0 })
    expect(lines('Away').some((l) => l.code === 'sessi_employer')).toBe(false)

    const normal = Object.fromEntries(lines('Normal').map((l) => [l.code, l.amountCents]))
    expect(normal).toMatchObject({ salary: RS(52000), tax: RS(1000), eobi_employee: RS(400), eobi_employer: RS(2000), sessi_employer: RS(3120) })
    expect(of('Normal').netCents).toBe(RS(52000 - 1400))

    expect((await call('ceo', 'POST', `/payroll/runs/${runId}/approve`)).statusCode).toBe(200)
    const lock = await call('ceo', 'POST', `/payroll/runs/${runId}/lock`)
    expect(lock.statusCode, lock.body).toBe(200)
    const e = await entry(tenantA, `hr.payroll.accrual:${runId}`)
    expect(e).not.toBeNull()
    expect(balanced(e!.lines)).toBe(true)
    // Tax for Normal + Leaver only; EOBI for the two who were paid.
    expect(amt(e!.lines, '2042', 'credit')).toBe(RS(2000))
    expect(amt(e!.lines, '2043', 'credit')).toBe(RS(2400) * 2)
    expect(amt(e!.lines, '2020', 'credit')).toBe(slips.reduce((a, sl) => a + sl.netCents, 0))
  })
})

describe('full & final applies the final month\'s attendance', () => {
  let fnf: string
  let calc: Record<string, number>

  it('pays the final month net of absences, half days and unpaid leave — not paid leave or days after leaving', async () => {
    fnf = (await call('hr', 'POST', '/records/final_settlement', { data: { employee: emps['Leaver'], lastWorkingDay: '2026-08-20' } })).json().id
    const r = await call('hr', 'POST', '/final-settlement/calculate', { employeeId: emps['Leaver'], lastWorkingDay: '2026-08-20', recordId: fnf })
    expect(r.statusCode, r.body).toBe(200)
    const c = r.json()
    expect(c.salaryFrom).toBe('2026-08-01T00:00:00.000Z')
    expect(c.months).toHaveLength(1)
    // 20 employed − 1 absent − 0.5 half day − 2 unpaid = 16.5 of 31 days.
    expect(c.months[0].basis).toMatchObject({ daysInMonth: 31, employedDays: 20, absentDays: 1.5, unpaidLeaveDays: 2, paidDays: 16.5 })
    expect(c.salaryPayable).toBe(Math.round(RS(52000) * 16.5 / 31))
    expect(c.salaryPayable).toBeLessThan(Math.round(RS(52000) * 20 / 31))
    expect(c.incomeTax).toBe(RS(1000))
    calc = c
  })

  it('once approved, its figures never change — added attendance does not move it', async () => {
    const saved = await call('hr', 'PATCH', `/records/final_settlement/${fnf}`, { data: Object.fromEntries(FNF_KEYS.map((k) => [k, calc[k]])) })
    expect(saved.statusCode, saved.body).toBe(200)
    const ok = await call('mgmt', 'POST', `/records/final_settlement/${fnf}/decide`, { decision: 'approved' })
    expect(ok.statusCode, ok.body).toBe(200)
    const before = await prisma.hrRecord.findUniqueOrThrow({ where: { id: fnf } })
    expect(before.status).toBe('approved')
    const e = await entry(tenantA, `hr.final_settlement.accrual:${fnf}`)
    expect(balanced(e!.lines)).toBe(true)

    await att(tenantA, emps['Leaver']!, '2026-08-07', 'absent')
    const again = await call('hr', 'POST', '/final-settlement/calculate', { employeeId: emps['Leaver'], lastWorkingDay: '2026-08-20', recordId: fnf })
    expect(again.statusCode).toBe(200)
    expect(again.json().months[0].basis.paidDays).toBe(15.5) // what it would be now…
    const after = await prisma.hrRecord.findUniqueOrThrow({ where: { id: fnf } })
    expect(after.data).toEqual(before.data) // …but the approved settlement is untouched
    expect(after.amountCents).toBe(before.amountCents)
    expect((after.data as Record<string, unknown>)['salaryPayable']).toBe(calc['salaryPayable'])
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA, reference: `hr.final_settlement.accrual:${fnf}` } })).toBe(1)
  })
})

describe('full & final over several months: window edges and a month with no paid days', () => {
  it('docks first unpaid day → last working day only; a no-paid month takes no tax / EOBI / SESSI; the accrual balances', async () => {
    // Last on a locked May payroll; leaves 20 Aug; owed Jun, Jul, Aug.
    const m = await mkEmp('Multi', tenantA, { status: 'resigned', lastWorkingDay: D('2026-08-20') })
    const may = await prisma.hrPayrollRun.create({ data: { tenantId: tenantA, period: '2026-05', status: 'locked', settings: {}, lockedAt: new Date() } })
    await prisma.hrPayslip.create({ data: { runId: may.id, tenantId: tenantA, employeeId: m, inputs: {}, lines: [], grossCents: 0, earningsCents: 0, deductionsCents: 0, eobiEmployeeCents: 0, eobiEmployerCents: 0, netCents: 0 } })
    await att(tenantA, m, '2026-05-31', 'absent') // a month payroll already paid
    await att(tenantA, m, '2026-06-01', 'absent') // the first unpaid day
    await leave(tenantA, m, unpaidType[tenantA]!, '2026-07-01', '2026-07-31', 31) // all of July
    await att(tenantA, m, '2026-08-20', 'half_day') // the last working day
    await att(tenantA, m, '2026-08-21', 'absent') // after leaving

    const fnf = (await call('hr', 'POST', '/records/final_settlement', { data: { employee: m, lastWorkingDay: '2026-08-20' } })).json().id as string
    const r = await call('hr', 'POST', '/final-settlement/calculate', { employeeId: m, lastWorkingDay: '2026-08-20', recordId: fnf })
    expect(r.statusCode, r.body).toBe(200)
    const c = r.json()
    expect(c.salaryFrom).toBe('2026-06-01T00:00:00.000Z')
    expect(c.months.map((x: { period: string }) => x.period)).toEqual(['2026-06', '2026-07', '2026-08'])
    expect(c.months[0].basis).toMatchObject({ employedDays: 30, absentDays: 1, unpaidLeaveDays: 0, paidDays: 29 })
    expect(c.months[1].basis).toMatchObject({ employedDays: 31, absentDays: 0, unpaidLeaveDays: 31, paidDays: 0 })
    expect(c.months[1]).toMatchObject({ salaryCents: 0, taxCents: 0, eobiEmployeeCents: 0, eobiEmployerCents: 0, sessiEmployerCents: 0 })
    expect(c.months[2].basis).toMatchObject({ employedDays: 20, absentDays: 0.5, paidDays: 19.5 })
    expect(c.salaryPayable).toBe(Math.round(RS(52000) * 29 / 30) + Math.round(RS(52000) * 19.5 / 31))
    expect(c.incomeTax).toBe(RS(2000))
    expect(c.eobiEmployee).toBe(RS(800))
    expect(c.eobiEmployer).toBe(RS(4000))
    // Gratuity / leave encashment do not read attendance.
    const plain = finalSettlement({ grossSalaryCents: RS(52000), monthlyTaxCents: RS(1000), joiningDate: D('2026-01-01') }, D('2026-08-20'), {
      salaryFrom: D('2026-06-01'), otPayableCents: 0, leaveBalanceDays: c.leaveBalanceDays, loanOutstandingCents: 0, deductionsCents: 0, otherAdjustmentsCents: 0, gratuityCents: c.gratuity,
    }, mergeSettings(SETTINGS as never))
    expect(c.leaveEncashment).toBe(plain.leaveEncashment)
    expect(c.gratuity).toBe(plain.gratuity)

    const saved = await call('hr', 'PATCH', `/records/final_settlement/${fnf}`, { data: Object.fromEntries(FNF_KEYS.map((k) => [k, c[k]])) })
    expect(saved.statusCode, saved.body).toBe(200)
    const ok = await call('mgmt', 'POST', `/records/final_settlement/${fnf}/decide`, { decision: 'approved' })
    expect(ok.statusCode, ok.body).toBe(200)
    const e = await entry(tenantA, `hr.final_settlement.accrual:${fnf}`)
    expect(e).not.toBeNull()
    expect(balanced(e!.lines)).toBe(true)
    expect(amt(e!.lines, '2042', 'credit')).toBe(RS(2000))
    expect(amt(e!.lines, '2043', 'credit')).toBe(RS(800 + 4000))
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantB, reference: `hr.final_settlement.accrual:${fnf}` } })).toBe(0)
  })

  it('a joining day stored with a time still counts that day\'s absence', async () => {
    const j = await mkEmp('Joiner', tenantA, { joiningDate: new Date('2026-08-05T09:30:00.000Z'), status: 'resigned', lastWorkingDay: D('2026-08-20') })
    await att(tenantA, j, '2026-08-05', 'absent')
    await att(tenantA, j, '2026-08-04', 'absent') // before joining
    const a = await settlementAttendance(tenantA, j, new Date('2026-08-05T09:30:00.000Z'), D('2026-08-01'), D('2026-08-20'), await getSettings(tenantA))
    expect(a).toEqual({ '2026-08': { absentDays: 1, unpaidLeaveDays: 0 } })
  })
})

describe('two companies', () => {
  it('company B cannot calculate A\'s leaver; A\'s attendance never touches B\'s settlement', async () => {
    expect((await call('hrB', 'POST', '/final-settlement/calculate', { employeeId: emps['Leaver'], lastWorkingDay: '2026-08-20' })).statusCode).toBe(404)
    const r = await call('hrB', 'POST', '/final-settlement/calculate', { employeeId: emps['Leaver B'], lastWorkingDay: '2026-08-20' })
    expect(r.statusCode, r.body).toBe(200)
    const c = r.json()
    expect(c.months[0].basis).toMatchObject({ employedDays: 20, absentDays: 0, unpaidLeaveDays: 0, paidDays: 20 })
    expect(c.salaryPayable).toBe(Math.round(RS(52000) * 20 / 31))
    // A's calculate never reaches B's employee either.
    expect((await call('hr', 'POST', '/final-settlement/calculate', { employeeId: emps['Leaver B'], lastWorkingDay: '2026-08-20' })).statusCode).toBe(404)
  })
})
