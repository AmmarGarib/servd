// The approvals inbox and the bell use ONE rule for the CEO (owner, 2026-11-14 — clean-up step 1, A2): an item is in
// the CEO's inbox (list AND counts) exactly when the bell's approverIdsFor names the CEO, and the reverse.
//   - lib/approvalRights.ts ceoMustSee decides both for the types where the CEO is only an override; it reads the
//     item's approvalSubject (the approve route's own facts), never the provider row — so a GRN finance check on a
//     PO finance raised itself (finance may verify it; owner 2026-11-11) is finance's in both, not the CEO's.
//   - HR steps: /hr/approvals lists a step for the CEO exactly when hrStepApprovers (the bell) names the CEO — an
//     HR-review step HR can take is HR's in both; a company with no HR / management login sends it to the CEO in both.
//   - every override type is non-delegable (the rule has no hand-over branch).
//   - two companies: company A's finance / HR never see company B's items.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { hrRoutes } = await import('../src/modules/hr/routes.js')
const { trustopsRoutes } = await import('../src/modules/trustops/routes.js')
const { procurementRoutes } = await import('../src/modules/procurement/routes.js')
const { registerApprovalsPlugin } = await import('../src/modules/approvals/index.js')
const { APPROVAL_RIGHTS, APPROVAL_TYPES, adminIsOverride, approverIdsFor } = await import('../src/lib/approvalRights.js')

const P = `a1r${Date.now()}`
let app: FastifyInstance
const T: Record<'A' | 'B', string> = { A: '', B: '' }
const U: Record<string, { id: string; name: string; email: string; role: string }> = {}

async function mkUser(key: string, role: string, tenants: string[]) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@a1r.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as never, tenantId: tenants[0] ?? null, isActive: true, accountStatus: 'active',
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name!, email: u.email!, role: u.role }
}
const headersOf = (key: string) => {
  const u = U[key]!
  return {
    authorization: `Bearer ${issueStaffSession({ id: u.id, name: u.name, email: u.email, role: u.role as never }).accessToken}`,
    'x-servd-portfolio': '1',
  }
}
type Inbox = { items: Array<{ type: string; id: string }>; types: Array<{ type: string; count: number }> }
async function inbox(key: string): Promise<Inbox> {
  const r = await app.inject({ method: 'GET', url: '/api/v1/approvals', headers: headersOf(key) })
  expect(r.statusCode, r.body).toBe(200)
  return r.json() as Inbox
}
const has = async (key: string, type: string, id: string) => (await inbox(key)).items.some((i) => i.type === type && i.id === id)
async function countOf(key: string, type: string): Promise<number> {
  const r = await app.inject({ method: 'GET', url: '/api/v1/approvals/counts', headers: headersOf(key) })
  expect(r.statusCode, r.body).toBe(200)
  return (r.json() as Inbox).types.find((t) => t.type === type)?.count ?? 0
}
const told = async (type: string, id: string) => (await approverIdsFor(type as never, id))?.userIds ?? []
/** The one-rule check: in the CEO's inbox ⇔ the bell names the CEO. */
async function sameForCeo(type: string, id: string): Promise<boolean> {
  const inInbox = await has('ceo', type, id)
  expect((await told(type, id)).includes(U.ceo!.id), `${type} ${id}: inbox ${inInbox}`).toBe(inInbox)
  return inInbox
}

let empA = ''
let empB = ''
let grnSeq = 0
async function mkGrn(tenantId: string, raisedBy: string) {
  grnSeq += 1
  const supplier = await prisma.supplier.create({ data: { name: `${P} supplier ${grnSeq}`, tenantId } })
  const po = await prisma.purchaseOrder.create({
    data: { supplierId: supplier.id, createdBy: U[raisedBy]!.id, buyerUserId: U[raisedBy]!.id, completedById: U[raisedBy]!.id, status: 'received', grnWorkflow: true } as never,
  })
  return prisma.goodsReceipt.create({
    data: { tenantId, supplierId: supplier.id, receivedById: U[raisedBy]!.id, poId: po.id, grnNumber: `GRN-${P.slice(-5)}${grnSeq}`, grnStatus: 'finance_review' } as never,
  })
}

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: `${P} A`, slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: `${P} B`, slug: `${P}-b` } })).id
  await mkUser('ceo', 'admin', [T.A, T.B])
  await mkUser('finA', 'finance', [T.A])
  await mkUser('hrA', 'hr', [T.A])
  await mkUser('hodA', 'foh_management', [T.A])
  await mkUser('hodB', 'foh_management', [T.B])
  await mkUser('staffA', 'cashier', [T.A])
  await mkUser('staffB', 'cashier', [T.B])
  const hodA = (await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-1`, fullName: 'Hod A', userId: U.hodA!.id } })).id
  empA = (await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-2`, fullName: 'Staff A', userId: U.staffA!.id, managerId: hodA } })).id
  const hodB = (await prisma.hrEmployee.create({ data: { tenantId: T.B, employeeCode: `${P}-3`, fullName: 'Hod B', userId: U.hodB!.id } })).id
  empB = (await prisma.hrEmployee.create({ data: { tenantId: T.B, employeeCode: `${P}-4`, fullName: 'Staff B', userId: U.staffB!.id, managerId: hodB } })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: (err as Error).message } })
  })
  await app.register(async (api) => {
    await api.register(hrRoutes, { prefix: '/hr' })
    await api.register(trustopsRoutes, { prefix: '/trustops' })
    await api.register(procurementRoutes, { prefix: '/procurement' })
    await registerApprovalsPlugin(api)
  }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  for (const t of [T.A, T.B]) await prisma.hrRecord.deleteMany({ where: { tenantId: t } }).catch(() => {})
  await app?.close()
})

describe('the CEO: one rule for the inbox and the bell', () => {
  it('every type where the CEO is only an override is non-delegable (the shared rule has no hand-over branch)', () => {
    const overrides = APPROVAL_TYPES.filter((t) => adminIsOverride(t))
    expect(overrides.length).toBeGreaterThan(0)
    for (const t of overrides) expect(APPROVAL_RIGHTS[t].delegable, t).toBe(false)
  })

  it('GRN finance check on a PO finance raised and bought: finance\'s in both, not the CEO\'s', async () => {
    const g = await mkGrn(T.A, 'finA')
    expect(await sameForCeo('grn_finance', g.id)).toBe(false)
    expect(await has('finA', 'grn_finance', g.id)).toBe(true)
    expect(await told('grn_finance', g.id)).toEqual([U.finA!.id])
  })

  it('stranded GRN check (company B has no finance login): the CEO\'s in both; A\'s finance never sees it', async () => {
    const g = await mkGrn(T.B, 'staffB')
    expect(await sameForCeo('grn_finance', g.id)).toBe(true)
    expect(await has('finA', 'grn_finance', g.id)).toBe(false)
  })

  it('cash voucher waiting for finance: finance\'s in both; stranded in B: the CEO\'s in both', async () => {
    let seq = 900
    const mk = (tenantId: string, by: string) => prisma.cashVoucher.create({
      data: { tenantId, seq: ++seq, number: `CV-${P.slice(-5)}${seq}`, voucherDate: new Date(), payeeName: 'Staff', purpose: 'Gas', amountCents: 10_000, preparedById: U[by]!.id, status: 'submitted' as never, submittedAt: new Date() },
    })
    expect(await sameForCeo('cash_request_finance', (await mk(T.A, 'staffA')).id)).toBe(false)
    expect(await sameForCeo('cash_request_finance', (await mk(T.B, 'staffB')).id)).toBe(true)
  })

  it('HR review step HR can take: HR\'s in both, not the CEO\'s (the inbox used to list it for the CEO)', async () => {
    const rec = await prisma.hrRecord.create({
      data: { tenantId: T.A, section: 'promotion', formVersion: 0, status: 'submitted', currentStep: 1, employeeId: empA, createdById: U.staffA!.id, approvals: [] },
    })
    expect(await sameForCeo('hr_request', rec.id)).toBe(false)
    expect(await has('hrA', 'hr_request', rec.id)).toBe(true)
    expect(await told('hr_request', rec.id)).toContain(U.hrA!.id)
  })

  it('HR review step in a company with no HR or management login: the CEO\'s in both; A\'s HR never sees it', async () => {
    const rec = await prisma.hrRecord.create({
      data: { tenantId: T.B, section: 'promotion', formVersion: 0, status: 'submitted', currentStep: 1, employeeId: empB, createdById: U.staffB!.id, approvals: [] },
    })
    expect(await sameForCeo('hr_request', rec.id)).toBe(true)
    expect(await has('hrA', 'hr_request', rec.id)).toBe(false)
  })

  it('the counts badge agrees with the list', async () => {
    const full = await inbox('ceo')
    for (const type of ['grn_finance', 'cash_request_finance', 'hr_request']) {
      expect(await countOf('ceo', type), type).toBe(full.items.filter((i) => i.type === type).length)
    }
  })
})
