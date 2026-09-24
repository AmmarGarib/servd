// HR module — the rules that must hold whatever format HR loads.
//
//   Pure logic:  EOBI, overtime, payslip arithmetic and proration, loan
//                installments to the paisa, approval permissions, format
//                checks, letter rendering.
//   Through the real API (Fastify inject, real DB):  a leave balance that
//                refuses over-booking, an approval chain HOD → HR, a salary
//                revision that waits for its effective date, and a payroll
//                month that carries OT and a loan — then locks and recovers.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { hrRoutes } from '../src/modules/hr/routes.js'
import {
  DEFAULT_HR_SETTINGS, mergeSettings, eobiContribution, overtimeCents, computePayslip, EMPTY_INPUTS,
  loanInstallmentCents, canActOnStep, employedFraction,
} from '../src/modules/hr/logic.js'
import { sectionByKey, validateAgainst, checkFormat, HR_SECTIONS } from '../src/modules/hr/forms.js'
import { renderLetter } from '../src/modules/hr/letters.js'

const RS = (r: number) => r * 100 // rupees → paisa

// ─── pure logic ─────────────────────────────────────────────────────────────

describe('EOBI', () => {
  it('refuses to guess when no wage base is set', () => {
    const r = eobiContribution(RS(60000), DEFAULT_HR_SETTINGS)
    expect(r.employeeCents).toBe(0)
    expect(r.problem).toMatch(/EOBI wage base/)
  })
  it('is 1% / 5% of the fixed base, not the salary', () => {
    const s = mergeSettings({ eobi: { employeePct: 1, employerPct: 5, base: 'fixed', fixedWageCents: RS(40000) } })
    expect(eobiContribution(RS(90000), s)).toEqual({ employeeCents: RS(400), employerCents: RS(2000) })
  })
  it('can be set to use gross instead', () => {
    const s = mergeSettings({ eobi: { employeePct: 1, employerPct: 5, base: 'gross', fixedWageCents: null } })
    expect(eobiContribution(RS(50000), s)).toEqual({ employeeCents: RS(500), employerCents: RS(2500) })
  })
})

describe('overtime', () => {
  it('is hours × (gross ÷ working days ÷ hours per day) × multiplier', () => {
    // 52,000 / 26 / 8 = Rs 250/h; 3 h at 2× = Rs 1,500
    expect(overtimeCents(3, RS(52000), DEFAULT_HR_SETTINGS)).toBe(RS(1500))
    expect(overtimeCents(3, RS(52000), DEFAULT_HR_SETTINGS, 1.5)).toBe(RS(1125))
    expect(overtimeCents(0, RS(52000), DEFAULT_HR_SETTINGS)).toBe(0)
  })
})

describe('payslip', () => {
  const s = mergeSettings({ eobi: { employeePct: 1, employerPct: 5, base: 'fixed', fixedWageCents: RS(40000) }, latesPerDeductionDay: 3 })
  const emp = { grossSalaryCents: RS(52000), monthlyTaxCents: RS(1000), joiningDate: null, lastWorkingDay: null }

  it('adds and deducts every line, and nets to the paisa', () => {
    const r = computePayslip(emp, '2026-09', {
      ...EMPTY_INPUTS, absentDays: 1, lateCount: 4, otHours: 3, otCents: RS(1500),
      earningAdjustmentsCents: RS(2000), loanInstallmentsCents: RS(5000),
    }, s)
    const daily = RS(52000) / 26 // Rs 2,000
    // earnings 52,000 + 1,500 + 2,000; deductions absence 2,000 + late (4 lates → 1 day) 2,000 + EOBI 400 + tax 1,000 + loan 5,000
    expect(r.earningsCents).toBe(RS(55500))
    expect(r.deductionsCents).toBe(daily * 2 + RS(400) + RS(1000) + RS(5000))
    expect(r.netCents).toBe(RS(55500) - RS(10400))
    expect(r.eobiEmployerCents).toBe(RS(2000))
    expect(r.lines.find((l) => l.kind === 'employer')?.amountCents).toBe(RS(2000))
    expect(r.warnings).toEqual([])
  })

  it('pays a mid-month joiner for the days employed', () => {
    // joins 16 Sep: 15 of 30 days
    const r = computePayslip({ ...emp, joiningDate: new Date('2026-09-16') }, '2026-09', EMPTY_INPUTS, s)
    expect(r.grossCents).toBe(RS(26000))
    expect(employedFraction('2026-09', new Date('2026-09-16'), null)).toBe(0.5)
  })

  it('flags a negative net instead of hiding it', () => {
    const r = computePayslip(emp, '2026-09', { ...EMPTY_INPUTS, deductionAdjustmentsCents: RS(100000) }, s)
    expect(r.netCents).toBeLessThan(0)
    expect(r.warnings.join(' ')).toMatch(/negative/)
  })
})

describe('loan installments', () => {
  const loan = { amountCents: RS(10000), installments: 3, firstPeriod: '2026-09' }
  it('recovers exactly the loan, the last installment taking the remainder', () => {
    let rec = 0
    const got: number[] = []
    for (const p of ['2026-08', '2026-09', '2026-10', '2026-11', '2026-12']) { const c = loanInstallmentCents(loan, p, rec); got.push(c); rec += c }
    expect(got[0]).toBe(0) // before the first month
    expect(rec).toBe(RS(10000))
    expect(got[4]).toBe(0) // nothing after it is repaid
  })
})

describe('who can approve', () => {
  it('never lets someone approve their own request', () => {
    expect(canActOnStep('hr', { id: 'u1', role: 'hr' }, { employeeUserId: 'u1', managerUserId: null }).ok).toBe(false)
  })
  it('gives the HOD step to the reporting manager', () => {
    expect(canActOnStep('hod', { id: 'boss', role: 'manager' }, { employeeUserId: 'e', managerUserId: 'boss' }).ok).toBe(true)
    expect(canActOnStep('hod', { id: 'other', role: 'manager' }, { employeeUserId: 'e', managerUserId: 'boss' }).ok).toBe(false)
  })
  it('lets HR act for a missing HOD so nothing gets stuck', () => {
    expect(canActOnStep('hod', { id: 'h', role: 'hr' }, { employeeUserId: 'e', managerUserId: null }).ok).toBe(true)
  })
  it('marks a CEO acting outside their step as an override', () => {
    expect(canActOnStep('hod', { id: 'ceo', role: 'admin' }, { employeeUserId: 'e', managerUserId: 'boss' })).toMatchObject({ ok: true, override: true })
  })
})

describe('formats', () => {
  it('every default format passes its own checks', () => {
    for (const sec of HR_SECTIONS.filter((x) => x.kind === 'record')) {
      expect(checkFormat(sec, sec.fields ?? []), sec.key).toEqual([])
    }
  })
  it('refuses a format that drops a binding the logic needs', () => {
    const leave = sectionByKey('leave')!
    const without = leave.fields!.map((f) => (f.bind === 'endDate' ? { ...f, bind: undefined } : f))
    expect(checkFormat(leave, without).join(' ')).toMatch(/endDate/)
  })
  it('refuses a format that deletes a system field, but allows relabelling it', () => {
    const ot = sectionByKey('overtime')!
    expect(checkFormat(ot, ot.fields!.filter((f) => f.key !== 'otAmount')).join(' ')).toMatch(/cannot be removed/)
    expect(checkFormat(ot, ot.fields!.map((f) => (f.key === 'otAmount' ? { ...f, label: 'Overtime pay' } : f)))).toEqual([])
  })
  it('validates, coerces and lifts bound values into slots', () => {
    const v = validateAgainst(sectionByKey('overtime')!.fields!, { employee: 'e1', date: '2026-09-10', otHours: '3' })
    expect(v.errors).toEqual([])
    expect(v.slots).toMatchObject({ employeeId: 'e1', quantity: 3 })
    expect(validateAgainst(sectionByKey('overtime')!.fields!, { date: '2026-09-10' }).errors.map((e) => e.field)).toContain('employee')
  })
})

describe('letters', () => {
  it('escapes values and shows unknown placeholders instead of blanking them', () => {
    const r = renderLetter('<p>Dear {{employee.fullName}}, {{employee.nope}}</p>', { employee: { fullName: 'Ali <b>' } })
    expect(r.html).toBe('<p>Dear Ali &lt;b&gt;, [employee.nope]</p>')
    expect(r.missing).toEqual(['employee.nope'])
  })
})

// ─── through the API ────────────────────────────────────────────────────────

let app: FastifyInstance
let tenantId: string
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.hrtest@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } as never }).catch(() => {})
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url: `/hr${url}`, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}` } })

beforeAll(async () => {
  tenantId = (await prisma.tenant.create({ data: { name: 'HR Test Co', slug: 'hr-test-co' } })).id
  await mkUser('ceo', 'admin')
  await mkUser('hr', 'hr')
  await mkUser('boss', 'manager')
  await mkUser('cook', 'kitchen')
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
  await prisma.hrPayrollRun.deleteMany({ where: { tenantId } })
  await prisma.hrRecord.deleteMany({ where: { tenantId } })
  await prisma.hrEmployee.deleteMany({ where: { tenantId } })
  await prisma.setting.deleteMany({ where: { key: `hr.settings.${tenantId}` } })
  await prisma.auditLog.deleteMany({ where: { tenantId } }).catch(() => {})
  await prisma.tenantMember.deleteMany({ where: { tenantId } }).catch(() => {})
  await prisma.user.deleteMany({ where: { tenantId } })
  await prisma.tenant.deleteMany({ where: { id: tenantId } })
  await app.close()
})

describe('HR through the API', () => {
  let bossEmp: string, cookEmp: string, annual: string

  it('creates employees from the Employee Master format, generating IDs', async () => {
    const b = await call('hr', 'POST', '/employees', { data: { fullName: 'Head Chef', grossSalaryCents: RS(150000), joiningDate: '2025-01-01', employmentType: 'permanent' } })
    expect(b.statusCode).toBe(201)
    expect(b.json().employeeCode).toBe('EMP-0001')
    bossEmp = b.json().id
    await call('hr', 'POST', `/employees/${bossEmp}/link-user`, { userId: users['boss']!.id })
    const c = await call('hr', 'POST', '/employees', { data: { fullName: 'Line Cook', grossSalaryCents: RS(52000), joiningDate: '2025-06-01', managerId: bossEmp, employmentType: 'permanent' } })
    expect(c.json().employeeCode).toBe('EMP-0002')
    cookEmp = c.json().id
    await call('hr', 'POST', `/employees/${cookEmp}/link-user`, { userId: users['cook']!.id })
  })

  it('keeps salaries away from anyone outside HR', async () => {
    expect((await call('cook', 'GET', '/employees')).statusCode).toBe(403)
    expect((await call('boss', 'GET', `/employees/${cookEmp}`)).statusCode).toBe(403)
  })

  it('books leave against the balance and refuses over-booking', async () => {
    annual = (await call('hr', 'POST', '/records/leave_type', { data: { name: 'Annual', entitlementDays: 14, pay: 'paid' } })).json().id
    const ok = await call('cook', 'POST', '/me/records/leave', { data: { leaveType: annual, from: '2026-10-05', to: '2026-10-09' } })
    expect(ok.statusCode).toBe(201)
    expect(ok.json().quantity).toBe(5)
    const tooMuch = await call('cook', 'POST', '/me/records/leave', { data: { leaveType: annual, from: '2026-11-01', to: '2026-11-12' } })
    expect(tooMuch.statusCode).toBe(400)
    expect(tooMuch.json().error.code).toBe('LEAVE_BALANCE') // 14 − 5 pending = 9 < 12
  })

  it('routes approval HOD → HR, and only the right people can act', async () => {
    const leave = (await call('hr', 'GET', `/records/leave?employeeId=${cookEmp}`)).json().records[0]
    expect((await call('cook', 'POST', `/records/leave/${leave.id}/decide`, { decision: 'approved' })).statusCode).toBe(403) // own request
    expect((await call('hr', 'POST', `/records/leave/${leave.id}/decide`, { decision: 'approved' })).statusCode).toBe(403) // HOD step belongs to the boss
    const inbox = (await call('boss', 'GET', '/approvals')).json()
    expect(inbox.map((r: { id: string }) => r.id)).toContain(leave.id)
    expect((await call('boss', 'POST', `/records/leave/${leave.id}/decide`, { decision: 'approved' })).json().status).toBe('submitted')
    expect((await call('hr', 'POST', `/records/leave/${leave.id}/decide`, { decision: 'approved' })).json().status).toBe('approved')
    const me = (await call('cook', 'GET', '/me')).json()
    expect(me.leaveBalances.find((b: { leaveTypeId: string }) => b.leaveTypeId === annual).balance).toBe(9)
  })

  it('holds a future-dated salary revision until its effective date', async () => {
    const rev = (await call('hr', 'POST', '/records/salary_revision', { data: { employee: cookEmp, revisedGross: RS(60000), effectiveDate: '2099-01-01' } })).json()
    expect(rev.data.increaseAmount).toBe(RS(8000))
    await call('hr', 'POST', `/records/salary_revision/${rev.id}/decide`, { decision: 'approved' })
    await call('ceo', 'POST', `/records/salary_revision/${rev.id}/decide`, { decision: 'approved' })
    const e = (await call('hr', 'GET', `/employees/${cookEmp}`)).json().employee
    expect(e.grossSalaryCents).toBe(RS(52000)) // not yet
  })

  it('runs a payroll month with OT and a loan, then recovers the loan on lock', async () => {
    await call('hr', 'PUT', '/settings', {
      ...DEFAULT_HR_SETTINGS, eobi: { employeePct: 1, employerPct: 5, base: 'fixed', fixedWageCents: RS(40000) },
    })
    const ot = (await call('cook', 'POST', '/me/records/overtime', { data: { date: '2026-09-10', otHours: 3 } })).json()
    await call('boss', 'POST', `/records/overtime/${ot.id}/decide`, { decision: 'approved' })
    const otDone = (await call('hr', 'POST', `/records/overtime/${ot.id}/decide`, { decision: 'approved' })).json()
    expect(otDone.amountCents).toBe(RS(1500))

    const loan = (await call('hr', 'POST', '/records/loan', { data: { employee: cookEmp, type: 'loan', amount: RS(10000), installments: 3, firstDeduction: '2026-09-01' } })).json()
    await call('hr', 'POST', `/records/loan/${loan.id}/decide`, { decision: 'approved' })
    await call('ceo', 'POST', `/records/loan/${loan.id}/decide`, { decision: 'approved' })

    const run = (await call('hr', 'POST', '/payroll/runs', { period: '2026-09' })).json()
    const detail = (await call('hr', 'GET', `/payroll/runs/${run.id}`)).json()
    const slip = detail.payslips.find((p: { employeeId: string }) => p.employeeId === cookEmp)
    const codes = slip.lines.map((l: { code: string }) => l.code)
    expect(codes).toEqual(expect.arrayContaining(['salary', 'overtime', 'eobi_employee', 'loan', 'eobi_employer']))
    expect(slip.netCents).toBe(RS(52000) + RS(1500) - RS(400) - 333333)

    // The preparer cannot approve their own payroll.
    expect((await call('hr', 'POST', `/payroll/runs/${run.id}/approve`)).statusCode).toBe(403)
    expect((await call('ceo', 'POST', `/payroll/runs/${run.id}/approve`)).statusCode).toBe(200)
    expect((await call('ceo', 'POST', `/payroll/runs/${run.id}/lock`)).statusCode).toBe(200)

    const loans = (await call('hr', 'GET', `/employees/${cookEmp}`)).json().loans
    expect(loans[0].recoveredCents).toBe(333333)
    expect(loans[0].outstandingCents).toBe(RS(10000) - 333333)
    // Only a locked payslip shows up in self-service.
    expect((await call('cook', 'GET', '/me')).json().payslips.map((p: { period: string }) => p.period)).toContain('2026-09')
  })

  it('saves the HR team\'s format as a new version and refuses a broken one', async () => {
    const fmt = (await call('hr', 'GET', '/forms/overtime')).json().current
    const renamed = fmt.fields.map((f: { key: string; label: string }) => (f.key === 'otHours' ? { ...f, label: 'Extra hours worked' } : f))
    const saved = await call('hr', 'PUT', '/forms/overtime', { fields: [...renamed, { key: 'supervisor', label: 'Supervisor on duty', type: 'text' }] })
    expect(saved.statusCode).toBe(200)
    expect(saved.json().version).toBe(1)
    const broken = await call('hr', 'PUT', '/forms/overtime', { fields: renamed.filter((f: { key: string }) => f.key !== 'otHours') })
    expect(broken.statusCode).toBe(400)
    expect(broken.json().error.message).toMatch(/quantity/)
  })

  it('builds every §30 report, as a preview and as CSV, for HR only', async () => {
    const list = (await call('hr', 'GET', '/reports')).json() as Array<{ key: string }>
    expect(list).toHaveLength(25)
    for (const r of list) {
      const q = '?from=2026-01-01&to=2026-12-31&period=2026-09&days=365'
      const preview = await call('hr', 'GET', `/reports/${r.key}${q}`)
      expect(preview.statusCode, r.key).toBe(200)
      expect(Array.isArray(preview.json().header), r.key).toBe(true)
      const file = await call('hr', 'GET', `/reports/${r.key}.csv${q}`)
      expect(file.statusCode, r.key).toBe(200)
      expect(file.headers['content-type']).toMatch(/text\/csv/)
    }
    const eobi = (await call('hr', 'GET', '/reports/eobi?period=2026-09')).json()
    expect(eobi.rows.length).toBeGreaterThan(0)
    const joiners = (await call('hr', 'GET', '/reports/new_joiners?from=2020-01-01&to=2030-12-31')).json()
    expect(joiners.rows.length).toBeGreaterThan(0)
    expect((await call('cook', 'GET', '/reports/salary')).statusCode).toBe(403)
    expect((await call('hr', 'GET', '/reports/nope')).statusCode).toBe(404)
  })
})
