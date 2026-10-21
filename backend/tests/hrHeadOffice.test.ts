// Head office D1/D3 — HR through head office (stream HO-C1; spec §5, §6.4,
// §7.4.3 + amendments A3, A5, A6, A14, A16, A19, A20).
//
// Real hrRoutes behind the real auth middleware (requireAuth →
// attachStaffPrincipal: reach, the lens header, module access).
//
//   HO (head office) ── live link ──▶ A (company)          B (company, unlinked)
//
//   ceo      admin        member HO, A        the CEO
//   hoHr     hr           member HO only      reaches A (lens): prepares, proposes
//   hoHr2    hr           member HO only      HO HR reviewer (non-final steps)
//   hoMgr    management   member HO only      reaches A, no hand-over; on HO's payroll
//   deleg    hr           member HO only      HO-wide HR hand-over
//   deleg2   hr           member HO only      HO-wide HR hand-over, on A's payroll
//   hrA      hr           member A            company HR
//   gmA      management   member A            company GM, on A's payroll
//   mgmtB    management   member B            another company
//   hrB      hr           member B            another company
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { runWithRlsContext } from '../src/lib/rlsContext.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { hrRoutes } from '../src/modules/hr/routes.js'
import { transferTargetsOutsideCompany } from '../src/modules/hr/forms.js'

const P = `hrho-${Date.now()}`
const RS = (r: number) => r * 100
let app: FastifyInstance
let HO: string, A: string, B: string
let empA1: string, empA2: string, empB1: string, deptB: string
const U: Record<string, { id: string; token: string }> = {}

async function tenant(name: string, kind: 'company' | 'head_office') {
  return (await prisma.tenant.create({ data: { name, slug: `${P}-${name.toLowerCase().replace(/\W+/g, '-')}`, kind } })).id
}
async function mkUser(key: string, role: UserRole, primary: string, members: string[]) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${P}@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role, isActive: true, accountStatus: 'active', tenantId: primary },
  })
  for (const t of members) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  U[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
let codeN = 0
async function mkEmployee(tenantId: string, name: string, userId: string | null = null) {
  return (await prisma.hrEmployee.create({
    data: {
      tenantId, employeeCode: `E${++codeN}-${P}`, fullName: name, grossSalaryCents: RS(60_000), basicSalaryCents: RS(40_000),
      joiningDate: new Date('2025-01-01'), status: 'active', userId,
    },
  })).id
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE'
function call(who: string, method: Method, url: string, opts: { lens?: string; payload?: unknown } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${U[who]!.token}` }
  if (opts.lens) headers['x-servd-active-tenant'] = opts.lens
  return app.inject({ method, url: `/api/v1/hr${url}`, headers, ...(opts.payload !== undefined ? { payload: opts.payload as never } : {}) })
}
const code = (r: { json: () => unknown }) => (r.json() as { error?: { code?: string } }).error?.code

const revision = (employee: string) => ({ data: { employee, revisedGross: RS(70_000), effectiveDate: '2027-01-01', reason: 'review' } })

/** A salary revision ([HR, MGMT]) raised in A by `who` (an HR `who` signs the HR step by raising). */
async function raise(who: string, lens?: string): Promise<string> {
  const r = await call(who, 'POST', '/records/salary_revision', { lens, payload: revision(empA1) })
  expect(r.statusCode, r.body).toBe(201)
  return r.json().id as string
}

beforeAll(async () => {
  HO = await tenant('GS Head Office', 'head_office')
  A = await tenant('Company A', 'company')
  B = await tenant('Company B', 'company')
  await mkUser('ceo', 'admin', HO, [HO, A])
  await mkUser('hoHr', 'hr', HO, [HO])
  await mkUser('hoHr2', 'hr', HO, [HO])
  await mkUser('hoMgr', 'management', HO, [HO])
  await mkUser('deleg', 'hr', HO, [HO])
  await mkUser('deleg2', 'hr', HO, [HO])
  await mkUser('hrA', 'hr', A, [A])
  // Raises requests whose HR step must still WAIT: a request raised by an HR login signs its own
  // (non-final) HR step by raising (owner, 2026-10-21), so these tests raise as a non-HR login.
  await mkUser('raiserA', 'management', A, [A])
  await mkUser('gmA', 'management', A, [A])
  await mkUser('mgmtB', 'management', B, [B])
  await mkUser('hrB', 'hr', B, [B])
  await prisma.headOfficeLink.create({ data: { tenantId: HO, companyTenantId: A, createdById: U.ceo!.id } })
  for (const d of ['deleg', 'deleg2']) {
    await prisma.approvalDelegation.create({ data: { tenantId: HO, section: 'hr', delegateUserId: U[d]!.id, grantedById: U.ceo!.id, note: 'HO-wide HR' } })
  }
  empA1 = await mkEmployee(A, 'Ayesha Cook')
  empA2 = await mkEmployee(A, 'Gm Ahmed', U.gmA!.id)
  await mkEmployee(A, 'Deleg Two', U.deleg2!.id)
  await mkEmployee(HO, 'Head Office Manager', U.hoMgr!.id)
  empB1 = await mkEmployee(B, 'Bilal B')
  deptB = (await prisma.department.create({ data: { tenantId: B, name: `B Kitchen ${P}` } })).id
  void empA2

  app = Fastify()
  app.addHook('onRequest', (_req, _reply, done) => { runWithRlsContext({}, () => done()) })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(async (api) => {
    await api.register(hrRoutes, { prefix: '/hr' })
  }, { prefix: '/api/v1' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('HR records through the head-office lens', () => {
  it('a section with approval steps → 201 in A, stamped; a section with none → 403', async () => {
    const id = await raise('hoHr', A)
    const rec = await prisma.hrRecord.findUniqueOrThrow({ where: { id } })
    expect(rec.tenantId).toBe(A)
    expect(rec.viaHeadOfficeId).toBe(HO)
    expect(rec.status).toBe('submitted')
    const audit = await prisma.auditLog.findFirst({ where: { entityId: id, action: 'hr.salary_revision.create' } })
    expect(audit?.tenantId).toBe(A)
    expect(audit?.metadata).toMatchObject({ viaHeadOfficeId: HO })

    const none = await call('hoHr', 'POST', '/records/training', { lens: A, payload: { data: { program: 'Food safety', date: '2026-11-01' } } })
    expect(none.statusCode).toBe(403)
    expect(code(none)).toBe('HEAD_OFFICE_SUBMIT_ONLY')
    // A member of A still records training directly (unchanged).
    const direct = await call('hrA', 'POST', '/records/training', { payload: { data: { program: 'Food safety', date: '2026-11-01' } } })
    expect(direct.statusCode, direct.body).toBe(201)
    expect(direct.json().viaHeadOfficeId).toBeNull()
  })

  it('PATCH / submit / cancel only on your own record nobody has acted on', async () => {
    const mine = await call('hoHr', 'POST', '/records/salary_revision', { lens: A, payload: { ...revision(empA1), submit: false } })
    expect(mine.statusCode, mine.body).toBe(201)
    const id = mine.json().id as string
    expect((await call('hoHr', 'PATCH', `/records/salary_revision/${id}`, { lens: A, payload: { data: { reason: 'annual' } } })).statusCode).toBe(200)
    expect((await call('hoHr', 'POST', `/records/salary_revision/${id}/submit`, { lens: A })).statusCode).toBe(200)

    // hrA's record: not the HOD's to touch through the lens.
    const theirs = await raise('hrA')
    const patch = await call('hoHr', 'PATCH', `/records/salary_revision/${theirs}`, { lens: A, payload: { data: { reason: 'x' } } })
    expect(patch.statusCode).toBe(403)
    expect(code(patch)).toBe('HEAD_OFFICE_SUBMIT_ONLY')
    expect(code(await call('hoHr', 'POST', `/records/salary_revision/${theirs}/cancel`, { lens: A }))).toBe('HEAD_OFFICE_SUBMIT_ONLY')

    // Own, but acted on: a person other than the raiser has decided it — no more cancelling.
    // (hoHr is an HR login, so raising signed the HR step automatically; the CEO takes the last step.)
    expect((await prisma.hrRecord.findUniqueOrThrow({ where: { id } })).currentStep).toBe(1)
    expect((await call('ceo', 'POST', `/records/salary_revision/${id}/decide`, { payload: { decision: 'approved' } })).statusCode).toBe(200)
    expect(code(await call('hoHr', 'POST', `/records/salary_revision/${id}/cancel`, { lens: A }))).toBe('HEAD_OFFICE_SUBMIT_ONLY')

    // Own and untouched: cancel works.
    const fresh = await raise('hoHr', A)
    expect((await call('hoHr', 'POST', `/records/salary_revision/${fresh}/cancel`, { lens: A })).statusCode).toBe(200)
  })

  it('create-employee through the lens only from your own approved offer (A6)', async () => {
    const offer = (createdById: string) => prisma.hrRecord.create({
      data: {
        tenantId: A, section: 'offer', formVersion: 1, status: 'approved', amountCents: RS(50_000), startDate: new Date('2026-12-01'), createdById,
        data: { candidateName: 'New Hire', salaryOffered: RS(50_000), joiningDate: '2026-12-01', acceptance: 'accepted' },
      },
    })
    const theirs = await offer(U.hrA!.id)
    const refused = await call('hoHr', 'POST', `/records/offer/${theirs.id}/create-employee`, { lens: A })
    expect(refused.statusCode).toBe(403)
    expect(code(refused)).toBe('HEAD_OFFICE_SUBMIT_ONLY')
    const mine = await offer(U.hoHr!.id)
    const ok = await call('hoHr', 'POST', `/records/offer/${mine.id}/create-employee`, { lens: A })
    expect(ok.statusCode, ok.body).toBe(201)
    expect(ok.json().tenantId).toBe(A)
    expect((await prisma.hrRecord.findUniqueOrThrow({ where: { id: mine.id } })).viaHeadOfficeId).toBe(HO)
  })

  it('the lens never writes outside the proposal routes, and B sees nothing of A', async () => {
    const id = await raise('hrA')
    // B's people: not found, whatever they try.
    expect((await call('mgmtB', 'POST', `/records/salary_revision/${id}/decide`, { payload: { decision: 'approved' } })).statusCode).toBe(404)
    expect((await call('hrB', 'POST', `/records/salary_revision/${id}/decide`, { payload: { decision: 'rejected' } })).statusCode).toBe(404)
    expect((await call('hrB', 'PATCH', `/records/salary_revision/${id}`, { payload: { data: { reason: 'x' } } })).statusCode).toBe(404)
    expect((await call('hrB', 'GET', `/records/salary_revision/${id}`)).statusCode).toBe(404)
    // B cannot borrow A's company through the header either.
    const hdr = await call('hrB', 'POST', '/records/salary_revision', { lens: A, payload: revision(empA1) })
    expect(hdr.statusCode).not.toBe(201)
    expect(await prisma.hrRecord.count({ where: { tenantId: A, createdById: U.hrB!.id } })).toBe(0)
  })
})

describe('decideRight: who decides a step (§7.4.3, A20)', () => {
  it('HO HR approves a non-final HR step of a company request, but cannot reject it', async () => {
    const one = await raise('raiserA')
    const rej = await call('hoHr2', 'POST', `/records/salary_revision/${one}/decide`, { payload: { decision: 'rejected' } })
    expect(rej.statusCode).toBe(403)
    expect(code(rej)).toBe('FINAL_STEP_NEEDS_HANDOVER')
    const ok = await call('hoHr2', 'POST', `/records/salary_revision/${one}/decide`, { payload: { decision: 'approved' } })
    expect(ok.statusCode, ok.body).toBe(200)
    const rec = await prisma.hrRecord.findUniqueOrThrow({ where: { id: one } })
    expect(rec.currentStep).toBe(1)
    expect(rec.tenantId).toBe(A)
    // approval.decide in A's trail (A19), never the head office's.
    const a = await prisma.auditLog.findFirst({ where: { entityId: one, action: 'approval.decide' } })
    expect(a?.tenantId).toBe(A)
    expect(a?.metadata).toMatchObject({ type: 'hr_request', decision: 'approve', path: 'reach' })
  })

  it('the final step → 403 without a hand-over, passes with one', async () => {
    const id = await raise('raiserA')
    expect((await call('raiserA', 'POST', `/records/salary_revision/${id}/decide`, { payload: { decision: 'approved' } })).statusCode).toBe(403) // raised it
    expect((await call('hoHr2', 'POST', `/records/salary_revision/${id}/decide`, { payload: { decision: 'approved' } })).statusCode).toBe(200)
    // Final (management) step: a reached HO manager with no hand-over.
    const no = await call('hoMgr', 'POST', `/records/salary_revision/${id}/decide`, { payload: { decision: 'approved' } })
    expect(no.statusCode).toBe(403)
    expect(code(no)).toBe('FINAL_STEP_NEEDS_HANDOVER')
    // The HR hand-over's delegate takes it.
    const yes = await call('deleg', 'POST', `/records/salary_revision/${id}/decide`, { payload: { decision: 'approved' } })
    expect(yes.statusCode, yes.body).toBe(200)
    expect(yes.json().status).toBe('approved')
    const d = await prisma.approvalDelegation.findFirstOrThrow({ where: { delegateUserId: U.deleg!.id } })
    const a = await prisma.auditLog.findFirst({ where: { entityId: id, action: 'approval.decide', userId: U.deleg!.id } })
    expect(a?.tenantId).toBe(A)
    expect(a?.metadata).toMatchObject({ via: 'delegation', delegationId: d.id })
    // Nothing landed in the head office's books or trail for it.
    expect(await prisma.auditLog.count({ where: { entityId: id, tenantId: HO } })).toBe(0)
  })

  it('a delegate may reject at any step', async () => {
    const id = await raise('raiserA')
    const r = await call('deleg', 'POST', `/records/salary_revision/${id}/decide`, { payload: { decision: 'rejected', note: 'not now' } })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().status).toBe('rejected')
  })

  it("a request that came through head office: the company GM can't give the final sign-off; the CEO can", async () => {
    // Raised through head office by a non-HR login (an HR raiser would have signed the HR step already).
    const id = await raise('hoMgr', A)
    expect((await prisma.hrRecord.findUniqueOrThrow({ where: { id } })).viaHeadOfficeId).toBe(HO)
    // A's own HR may still do the (non-final) HR review.
    expect((await call('hrA', 'POST', `/records/salary_revision/${id}/decide`, { payload: { decision: 'approved' } })).statusCode).toBe(200)
    const gm = await call('gmA', 'POST', `/records/salary_revision/${id}/decide`, { payload: { decision: 'approved' } })
    expect(gm.statusCode).toBe(403)
    expect(code(gm)).toBe('APPROVAL_NOT_YOURS')
    expect((await call('ceo', 'POST', `/records/salary_revision/${id}/decide`, { payload: { decision: 'approved' } })).statusCode).toBe(200)
  })

  it("a company GM still gives the final sign-off on their own staff's requests (unchanged)", async () => {
    const id = await raise('raiserA')
    expect((await call('hoHr2', 'POST', `/records/salary_revision/${id}/decide`, { payload: { decision: 'approved' } })).statusCode).toBe(200)
    const gm = await call('gmA', 'POST', `/records/salary_revision/${id}/decide`, { payload: { decision: 'approved' } })
    expect(gm.statusCode, gm.body).toBe(200)
    expect(gm.json().status).toBe('approved')
    // §7.8: a plain member decision writes approval.decide too, in A.
    const a = await prisma.auditLog.findFirst({ where: { entityId: id, action: 'approval.decide', userId: U.gmA!.id } })
    expect(a?.tenantId).toBe(A)
    expect(a?.metadata).toMatchObject({ type: 'hr_request', decision: 'approve', via: 'role', path: 'member' })
  })

  it('an unstamped request raised by a head-office member: a member decision still writes approval.decide in its company', async () => {
    // hoMgr is employed by HO; his own request is raised in HO (unstamped).
    const r = await call('hoMgr', 'POST', '/records/salary_revision', { payload: revision(await prisma.hrEmployee.findFirstOrThrow({ where: { userId: U.hoMgr!.id } }).then((e) => e.id)) })
    expect(r.statusCode, r.body).toBe(201)
    const id = r.json().id as string
    const rec = await prisma.hrRecord.findUniqueOrThrow({ where: { id } })
    expect(rec.viaHeadOfficeId ?? null).toBeNull()
    const ok = await call('hoHr2', 'POST', `/records/salary_revision/${id}/decide`, { payload: { decision: 'approved' } })
    expect(ok.statusCode, ok.body).toBe(200)
    const a = await prisma.auditLog.findFirst({ where: { entityId: id, action: 'approval.decide', userId: U.hoHr2!.id } })
    expect(a?.tenantId).toBe(rec.tenantId)
    expect(a?.metadata).toMatchObject({ via: 'role', path: 'member' })
  })

  it('GET /hr/approvals agrees: reach lists non-final HR steps, a delegate lists final steps', async () => {
    const atHr = await raise('raiserA')
    const atFinal = await raise('raiserA')
    expect((await call('hoHr2', 'POST', `/records/salary_revision/${atFinal}/decide`, { payload: { decision: 'approved' } })).statusCode).toBe(200)
    const ids = async (who: string) => ((await call(who, 'GET', '/approvals')).json() as Array<{ id: string }>).map((r) => r.id)
    const hoHr = await ids('hoHr')
    expect(hoHr).toContain(atHr)
    expect(hoHr).not.toContain(atFinal)
    const deleg = await ids('deleg')
    expect(deleg).toContain(atFinal)
    const mgr = await ids('hoMgr')
    expect(mgr).not.toContain(atFinal)      // final step: no hand-over
    expect(mgr).toContain(atHr)             // HR_APPROVERS may forward an HR step (canActOnStep, unchanged)
    // B's management: nothing of A.
    const b = await ids('mgmtB')
    expect(b).not.toContain(atHr)
    expect(b).not.toContain(atFinal)
  })
})

describe('A16: transfers stay inside one company', () => {
  it('refuses a department or manager of another company', async () => {
    expect(await transferTargetsOutsideCompany(prisma, A, { newDepartment: deptB, newManager: empB1 })).toEqual([
      { key: 'newDepartment', label: 'New department' }, { key: 'newManager', label: 'New manager' },
    ])
    expect(await transferTargetsOutsideCompany(prisma, B, { newDepartment: deptB, newManager: empB1 })).toEqual([])
    // A stored transfer (say, from before the check) cannot be approved into B.
    const rec = await prisma.hrRecord.create({
      data: {
        tenantId: A, section: 'transfer', formVersion: 1, status: 'submitted', currentStep: 1, employeeId: empA1, effectiveDate: new Date('2026-12-01'),
        createdById: U.hrA!.id, data: { employee: empA1, newDepartment: deptB, effectiveDate: '2026-12-01' },
      },
    })
    const r = await call('ceo', 'POST', `/records/transfer/${rec.id}/decide`, { payload: { decision: 'approved' } })
    expect(r.statusCode).toBe(422)
    expect(code(r)).toBe('TRANSFER_OTHER_COMPANY')
    // Raising one with B's manager is refused at save.
    const save = await call('hrA', 'POST', '/records/transfer', { payload: { data: { employee: empA1, newManager: empB1, effectiveDate: '2026-12-01' } } })
    expect(save.statusCode).toBe(422)
  })
})

describe('payroll through head office', () => {
  it('prepared in A through the lens; the preparer, company management and an own-pay delegate cannot approve it; a delegate can', async () => {
    const created = await call('hoHr', 'POST', '/payroll/runs', { lens: A, payload: { period: '2026-07' } })
    expect(created.statusCode, created.body).toBe(201)
    const run = created.json() as { id: string; tenantId: string; viaHeadOfficeId: string }
    expect(run.tenantId).toBe(A)
    expect(run.viaHeadOfficeId).toBe(HO)
    // A second run for the month: the company's own stays the company's.
    expect((await call('hoHr', 'POST', '/payroll/runs', { lens: A, payload: { period: '2026-07' } })).statusCode).toBe(409)
    expect((await call('hoHr', 'POST', `/payroll/runs/${run.id}/recalculate`, { lens: A })).statusCode).toBe(200)

    expect((await call('hoHr', 'POST', `/payroll/runs/${run.id}/approve`)).statusCode).toBe(403)        // the preparer
    const gm = await call('gmA', 'POST', `/payroll/runs/${run.id}/approve`)
    expect(gm.statusCode).toBe(403)                                                                       // came through HO
    expect(code(gm)).toBe('APPROVAL_NOT_YOURS')
    const own = await call('deleg2', 'POST', `/payroll/runs/${run.id}/approve`)
    expect(own.statusCode).toBe(403)
    expect(code(own)).toBe('OWN_PAY_IN_RUN')
    expect((await call('mgmtB', 'POST', `/payroll/runs/${run.id}/approve`)).statusCode).toBe(404)
    const ok = await call('deleg', 'POST', `/payroll/runs/${run.id}/approve`)
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().status).toBe('approved')
    const a = await prisma.auditLog.findFirst({ where: { entityId: run.id, action: 'approval.decide' } })
    expect(a?.tenantId).toBe(A)
    expect(a?.metadata).toMatchObject({ type: 'payroll_run', via: 'delegation' })

    // Approved: no more preparation through the lens.
    const late = await call('hoHr', 'POST', `/payroll/runs/${run.id}/recalculate`, { lens: A })
    expect(late.statusCode).toBe(403)
    expect(code(late)).toBe('HEAD_OFFICE_SUBMIT_ONLY')
    // Reopen through the hand-over too; /paid keeps the role path only.
    expect((await call('deleg', 'POST', `/payroll/runs/${run.id}/reopen`)).statusCode).toBe(200)
    expect((await call('deleg', 'POST', `/payroll/runs/${run.id}/paid`, { payload: {} })).statusCode).toBe(403)
  })

  it('DELETE through the lens only a run you alone prepared', async () => {
    const theirs = (await call('hrA', 'POST', '/payroll/runs', { payload: { period: '2026-08' } })).json() as { id: string }
    const refused = await call('hoHr', 'DELETE', `/payroll/runs/${theirs.id}`, { lens: A })
    expect(refused.statusCode).toBe(403)
    expect(code(refused)).toBe('HEAD_OFFICE_SUBMIT_ONLY')
    const mine = (await call('hoHr', 'POST', '/payroll/runs', { lens: A, payload: { period: '2026-09' } })).json() as { id: string }
    expect((await call('hoHr', 'DELETE', `/payroll/runs/${mine.id}`, { lens: A })).statusCode).toBe(204)
  })

  it("OWN_PAY_IN_RUN does not touch a company GM approving their company's own run", async () => {
    const run = (await call('hrA', 'POST', '/payroll/runs', { payload: { period: '2026-10' } })).json() as { id: string }
    expect(await prisma.hrPayslip.count({ where: { runId: run.id, employee: { userId: U.gmA!.id } } })).toBe(1)
    const ok = await call('gmA', 'POST', `/payroll/runs/${run.id}/approve`)
    expect(ok.statusCode, ok.body).toBe(200)
    // §7.8: every payroll decision writes approval.decide, in the run's company.
    const a = await prisma.auditLog.findFirst({ where: { entityId: run.id, action: 'approval.decide', userId: U.gmA!.id } })
    expect(a?.tenantId).toBe(A)
    expect(a?.metadata).toMatchObject({ type: 'payroll_run', via: 'role' })
  })

  it("the head office's own payroll goes to the CEO, and posts to the head office's books", async () => {
    await ensureChartOfAccounts(HO)
    const run = (await call('hoHr', 'POST', '/payroll/runs', { payload: { period: '2026-07' } })).json() as { id: string; tenantId: string }
    expect(run.tenantId).toBe(HO)
    const own = await call('hoMgr', 'POST', `/payroll/runs/${run.id}/approve`)
    expect(own.statusCode).toBe(403)
    expect(code(own)).toBe('OWN_PAY_IN_RUN')
    expect((await call('ceo', 'POST', `/payroll/runs/${run.id}/approve`)).statusCode).toBe(200)
    const locked = await call('ceo', 'POST', `/payroll/runs/${run.id}/lock`)
    expect(locked.statusCode, locked.body).toBe(200)
    const je = await prisma.journalEntry.findMany({ where: { reference: { contains: run.id } } })
    expect(je.length).toBeGreaterThan(0)
    expect(je.every((e) => e.tenantId === HO)).toBe(true)
  })
})

describe('Department.isHeadOffice retires with the head-office setup', () => {
  it('is kept before the setup marker and ignored after it', async () => {
    const before = await call('hrA', 'POST', '/org/departments', { payload: { name: `Office ${P}`, isHeadOffice: true } })
    expect(before.statusCode, before.body).toBe(201)
    expect(before.json().isHeadOffice).toBe(true)
    const orgBefore = (await call('hrA', 'GET', '/org')).json() as { departments: Array<Record<string, unknown>> }
    expect(orgBefore.departments.find((d) => d['id'] === before.json().id)?.['isHeadOffice']).toBe(true)

    await prisma.headOfficeBooks.create({ data: { tenantId: HO, setupAppliedAt: new Date(), setupAppliedById: U.ceo!.id } })

    const after = await call('hrA', 'POST', '/org/departments', { payload: { name: `Office 2 ${P}`, isHeadOffice: true } })
    expect(after.statusCode, after.body).toBe(201)
    expect('isHeadOffice' in after.json()).toBe(false)
    expect((await prisma.department.findUniqueOrThrow({ where: { id: after.json().id } })).isHeadOffice).toBe(false)
    const patched = await call('hrA', 'PATCH', `/org/departments/${before.json().id}`, { payload: { isHeadOffice: false, order: 3 } })
    expect(patched.statusCode).toBe(200)
    expect('isHeadOffice' in patched.json()).toBe(false)
    expect((await prisma.department.findUniqueOrThrow({ where: { id: before.json().id } })).isHeadOffice).toBe(true) // ignored, not written
    const org = (await call('hrA', 'GET', '/org')).json() as { departments: Array<Record<string, unknown>> }
    expect(org.departments.every((d) => !('isHeadOffice' in d))).toBe(true)
  })
})
