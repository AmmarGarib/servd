// People audit, HR and the rota (scratchpad audit/people/report.json and
// audit/books/report.json).
//
//   PPL-07   a negative salary was saved, and payroll approved, locked and paid
//            it; the payment cleared more than the accrual put in Wages Payable.
//   PPL-10   a login switched off in Workforce stayed on payroll, unflagged.
//   PPL-12   the rota took a shift on a day of approved leave.
//   PPL-13   staff could not ask for a shift swap.
//   PPL-15   the leaver sweep wrote isActive only, leaving accountStatus active.
//   BOOKS-02 finance could not read the payroll register.
//
// Two companies: company B's HR and finance get 404 on company A's rows.
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
import { schedulingRoutes } from '../src/modules/scheduling/routes.js'
import { negativeMoney } from '../src/modules/hr/forms.js'
import { deactivateLeftLogins } from '../src/modules/hr/separations.js'

const RS = (r: number) => r * 100
const stamp = Date.now()

let app: FastifyInstance
let tenantA: string, tenantB: string
let stackd: string, clifton: string, dha: string, morning: string
const users: Record<string, { id: string; token: string }> = {}
const emps: Record<string, string> = {}

async function mkUser(key: string, role: string, tenantId: string, extra: Record<string, unknown> = {}) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${stamp}@pplhr.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId, ...extra },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
  return u.id
}
async function mkEmp(key: string, tenantId: string, extra: Record<string, unknown> = {}) {
  const e = await prisma.hrEmployee.create({
    data: { tenantId, employeeCode: `H-${String(Object.keys(emps).length + 1).padStart(4, '0')}`, fullName: key, grossSalaryCents: RS(60000), basicSalaryCents: RS(40000), joiningDate: new Date('2025-01-01'), ...extra },
  })
  emps[key] = e.id
  return e.id
}
const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}` } })
const day = (s: string) => new Date(`${s}T00:00:00.000Z`)

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'GS Foods (hr)', slug: `gs-hr-${stamp}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Karachi Bites (hr)', slug: `kb-hr-${stamp}` } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  stackd = (await prisma.concept.create({ data: { name: 'Stackd', slug: `stackd-hr-${stamp}`, type: 'restaurant', tenantId: tenantA } })).id
  clifton = (await prisma.location.create({ data: { slug: `clifton-hr-${stamp}`, name: 'Clifton Block 5', tenantId: tenantA } })).id
  dha = (await prisma.location.create({ data: { slug: `dha-hr-${stamp}`, name: 'DHA Phase 6', tenantId: tenantA } })).id
  await prisma.conceptLocation.create({ data: { conceptId: stackd, locationId: clifton } })
  morning = (await prisma.hrRecord.create({ data: { tenantId: tenantA, section: 'shift', formVersion: 0, status: 'approved', data: { name: 'Morning', start: '09:00', end: '17:00' } } })).id

  await mkUser('ceo', 'admin', tenantA)
  await mkUser('hr', 'hr', tenantA)
  await mkUser('fin', 'finance', tenantA)
  await mkUser('omar', 'foh_management', tenantA)
  await mkUser('ali', 'cashier', tenantA)
  await mkUser('bilal', 'cashier', tenantA)
  await mkUser('danish', 'foh', tenantA)
  await mkUser('imran', 'kitchen', tenantA)
  await mkUser('ayesha', 'kitchen', tenantA)
  await mkUser('legacyOff', 'kitchen', tenantA, { isActive: false }) // switched off through isActive alone
  await mkUser('hrB', 'hr', tenantB)
  await mkUser('finB', 'finance', tenantB)

  const omarEmp = await mkEmp('Omar Sheikh', tenantA, { userId: users['omar']!.id, locationId: clifton })
  await mkEmp('Ali Raza', tenantA, { userId: users['ali']!.id, locationId: clifton, managerId: omarEmp })
  await mkEmp('Bilal Ahmed', tenantA, { userId: users['bilal']!.id, locationId: clifton, managerId: omarEmp })
  await mkEmp('Danish Iqbal', tenantA, { userId: users['danish']!.id, locationId: dha })
  await mkEmp('Imran Shah', tenantA, { userId: users['imran']!.id })
  await mkEmp('Ayesha Khan', tenantA, { userId: users['ayesha']!.id, status: 'terminated', lastWorkingDay: new Date(Date.now() - 3 * 86_400_000) })
  await mkEmp('Old Timer', tenantA, { userId: users['legacyOff']!.id, status: 'terminated', lastWorkingDay: new Date(Date.now() - 3 * 86_400_000) })
  await mkEmp('KB Staff', tenantB)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(hrRoutes, { prefix: '/api/v1/hr' })
  await app.register(schedulingRoutes, { prefix: '/api/v1/scheduling' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

// ─── PPL-07 ──────────────────────────────────────────────────────────────────

describe('PPL-07 pay inputs are never negative, and payroll pays exactly what it accrued', () => {
  it('refuses a negative salary, basic above gross, a negative allowance or adjustment', async () => {
    const neg = await call('hr', 'POST', '/hr/employees', { data: { fullName: 'Typo Salary', grossSalaryCents: -500_000 } })
    expect(neg.statusCode).toBe(400)
    const basic = await call('hr', 'POST', '/hr/employees', { data: { fullName: 'Typo Basic', grossSalaryCents: RS(10000), basicSalaryCents: RS(90000) } })
    expect(basic.statusCode).toBe(400)
    expect(basic.json().error.code).toBe('BASIC_OVER_GROSS')
    const allowance = await call('hr', 'POST', '/hr/employees', { data: { fullName: 'Typo Allowance', grossSalaryCents: RS(10000), allowances: [{ name: 'Fuel', amountCents: -100 }] } })
    expect(allowance.statusCode).toBe(400)
    const edit = await call('hr', 'PATCH', `/hr/employees/${emps['Bilal Ahmed']}`, { data: { grossSalaryCents: -1 } })
    expect(edit.statusCode).toBe(400)
    const bonus = await call('hr', 'POST', '/hr/records/payroll_adjustment', { data: { employee: emps['Bilal Ahmed'], month: '2026-09-15', kind: 'bonus', amount: -50_000 } })
    expect(bonus.statusCode).toBe(400)
    expect(bonus.json().error.code).toMatch(/NEGATIVE_AMOUNT|VALIDATION_ERROR/)
    // …whatever a company's own format says: a money field with no minimum.
    expect(negativeMoney('employees', [{ key: 'x', label: 'Custom pay', type: 'money' }], { x: -1 })).toEqual(['Custom pay'])
    expect(negativeMoney('final_settlement', [{ key: 'otherAdjustments', label: 'Other', type: 'money' }], { otherAdjustments: -1 })).toEqual([])
    // A good edit still goes through.
    expect((await call('hr', 'PATCH', `/hr/employees/${emps['Bilal Ahmed']}`, { data: { grossSalaryCents: RS(65000) } })).statusCode).toBe(200)
  })

  let runId: string
  it('blocks approve and lock while a payslip is negative (a salary saved before the rule)', async () => {
    await mkEmp('Typo Salary', tenantA, { grossSalaryCents: -500_000, basicSalaryCents: 0 })
    const run = await call('hr', 'POST', '/hr/payroll/runs', { period: '2026-09' })
    expect(run.statusCode).toBe(201)
    runId = run.json().id
    const approve = await call('ceo', 'POST', `/hr/payroll/runs/${runId}/approve`)
    expect(approve.statusCode).toBe(409)
    expect(approve.json().error.message).toMatch(/Typo Salary/)
    expect((await call('ceo', 'POST', `/hr/payroll/runs/${runId}/lock`)).statusCode).toBe(409)
  })

  it('PPL-10: names whoever is paid though their login is off, or terminated with no last day', async () => {
    await prisma.user.update({ where: { id: users['imran']!.id }, data: { isActive: false, accountStatus: 'suspended' } })
    await mkEmp('Gone No Date', tenantA, { status: 'terminated', lastWorkingDay: null })
    expect((await call('hr', 'POST', `/hr/payroll/runs/${runId}/recalculate`)).statusCode).toBe(200)
    const run = await prisma.hrPayrollRun.findUniqueOrThrow({ where: { id: runId } })
    const warnings = ((run.totals as Record<string, unknown>)['warnings'] as string[]).join(' | ')
    expect(warnings).toMatch(/Imran Shah: their login is switched off in Workforce/)
    expect(warnings).toMatch(/Gone No Date: terminated with no last working day/)
    expect(warnings).not.toMatch(/Ali Raza:/)
  })

  it('once corrected: approve, lock and pay, and Wages Payable clears to exactly zero', async () => {
    expect((await call('hr', 'PATCH', `/hr/employees/${emps['Typo Salary']}`, { data: { grossSalaryCents: RS(30000) } })).statusCode).toBe(200)
    expect((await call('hr', 'POST', `/hr/payroll/runs/${runId}/recalculate`)).statusCode).toBe(200)
    expect((await call('ceo', 'POST', `/hr/payroll/runs/${runId}/approve`)).statusCode).toBe(200)
    expect((await call('ceo', 'POST', `/hr/payroll/runs/${runId}/lock`)).statusCode).toBe(200)
    expect((await call('ceo', 'POST', `/hr/payroll/runs/${runId}/paid`, { from: 'bank' })).statusCode).toBe(200)
    const lines = await prisma.journalLine.findMany({
      where: { account: { code: '2020' }, journalEntry: { tenantId: tenantA, reference: { in: [`hr.payroll.accrual:${runId}`, `hr.payroll.payment:${runId}`] } } },
      include: { journalEntry: { select: { reference: true } } },
    })
    const credit = lines.filter((l) => l.type === 'credit').reduce((a, l) => a + l.amountCents, 0)
    const debit = lines.filter((l) => l.type === 'debit').reduce((a, l) => a + l.amountCents, 0)
    expect(credit).toBeGreaterThan(0)
    expect(debit).toBe(credit)
    const slips = await prisma.hrPayslip.aggregate({ where: { runId }, _sum: { netCents: true } })
    expect(credit).toBe(slips._sum.netCents)
  })
})

// ─── BOOKS-02 ────────────────────────────────────────────────────────────────

describe('BOOKS-02 finance reads the payroll register, and only its own company\'s', () => {
  it('finance lists and opens runs and downloads the bank file, but prepares and approves nothing', async () => {
    const run = await prisma.hrPayrollRun.findFirstOrThrow({ where: { tenantId: tenantA, period: '2026-09' } })
    const list = await call('fin', 'GET', '/hr/payroll/runs')
    expect(list.statusCode).toBe(200)
    expect((list.json() as Array<{ id: string }>).some((r) => r.id === run.id)).toBe(true)
    expect((await call('fin', 'GET', `/hr/payroll/runs/${run.id}`)).statusCode).toBe(200)
    expect((await call('fin', 'GET', `/hr/payroll/runs/${run.id}/export.csv?kind=bank`)).statusCode).toBe(200)
    expect((await call('fin', 'POST', '/hr/payroll/runs', { period: '2026-08' })).statusCode).toBe(403)
    expect((await call('fin', 'POST', `/hr/payroll/runs/${run.id}/approve`)).statusCode).toBe(403)
    expect((await call('fin', 'GET', '/hr/employees')).statusCode).toBe(403) // salaries stay HR's
    // Company B's finance and HR: not found.
    expect((await call('finB', 'GET', `/hr/payroll/runs/${run.id}`)).statusCode).toBe(404)
    expect((await call('hrB', 'GET', `/hr/payroll/runs/${run.id}`)).statusCode).toBe(404)
    expect(((await call('finB', 'GET', '/hr/payroll/runs')).json() as Array<{ id: string }>).some((r) => r.id === run.id)).toBe(false)
  })
})

// ─── PPL-15 ──────────────────────────────────────────────────────────────────

describe('PPL-15 the leaver sweep suspends through the one status column', () => {
  it('writes accountStatus suspended with the isActive mirror, and finishes a legacy isActive-only row', async () => {
    await deactivateLeftLogins(tenantA)
    expect(await prisma.user.findUniqueOrThrow({ where: { id: users['ayesha']!.id }, select: { isActive: true, accountStatus: true } }))
      .toEqual({ isActive: false, accountStatus: 'suspended' })
    expect(await prisma.user.findUniqueOrThrow({ where: { id: users['legacyOff']!.id }, select: { isActive: true, accountStatus: true } }))
      .toEqual({ isActive: false, accountStatus: 'suspended' })
    // Still at work: untouched.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: users['ali']!.id } })).accountStatus).toBe('active')
  })
})

// ─── PPL-12 ──────────────────────────────────────────────────────────────────

describe('PPL-12 the rota refuses a shift on approved leave', () => {
  const leave = (employeeId: string, from: string, to: string, quantity: number) =>
    prisma.hrRecord.create({ data: { tenantId: tenantA, section: 'leave', formVersion: 0, status: 'approved', employeeId, startDate: day(from), endDate: day(to), quantity, data: {} } })

  it('409 on a leave day, fine the day after, and a half day can still be rostered', async () => {
    await leave(emps['Ali Raza']!, '2026-11-03', '2026-11-04', 2)
    const on = await call('omar', 'POST', '/scheduling', { conceptId: stackd, employeeId: emps['Ali Raza'], date: '2026-11-03', startTime: '09:00', endTime: '17:00' })
    expect(on.statusCode).toBe(409)
    expect(on.json().error.code).toBe('ON_LEAVE')
    expect(on.json().error.message).toMatch(/Ali Raza is on approved leave \(2026-11-03 to 2026-11-04\)/)
    expect((await call('omar', 'POST', '/scheduling', { conceptId: stackd, employeeId: emps['Ali Raza'], date: '2026-11-04', shiftId: morning })).statusCode).toBe(409)
    expect((await call('omar', 'POST', '/scheduling', { conceptId: stackd, employeeId: emps['Ali Raza'], date: '2026-11-05', startTime: '09:00', endTime: '17:00' })).statusCode).toBe(201)
    // A day off on a leave day is harmless.
    expect((await call('omar', 'POST', '/scheduling', { conceptId: stackd, employeeId: emps['Ali Raza'], date: '2026-11-03', off: true })).statusCode).toBe(201)
    await leave(emps['Ali Raza']!, '2026-11-06', '2026-11-06', 0.5)
    expect((await call('omar', 'POST', '/scheduling', { conceptId: stackd, employeeId: emps['Ali Raza'], date: '2026-11-06', startTime: '09:00', endTime: '13:00' })).statusCode).toBe(201)
  })

  it('refuses a change of hours on a day that became leave, and copy-week skips it', async () => {
    const shift = await call('omar', 'POST', '/scheduling', { conceptId: stackd, employeeId: emps['Bilal Ahmed'], date: '2026-11-02', startTime: '10:00', endTime: '18:00' })
    expect(shift.statusCode).toBe(201)
    await leave(emps['Bilal Ahmed']!, '2026-11-02', '2026-11-02', 1)
    const patch = await call('omar', 'PATCH', `/scheduling/${shift.json().id}`, { startTime: '11:00' })
    expect(patch.statusCode).toBe(409)
    expect(patch.json().error.code).toBe('ON_LEAVE')

    await leave(emps['Bilal Ahmed']!, '2026-11-09', '2026-11-09', 1)
    const copy = await call('omar', 'POST', '/scheduling/copy-week', { conceptId: stackd, sourceWeekStart: '2026-11-02', targetWeekStart: '2026-11-09' })
    expect(copy.statusCode).toBe(200)
    expect(await prisma.scheduledShift.count({ where: { userId: users['bilal']!.id, date: day('2026-11-09') } })).toBe(0)
    expect(await prisma.scheduledShift.count({ where: { userId: users['ali']!.id, date: day('2026-11-12') } })).toBe(1) // Ali's 5th → 12th copied
  })
})

// ─── PPL-13 ──────────────────────────────────────────────────────────────────

describe('PPL-13 staff ask for a swap of their own shift; the manager approves', () => {
  // Ten days out, stepping past 2–15 Nov 2026, the weeks PPL-12 fills (leave, copied rota)
  // — a swap there is refused or shows as leave / off.
  const future = (() => {
    const t = Date.now() + 10 * 86_400_000
    for (let i = 0; ; i++) {
      const d = new Date(t + i * 86_400_000).toISOString().slice(0, 10)
      if (d < '2026-11-02' || d > '2026-11-15') return d
    }
  })()
  let swapId: string

  it('offers it in self-service and files it for the requester only', async () => {
    const me = await call('ali', 'GET', '/hr/me')
    expect(me.json().canRequest).toContain('shift_swap')
    const form = await call('ali', 'GET', '/hr/me/forms/shift_swap')
    expect(form.statusCode).toBe(200)
    expect((form.json().fields as Array<{ key: string }>).map((f) => f.key)).not.toContain('employee')

    // Naming someone else as "employee" is ignored: a swap is of your own shift.
    const r = await call('ali', 'POST', '/hr/me/records/shift_swap', { data: { employee: emps['Bilal Ahmed'], swapWith: emps['Bilal Ahmed'], date: future, toShift: morning, reason: 'Exam' } })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json()).toMatchObject({ employeeId: emps['Ali Raza'], status: 'submitted', section: 'shift_swap' })
    swapId = r.json().id
  })

  it('refuses a swap with yourself, another branch, another company, or a past day', async () => {
    const send = (data: Record<string, unknown>) => call('ali', 'POST', '/hr/me/records/shift_swap', { data: { date: future, toShift: morning, ...data } })
    expect((await send({ swapWith: emps['Ali Raza'] })).statusCode).toBe(400)
    expect((await send({ swapWith: emps['Danish Iqbal'] })).statusCode).toBe(422)
    const foreign = await send({ swapWith: emps['KB Staff'] })
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('BAD_REFERENCE')
    expect((await send({ swapWith: emps['Bilal Ahmed'], date: '2026-01-05' })).statusCode).toBe(400)
  })

  it('only the reporting manager approves it, and the rota moves', async () => {
    expect((await call('ali', 'POST', `/hr/records/shift_swap/${swapId}/decide`, { decision: 'approved' })).statusCode).toBe(403)
    expect((await call('bilal', 'POST', `/hr/records/shift_swap/${swapId}/decide`, { decision: 'approved' })).statusCode).toBe(403)
    expect((await call('hrB', 'POST', `/hr/records/shift_swap/${swapId}/decide`, { decision: 'approved' })).statusCode).toBe(404)
    // The colleague the swap moves accepts it first (audit HR-R5).
    const early = await call('omar', 'POST', `/hr/records/shift_swap/${swapId}/decide`, { decision: 'approved' })
    expect(early.statusCode).toBe(409)
    expect(early.json().error.code).toBe('PARTNER_NOT_ACCEPTED')
    expect((await call('bilal', 'POST', `/hr/me/swaps/${swapId}/respond`, { accept: true })).statusCode).toBe(200)
    const ok = await call('omar', 'POST', `/hr/records/shift_swap/${swapId}/decide`, { decision: 'approved' })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().status).toBe('approved')
    const week = await call('ali', 'GET', `/scheduling?conceptId=${stackd}&weekStart=${future}`)
    const cell = (week.json().cells as Array<{ employeeId: string; date: string; source: string; kind: string }>).find((c) => c.employeeId === emps['Ali Raza'] && c.date === future)
    expect(cell).toMatchObject({ kind: 'shift', source: 'swap' })
  })
})
