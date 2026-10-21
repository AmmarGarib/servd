// Overtime is opt-in (owner, 2026-10-21): "give an option to HR to add OT in
// final payroll at time of payroll, other wise it should not include in
// payroll".
//
//   - a fresh draft payslip pays no OT; the approved, unpaid OT is listed as
//     inputs.otAvailable (priced as payroll prices it)
//   - POST /hr/payroll/payslips/:id/overtime {recordIds} adds it (replaces the
//     choice; [] removes it); recalculating keeps what HR added
//   - OT not added is not paid: it stays available for the next run
//   - one record is never on two runs (422 OT_NOT_AVAILABLE)
//   - two companies: B gets 404 on A's payslip / run; A's payslip refuses B's
//     record (422)
//   - "Add all available overtime" on a run
//   - the full & final follows the same rules, and stores the days it pays
//     (owner, 2026-10-21: "Full and final form does not show number of days
//     worked") as data._payBasis — absences docked — shown on the statement
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
import { unpaidOvertime, ALL_RUN_STATUSES } from '../src/modules/hr/service.js'
import { withLetterSystemRows } from '../src/modules/hr/letters.js'

const RS = (r: number) => r * 100
const stamp = Date.now()
const D = (s: string) => new Date(`${s}T00:00:00.000Z`)

let app: FastifyInstance
let tenantA: string, tenantB: string
const users: Record<string, { id: string; token: string }> = {}
const emps: Record<string, string> = {}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${stamp}@otoptin.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
async function mkEmp(key: string, tenantId: string, grossRs: number, extra: Record<string, unknown> = {}) {
  const e = await prisma.hrEmployee.create({
    data: { tenantId, employeeCode: `OT-${String(Object.keys(emps).length + 1).padStart(4, '0')}`, fullName: key, grossSalaryCents: RS(grossRs), monthlyTaxCents: 0, joiningDate: D('2025-01-01'), paymentMethod: 'bank', ...extra },
  })
  emps[key] = e.id
  return e.id
}
const rec = (tenantId: string, section: string, employeeId: string | null, data: Record<string, unknown>) =>
  prisma.hrRecord.create({ data: { tenantId, section, formVersion: 0, employeeId, status: 'approved', ...data } })
/** Approved overtime as onFinalApproval leaves it: hours and amount fixed. */
const ot = (tenantId: string, employeeId: string, day: string, hours: number, amountRs: number) =>
  rec(tenantId, 'overtime', employeeId, { startDate: D(day), quantity: hours, amountCents: RS(amountRs), data: { approvedHours: hours, otAmount: RS(amountRs) } })

const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/hr${url}`, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}` } })

type Slip = { id: string; employeeId: string; grossCents: number; earningsCents: number; netCents: number; lines: Array<{ code: string; amountCents: number }>; inputs: Record<string, unknown> }
async function slipOf(who: string, runId: string, employeeId: string): Promise<Slip> {
  const r = await call(who, 'GET', `/payroll/runs/${runId}`)
  expect(r.statusCode, r.body).toBe(200)
  return (r.json().payslips as Slip[]).find((s) => s.employeeId === employeeId)!
}
async function newRun(who: string, period: string): Promise<string> {
  const r = await call(who, 'POST', '/payroll/runs', { period })
  expect(r.statusCode, r.body).toBe(201)
  return r.json().id
}
const otLine = (s: Slip) => s.lines.find((l) => l.code === 'overtime')?.amountCents ?? 0

let ot1: string, ot2: string, otB: string
let mar: string, apr: string, may: string

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: `OT A ${stamp}`, slug: `ot-a-${stamp}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: `OT B ${stamp}`, slug: `ot-b-${stamp}` } })).id
  for (const t of [tenantA, tenantB]) await ensureChartOfAccounts(t)
  await mkUser('hrA', 'hr', tenantA)
  await mkUser('hrB', 'hr', tenantB)
  const cook = await mkEmp('a-cook', tenantA, 62000)
  await mkEmp('b-cook', tenantB, 56000)
  ot1 = (await ot(tenantA, cook, '2027-03-10', 3, 1500)).id
  ot2 = (await ot(tenantA, cook, '2027-04-12', 2, 1000)).id
  otB = (await ot(tenantB, emps['b-cook']!, '2027-03-10', 4, 2000)).id

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

describe('payroll overtime is added by HR, never on its own', () => {
  it('a fresh draft pays no OT and lists what is available, priced as payroll prices it', async () => {
    mar = await newRun('hrA', '2027-03')
    const s = await slipOf('hrA', mar, emps['a-cook']!)
    expect(s.inputs['otCents']).toBe(0)
    expect(s.inputs['otHours']).toBe(0)
    expect(s.inputs['otRecordIds']).toEqual([])
    expect(s.inputs['otAvailable']).toEqual([{ recordId: ot1, date: '2027-03-10', hours: 3, amountCents: RS(1500) }])
    expect(otLine(s)).toBe(0)
  })

  it('adding includes it at the right amount, recalculating keeps it, and [] removes it', async () => {
    const before = await slipOf('hrA', mar, emps['a-cook']!)
    const r = await call('hrA', 'POST', `/payroll/payslips/${before.id}/overtime`, { recordIds: [ot1] })
    expect(r.statusCode, r.body).toBe(200)
    const s = r.json() as Slip
    expect(s.inputs['otRecordIds']).toEqual([ot1])
    expect(s.inputs['otHours']).toBe(3)
    expect(s.inputs['otCents']).toBe(RS(1500))
    expect(otLine(s)).toBe(RS(1500))
    expect(s.earningsCents - before.earningsCents).toBe(RS(1500))
    const log = await prisma.auditLog.findFirst({ where: { tenantId: tenantA, action: 'hr.payroll.overtime_added', entityId: before.id } })
    expect(log).not.toBeNull()
    expect((log!.metadata as Record<string, unknown>)['actorRole']).toBe('hr')
    expect(((await prisma.hrPayrollRun.findUniqueOrThrow({ where: { id: mar } })).totals as Record<string, number>)['earningsCents']).toBeGreaterThanOrEqual(s.earningsCents)

    // "Recalculate from records" keeps exactly what HR added.
    expect((await call('hrA', 'POST', `/payroll/runs/${mar}/recalculate`)).statusCode).toBe(200)
    const kept = await slipOf('hrA', mar, emps['a-cook']!)
    expect(kept.inputs['otRecordIds']).toEqual([ot1])
    expect(otLine(kept)).toBe(RS(1500))

    const off = await call('hrA', 'POST', `/payroll/payslips/${kept.id}/overtime`, { recordIds: [] })
    expect(off.statusCode, off.body).toBe(200)
    expect(off.json().inputs.otCents).toBe(0)
    expect(otLine(off.json())).toBe(0)
  })

  it('a run approved without adding leaves the OT available for the next run — not added there either', async () => {
    await prisma.hrPayrollRun.update({ where: { id: mar }, data: { status: 'approved' } })
    const late = await call('hrA', 'POST', `/payroll/payslips/${(await slipOf('hrA', mar, emps['a-cook']!)).id}/overtime`, { recordIds: [ot1] })
    expect(late.statusCode).toBe(409)
    expect(late.json().error.code).toBe('RUN_NOT_DRAFT')
    expect((await call('hrA', 'POST', `/payroll/runs/${mar}/overtime`, { all: true })).statusCode).toBe(409)

    apr = await newRun('hrA', '2027-04')
    const s = await slipOf('hrA', apr, emps['a-cook']!)
    expect(s.inputs['otCents']).toBe(0)
    expect((s.inputs['otAvailable'] as Array<{ recordId: string }>).map((a) => a.recordId).sort()).toEqual([ot1, ot2].sort())
  })

  it('refuses the same record on two runs, another company\'s record, and another company\'s payslip', async () => {
    const s = await slipOf('hrA', apr, emps['a-cook']!)
    expect((await call('hrA', 'POST', `/payroll/payslips/${s.id}/overtime`, { recordIds: [ot1] })).statusCode).toBe(200)

    may = await newRun('hrA', '2027-05')
    const m = await slipOf('hrA', may, emps['a-cook']!)
    expect((m.inputs['otAvailable'] as Array<{ recordId: string }>).map((a) => a.recordId)).toEqual([ot2])
    const twice = await call('hrA', 'POST', `/payroll/payslips/${m.id}/overtime`, { recordIds: [ot1] })
    expect(twice.statusCode).toBe(422)
    expect(twice.json().error.code).toBe('OT_NOT_AVAILABLE')

    // Company B's record on company A's payslip.
    const foreign = await call('hrA', 'POST', `/payroll/payslips/${m.id}/overtime`, { recordIds: [otB] })
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('OT_NOT_AVAILABLE')
    // Company B never reaches A's payslip or run.
    expect((await call('hrB', 'POST', `/payroll/payslips/${m.id}/overtime`, { recordIds: [] })).statusCode).toBe(404)
    expect((await call('hrB', 'POST', `/payroll/runs/${may}/overtime`, { all: true })).statusCode).toBe(404)
    // Nothing changed on A's May payslip.
    expect((await slipOf('hrA', may, emps['a-cook']!)).inputs['otCents']).toBe(0)
  })

  it('"Add all available overtime" adds each payslip\'s available OT — and only that', async () => {
    const r = await call('hrA', 'POST', `/payroll/runs/${may}/overtime`, { all: true })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().updated).toBe(1)
    const m = await slipOf('hrA', may, emps['a-cook']!)
    expect(m.inputs['otRecordIds']).toEqual([ot2])
    expect(otLine(m)).toBe(RS(1000))
    // April still holds ot1 only.
    expect((await slipOf('hrA', apr, emps['a-cook']!)).inputs['otRecordIds']).toEqual([ot1])
    // Company B's run: B's own OT only.
    const bRun = await newRun('hrB', '2027-03')
    expect((await slipOf('hrB', bRun, emps['b-cook']!)).inputs['otCents']).toBe(0)
    expect((await call('hrB', 'POST', `/payroll/runs/${bRun}/overtime`, { all: true })).json().updated).toBe(1)
    expect(otLine(await slipOf('hrB', bRun, emps['b-cook']!))).toBe(RS(2000))
  })
})

describe('full & final: OT opt-in, and the days it pays', () => {
  let leaver: string, ot3: string, fnfId: string
  beforeAll(async () => {
    // Joins 1 Jun 2027, last day 10 Jun: on no payroll. Rs 60,000 / 30 = Rs 2,000 a day.
    leaver = await mkEmp('a-leaver', tenantA, 60000, { joiningDate: D('2027-06-01'), employmentType: 'permanent' })
    await rec(tenantA, 'attendance', leaver, { startDate: D('2027-06-05'), category: 'absent' })
    await rec(tenantA, 'attendance', leaver, { startDate: D('2027-06-08'), category: 'half_day' })
    ot3 = (await ot(tenantA, leaver, '2027-06-03', 2, 800)).id
    fnfId = (await prisma.hrRecord.create({
      data: { tenantId: tenantA, section: 'final_settlement', formVersion: 0, employeeId: leaver, status: 'draft', endDate: D('2027-06-10'), data: { employee: leaver, lastWorkingDay: '2027-06-10' } },
    })).id
  })

  it('pays no OT unless added, and stores the days paid with absences docked', async () => {
    const r = await call('hrA', 'POST', '/final-settlement/calculate', { employeeId: leaver, lastWorkingDay: '2027-06-10', recordId: fnfId })
    expect(r.statusCode, r.body).toBe(200)
    const f = r.json()
    expect(f.otPayable).toBe(0)
    expect(f.otRecordIds).toEqual([])
    expect(f.otAvailable).toEqual([{ recordId: ot3, date: '2027-06-03', hours: 2, amountCents: RS(800) }])
    const basis = { period: '2027-06', from: '2027-06-01', to: '2027-06-10', daysInMonth: 30, employedDays: 10, absentDays: 1.5, unpaidLeaveDays: 0, paidDays: 8.5, salaryCents: RS(17000) }
    expect(f.payBasis).toEqual([expect.objectContaining(basis)])
    expect(f.salaryPayable).toBe(RS(17000))
    const stored = (await prisma.hrRecord.findUniqueOrThrow({ where: { id: fnfId } })).data as Record<string, unknown>
    expect(stored['_payBasis']).toEqual([expect.objectContaining(basis)])
    expect((stored['_calc'] as Record<string, unknown>)['otRecordIds']).toEqual([])
  })

  it('adds OT when HR chooses it, keeps the choice on the next calculation, and refuses what is not available', async () => {
    const add = await call('hrA', 'POST', '/final-settlement/calculate', { employeeId: leaver, lastWorkingDay: '2027-06-10', recordId: fnfId, otRecordIds: [ot3] })
    expect(add.statusCode, add.body).toBe(200)
    expect(add.json().otPayable).toBe(RS(800))
    expect(add.json().netAmount - RS(800)).toBeLessThanOrEqual(RS(17000))
    const stored = (await prisma.hrRecord.findUniqueOrThrow({ where: { id: fnfId } })).data as Record<string, unknown>
    expect((stored['_calc'] as Record<string, unknown>)['otRecordIds']).toEqual([ot3])
    expect(await prisma.auditLog.count({ where: { tenantId: tenantA, action: 'hr.payroll.overtime_added', entityId: fnfId } })).toBe(1)

    const again = await call('hrA', 'POST', '/final-settlement/calculate', { employeeId: leaver, lastWorkingDay: '2027-06-10', recordId: fnfId })
    expect(again.json().otPayable).toBe(RS(800))

    // Another company's record, or one already on a payslip: 422.
    for (const id of [otB, ot1]) {
      const bad = await call('hrA', 'POST', '/final-settlement/calculate', { employeeId: leaver, lastWorkingDay: '2027-06-10', recordId: fnfId, otRecordIds: [id] })
      expect(bad.statusCode).toBe(422)
      expect(bad.json().error.code).toBe('OT_NOT_AVAILABLE')
    }
    // Company B never reaches A's leaver.
    expect((await call('hrB', 'POST', '/final-settlement/calculate', { employeeId: leaver, lastWorkingDay: '2027-06-10', otRecordIds: [] })).statusCode).toBe(404)
  })

  it('an approved settlement pays the OT it listed — no payroll offers it again', async () => {
    const before = await unpaidOvertime(tenantA, leaver, D('2027-01-01'), D('2027-12-31'), { runStatuses: ALL_RUN_STATUSES })
    expect(before.map((o) => o.id)).toEqual([ot3])
    await prisma.hrRecord.update({ where: { id: fnfId }, data: { status: 'approved' } })
    expect(await unpaidOvertime(tenantA, leaver, D('2027-01-01'), D('2027-12-31'), { runStatuses: ALL_RUN_STATUSES })).toEqual([])
    // Changing the OT of a settlement already acted on: 409.
    const late = await call('hrA', 'POST', '/final-settlement/calculate', { employeeId: leaver, lastWorkingDay: '2027-06-10', recordId: fnfId, otRecordIds: [] })
    expect(late.statusCode).toBe(409)
    await prisma.hrRecord.update({ where: { id: fnfId }, data: { status: 'draft' } })
  })

  it('prints the days paid on the full & final statement', async () => {
    expect(withLetterSystemRows('final_settlement_statement', '<table><tr><td>Salary payable</td><td>{{record.salaryPayable}}</td></tr><tr><td>Net</td><td>{{record.netAmount}}</td></tr></table>'))
      .toMatch(/Days paid<\/td><td>\{\{record\.daysPaid\}\}<\/td><\/tr><tr><td>Salary payable/)
    const r = await call('hrA', 'POST', '/letters/render', { key: 'final_settlement_statement', recordId: fnfId })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().html).toContain('1–10 Jun 2027: 10 days employed − 1.5 absent − 0 unpaid leave = 8.5 paid days of 30')
  })
})
