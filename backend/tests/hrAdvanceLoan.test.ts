// HR seams for cash requests (finance wave B, accountant default H3):
//
//   - a LEGACY staff advance moved from a cash request (data.paidFrom
//     'cash_request'; the converter createLoanFromCashAdvanceTx is removed):
//     the loan register and payroll recover it like any advance; HR cannot
//     edit or cancel it (409 LOAN_FROM_CASH_REQUEST)
//   - directManagerUserIdOf / teamUserIdsUnder: the HR reporting line is the
//     ONE hierarchy the cash-request HOD signature reads — the direct
//     manager's login, the whole tree under a manager — and another company's
//     reporting line is never read
//
// Two companies: company B gets 404 on A's advance and cannot bind A's
// employee to its own request.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { hrRoutes } from '../src/modules/hr/routes.js'
import { CASH_REQUEST_PAID_FROM } from '../src/modules/hr/advanceLoan.js'
import { directManagerUserIdOf, teamUserIdsUnder, loansFor } from '../src/modules/hr/service.js'
import { pktToday, periodOf } from '../src/modules/hr/logic.js'

const RS = (r: number) => r * 100
const stamp = Date.now()
const D = (s: string) => new Date(`${s}T00:00:00.000Z`)

let app: FastifyInstance
let tenantA: string, tenantB: string
const users: Record<string, { id: string; token: string }> = {}
const emps: Record<string, string> = {}

async function mkUser(key: string, role: string, tenantId: string, alsoIn: string[] = []) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${stamp}@adv.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId },
  })
  for (const t of [tenantId, ...alsoIn]) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
async function mkEmp(key: string, tenantId: string, extra: Record<string, unknown> = {}) {
  const e = await prisma.hrEmployee.create({
    data: { tenantId, employeeCode: `A-${String(Object.keys(emps).length + 1).padStart(4, '0')}`, fullName: key, grossSalaryCents: RS(52000), basicSalaryCents: RS(30000), joiningDate: D('2026-01-01'), status: 'active', ...extra },
  })
  emps[key] = e.id
  return e.id
}
const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/hr${url}`, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}` } })

async function entry(tenantId: string, reference: string) {
  return prisma.journalEntry.findFirst({ where: { tenantId, reference }, include: { lines: { include: { account: { select: { code: true } } } } } })
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'GS Foods (adv)', slug: `gs-adv-${stamp}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Karachi Bites (adv)', slug: `kb-adv-${stamp}` } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)

  await mkUser('ceo', 'admin', tenantA)
  await mkUser('hr', 'hr', tenantA)
  await mkUser('hrB', 'hr', tenantB)
  await mkUser('ceoB', 'admin', tenantB)
  // The head-office manager works in both companies (one employee record per company).
  await mkUser('manager', 'fnb_manager', tenantA, [tenantB])
  await mkUser('cook', 'boh', tenantA)
  await mkUser('prep', 'boh', tenantA)
  await mkUser('cookB', 'boh', tenantB)
  await mkUser('lonely', 'foh', tenantA)

  // A: manager → cook → (prep with a login, porter with none)
  const mgr = await mkEmp('Manager', tenantA, { userId: users['manager']!.id })
  const cook = await mkEmp('Cook', tenantA, { userId: users['cook']!.id, managerId: mgr })
  await mkEmp('Prep', tenantA, { userId: users['prep']!.id, managerId: cook })
  await mkEmp('Porter', tenantA, { managerId: cook })
  // A manager with no login: HR stands in.
  const noLogin = await mkEmp('No-login boss', tenantA)
  await mkEmp('Lonely', tenantA, { userId: users['lonely']!.id, managerId: noLogin })
  // B: the same manager login over B's own cook.
  const mgrB = await mkEmp('Manager (B)', tenantB, { userId: users['manager']!.id })
  await mkEmp('Cook B', tenantB, { userId: users['cookB']!.id, managerId: mgrB })

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

describe('a legacy staff advance moved from a cash request', () => {
  const voucherId = randomUUID()
  let recordId: string

  beforeAll(async () => {
    // As the removed converter wrote it: an approved 'loan' (category advance), recovered from next month.
    const t = pktToday()
    const firstDeduction = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1))
    const rec = await prisma.hrRecord.create({
      data: {
        tenantId: tenantA, section: 'loan', formVersion: 1, employeeId: emps['Cook']!, category: 'advance',
        amountCents: RS(6000), quantity: 3, startDate: t, effectiveDate: firstDeduction, status: 'approved', currentStep: 0,
        approvals: [{ step: 'ceo', role: 'management', decision: 'approved', byUserId: users['ceo']!.id, byName: 'ceo', at: new Date().toISOString(), note: 'Unsettled cash request CV-00007 moved to a staff advance' }],
        data: {
          employee: emps['Cook'], type: 'advance', amount: RS(6000), date: t.toISOString(), installments: 3,
          firstDeduction: firstDeduction.toISOString(), reason: 'Unsettled cash request CV-00007', paidFrom: CASH_REQUEST_PAID_FROM,
          bankAccount: null, cashVoucherId: voucherId, cashVoucherNumber: 'CV-00007',
        },
        createdById: users['ceo']!.id,
      } as never,
    })
    recordId = rec.id
  })

  it('the loan register and payroll recover it like any advance', async () => {
    const loans = await loansFor(tenantA, emps['Cook'])
    expect(loans.find((l) => l.id === recordId)).toMatchObject({ type: 'advance', amountCents: RS(6000), installments: 3, outstandingCents: RS(6000) })
    const detail = (await call('hr', 'GET', `/employees/${emps['Cook']}`)).json()
    expect(detail.loans.map((l: { id: string }) => l.id)).toContain(recordId)

    const period = periodOf(new Date(Date.UTC(pktToday().getUTCFullYear(), pktToday().getUTCMonth() + 1, 1)))
    const run = await call('hr', 'POST', '/payroll/runs', { period })
    expect(run.statusCode, run.body).toBe(201)
    const slip = await prisma.hrPayslip.findFirstOrThrow({ where: { runId: run.json().id, employeeId: emps['Cook'] } })
    expect((slip.inputs as { loans: Array<{ loanId: string; cents: number }> }).loans).toEqual([{ loanId: recordId, cents: RS(2000) }])
    expect((await call('hr', 'DELETE', `/payroll/runs/${run.json().id}`)).statusCode).toBe(204)
  })

  it('HR cannot edit or cancel it (409 LOAN_FROM_CASH_REQUEST); company B gets 404', async () => {
    const cancel = await call('hr', 'POST', `/records/loan/${recordId}/cancel`)
    expect(cancel.statusCode).toBe(409)
    expect(cancel.json().error.code).toBe('LOAN_FROM_CASH_REQUEST')
    const edit = await call('hr', 'PATCH', `/records/loan/${recordId}`, { data: { installments: 1 } })
    expect(edit.statusCode).toBe(409)
    expect(edit.json().error.code).toBe('LOAN_FROM_CASH_REQUEST')
    expect((await prisma.hrRecord.findUniqueOrThrow({ where: { id: recordId } })).status).toBe('approved')
    expect(await entry(tenantA, `hr.loan.disbursement.reversal:${recordId}`)).toBeNull()

    expect((await call('hrB', 'GET', `/records/loan/${recordId}`)).statusCode).toBe(404)
    expect((await call('hrB', 'POST', `/records/loan/${recordId}/cancel`)).statusCode).toBe(404)
    expect((await call('ceoB', 'GET', `/employees/${emps['Cook']}`)).statusCode).toBe(404)
  })
})

describe('the HR reporting line, for the cash-request HOD signature', () => {
  it('directManagerUserIdOf: the direct manager\'s login, in that company only', async () => {
    expect(await directManagerUserIdOf(tenantA, users['cook']!.id)).toBe(users['manager']!.id)
    expect(await directManagerUserIdOf(tenantA, users['prep']!.id)).toBe(users['cook']!.id) // direct, not the top
    expect(await directManagerUserIdOf(tenantA, users['manager']!.id)).toBeNull()          // nobody above
    expect(await directManagerUserIdOf(tenantA, users['lonely']!.id)).toBeNull()           // manager has no login
    expect(await directManagerUserIdOf(tenantA, users['ceo']!.id)).toBeNull()              // not an employee
    // B's reporting line: the cook of A is nobody there.
    expect(await directManagerUserIdOf(tenantB, users['cook']!.id)).toBeNull()
    expect(await directManagerUserIdOf(tenantB, users['cookB']!.id)).toBe(users['manager']!.id)
  })

  it('teamUserIdsUnder: the whole tree under a manager, logins only, one company at a time', async () => {
    const a = await teamUserIdsUnder(tenantA, users['manager']!.id)
    expect(a.sort()).toEqual([users['cook']!.id, users['prep']!.id].sort()) // the porter has no login
    expect(await teamUserIdsUnder(tenantA, users['cook']!.id)).toEqual([users['prep']!.id])
    expect(await teamUserIdsUnder(tenantA, users['prep']!.id)).toEqual([])
    // The same manager login in B sees B's tree only.
    expect(await teamUserIdsUnder(tenantB, users['manager']!.id)).toEqual([users['cookB']!.id])
    expect(await teamUserIdsUnder(tenantB, users['cook']!.id)).toEqual([])
  })

  it('/hr/team still walks the same tree; HR approvals still go to the direct manager', async () => {
    const team = (await call('manager', 'GET', '/team')).json()
    expect(team.team.map((t: { fullName: string; depth: number }) => `${t.fullName}:${t.depth}`).sort()).toEqual(['Cook:1', 'Porter:2', 'Prep:2'])
    // A leave raised for the prep cook waits on the cook (the direct manager), not the top.
    const lt = await call('hr', 'POST', '/records/leave_type', { data: { name: 'Annual', entitlementDays: 14, pay: 'paid' } })
    expect(lt.statusCode, lt.body).toBe(201)
    const leave = await call('prep', 'POST', '/me/records/leave', { data: { leaveType: lt.json().id, from: '2027-03-01', to: '2027-03-02' } })
    expect(leave.statusCode, leave.body).toBe(201)
    expect((await call('manager', 'POST', `/records/leave/${leave.json().id}/decide`, { decision: 'approved' })).statusCode).toBe(403)
    expect((await call('cook', 'POST', `/records/leave/${leave.json().id}/decide`, { decision: 'approved' })).json().status).toBe('submitted')
  })
})
