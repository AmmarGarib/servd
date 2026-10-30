// Owner decision 2026-10-27: a wage change and a guest-list download go through the manager channel first and
// the CEO gives the FINAL approval (approval types wage_change and customer_export, CEO only for now).
//
//   A) Wage change: a non-CEO salary edit on the employee master answers 202 and raises a salary revision
//      through the HR request engine (HR → management → the CEO last). The salary and payroll stay as they were
//      until the CEO approves; a rejection keeps them; the CEO's own edit applies at once; company B 404.
//   B) Guest-list download: a non-CEO asks (202); the CEO approves; the requester downloads once within 24 h;
//      a second download, an expired one, someone else's, and another company's are refused; the CEO
//      downloads at once.
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
import { crmRoutes } from '../src/modules/crm/routes.js'
import { waitlistRoutes } from '../src/modules/waitlist/routes.js'
import { approvalSubject, APPROVAL_RIGHTS } from '../src/lib/approvalRights.js'
import { getSettings, saveSettings } from '../src/modules/hr/service.js'

const RS = (r: number) => r * 100
const stamp = Date.now()
const D = (s: string) => new Date(`${s}T00:00:00.000Z`)

let app: FastifyInstance
let tenantA: string, tenantB: string, conceptA: string, conceptB: string
const users: Record<string, { id: string; token: string }> = {}
const emps: Record<string, string> = {}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${stamp}@wagexp.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
async function mkEmp(key: string, tenantId: string, grossRs: number) {
  const e = await prisma.hrEmployee.create({
    data: { tenantId, employeeCode: `WX-${String(Object.keys(emps).length + 1).padStart(4, '0')}`, fullName: key, grossSalaryCents: RS(grossRs), basicSalaryCents: RS(grossRs / 2), monthlyTaxCents: 0, joiningDate: D('2025-01-01'), paymentMethod: 'bank' },
  })
  emps[key] = e.id
  return e.id
}
const call = (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}` } })
const gross = async (id: string) => (await prisma.hrEmployee.findUniqueOrThrow({ where: { id } })).grossSalaryCents
const decide = (who: string, id: string, decision: 'approved' | 'rejected', note?: string) =>
  call(who, 'POST', `/hr/records/salary_revision/${id}/decide`, { decision, ...(note && { note }) })

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: `WX A ${stamp}`, slug: `wx-a-${stamp}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: `WX B ${stamp}`, slug: `wx-b-${stamp}` } })).id
  for (const t of [tenantA, tenantB]) await ensureChartOfAccounts(t)
  // These payrolls are about the wage change, not attendance: no punches are made, so the October no-punch rule
  // (owner, 2026-10-30) is off for these companies.
  for (const t of [tenantA, tenantB]) await saveSettings(t, { ...(await getSettings(t)), absentWithoutPunchFrom: null })
  conceptA = (await prisma.concept.create({ data: { name: `WX Brand A ${stamp}`, slug: `wx-brand-a-${stamp}`, type: 'restaurant', tenantId: tenantA } as never })).id
  conceptB = (await prisma.concept.create({ data: { name: `WX Brand B ${stamp}`, slug: `wx-brand-b-${stamp}`, type: 'restaurant', tenantId: tenantB } as never })).id
  await mkUser('ceoA', 'admin', tenantA)
  await mkUser('ceoB', 'admin', tenantB)
  await mkUser('hrA', 'hr', tenantA)
  await mkUser('hrB', 'hr', tenantB)
  await mkUser('mgmtA', 'management', tenantA)
  await mkUser('mktA', 'marketing', tenantA)
  await mkUser('mkt2A', 'marketing', tenantA)
  await mkUser('mktB', 'marketing', tenantB)
  await mkEmp('cook', tenantA, 60000)
  await mkEmp('waiter', tenantA, 40000)
  await mkEmp('runner', tenantA, 30000)
  await mkEmp('b-cook', tenantB, 50000)

  // Guests: one of A's brand, one of B's.
  for (const [key, concept] of [['a', conceptA], ['b', conceptB]] as const) {
    const c = await prisma.customer.create({ data: { name: `Guest ${key} ${stamp}`, phone: `92300${String(stamp).slice(-6)}${key === 'a' ? 1 : 2}`, email: `guest.${key}.${stamp}@wagexp.pk` } as never })
    await prisma.order.create({ data: { conceptId: concept, customerId: c.id, source: 'pos', status: 'completed', totalCents: 150_000, placedAt: new Date() } as never })
  }

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: (err as Error).message } })
  })
  await app.register(hrRoutes, { prefix: '/hr' })
  await app.register(crmRoutes, { prefix: '/crm' })
  await app.register(waitlistRoutes, { prefix: '/waitlist' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  await app?.close()
  for (const t of [tenantA, tenantB]) {
    await prisma.customerExportRequest.deleteMany({ where: { tenantId: t } })
    await prisma.hrPayrollRun.deleteMany({ where: { tenantId: t } })
    await prisma.hrRecord.deleteMany({ where: { tenantId: t } })
    await prisma.hrEmployee.deleteMany({ where: { tenantId: t } })
    await prisma.order.deleteMany({ where: { concept: { tenantId: t } } })
    await prisma.concept.deleteMany({ where: { tenantId: t } })
    await prisma.staffNotification.deleteMany({ where: { tenantId: t } }).catch(() => {})
    await prisma.auditLog.deleteMany({ where: { tenantId: t } }).catch(() => {})
    await prisma.tenantMember.deleteMany({ where: { tenantId: t } }).catch(() => {})
  }
  await prisma.customer.deleteMany({ where: { email: { endsWith: `${stamp}@wagexp.pk` } } })
})

describe('registry', () => {
  it('wage_change and customer_export are the CEO\'s, not handed over yet', () => {
    for (const t of ['wage_change', 'customer_export'] as const) {
      expect(APPROVAL_RIGHTS[t]).toMatchObject({ section: 'ceo', delegable: false, roles: ['admin'] })
    }
  })
})

describe('A) wage change', () => {
  let reqId: string
  let runId: string

  it('a non-CEO salary edit is 202: nothing changes on the employee, payroll pays the old salary', async () => {
    const r = await call('hrA', 'PATCH', `/hr/employees/${emps.cook}`, { data: { grossSalaryCents: RS(70000), basicSalaryCents: RS(35000) } })
    expect(r.statusCode, r.body).toBe(202)
    const body = r.json()
    expect(body.pendingApproval).toBe(true)
    expect(body.request.section).toBe('salary_revision')
    expect(body.request.status).toBe('submitted')
    reqId = body.request.id
    expect(await gross(emps.cook!)).toBe(RS(60000))
    // HR raised it: its HR step is signed by raising; it waits on management (the manager channel), not the CEO yet.
    expect((await approvalSubject('wage_change', reqId))!.status).toBe('with_managers')
    const run = await call('hrA', 'POST', '/hr/payroll/runs', { period: '2026-10' })
    expect(run.statusCode, run.body).toBe(201)
    runId = run.json().id
    const slip = (await call('hrA', 'GET', `/hr/payroll/runs/${runId}`)).json().payslips.find((s: { employeeId: string }) => s.employeeId === emps.cook)
    expect(slip.grossCents).toBe(RS(60000))
    // The profile shows it waiting.
    const prof = (await call('hrA', 'GET', `/hr/employees/${emps.cook}`)).json()
    expect(prof.pendingWageChange).toMatchObject({ id: reqId, grossCents: RS(70000), basicCents: RS(35000), atCeoStep: false, canWithdraw: true })
  })

  it('a second pay change while one waits is 409; other fields still save at once', async () => {
    const r = await call('hrA', 'PATCH', `/hr/employees/${emps.cook}`, { data: { grossSalaryCents: RS(80000) } })
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('WAGE_CHANGE_PENDING')
  })

  it('management approves its step; then only the CEO of the company decides (HR / management 403, company B 404)', async () => {
    expect((await decide('mgmtA', reqId, 'approved')).statusCode).toBe(200)
    expect((await approvalSubject('wage_change', reqId))!.status).toBe('pending')
    expect(await gross(emps.cook!)).toBe(RS(60000))
    expect((await decide('mgmtA', reqId, 'approved')).statusCode).toBe(403)
    expect((await decide('hrA', reqId, 'approved')).statusCode).toBe(403)
    expect((await decide('ceoB', reqId, 'approved')).statusCode).toBe(404)
    // The CEO's queue lists it as a wage change.
    const rows = (await call('ceoA', 'GET', '/hr/approvals')).json() as Array<{ id: string; wageCeoStep?: boolean }>
    expect(rows.find((x) => x.id === reqId)?.wageCeoStep).toBe(true)
  })

  it('a CEO rejection needs a reason of 10+ characters', async () => {
    const r = await decide('ceoA', reqId, 'rejected', 'too short')
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('NOTE_REQUIRED')
  })

  it('the CEO approves: the salary applies, and payroll recalculates at the new pay', async () => {
    const r = await decide('ceoA', reqId, 'approved')
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().status).toBe('approved')
    const emp = await prisma.hrEmployee.findUniqueOrThrow({ where: { id: emps.cook! } })
    expect(emp.grossSalaryCents).toBe(RS(70000))
    expect(emp.basicSalaryCents).toBe(RS(35000))
    expect((await call('hrA', 'POST', `/hr/payroll/runs/${runId}/recalculate`)).statusCode).toBe(200)
    const slip = (await call('hrA', 'GET', `/hr/payroll/runs/${runId}`)).json().payslips.find((s: { employeeId: string }) => s.employeeId === emps.cook)
    expect(slip.grossCents).toBe(RS(70000))
    const decided = await prisma.auditLog.findFirst({ where: { action: 'approval.decide', entityId: reqId, tenantId: tenantA } })
    expect((decided?.metadata as { type?: string } | null)?.type).toBe('wage_change')
  })

  it('a rejection leaves the salary as it was', async () => {
    const r = await call('hrA', 'PATCH', `/hr/employees/${emps.waiter}`, { data: { grossSalaryCents: RS(45000) } })
    expect(r.statusCode).toBe(202)
    const id = r.json().request.id
    expect((await decide('mgmtA', id, 'approved')).statusCode).toBe(200)
    const rej = await decide('ceoA', id, 'rejected', 'Not in this quarter budget')
    expect(rej.statusCode, rej.body).toBe(200)
    expect(rej.json().status).toBe('rejected')
    expect(await gross(emps.waiter!)).toBe(RS(40000))
  })

  it('the requester may withdraw a waiting pay change', async () => {
    const r = await call('hrA', 'PATCH', `/hr/employees/${emps.runner}`, { data: { grossSalaryCents: RS(33000) } })
    expect(r.statusCode).toBe(202)
    const id = r.json().request.id
    const w = await call('hrA', 'POST', `/hr/records/salary_revision/${id}/cancel`, {})
    expect(w.statusCode, w.body).toBe(200)
    expect((await prisma.hrRecord.findUniqueOrThrow({ where: { id } })).status).toBe('cancelled')
    expect(await gross(emps.runner!)).toBe(RS(30000))
  })

  it('the CEO\'s own change applies at once (no request)', async () => {
    const r = await call('ceoA', 'PATCH', `/hr/employees/${emps.runner}`, { data: { grossSalaryCents: RS(36000) } })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().pendingApproval).toBeUndefined()
    expect(await gross(emps.runner!)).toBe(RS(36000))
    expect(await prisma.hrRecord.count({ where: { employeeId: emps.runner, section: 'salary_revision', status: 'submitted' } })).toBe(0)
  })

  it('company B never reaches company A\'s employee (404)', async () => {
    expect((await call('hrB', 'PATCH', `/hr/employees/${emps.cook}`, { data: { grossSalaryCents: RS(1) } })).statusCode).toBe(404)
    expect((await call('hrB', 'GET', `/hr/employees/${emps.cook}`)).statusCode).toBe(404)
  })
})

describe('B) guest-list download', () => {
  let reqId: string

  it('a non-CEO cannot download directly (403 EXPORT_NEEDS_CEO), the waitlist neither', async () => {
    const r = await call('mktA', 'GET', '/crm/customers/export?format=csv')
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('EXPORT_NEEDS_CEO')
    const w = await call('mktA', 'GET', '/waitlist/signups.csv')
    expect(w.statusCode).toBe(403)
  })

  it('the CEO downloads at once — only their own company\'s guests', async () => {
    const r = await call('ceoA', 'GET', '/crm/customers/export?format=csv')
    expect(r.statusCode, r.body).toBe(200)
    expect(r.body).toContain(`guest.a.${stamp}@wagexp.pk`)
    expect(r.body).not.toContain(`guest.b.${stamp}@wagexp.pk`)
    expect(await prisma.auditLog.count({ where: { action: 'customer_export.download', userId: users.ceoA!.id } })).toBe(1)
  })

  it('a non-CEO asks (202); the CEO\'s own ask is refused', async () => {
    const short = await call('mktA', 'POST', '/crm/exports', { kind: 'customers', reason: 'need it' })
    expect(short.statusCode).toBe(400)
    const r = await call('mktA', 'POST', '/crm/exports', { kind: 'customers', filters: {}, reason: 'Birthday campaign list for October' })
    expect(r.statusCode, r.body).toBe(202)
    expect(r.json().pendingApproval).toBe(true)
    reqId = r.json().request.id
    expect((await approvalSubject('customer_export', reqId))!.status).toBe('pending')
    expect((await call('ceoA', 'POST', '/crm/exports', { kind: 'customers', reason: 'Birthday campaign list' })).statusCode).toBe(422)
    // Not downloadable before the CEO approves.
    expect((await call('mktA', 'GET', `/crm/exports/${reqId}/download`)).statusCode).toBe(409)
  })

  it('only the CEO of the company decides; company B gets 404', async () => {
    expect((await call('mktA', 'POST', `/crm/exports/${reqId}/approve`, {})).statusCode).toBe(403)
    expect((await call('ceoB', 'POST', `/crm/exports/${reqId}/approve`, {})).statusCode).toBe(404)
    expect((await call('mktB', 'GET', `/crm/exports/${reqId}/download`)).statusCode).toBe(404)
    expect((await call('ceoB', 'GET', '/crm/exports?status=pending')).json().items.some((i: { id: string }) => i.id === reqId)).toBe(false)
    expect((await call('ceoA', 'GET', '/crm/exports?status=pending')).json().items.some((i: { id: string }) => i.id === reqId)).toBe(true)
  })

  it('approved: the requester downloads ONCE; a second download and someone else\'s fail', async () => {
    const ok = await call('ceoA', 'POST', `/crm/exports/${reqId}/approve`, {})
    expect(ok.statusCode, ok.body).toBe(200)
    expect((await call('mkt2A', 'GET', `/crm/exports/${reqId}/download`)).statusCode).toBe(403)
    const first = await call('mktA', 'GET', `/crm/exports/${reqId}/download?format=csv`)
    expect(first.statusCode, first.body).toBe(200)
    expect(first.body).toContain(`guest.a.${stamp}@wagexp.pk`)
    expect(first.body).not.toContain(`guest.b.${stamp}@wagexp.pk`)
    const second = await call('mktA', 'GET', `/crm/exports/${reqId}/download?format=csv`)
    expect(second.statusCode).toBe(409)
    expect(second.json().error.code).toBe('EXPORT_ALREADY_DOWNLOADED')
    const mine = (await call('mktA', 'GET', '/crm/exports')).json().items.find((i: { id: string }) => i.id === reqId)
    expect(mine).toMatchObject({ state: 'downloaded', canDownload: false, rowCount: 1 })
  })

  it('an approval expires after 24 hours', async () => {
    const r = await call('mktA', 'POST', '/crm/exports', { kind: 'customers', reason: 'Second copy for the agency' })
    const id = r.json().request.id
    expect((await call('ceoA', 'POST', `/crm/exports/${id}/approve`, {})).statusCode).toBe(200)
    await prisma.customerExportRequest.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 60_000) } })
    const d = await call('mktA', 'GET', `/crm/exports/${id}/download`)
    expect(d.statusCode).toBe(410)
    expect(d.json().error.code).toBe('EXPORT_EXPIRED')
  })

  it('a rejection needs a reason; the requester may withdraw a waiting ask', async () => {
    const a = (await call('mktA', 'POST', '/crm/exports', { kind: 'waitlist', reason: 'Launch list for the new brand' })).json().request.id
    expect((await call('ceoA', 'POST', `/crm/exports/${a}/reject`, { note: 'no' })).statusCode).toBe(400)
    expect((await call('ceoA', 'POST', `/crm/exports/${a}/reject`, { note: 'Use the campaign tool instead' })).statusCode).toBe(200)
    expect((await call('mktA', 'GET', `/crm/exports/${a}/download`)).statusCode).toBe(409)
    const b = (await call('mktA', 'POST', '/crm/exports', { kind: 'customers', reason: 'Spare copy for the archive' })).json().request.id
    expect((await call('mkt2A', 'POST', `/crm/exports/${b}/withdraw`, {})).statusCode).toBe(403)
    expect((await call('mktA', 'POST', `/crm/exports/${b}/withdraw`, {})).statusCode).toBe(200)
    expect((await call('ceoA', 'POST', `/crm/exports/${b}/approve`, {})).statusCode).toBe(409)
  })
})
