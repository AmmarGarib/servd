// Statutory payables (accountant default H7, finance wave B) and HR's part of
// the period close:
//
//   - locking payroll credits 2043 EOBI (employee + employer), 2044 SESSI /
//     PESSI and 2042 salary tax — nothing to the old 2090 / 2040 stand-ins —
//     and a full & final's accrual does the same
//   - an operator who took 2043 for an account of their own gets 422
//     ACCOUNT_CODE_TAKEN: the lock (or approval) rolls back, the run stays
//     approved; another company is unaffected
//   - HR's old 'EOBI / SESSI payments' form takes no new records (409
//     SECTION_MOVED — Accounting → Statutory payments records them); the rows
//     recorded before are still listed, read-only
//   - hrCloseChecks: a month with staff to pay and no locked, booked payroll
//     blocks the close — from the company's first payroll in servd on, never
//     before; another company's unlocked payroll never blocks this one; an
//     approved full & final not on the books blocks until it is booked
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
import { hrCloseChecks } from '../src/modules/hr/closeChecks.js'
import type { CloseCheckContext } from '../src/modules/accounting/closeCheckTypes.js'
import { DEFAULT_HR_SETTINGS } from '../src/modules/hr/logic.js'

const RS = (r: number) => r * 100
const stamp = Date.now()
const D = (s: string) => new Date(`${s}T00:00:00.000Z`)
/** PKT end of a day, as a lock is stored. */
const pktEnd = (ymd: string) => new Date(new Date(`${ymd}T23:59:59.999+05:00`).getTime())

let app: FastifyInstance
let tenantA: string, tenantB: string
const users: Record<string, { id: string; token: string }> = {}
const emps: Record<string, string> = {}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${stamp}@stat.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
async function mkEmp(key: string, tenantId: string, extra: Record<string, unknown> = {}) {
  const e = await prisma.hrEmployee.create({
    data: { tenantId, employeeCode: `S-${String(Object.keys(emps).length + 1).padStart(4, '0')}`, fullName: key, grossSalaryCents: RS(52000), basicSalaryCents: RS(30000), monthlyTaxCents: RS(1000), joiningDate: D('2026-01-01'), paymentMethod: 'bank', ...extra },
  })
  emps[key] = e.id
  return e.id
}
const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/hr${url}`, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}` } })

type Ln = { type: string; amountCents: number | bigint; account: { code: string } }
async function entry(tenantId: string, reference: string) {
  return prisma.journalEntry.findFirst({ where: { tenantId, reference }, include: { lines: { include: { account: { select: { code: true } } } } } })
}
const amt = (lines: Ln[], code: string, type: 'debit' | 'credit') => lines.filter((l) => l.account.code === code && l.type === type).reduce((a, l) => a + Number(l.amountCents), 0)
const balanced = (lines: Ln[]) => lines.reduce((a, l) => a + (l.type === 'debit' ? 1 : -1) * Number(l.amountCents), 0) === 0

const ctxFor = (tenantId: string, months: string[], newLock: Date): CloseCheckContext => ({
  db: prisma, tenantId, prevLock: null, newLock, months, isYearEnd: false,
})
const payrollCheck = hrCloseChecks.find((c) => c.key === 'payroll')!
const fnfCheck = hrCloseChecks.find((c) => c.key === 'fnf_unposted')!

async function runFor(who: string, approver: string, period: string, lock = true) {
  const r = await call(who, 'POST', '/payroll/runs', { period })
  expect(r.statusCode, r.body).toBe(201)
  const id = r.json().id as string
  expect((await call(approver, 'POST', `/payroll/runs/${id}/approve`)).statusCode).toBe(200)
  if (lock) expect((await call(approver, 'POST', `/payroll/runs/${id}/lock`)).statusCode).toBe(200)
  return id
}

const SETTINGS = {
  ...DEFAULT_HR_SETTINGS,
  eobi: { enabled: true, employeePct: 1, employerPct: 5, base: 'fixed', fixedWageCents: RS(40000) },
  sessi: { employerPct: 6, wageCeilingCents: null },
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'GS Foods (stat)', slug: `gs-stat-${stamp}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Karachi Bites (stat)', slug: `kb-stat-${stamp}` } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)

  await mkUser('ceo', 'admin', tenantA)
  await mkUser('hr', 'hr', tenantA)
  await mkUser('mgmt', 'management', tenantA)
  await mkUser('ceoB', 'admin', tenantB)
  await mkUser('hrB', 'hr', tenantB)

  await mkEmp('Cook', tenantA)
  await mkEmp('Server', tenantA, { monthlyTaxCents: 0 })
  await mkEmp('Leaver', tenantA, { status: 'resigned', lastWorkingDay: D('2026-08-20') })
  await mkEmp('Cook B', tenantB)

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

describe('payroll and F&F credit the statutory payables', () => {
  let julyA: string

  it('locking payroll credits 2043 / 2044 / 2042 and nothing to 2090 / 2040', async () => {
    julyA = await runFor('hr', 'ceo', '2026-07')
    const slips = await prisma.hrPayslip.findMany({ where: { runId: julyA } })
    const line = (code: string) => slips.reduce((a, s) => a + (s.lines as Array<{ code: string; amountCents: number }>).filter((l) => l.code === code).reduce((x, l) => x + l.amountCents, 0), 0)
    const e = await entry(tenantA, `hr.payroll.accrual:${julyA}`)
    expect(e).not.toBeNull()
    expect(balanced(e!.lines)).toBe(true)
    expect(line('eobi_employee')).toBe(RS(400) * 3)
    expect(amt(e!.lines, '2043', 'credit')).toBe(line('eobi_employee') + line('eobi_employer'))
    expect(amt(e!.lines, '2044', 'credit')).toBe(line('sessi_employer'))
    expect(line('sessi_employer')).toBeGreaterThan(0)
    expect(amt(e!.lines, '2042', 'credit')).toBe(line('tax'))
    expect(line('tax')).toBe(RS(2000)) // Cook + Leaver; Server pays none
    expect(amt(e!.lines, '2090', 'credit') + amt(e!.lines, '2040', 'credit')).toBe(0)
    expect(amt(e!.lines, '2020', 'credit')).toBe(slips.reduce((a, s) => a + s.netCents, 0))
  })

  it('a full & final credits them the same way', async () => {
    const fnf = (await call('hr', 'POST', '/records/final_settlement', { data: { employee: emps['Leaver'], lastWorkingDay: '2026-08-20' } })).json().id
    const c = (await call('hr', 'POST', '/final-settlement/calculate', { employeeId: emps['Leaver'], lastWorkingDay: '2026-08-20', recordId: fnf })).json()
    expect(c.salaryFrom).toBe('2026-08-01T00:00:00.000Z')
    const keys = ['salaryPayable', 'otPayable', 'leaveEncashment', 'gratuity', 'loanRecovery', 'incomeTax', 'eobiEmployee', 'eobiEmployer', 'sessiEmployer']
    expect((await call('hr', 'PATCH', `/records/final_settlement/${fnf}`, { data: Object.fromEntries(keys.map((k) => [k, c[k]])) })).statusCode).toBe(200)
    const ok = await call('mgmt', 'POST', `/records/final_settlement/${fnf}/decide`, { decision: 'approved' })
    expect(ok.statusCode, ok.body).toBe(200)
    const e = await entry(tenantA, `hr.final_settlement.accrual:${fnf}`)
    expect(balanced(e!.lines)).toBe(true)
    expect(amt(e!.lines, '2043', 'credit')).toBe(c.eobiEmployee + c.eobiEmployer)
    expect(amt(e!.lines, '2044', 'credit')).toBe(c.sessiEmployer)
    expect(amt(e!.lines, '2042', 'credit')).toBe(c.incomeTax)
    expect(c.incomeTax).toBe(RS(1000))
    expect(amt(e!.lines, '2090', 'credit') + amt(e!.lines, '2040', 'credit')).toBe(0)
  })

  it('refuses with 422 ACCOUNT_CODE_TAKEN when the company took 2043 for its own account — the run stays approved; B is unaffected', async () => {
    const aug = (await call('hr', 'POST', '/payroll/runs', { period: '2026-08' })).json().id
    expect((await call('ceo', 'POST', `/payroll/runs/${aug}/approve`)).statusCode).toBe(200)
    await prisma.account.updateMany({ where: { tenantId: tenantA, code: '2043' }, data: { type: 'expense', name: 'Office tea' } })
    try {
      const lock = await call('ceo', 'POST', `/payroll/runs/${aug}/lock`)
      expect(lock.statusCode).toBe(422)
      expect(lock.json().error.code).toBe('ACCOUNT_CODE_TAKEN')
      expect(lock.json().error.message).toMatch(/2043/)
      expect((await prisma.hrPayrollRun.findUniqueOrThrow({ where: { id: aug } })).status).toBe('approved')
      expect(await entry(tenantA, `hr.payroll.accrual:${aug}`)).toBeNull()

      // Company B's own 2043 is its template account: B locks normally.
      const augB = await runFor('hrB', 'ceoB', '2026-08')
      const eb = await entry(tenantB, `hr.payroll.accrual:${augB}`)
      expect(amt(eb!.lines, '2043', 'credit')).toBeGreaterThan(0)
    } finally {
      await prisma.account.updateMany({ where: { tenantId: tenantA, code: '2043' }, data: { type: 'liability', name: 'EOBI Payable' } })
    }
    // Fixed, the lock goes through.
    expect((await call('ceo', 'POST', `/payroll/runs/${aug}/lock`)).statusCode).toBe(200)
    expect(await entry(tenantA, `hr.payroll.accrual:${aug}`)).not.toBeNull()
  })
})

describe('HR\'s EOBI / SESSI payments form has moved to Accounting', () => {
  it('takes no new records (409 SECTION_MOVED); the old ones are still listed and read-only', async () => {
    const old = await prisma.hrRecord.create({
      data: { tenantId: tenantA, section: 'eobi_challan', formVersion: 0, status: 'approved', effectiveDate: D('2026-06-01'), amountCents: RS(3000), data: { scheme: 'EOBI', month: '2026-06-01T00:00:00.000Z', amount: RS(3000) } },
    })
    const r = await call('hr', 'POST', '/records/eobi_challan', { data: { scheme: 'EOBI', month: '2026-07-01', amount: RS(3000) } })
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('SECTION_MOVED')
    expect(r.json().error.message).toMatch(/Accounting → Statutory payments/)
    expect((await call('hr', 'POST', '/me/records/eobi_challan', { data: {} })).statusCode).toBe(403) // never self-service
    expect(await prisma.hrRecord.count({ where: { tenantId: tenantA, section: 'eobi_challan' } })).toBe(1)

    const list = await call('hr', 'GET', '/records/eobi_challan')
    expect(list.statusCode).toBe(200)
    expect(list.json().records.map((x: { id: string }) => x.id)).toEqual([old.id])
    expect((await call('hr', 'GET', `/records/eobi_challan/${old.id}`)).statusCode).toBe(200)
    const edit = await call('hr', 'PATCH', `/records/eobi_challan/${old.id}`, { data: { amount: RS(1) } })
    expect(edit.statusCode).toBe(409)
    expect(edit.json().error.code).toBe('SECTION_MOVED')
    // Company B never sees A's.
    expect((await call('hrB', 'GET', `/records/eobi_challan/${old.id}`)).statusCode).toBe(404)
    expect((await call('hrB', 'GET', '/records/eobi_challan')).json().records).toEqual([])

    const sections = (await call('hr', 'GET', '/sections')).json() as Array<{ key: string; movedTo: { path: string } | null }>
    expect(sections.find((s) => s.key === 'eobi_challan')!.movedTo!.path).toBe('/accounting/statutory')
    expect(sections.find((s) => s.key === 'leave')!.movedTo).toBeNull()
  })

  it('HR keeps no statutory report of its own (Danish\'s formats replaced them); Accounting is the one place', async () => {
    expect((await call('hr', 'GET', '/reports/statutory')).statusCode).toBe(404)
  })
})

describe('hrCloseChecks', () => {
  it('blocks a month with staff to pay and no locked payroll — from the first payroll on, never before', async () => {
    // A's first payroll is July. September has staff and no run; June and
    // earlier were paid outside servd.
    const p = await payrollCheck.run(ctxFor(tenantA, ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09'], pktEnd('2026-09-30')))
    expect(p).not.toBeNull()
    expect(p).toMatchObject({ key: 'payroll', severity: 'block', overridable: true, months: ['2026-09'], link: '/hr/payroll' })
    expect(await payrollCheck.run(ctxFor(tenantA, ['2026-05', '2026-06'], pktEnd('2026-06-30')))).toBeNull()
    // A lock part way into a month does not ask for that month's payroll.
    expect(await payrollCheck.run(ctxFor(tenantA, ['2026-08', '2026-09'], pktEnd('2026-09-10')))).toBeNull()

    // An unlocked (approved) run blocks too.
    const sep = await runFor('hr', 'ceo', '2026-09', false)
    expect((await payrollCheck.run(ctxFor(tenantA, ['2026-09'], pktEnd('2026-09-30'))))?.months).toEqual(['2026-09'])
    expect((await call('ceo', 'POST', `/payroll/runs/${sep}/lock`)).statusCode).toBe(200)
    expect(await payrollCheck.run(ctxFor(tenantA, ['2026-07', '2026-08', '2026-09'], pktEnd('2026-09-30')))).toBeNull()
  })

  it('blocks a locked month whose payroll never reached the books', async () => {
    const sep = await prisma.hrPayrollRun.findFirstOrThrow({ where: { tenantId: tenantA, period: '2026-09' } })
    const e = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: tenantA, reference: `hr.payroll.accrual:${sep.id}` } })
    // As a run locked before locking booked it (pre 2026-09-24) would be.
    await prisma.journalEntry.update({ where: { id: e.id }, data: { reference: `hr.payroll.accrual.moved:${sep.id}` } })
    try {
      const p = await payrollCheck.run(ctxFor(tenantA, ['2026-09'], pktEnd('2026-09-30')))
      expect(p?.months).toEqual(['2026-09'])
      expect(p?.detail).toMatch(/not on the books/)
      expect(p?.cents).toBeGreaterThan(0)
    } finally {
      await prisma.journalEntry.update({ where: { id: e.id }, data: { reference: `hr.payroll.accrual:${sep.id}` } })
    }
  })

  it('another company\'s unlocked payroll never blocks this one', async () => {
    // B's first payroll is August (locked); its September is a draft.
    const sepB = (await call('hrB', 'POST', '/payroll/runs', { period: '2026-09' })).json().id
    const forB = await payrollCheck.run(ctxFor(tenantB, ['2026-08', '2026-09'], pktEnd('2026-09-30')))
    expect(forB?.months).toEqual(['2026-09'])
    expect(await payrollCheck.run(ctxFor(tenantA, ['2026-08', '2026-09'], pktEnd('2026-09-30')))).toBeNull()
    expect((await call('hrB', 'DELETE', `/payroll/runs/${sepB}`)).statusCode).toBe(204)
  })

  it('blocks an approved full & final that is not on the books, until it is booked', async () => {
    const lock = new Date(Date.now() + 3_600_000)
    expect(await fnfCheck.run(ctxFor(tenantA, [], lock))).toBeNull()
    const old = await mkEmp('Old Leaver', tenantA, { status: 'resigned', lastWorkingDay: D('2026-06-30') })
    const legacy = await prisma.hrRecord.create({
      data: { tenantId: tenantA, section: 'final_settlement', formVersion: 0, employeeId: old, status: 'approved', endDate: D('2026-06-30'), amountCents: RS(9000), data: { salaryPayable: RS(10000), deductions: RS(1000), netAmount: RS(9000) } },
    })
    const p = await fnfCheck.run(ctxFor(tenantA, [], lock))
    expect(p).toMatchObject({ key: 'fnf_unposted', severity: 'block', overridable: true, count: 1, cents: RS(9000) })
    expect(p!.fix).toEqual({ method: 'POST', path: '/hr/final-settlement/post-unposted', label: 'Book approved settlements' })
    // Approved after the lock: not this close's business.
    expect(await fnfCheck.run(ctxFor(tenantA, [], new Date(Date.now() - 86_400_000)))).toBeNull()
    // Company B's close never sees it.
    expect(await fnfCheck.run(ctxFor(tenantB, [], lock))).toBeNull()

    const r = (await call('ceo', 'POST', '/final-settlement/post-unposted')).json()
    expect(r.posted).toContain(legacy.id)
    const e = await entry(tenantA, `hr.final_settlement.accrual:${legacy.id}`)
    expect(amt(e!.lines, '2020', 'credit')).toBe(RS(9000))
    expect(await fnfCheck.run(ctxFor(tenantA, [], lock))).toBeNull()
  })
})
