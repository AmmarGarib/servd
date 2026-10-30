// Payroll goes through finance before the CEO (owner, 2026-10-30: "How HR will push payroll to finance for
// review?" → "HR sends to finance, then CEO"; "Finance will put tax figures").
//
//   draft → POST /send-to-finance (HR) → finance_review → POST /finance-pass (finance with accounting, or the CEO)
//   → finance_checked → POST /approve (the approver) → approved → lock. POST /finance-return {note ≥10} sends it
//   back to draft; PUT /payslips/:id/tax {taxCents} while it is with finance (the CEO also on a draft) is kept
//   through a later Recalculate.
//
//   - approve from draft: 409 NOT_FINANCE_CHECKED; from finance_review only the CEO (owner 2026-10-30)
//   - HR cannot pass; finance without the accounting module cannot; finance cannot set tax on its own payslip
//   - edits (recalculate, payslip PATCH, overtime, delete) refused outside draft
//   - company B: 404 on A's run and payslip
//   - the inbox lists the run under payroll_finance_review, then payroll_run
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { hrRoutes } from '../src/modules/hr/routes.js'
import { getSettings, saveSettings } from '../src/modules/hr/service.js'
import { registerApprovalsPlugin } from '../src/modules/approvals/index.js'
import { approverIdsFor } from '../src/lib/approvalRights.js'

const stamp = Date.now()
const P = `pfr${stamp}`
const RS = (r: number) => r * 100
const D = (s: string) => new Date(`${s}T00:00:00.000Z`)
let app: FastifyInstance
const T: Record<'A' | 'B', string> = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: string }> = {}
const E: Record<string, string> = {}

async function mkUser(key: string, role: string, tenantId: string, extra: Record<string, unknown> = {}) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@pfr.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as never, tenantId, isActive: true, accountStatus: 'active', ...extra,
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
const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, payload: payload as never, headers: auth(who) })
const code = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code

type Slip = { id: string; employeeId: string; netCents: number; deductionsCents: number; lines: Array<{ code: string; amountCents: number }>; inputs: Record<string, unknown> }
async function runOf(who: string, id: string) {
  const r = await call(who, 'GET', `/hr/payroll/runs/${id}`)
  expect(r.statusCode, r.body).toBe(200)
  return r.json() as { run: { status: string; financeReturnNote: string | null; totals: { deductionsCents: number } }; payslips: Slip[] }
}
const taxLine = (s: Slip) => s.lines.find((l) => l.code === 'tax')?.amountCents ?? 0
async function inboxIds(who: string, type: string): Promise<string[]> {
  const r = await call(who, 'GET', `/approvals?type=${type}`)
  expect(r.statusCode, r.body).toBe(200)
  return (r.json() as { items: Array<{ type: string; id: string }> }).items.filter((i) => i.type === type).map((i) => i.id)
}

let runA = '', runB = ''

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: `${P} A`, slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: `${P} B`, slug: `${P}-b` } })).id
  for (const t of [T.A, T.B]) {
    await ensureChartOfAccounts(t)
    await saveSettings(t, { ...(await getSettings(t)), absentWithoutPunchFrom: null })
  }
  await mkUser('ceo', 'admin', T.A)
  await mkUser('hr', 'hr', T.A)
  await mkUser('fin', 'finance', T.A)
  await mkUser('fin2', 'finance', T.A)
  await mkUser('finNoAcc', 'finance', T.A, { moduleDeny: ['accounting'] })
  await mkUser('mgmt', 'management', T.A)
  await mkUser('hrB', 'hr', T.B)
  await mkUser('finB', 'finance', T.B)
  E['cook'] = (await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-1`, fullName: 'Cook', grossSalaryCents: RS(60000), monthlyTaxCents: RS(1000), joiningDate: D('2025-01-01'), paymentMethod: 'bank' } })).id
  E['finEmp'] = (await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-2`, fullName: 'Finance person', grossSalaryCents: RS(90000), monthlyTaxCents: RS(2000), joiningDate: D('2025-01-01'), paymentMethod: 'bank', userId: U['fin']!.id } })).id
  E['bCook'] = (await prisma.hrEmployee.create({ data: { tenantId: T.B, employeeCode: `${P}-3`, fullName: 'B cook', grossSalaryCents: RS(50000), monthlyTaxCents: 0, joiningDate: D('2025-01-01'), paymentMethod: 'bank' } })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: (err as Error).message } })
  })
  await app.register(async (api) => {
    await api.register(hrRoutes, { prefix: '/hr' })
    await registerApprovalsPlugin(api)
  }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  for (const t of [T.A, T.B]) {
    await prisma.hrPayrollRun.deleteMany({ where: { tenantId: t } }).catch(() => {})
    await prisma.hrEmployee.deleteMany({ where: { tenantId: t } }).catch(() => {})
  }
  await app?.close()
})

describe('payroll: HR → finance → CEO', () => {
  it('HR sends a draft to finance; approve before finance checks it is refused', async () => {
    const c = await call('hr', 'POST', '/hr/payroll/runs', { period: '2027-03' })
    expect(c.statusCode, c.body).toBe(201)
    runA = c.json().id
    runB = (await call('hrB', 'POST', '/hr/payroll/runs', { period: '2027-03' })).json().id

    const early = await call('ceo', 'POST', `/hr/payroll/runs/${runA}/approve`)
    expect(early.statusCode).toBe(409)
    expect(code(early)).toBe('NOT_FINANCE_CHECKED')
    // Finance cannot pass a draft; HR cannot send someone else's company's run.
    expect(code(await call('fin', 'POST', `/hr/payroll/runs/${runA}/finance-pass`, {}))).toBe('NOT_WITH_FINANCE')
    expect((await call('hrB', 'POST', `/hr/payroll/runs/${runA}/send-to-finance`)).statusCode).toBe(404)

    const sent = await call('hr', 'POST', `/hr/payroll/runs/${runA}/send-to-finance`)
    expect(sent.statusCode, sent.body).toBe(200)
    expect(sent.json().status).toBe('finance_review')
    expect(code(await call('hr', 'POST', `/hr/payroll/runs/${runA}/send-to-finance`))).toBe('RUN_NOT_DRAFT')
  })

  it('the inbox lists it for finance under payroll_finance_review; the bell tells finance', async () => {
    expect(await inboxIds('fin', 'payroll_finance_review')).toContain(runA)
    expect(await inboxIds('finB', 'payroll_finance_review')).not.toContain(runA)
    expect(await inboxIds('ceo', 'payroll_run')).not.toContain(runA)
    const who = await approverIdsFor('payroll_finance_review', runA)
    expect(who?.userIds).toEqual(expect.arrayContaining([U['fin']!.id, U['fin2']!.id]))
    expect(who?.userIds).not.toContain(U['finNoAcc']!.id)
    expect(who?.userIds).not.toContain(U['hr']!.id)
  })

  it('HR edits nothing while it is with finance', async () => {
    const slips = (await runOf('hr', runA)).payslips
    const s = slips.find((x) => x.employeeId === E['cook'])!
    expect(code(await call('hr', 'POST', `/hr/payroll/runs/${runA}/recalculate`))).toBe('RUN_NOT_DRAFT')
    expect(code(await call('hr', 'PATCH', `/hr/payroll/payslips/${s.id}`, { lateCount: 1 }))).toBe('RUN_NOT_DRAFT')
    expect(code(await call('hr', 'POST', `/hr/payroll/payslips/${s.id}/overtime`, { recordIds: [] }))).toBe('RUN_NOT_DRAFT')
    expect(code(await call('hr', 'POST', `/hr/payroll/runs/${runA}/overtime`, { all: true }))).toBe('RUN_NOT_DRAFT')
    expect((await call('hr', 'DELETE', `/hr/payroll/runs/${runA}`)).statusCode).toBe(409)
  })

  it('who may pass, return and set tax', async () => {
    expect((await call('hr', 'POST', `/hr/payroll/runs/${runA}/finance-pass`, {})).statusCode).toBe(403)
    expect((await call('finNoAcc', 'POST', `/hr/payroll/runs/${runA}/finance-pass`, {})).statusCode).toBe(403)
    expect((await call('mgmt', 'POST', `/hr/payroll/runs/${runA}/finance-pass`, {})).statusCode).toBe(403)
    expect((await call('finB', 'POST', `/hr/payroll/runs/${runA}/finance-pass`, {})).statusCode).toBe(404)
    const slips = (await runOf('fin', runA)).payslips
    const own = slips.find((x) => x.employeeId === E['finEmp'])!
    const cook = slips.find((x) => x.employeeId === E['cook'])!
    const self = await call('fin', 'PUT', `/hr/payroll/payslips/${own.id}/tax`, { taxCents: 0 })
    expect(self.statusCode).toBe(403)
    expect(code(self)).toBe('OWN_PAYSLIP')
    expect((await call('finB', 'PUT', `/hr/payroll/payslips/${cook.id}/tax`, { taxCents: 0 })).statusCode).toBe(404)
    expect((await call('hr', 'PUT', `/hr/payroll/payslips/${cook.id}/tax`, { taxCents: 0 })).statusCode).toBe(403)
    expect((await call('fin', 'PUT', `/hr/payroll/payslips/${cook.id}/tax`, { taxCents: -1 })).statusCode).toBe(400)
    // Return needs a note.
    const short = await call('fin', 'POST', `/hr/payroll/runs/${runA}/finance-return`, { note: 'fix' })
    expect(short.statusCode).toBe(422)
    expect(code(short)).toBe('NOTE_TOO_SHORT')
  })

  it('finance returns it to HR with a note; HR edits and sends again', async () => {
    const back = await call('fin', 'POST', `/hr/payroll/runs/${runA}/finance-return`, { note: 'Late count for the cook is wrong' })
    expect(back.statusCode, back.body).toBe(200)
    expect(back.json().status).toBe('draft')
    expect(back.json().financeReturnNote).toBe('Late count for the cook is wrong')
    expect(await inboxIds('fin', 'payroll_finance_review')).not.toContain(runA)
    const cook = (await runOf('hr', runA)).payslips.find((x) => x.employeeId === E['cook'])!
    expect((await call('hr', 'PATCH', `/hr/payroll/payslips/${cook.id}`, { lateCount: 0 })).statusCode).toBe(200)
    expect((await call('hr', 'POST', `/hr/payroll/runs/${runA}/send-to-finance`)).statusCode).toBe(200)
  })

  it('finance sets the tax; it survives a return and a Recalculate', async () => {
    const before = await runOf('fin', runA)
    const cook = before.payslips.find((x) => x.employeeId === E['cook'])!
    expect(taxLine(cook)).toBe(RS(1000))
    const set = await call('fin', 'PUT', `/hr/payroll/payslips/${cook.id}/tax`, { taxCents: RS(2500) })
    expect(set.statusCode, set.body).toBe(200)
    const after = await runOf('fin', runA)
    const cook2 = after.payslips.find((x) => x.employeeId === E['cook'])!
    expect(taxLine(cook2)).toBe(RS(2500))
    expect(cook2.netCents).toBe(cook.netCents - RS(1500))
    expect(after.run.totals.deductionsCents).toBe(before.run.totals.deductionsCents + RS(1500))
    const audit = await prisma.auditLog.findFirst({ where: { action: 'hr.payroll.tax_set', entityId: cook.id } })
    expect(audit?.tenantId).toBe(T.A)

    // Round trip: return, recalculate from records, the tax stays finance's.
    expect((await call('fin2', 'POST', `/hr/payroll/runs/${runA}/finance-return`, { note: 'Please recalculate from records' })).statusCode).toBe(200)
    expect((await call('hr', 'POST', `/hr/payroll/runs/${runA}/recalculate`)).statusCode).toBe(200)
    const re = (await runOf('hr', runA)).payslips.find((x) => x.employeeId === E['cook'])!
    expect(taxLine(re)).toBe(RS(2500))
    expect((await call('hr', 'POST', `/hr/payroll/runs/${runA}/send-to-finance`)).statusCode).toBe(200)
  })

  it('finance passes it; the CEO approves and locks it; the inbox moves it to payroll_run', async () => {
    const pass = await call('fin', 'POST', `/hr/payroll/runs/${runA}/finance-pass`, { note: 'Tax checked' })
    expect(pass.statusCode, pass.body).toBe(200)
    expect(pass.json().status).toBe('finance_checked')
    expect(pass.json().financeCheckedById).toBe(U['fin']!.id)
    expect(await inboxIds('fin', 'payroll_finance_review')).not.toContain(runA)
    expect(await inboxIds('ceo', 'payroll_run')).toContain(runA)
    // Tax is finance's only while it is with finance.
    const cook = (await runOf('fin', runA)).payslips.find((x) => x.employeeId === E['cook'])!
    expect(code(await call('fin', 'PUT', `/hr/payroll/payslips/${cook.id}/tax`, { taxCents: 0 }))).toBe('RUN_NOT_IN_FINANCE_REVIEW')
    // HR edits nothing now either.
    expect(code(await call('hr', 'POST', `/hr/payroll/runs/${runA}/recalculate`))).toBe('RUN_NOT_DRAFT')

    const ok = await call('ceo', 'POST', `/hr/payroll/runs/${runA}/approve`)
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().status).toBe('approved')
    expect(await inboxIds('ceo', 'payroll_run')).not.toContain(runA)
    // Reopen sends it back through finance.
    const re = await call('ceo', 'POST', `/hr/payroll/runs/${runA}/reopen`)
    expect(re.json().status).toBe('draft')
    expect(re.json().financeCheckedById).toBeNull()
    expect(code(await call('ceo', 'POST', `/hr/payroll/runs/${runA}/approve`))).toBe('NOT_FINANCE_CHECKED')
    expect((await call('hr', 'POST', `/hr/payroll/runs/${runA}/send-to-finance`)).statusCode).toBe(200)
    expect((await call('fin', 'POST', `/hr/payroll/runs/${runA}/finance-pass`, {})).statusCode).toBe(200)
    expect((await call('ceo', 'POST', `/hr/payroll/runs/${runA}/approve`)).statusCode).toBe(200)
    const lock = await call('ceo', 'POST', `/hr/payroll/runs/${runA}/lock`)
    expect(lock.statusCode, lock.body).toBe(200)
    expect(lock.json().status).toBe('locked')
  })

  it('the CEO may set tax on a draft and pass a run themselves; company B stays its own', async () => {
    const b = await runOf('hrB', runB)
    const bSlip = b.payslips[0]!
    expect((await call('ceo', 'GET', `/hr/payroll/runs/${runB}`)).statusCode).toBe(404)
    expect((await call('fin', 'PUT', `/hr/payroll/payslips/${bSlip.id}/tax`, { taxCents: 0 })).statusCode).toBe(404)
    // Finance cannot set tax on B's draft (not with finance); B's run is B's.
    expect(code(await call('finB', 'PUT', `/hr/payroll/payslips/${bSlip.id}/tax`, { taxCents: RS(100) }))).toBe('RUN_NOT_IN_FINANCE_REVIEW')
    expect((await call('hrB', 'POST', `/hr/payroll/runs/${runB}/send-to-finance`)).statusCode).toBe(200)
    expect((await call('fin', 'POST', `/hr/payroll/runs/${runB}/finance-return`, { note: 'Not my company at all' })).statusCode).toBe(404)
    expect((await call('finB', 'PUT', `/hr/payroll/payslips/${bSlip.id}/tax`, { taxCents: RS(100) })).statusCode).toBe(200)
    expect((await call('finB', 'POST', `/hr/payroll/runs/${runB}/finance-pass`, {})).statusCode).toBe(200)
    expect((await runOf('hrB', runB)).run.status).toBe('finance_checked')
  })
})

describe('the CEO approves a run still with finance (owner, 2026-10-30: "i am ceo??")', () => {
  it('approves in one step and signs the finance check', async () => {
    const c = await call('hr', 'POST', '/hr/payroll/runs', { period: '2027-05' })
    expect(c.statusCode, c.body).toBe(201)
    const id = c.json().id
    expect((await call('hr', 'POST', `/hr/payroll/runs/${id}/send-to-finance`)).statusCode).toBe(200)
    expect(await inboxIds('ceo', 'payroll_finance_review')).toContain(id)
    const ok = await call('ceo', 'POST', `/hr/payroll/runs/${id}/approve`)
    expect(ok.statusCode, ok.body).toBe(200)
    const row = await prisma.hrPayrollRun.findUniqueOrThrow({ where: { id } })
    expect(row.status).toBe('approved')
    expect(row.financeCheckedById).toBe(row.approvedById)
  })
})
