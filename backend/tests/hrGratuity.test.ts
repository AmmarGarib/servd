// Gratuity at exit (accountant default H6, finance wave B):
//
//   - 30 days of the LAST gross per counted year; a part year of MORE than 6
//     months counts (day-precise); permanent staff with a full year or more;
//     on by default, a per-company HR setting
//   - "Calculate" on a full & final returns it with the service breakdown,
//     from the gross in force at the last working day (the latest revision)
//   - approval books Dr 6036 Gratuity inside the Cr 2020 net, in the leaver's
//     own company only; an amount over INT4 is 422 AMOUNT_TOO_LARGE
//   - a company that saved its own F&F format before gratuity existed still
//     gets the field (getFormat puts it back), and can edit the format again
//   - the F&F statement letter shows a Gratuity row, a company's own letter too
//
// Two companies: company B's HR gets 404 on company A's leaver.
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
import { sectionByKey } from '../src/modules/hr/forms.js'
import { withLetterSystemRows, DEFAULT_LETTERS } from '../src/modules/hr/letters.js'
import {
  gratuityFor, serviceLength, DEFAULT_GRATUITY, mergeSettings, finalSettlement, settlementNet, settlementParts, DEFAULT_HR_SETTINGS,
} from '../src/modules/hr/logic.js'

const RS = (r: number) => r * 100
const stamp = Date.now()
const D = (s: string) => new Date(`${s}T00:00:00.000Z`)
const perm = (joined: string) => ({ employmentType: 'permanent', joiningDate: D(joined) })

// ─── pure ───────────────────────────────────────────────────────────────────

describe('gratuityFor', () => {
  const gross = RS(60000)

  it('pays nothing under a full year of service', () => {
    const g = gratuityFor(perm('2024-01-01'), D('2024-11-30'), gross, DEFAULT_GRATUITY)
    expect(g).toMatchObject({ eligible: false, years: 0, months: 11, days: 0, countedYears: 0, amountCents: 0 })
    expect(g.reason).toMatch(/less than 1 year/i)
  })

  it('counts a remainder of exactly 6 months as nothing, and one day more as a year', () => {
    const exact = gratuityFor(perm('2024-01-01'), D('2025-06-30'), gross, DEFAULT_GRATUITY)
    expect(exact).toMatchObject({ eligible: true, years: 1, months: 6, days: 0, countedYears: 1, amountCents: gross })
    const plusDay = gratuityFor(perm('2024-01-01'), D('2025-07-01'), gross, DEFAULT_GRATUITY)
    expect(plusDay).toMatchObject({ years: 1, months: 6, days: 1, countedYears: 2, amountCents: gross * 2 })
  })

  it('3 years 7 months counts as 4', () => {
    const g = gratuityFor(perm('2022-01-01'), D('2025-07-31'), gross, DEFAULT_GRATUITY)
    expect(g).toMatchObject({ years: 3, months: 7, days: 0, countedYears: 4, amountCents: gross * 4 })
  })

  it('pays 30 days of the last gross a year: round(gross ÷ 30 × days)', () => {
    const odd = gratuityFor(perm('2020-03-15'), D('2026-03-14'), 5_200_001, DEFAULT_GRATUITY)
    expect(odd.countedYears).toBe(6)
    expect(odd.amountCents).toBe(5_200_001 * 6)
    const g = gratuityFor(perm('2020-03-15'), D('2026-03-14'), 5_200_001, { ...DEFAULT_GRATUITY, daysPerYear: 15 })
    expect(g.amountCents).toBe(Math.round(5_200_001 / 30 * 15) * 6)
  })

  it('pays nothing to probation staff, when switched off, or with no joining date — and says why', () => {
    const probation = gratuityFor({ employmentType: 'probation', joiningDate: D('2020-01-01') }, D('2026-01-01'), gross, DEFAULT_GRATUITY)
    expect(probation).toMatchObject({ eligible: false, amountCents: 0 })
    expect(probation.reason).toMatch(/permanent.*probation/)
    const off = gratuityFor(perm('2020-01-01'), D('2026-01-01'), gross, { ...DEFAULT_GRATUITY, enabled: false })
    expect(off).toMatchObject({ eligible: false, amountCents: 0 })
    expect(off.reason).toMatch(/switched off/)
    const noDate = gratuityFor({ employmentType: 'permanent', joiningDate: null }, D('2026-01-01'), gross, DEFAULT_GRATUITY)
    expect(noDate).toMatchObject({ eligible: false, amountCents: 0 })
    // Contract staff when the company says so.
    expect(gratuityFor({ employmentType: 'contract', joiningDate: D('2020-01-01') }, D('2026-01-01'), gross, { ...DEFAULT_GRATUITY, eligibleTypes: ['permanent', 'contract'] }).amountCents).toBe(gross * 6)
  })

  it('measures service by calendar day, both ends counted', () => {
    expect(serviceLength(D('2024-01-31'), D('2025-02-27'))).toEqual({ years: 1, months: 0, days: 28 })
    expect(serviceLength(D('2024-02-29'), D('2025-02-27'))).toEqual({ years: 0, months: 11, days: 30 })
    expect(serviceLength(D('2025-01-01'), D('2025-01-01'))).toEqual({ years: 0, months: 0, days: 1 })
  })

  it('is part of the one net formula, and settings deep-merge', () => {
    const r = finalSettlement({ grossSalaryCents: gross, joiningDate: D('2020-01-01') }, D('2026-01-31'),
      { salaryFrom: D('2026-01-01'), otPayableCents: 0, leaveBalanceDays: 0, loanOutstandingCents: 0, deductionsCents: 0, otherAdjustmentsCents: 0, gratuityCents: RS(1234) },
      DEFAULT_HR_SETTINGS)
    expect(r.gratuity).toBe(RS(1234))
    expect(r.netAmount).toBe(gross + RS(1234))
    expect(settlementNet(settlementParts({ salaryPayable: 100, gratuity: 50 }))).toBe(150)
    expect(settlementParts({}).gratuity).toBe(0)
    expect(mergeSettings(JSON.parse('{"gratuity":{"daysPerYear":15}}')).gratuity).toEqual({ ...DEFAULT_GRATUITY, daysPerYear: 15 })
    expect(mergeSettings(null).gratuity).toEqual(DEFAULT_GRATUITY)
  })
})

describe('the F&F statement letter', () => {
  it('has a Gratuity row, and puts one into a company\'s own older statement', () => {
    expect(DEFAULT_LETTERS.find((l) => l.key === 'final_settlement_statement')!.body).toContain('{{record.gratuity}}')
    const own = '<table><tr><td>Salary</td><td>{{record.salaryPayable}}</td></tr><tr><td>Leave</td><td>{{record.leaveEncashment}}</td></tr><tr><td>Net</td><td>{{record.netAmount}}</td></tr></table>'
    const fixed = withLetterSystemRows('final_settlement_statement', own)
    expect(fixed.indexOf('{{record.gratuity}}')).toBeGreaterThan(fixed.indexOf('{{record.leaveEncashment}}'))
    expect(fixed.indexOf('{{record.gratuity}}')).toBeLessThan(fixed.indexOf('{{record.netAmount}}'))
    const noLeave = withLetterSystemRows('final_settlement_statement', '<table><tr><td>Net</td><td>{{record.netAmount}}</td></tr></table>')
    expect(noLeave.indexOf('{{record.gratuity}}')).toBeLessThan(noLeave.indexOf('{{record.netAmount}}'))
    expect(withLetterSystemRows('final_settlement_statement', '<p>{{record.netAmount}}</p>')).toBe('<p>{{record.netAmount}}</p>')
    expect(withLetterSystemRows('warning_letter', own)).toBe(own)
  })
})

// ─── through the API ────────────────────────────────────────────────────────

let app: FastifyInstance
let tenantA: string, tenantB: string, tenantC: string
let kitchen: string
const users: Record<string, { id: string; token: string }> = {}
const emps: Record<string, string> = {}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${stamp}@grat.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
async function mkEmp(key: string, tenantId: string, extra: Record<string, unknown> = {}) {
  const e = await prisma.hrEmployee.create({
    data: { tenantId, employeeCode: `G-${String(Object.keys(emps).length + 1).padStart(4, '0')}`, fullName: key, grossSalaryCents: RS(52000), basicSalaryCents: RS(30000), joiningDate: D('2023-01-01'), employmentType: 'permanent', ...extra },
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

const FIGURES = ['salaryPayable', 'otPayable', 'leaveEncashment', 'gratuity', 'loanRecovery', 'incomeTax', 'eobiEmployee', 'eobiEmployer', 'sessiEmployer']

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'GS Foods (grat)', slug: `gs-grat-${stamp}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Karachi Bites (grat)', slug: `kb-grat-${stamp}` } })).id
  tenantC = (await prisma.tenant.create({ data: { name: 'Old Format Co (grat)', slug: `of-grat-${stamp}` } })).id
  for (const t of [tenantA, tenantB, tenantC]) await ensureChartOfAccounts(t)
  kitchen = (await prisma.department.create({ data: { tenantId: tenantA, name: 'Kitchen' } })).id

  await mkUser('ceo', 'admin', tenantA)
  await mkUser('hr', 'hr', tenantA)
  await mkUser('mgmt', 'management', tenantA)
  await mkUser('hrB', 'hr', tenantB)
  await mkUser('ceoB', 'admin', tenantB)
  await mkUser('hrC', 'hr', tenantC)

  await mkEmp('Senior', tenantA, { departmentId: kitchen, status: 'resigned', lastWorkingDay: D('2026-09-30') })
  await mkEmp('Probie', tenantA, { employmentType: 'probation', joiningDate: D('2020-01-01') })
  await mkEmp('Big', tenantA, { grossSalaryCents: 1_000_000_000, basicSalaryCents: 0, joiningDate: D('2018-01-01') })
  await mkEmp('Leaver C', tenantC)
  // A revision approved for June — the last gross is the revised one.
  await prisma.hrRecord.create({ data: { tenantId: tenantA, section: 'salary_revision', formVersion: 0, employeeId: emps['Senior']!, status: 'approved', amountCents: RS(70000), effectiveDate: D('2026-06-01'), data: {} } })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(hrRoutes, { prefix: '/hr' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('gratuity on a full & final', () => {
  let fnf: string
  let calc: Record<string, unknown>

  it('is worked out by Calculate on the last gross, with the service it counted', async () => {
    fnf = (await call('hr', 'POST', '/records/final_settlement', { data: { employee: emps['Senior'], lastWorkingDay: '2026-09-30' } })).json().id
    const r = await call('hr', 'POST', '/final-settlement/calculate', { employeeId: emps['Senior'], lastWorkingDay: '2026-09-30', recordId: fnf })
    expect(r.statusCode, r.body).toBe(200)
    calc = r.json()
    // 1 Jan 2023 – 30 Sep 2026: 3 years 9 months → 4 counted years at the
    // June revision's Rs 70,000.
    expect(calc['gratuityDetail']).toMatchObject({ eligible: true, years: 3, months: 9, days: 0, countedYears: 4, lastGrossCents: RS(70000), daysPerYear: 30 })
    expect(calc['gratuity']).toBe(RS(70000) * 4)
    expect(calc['netAmount']).toBe((calc['salaryPayable'] as number) + RS(280000))

    const probie = (await call('hr', 'POST', '/final-settlement/calculate', { employeeId: emps['Probie'], lastWorkingDay: '2026-09-30' })).json()
    expect(probie.gratuity).toBe(0)
    expect(probie.gratuityDetail.eligible).toBe(false)
    expect(probie.gratuityDetail.reason).toMatch(/probation/)
  })

  it('follows the company\'s setting', async () => {
    const cur = (await call('hr', 'GET', '/settings')).json()
    expect(cur.gratuity).toEqual(DEFAULT_GRATUITY)
    const off = await call('hr', 'PUT', '/settings', { ...cur, gratuity: { ...cur.gratuity, enabled: false } })
    expect(off.statusCode, off.body).toBe(200)
    expect((await call('hr', 'POST', '/final-settlement/calculate', { employeeId: emps['Senior'], lastWorkingDay: '2026-09-30' })).json().gratuity).toBe(0)
    // A screen that sends no gratuity block keeps the company's.
    const { gratuity: _g, ...withoutGratuity } = cur
    void _g
    expect((await call('hr', 'PUT', '/settings', withoutGratuity)).json().gratuity.enabled).toBe(false)
    expect((await call('hr', 'PUT', '/settings', { ...cur, gratuity: { ...cur.gratuity, daysPerYear: 0 } })).statusCode).toBe(400)
    expect((await call('hr', 'PUT', '/settings', cur)).json().gratuity.enabled).toBe(true)
    // Company B's setting is its own.
    expect((await call('hrB', 'GET', '/settings')).json().gratuity.enabled).toBe(true)
  })

  it('company B gets 404 on company A\'s leaver: calculate, approve and pay', async () => {
    expect((await call('hrB', 'POST', '/final-settlement/calculate', { employeeId: emps['Senior'], lastWorkingDay: '2026-09-30' })).statusCode).toBe(404)
    expect((await call('hrB', 'POST', '/final-settlement/calculate', { employeeId: emps['Senior'], lastWorkingDay: '2026-09-30', recordId: fnf })).statusCode).toBe(404)
    expect((await call('ceoB', 'POST', `/records/final_settlement/${fnf}/decide`, { decision: 'approved' })).statusCode).toBe(404)
    expect((await call('ceoB', 'POST', `/final-settlement/${fnf}/paid`, { cash: true })).statusCode).toBe(404)
    expect((await call('hrB', 'GET', `/records/final_settlement/${fnf}`)).statusCode).toBe(404)
  })

  it('is booked on approval: Dr 6036 Gratuity, inside the Cr 2020 net, in A\'s books only', async () => {
    const saved = await call('hr', 'PATCH', `/records/final_settlement/${fnf}`, { data: { ...Object.fromEntries(FIGURES.map((k) => [k, calc[k]])), deductions: 0, otherAdjustments: 0 } })
    expect(saved.statusCode, saved.body).toBe(200)
    expect(saved.json().data.gratuity).toBe(RS(280000))
    expect(saved.json().amountCents).toBe(calc['netAmount'])

    // HR raised it, so its HR step is signed by raising: it already waits on management.
    const at = await prisma.hrRecord.findUniqueOrThrow({ where: { id: fnf } })
    expect([at.status, at.currentStep]).toEqual(['submitted', 1])
    const ok = await call('mgmt', 'POST', `/records/final_settlement/${fnf}/decide`, { decision: 'approved' })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().status).toBe('approved')

    const e = await entry(tenantA, `hr.final_settlement.accrual:${fnf}`)
    expect(e).not.toBeNull()
    expect(balanced(e!.lines)).toBe(true)
    expect(amt(e!.lines, '6036', 'debit')).toBe(RS(280000))
    expect(amt(e!.lines, '6030', 'debit')).toBe(calc['salaryPayable'])
    expect(amt(e!.lines, '2020', 'credit')).toBe(calc['netAmount'])
    expect(await prisma.journalEntry.count({ where: { tenantId: { in: [tenantB, tenantC] }, reference: `hr.final_settlement.accrual:${fnf}` } })).toBe(0)

    // Paid: Wages payable cleared with the gratuity in it.
    const paid = await call('mgmt', 'POST', `/final-settlement/${fnf}/paid`, { cash: true })
    expect(paid.statusCode, paid.body).toBe(200)
    const pay = await entry(tenantA, `hr.final_settlement.payment:${fnf}`)
    expect(amt(pay!.lines, '2020', 'debit')).toBe(calc['netAmount'])
  })

  it('prints on the statement letter', async () => {
    const r = await call('hr', 'POST', '/letters/render', { key: 'final_settlement_statement', recordId: fnf })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().html).toContain('Gratuity')
    expect(r.json().html).toContain('280,000')
    expect(r.json().missing).not.toContain('record.gratuity')
    // A company letter saved before gratuity existed gets the row too.
    const own = DEFAULT_LETTERS.find((l) => l.key === 'final_settlement_statement')!.body.replace('<tr><td>Gratuity</td><td>{{record.gratuity}}</td></tr>', '')
    expect(own).not.toContain('record.gratuity')
    expect((await call('hr', 'PUT', '/letters/final_settlement_statement', { title: 'Our F&F', body: own })).statusCode).toBe(200)
    try {
      const listed = (await call('hr', 'GET', '/letters')).json().find((l: { key: string }) => l.key === 'final_settlement_statement')
      expect(listed.body).toContain('{{record.gratuity}}')
      expect((await call('hr', 'POST', '/letters/render', { key: 'final_settlement_statement', recordId: fnf })).json().html).toContain('280,000')
    } finally {
      await call('hr', 'DELETE', '/letters/final_settlement_statement')
    }
  })

  it('refuses an amount over INT4 with 422, on Calculate and on save', async () => {
    const big = await call('hr', 'POST', '/final-settlement/calculate', { employeeId: emps['Big'], lastWorkingDay: '2026-09-30' })
    expect(big.statusCode).toBe(422)
    expect(big.json().error.code).toBe('AMOUNT_TOO_LARGE')
    const rec = (await call('hr', 'POST', '/records/final_settlement', { data: { employee: emps['Probie'], lastWorkingDay: '2026-09-30' } })).json()
    const tooBig = await call('hr', 'PATCH', `/records/final_settlement/${rec.id}`, { data: { gratuity: 2_200_000_000 } })
    expect(tooBig.statusCode).toBe(422)
    expect(tooBig.json().error.code).toBe('AMOUNT_TOO_LARGE')
    expect((await prisma.hrRecord.findUniqueOrThrow({ where: { id: rec.id } })).data).not.toHaveProperty('gratuity', 2_200_000_000)
  })
})

describe('a company that saved its own F&F format before gratuity existed', () => {
  it('still gets the gratuity field, saves it, and can edit the format again', async () => {
    const sec = sectionByKey('final_settlement')!
    const oldFields = sec.fields!.filter((f) => f.key !== 'gratuity').map((f) => (f.key === 'otPayable' ? { ...f, label: 'Overtime owed' } : f))
    await prisma.hrFormDefinition.create({
      // As stored by a save before this release (plain JSON).
      data: { tenantId: tenantC, section: 'final_settlement', version: 1, title: 'Our F&F', fields: JSON.parse(JSON.stringify(oldFields)), workflow: JSON.parse(JSON.stringify(sec.workflow)), stages: [], isActive: true },
    })
    const fmt = (await call('hrC', 'GET', '/forms/final_settlement')).json().current
    expect(fmt.version).toBe(1)
    const keys = fmt.fields.map((f: { key: string }) => f.key)
    expect(keys).toContain('gratuity')
    expect(keys.indexOf('gratuity')).toBe(keys.indexOf('leaveEncashment') + 1)
    expect(fmt.fields.find((f: { key: string }) => f.key === 'otPayable').label).toBe('Overtime owed')

    const created = await call('hrC', 'POST', '/records/final_settlement', { data: { employee: emps['Leaver C'], lastWorkingDay: '2026-09-30', salaryPayable: RS(1000), gratuity: RS(500) } })
    expect(created.statusCode, created.body).toBe(201)
    expect(created.json().formVersion).toBe(1)
    expect(created.json().data.gratuity).toBe(RS(500))
    expect(created.json().amountCents).toBe(RS(1500))
    const edited = await call('hrC', 'PATCH', `/records/final_settlement/${created.json().id}`, { data: { gratuity: RS(700) } })
    expect(edited.statusCode, edited.body).toBe(200)
    expect(edited.json().amountCents).toBe(RS(1700))

    // The next edit of the format passes its checks (gratuity is in it now);
    // dropping gratuity is refused like any system field.
    const next = await call('hrC', 'PUT', '/forms/final_settlement', { fields: fmt.fields, workflow: fmt.workflow })
    expect(next.statusCode, next.body).toBe(200)
    expect(next.json().version).toBe(2)
    const drop = await call('hrC', 'PUT', '/forms/final_settlement', { fields: fmt.fields.filter((f: { key: string }) => f.key !== 'gratuity'), workflow: fmt.workflow })
    expect(drop.statusCode).toBe(400)
    // The old version can still be made live (checked with gratuity put back).
    expect((await call('hrC', 'POST', '/forms/final_settlement/activate', { version: 1 })).statusCode).toBe(200)
    // Company A's format is untouched.
    expect((await call('hr', 'GET', '/forms/final_settlement')).json().current.version).toBe(0)
  })
})
