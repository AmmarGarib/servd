// Payroll pay basis (owner HR-1 / HR-2, 2026-10-16): "we will do by actual
// number of days in a month" — salary = monthly gross ÷ the month's calendar
// days × paid days, where paid days = days employed − absent − unpaid leave.
//
//   - weekly off days, holidays, paid leave and days with no attendance record
//     are paid days; an absence (not on leave) and approved unpaid leave are not
//   - a joiner / leaver: the days before joining or after leaving are not
//     employed — never absences (HR-2)
//   - the basis (days in month, paid days, per-day rate) is kept on the
//     payslip and is what the Payroll Report's Days Worked shows
//   - a locked run calculated before the change keeps its figures; only a
//     draft is recalculated
//   - two companies: each run pays its own staff on its own month; company B
//     never sees or recalculates company A's run (404)
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

const RS = (r: number) => r * 100
const stamp = Date.now()
const D = (s: string) => new Date(`${s}T00:00:00.000Z`)

let app: FastifyInstance
let tenantA: string, tenantB: string
const users: Record<string, { id: string; token: string }> = {}
const emps: Record<string, string> = {}
let unpaidTypeA: string, paidTypeA: string

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${stamp}@paydays.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
async function mkEmp(key: string, tenantId: string, grossRs: number, extra: Record<string, unknown> = {}) {
  const e = await prisma.hrEmployee.create({
    data: { tenantId, employeeCode: `PD-${String(Object.keys(emps).length + 1).padStart(4, '0')}`, fullName: key, grossSalaryCents: RS(grossRs), monthlyTaxCents: 0, joiningDate: D('2025-01-01'), paymentMethod: 'bank', ...extra },
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

type Slip = { employeeId: string; grossCents: number; netCents: number; lines: Array<{ code: string; label: string; amountCents: number }>; inputs: Record<string, unknown> }
async function slipsOf(who: string, runId: string): Promise<Map<string, Slip>> {
  const r = await call(who, 'GET', `/payroll/runs/${runId}`)
  expect(r.statusCode, r.body).toBe(200)
  return new Map((r.json().payslips as Slip[]).map((s) => [s.employeeId, s]))
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: `PayDays A ${stamp}`, slug: `paydays-a-${stamp}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: `PayDays B ${stamp}`, slug: `paydays-b-${stamp}` } })).id
  for (const t of [tenantA, tenantB]) await ensureChartOfAccounts(t)
  await mkUser('hrA', 'hr', tenantA)
  await mkUser('ceoA', 'admin', tenantA)
  await mkUser('hrB', 'hr', tenantB)
  unpaidTypeA = (await rec(tenantA, 'leave_type', null, { category: 'unpaid', data: { name: 'Unpaid' } })).id
  paidTypeA = (await rec(tenantA, 'leave_type', null, { category: 'paid', data: { name: 'Annual' } })).id

  // Company A, January 2027 (31 days). Rs 62,000 = Rs 2,000 a day.
  const full = await mkEmp('a-full', tenantA, 62000)
  // Weekly offs, a holiday, paid leave and a late are paid days.
  await att(tenantA, full, '2027-01-03', 'off_day')
  await att(tenantA, full, '2027-01-10', 'off_day')
  await att(tenantA, full, '2027-01-05', 'holiday')
  await att(tenantA, full, '2027-01-06', 'late')
  await leave(tenantA, full, paidTypeA, '2027-01-12', '2027-01-13', 2)
  await att(tenantA, full, '2027-01-12', 'absent') // on paid leave: not an absence
  // One absence and a half day; two days of unpaid leave.
  await att(tenantA, full, '2027-01-20', 'absent')
  await att(tenantA, full, '2027-01-21', 'half_day')
  await leave(tenantA, full, unpaidTypeA, '2027-01-25', '2027-01-26', 2)
  // A joiner on 22 Jan (10 of 31 days), absent once.
  const joiner = await mkEmp('a-joiner', tenantA, 62000, { joiningDate: D('2027-01-22') })
  await att(tenantA, joiner, '2027-01-25', 'absent')
  // An absence recorded before joining is not counted.
  await att(tenantA, joiner, '2027-01-05', 'absent')
  // A leaver on 15 Jan (15 of 31 days), one day unpaid leave.
  const leaver = await mkEmp('a-leaver', tenantA, 62000, { lastWorkingDay: D('2027-01-15') })
  await leave(tenantA, leaver, unpaidTypeA, '2027-01-14', '2027-01-14', 1)
  await att(tenantA, leaver, '2027-01-20', 'absent') // after leaving: not counted

  // Company B, February 2027 (28 days). Rs 56,000 = Rs 2,000 a day.
  await mkEmp('b-full', tenantB, 56000)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(hrRoutes, { prefix: '/hr' })
  await app.ready()
})

afterAll(async () => {
  for (const t of [tenantA, tenantB]) {
    await prisma.hrPayrollRun.deleteMany({ where: { tenantId: t } })
    await prisma.hrRecord.deleteMany({ where: { tenantId: t } })
    await prisma.hrEmployee.deleteMany({ where: { tenantId: t } })
    await prisma.setting.deleteMany({ where: { key: `hr.settings.${t}` } })
    await prisma.auditLog.deleteMany({ where: { tenantId: t } }).catch(() => {})
    await prisma.tenantMember.deleteMany({ where: { tenantId: t } }).catch(() => {})
    await prisma.user.deleteMany({ where: { tenantId: t } })
    await prisma.account.updateMany({ where: { tenantId: t }, data: { controlledBy: null } })
    await prisma.tenant.deleteMany({ where: { id: t } })
  }
  await app.close()
})

describe('pay = gross ÷ days in month × paid days (HR-1)', () => {
  let runA: string

  it('pays a full month net of absences and unpaid leave — offs, holidays and paid leave are paid', async () => {
    const r = await call('hrA', 'POST', '/payroll/runs', { period: '2027-01' })
    expect(r.statusCode, r.body).toBe(201)
    runA = r.json().id
    const s = (await slipsOf('hrA', runA)).get(emps['a-full']!)!
    // 31 − 1 absent − 0.5 half day − 2 unpaid = 27.5 paid days × Rs 2,000.
    expect(s.inputs['payBasis']).toEqual({ daysInMonth: 31, employedDays: 31, absentDays: 1.5, unpaidLeaveDays: 2, paidDays: 27.5, dailyRateCents: RS(2000), monthlyGrossCents: RS(62000) })
    expect(s.grossCents).toBe(RS(55000))
    expect(s.lines.find((l) => l.code === 'salary')).toMatchObject({ amountCents: RS(55000), label: 'Salary — 27.5 of 31 days × Rs 2,000.00/day (1.5 absent, 2 unpaid leave)' })
    expect(s.lines.map((l) => l.code)).not.toContain('absence')
    expect(s.lines.map((l) => l.code)).not.toContain('unpaid_leave')
    expect(s.netCents).toBe(RS(55000))
  })

  it('pays a joiner and a leaver only for the days employed, net of their own absences', async () => {
    const slips = await slipsOf('hrA', runA)
    const j = slips.get(emps['a-joiner']!)!
    expect(j.inputs['payBasis']).toMatchObject({ daysInMonth: 31, employedDays: 10, absentDays: 1, unpaidLeaveDays: 0, paidDays: 9 })
    expect(j.grossCents).toBe(RS(18000))
    const l = slips.get(emps['a-leaver']!)!
    expect(l.inputs['payBasis']).toMatchObject({ daysInMonth: 31, employedDays: 15, absentDays: 0, unpaidLeaveDays: 1, paidDays: 14 })
    expect(l.grossCents).toBe(RS(28000))
  })

  it('shows the salary breakup (total salary → attendance → gross → deductions → net) on the run, payslip and register', async () => {
    const run = await call('hrA', 'GET', `/payroll/runs/${runA}`)
    expect(run.statusCode, run.body).toBe(200)
    type K = { totalSalaryCents: number; basicCents: number; allowancesCents: number; attendanceDeductionCents: number; otherEarnings: Array<{ cents: number }>; lateCents: number; grossCents: number; taxCents: number; otherDeductionsCents: number; eobiCents: number; netCents: number }
    const slips = (run.json() as { payslips: Array<{ netCents: number; employee: Record<string, unknown>; breakup: K }> }).payslips
    expect(slips.length).toBeGreaterThan(0)
    for (const s of slips) {
      const k = s.breakup
      expect(k.basicCents + k.allowancesCents).toBe(k.totalSalaryCents)
      expect(k.totalSalaryCents - k.attendanceDeductionCents + k.otherEarnings.reduce((a, x) => a + x.cents, 0)).toBe(k.grossCents)
      expect(k.grossCents - k.taxCents - k.otherDeductionsCents - k.eobiCents).toBe(s.netCents)
      expect(s.employee).not.toHaveProperty('data') // only the breakup leaves the employee master
    }
    const full = slips.find((s) => s.employee['employeeCode'] === 'a-full') ?? slips[0]!
    expect(full.breakup.totalSalaryCents).toBeGreaterThan(full.breakup.grossCents - 1)
    const csv = await call('hrA', 'GET', `/payroll/runs/${runA}/export.csv?kind=register`)
    const head = csv.body.trim().split('\n')[0]!
    for (const h of ['Basic', 'Allowances', 'Total salary', 'Attendance deduction', 'Gross', 'Income tax', 'Other deductions', 'Net']) expect(head).toContain(h)
  })

  it('shows the paid days and per-day rate in the register and the Payroll Report', async () => {
    const csv = await call('hrA', 'GET', `/payroll/runs/${runA}/export.csv?kind=register`)
    expect(csv.statusCode).toBe(200)
    const [head, ...rows] = csv.body.trim().split('\n')
    expect(head).toContain('Days in month')
    expect(head).toContain('Paid days')
    expect(head).toContain('Per-day rate')
    expect(rows.some((r) => r.includes('a-full') && r.includes(',31,27.5,2000.00,'))).toBe(true)

    const rep = await call('hrA', 'GET', '/reports/payroll_report?month=2027-01')
    expect(rep.statusCode, rep.body).toBe(200)
    const t = rep.json() as { header: string[]; rows: unknown[][]; note: string }
    const col = (name: string) => t.header.indexOf(name)
    const row = t.rows.find((r) => r[1] === 'a-full')!
    expect(row[col('Days Worked')]).toBe(27.5)
    expect(row[col('Salary Earned')]).toBe(55000)
    expect(row[col('Unpaid Leave Ded.')]).toBe(0)
    expect(t.note).toMatch(/calendar days of the month × Days Worked/)
  })

  it('never recalculates a locked run — its figures stay as they were', async () => {
    // A run locked before HR-1, on the old 26-day lines.
    const emp = emps['a-full']!
    const old = await prisma.hrPayrollRun.create({
      data: { tenantId: tenantA, period: '2026-12', status: 'locked', lockedAt: new Date(), settings: { workingDaysPerMonth: 26 }, totals: { employees: 1, grossCents: RS(62000), netCents: RS(59615) } },
    })
    const lines = [
      { kind: 'earning', code: 'salary', label: 'Salary', amountCents: RS(62000) },
      { kind: 'deduction', code: 'absence', label: 'Absence (1 days)', amountCents: 238_462 },
    ]
    await prisma.hrPayslip.create({
      data: { runId: old.id, tenantId: tenantA, employeeId: emp, inputs: { absentDays: 1, unpaidLeaveDays: 0 }, lines, grossCents: RS(62000), earningsCents: RS(62000), deductionsCents: 238_462, eobiEmployeeCents: 0, eobiEmployerCents: 0, netCents: 5_961_538 },
    })
    const re = await call('hrA', 'POST', `/payroll/runs/${old.id}/recalculate`)
    expect(re.statusCode).toBe(409)
    const s = (await slipsOf('hrA', old.id)).get(emp)!
    expect(s.lines).toEqual(lines)
    expect(s.netCents).toBe(5_961_538)
    expect(s.inputs['payBasis']).toBeUndefined()
    // The report reads the locked payslips as they are.
    const t = (await call('hrA', 'GET', '/reports/payroll_report?month=2026-12')).json() as { header: string[]; rows: unknown[][] }
    const row = t.rows.find((r) => r[1] === 'a-full')!
    expect(row[t.header.indexOf('Salary Earned')]).toBe(62000)
    expect(row[t.header.indexOf('Net Salary Payable')]).toBe(59615.38)
  })
})

describe('two companies', () => {
  it('pays company B on its own month (28 days) and keeps the runs apart', async () => {
    const r = await call('hrB', 'POST', '/payroll/runs', { period: '2027-02' })
    expect(r.statusCode, r.body).toBe(201)
    const runB = r.json().id as string
    expect(r.json().tenantId).toBe(tenantB)
    const slips = await slipsOf('hrB', runB)
    expect(Array.from(slips.keys())).toEqual([emps['b-full']])
    const s = slips.get(emps['b-full']!)!
    expect(s.inputs['payBasis']).toMatchObject({ daysInMonth: 28, paidDays: 28, dailyRateCents: RS(2000) })
    expect(s.grossCents).toBe(RS(56000))

    // Company A's run is not company B's: 404 to read, recalculate or export.
    const runA = (await prisma.hrPayrollRun.findFirstOrThrow({ where: { tenantId: tenantA, period: '2027-01' } })).id
    expect((await call('hrB', 'GET', `/payroll/runs/${runA}`)).statusCode).toBe(404)
    expect((await call('hrB', 'POST', `/payroll/runs/${runA}/recalculate`)).statusCode).toBe(404)
    expect((await call('hrB', 'GET', `/payroll/runs/${runA}/export.csv?kind=register`)).statusCode).toBe(404)
    expect((await call('hrA', 'GET', `/payroll/runs/${runB}`)).statusCode).toBe(404)
    // B's Payroll Report for January has none of A's staff.
    const t = (await call('hrB', 'GET', '/reports/payroll_report?month=2027-01')).json() as { rows: unknown[][] }
    expect(t.rows.some((row) => typeof row[1] === 'string' && (row[1] as string).startsWith('a-'))).toBe(false)
  })

  it('drops a retired 26-day setting a PUT still sends', async () => {
    const cur = (await call('hrB', 'GET', '/settings')).json()
    const put = await call('hrB', 'PUT', '/settings', { ...cur, workingDaysPerMonth: 26 })
    expect(put.statusCode, put.body).toBe(200)
    expect(put.json().workingDaysPerMonth).toBeUndefined()
    const row = await prisma.setting.findUnique({ where: { key: `hr.settings.${tenantB}` } })
    expect(JSON.parse(row!.value).workingDaysPerMonth).toBeUndefined()
  })
})

// Gate (2026-10-16): the arithmetic edges, on the pure engine.
import { computePayslip, mergeSettings, EMPTY_INPUTS, finalSettlement } from '../src/modules/hr/logic.js'

describe('pay basis edges (pure)', () => {
  const s = mergeSettings({ latesPerDeductionDay: 3 })
  const emp = (gross: number, joiningDate: Date | null = null, lastWorkingDay: Date | null = null, tax = 0) => ({ grossSalaryCents: gross, monthlyTaxCents: tax, joiningDate, lastWorkingDay })

  it('a leap February divides by 29; a half day takes half a day, rounded once', () => {
    expect(computePayslip(emp(RS(29000)), '2028-02', EMPTY_INPUTS, s).basis).toMatchObject({ daysInMonth: 29, paidDays: 29, dailyRateCents: RS(1000) })
    const r = computePayslip(emp(1234567), '2026-10', { ...EMPTY_INPUTS, absentDays: 0.5 }, s)
    expect(r.grossCents).toBe(Math.round(1234567 * 30.5 / 31))
  })

  it('a joiner who leaves the same month is paid only those days, docked at most what they were employed', () => {
    const r = computePayslip(emp(RS(31000), D('2026-10-10'), D('2026-10-20')), '2026-10', { ...EMPTY_INPUTS, absentDays: 2, unpaidLeaveDays: 3 }, s)
    expect(r.basis).toMatchObject({ employedDays: 11, absentDays: 2, unpaidLeaveDays: 3, paidDays: 6 })
    expect(r.grossCents).toBe(RS(6000))
    const over = computePayslip(emp(RS(31000), D('2026-10-10'), D('2026-10-20')), '2026-10', { ...EMPTY_INPUTS, absentDays: 2, unpaidLeaveDays: 20 }, s)
    expect(over.basis.paidDays).toBe(0)
    expect(over.grossCents).toBe(0)
  })

  it('joining and leaving on the same day counts that day even when the stored times are out of order', () => {
    const r = computePayslip(emp(RS(31000), new Date('2026-10-16T10:00:00Z'), new Date('2026-10-16T00:00:00Z')), '2026-10', EMPTY_INPUTS, s)
    expect(r.basis.employedDays).toBe(1)
    expect(r.grossCents).toBe(RS(1000))
  })

  it('lates are docked at the same daily rate, never below the salary earned; OT and allowances stay', () => {
    const r = computePayslip(emp(RS(30000)), '2026-09', { ...EMPTY_INPUTS, absentDays: 29, lateCount: 9, otHours: 1, otCents: 5000, earningAdjustmentsCents: 7000 }, s)
    const by = Object.fromEntries(r.lines.map((l) => [l.code, l.amountCents]))
    expect(by).toMatchObject({ salary: RS(1000), late: RS(1000), overtime: 5000, adjustments: 7000 })
    expect(r.netCents).toBe(12000)
  })

  it('EOBI and SESSI on gross stay on the days employed, not lowered by absences', () => {
    const g = mergeSettings({ eobi: { enabled: true, employeePct: 1, employerPct: 5, base: 'gross', fixedWageCents: null }, sessi: { employerPct: 6, wageCeilingCents: null } })
    const r = computePayslip(emp(RS(30000), D('2026-09-16')), '2026-09', { ...EMPTY_INPUTS, absentDays: 5 }, g)
    expect(r.grossCents).toBe(RS(10000))
    expect(r.eobiEmployeeCents).toBe(RS(150))
    expect(r.lines.find((l) => l.code === 'sessi_employer')!.amountCents).toBe(RS(900))
  })

  it('full & final pays each month on its own calendar days and encashes leave at the leaving month\'s rate', () => {
    const f = finalSettlement({ grossSalaryCents: RS(30000), joiningDate: D('2026-10-10'), monthlyTaxCents: 0 }, D('2026-11-15'), {
      salaryFrom: D('2026-10-01'), otPayableCents: 0, leaveBalanceDays: 2.5, loanOutstandingCents: 0, deductionsCents: 0, otherAdjustmentsCents: 0,
      salaryByPeriod: { '2026-10': RS(31000), '2026-11': RS(30000) },
    }, s)
    expect(f.months.map((m) => m.salaryCents)).toEqual([RS(22000), RS(15000)])
    expect(f.leaveEncashment).toBe(RS(2500))
  })
})
