// Head office D1/D3 — purchase-order and recipe approvals rewired (stream
// HO-B3a; spec §6.4, §7.3, §7.4 + amendments A3, A5, A6, A21).
//
// Real procurementRoutes / recipeRoutes behind the real auth middleware
// (requireAuth → attachStaffPrincipal: reach, the lens header, module access).
//
//   HO (head office) ── live link ──▶ A (company)          B (company, unlinked)
//
//   ceo       admin        member HO, A           the CEO
//   hodA      procurement  member HO only         reaches A (lens)
//   hodB      procurement  member HO only         teammate of hodA
//   deleg     procurement  member HO only         HO-wide Procurement hand-over
//   gmA       management   member A               company GM
//   buyerA    procurement  member A               company buyer
//   ceoB      admin        member B only          another company's admin
//   chefA     boh_management member A             company chef
//   ownerA    owner        member A               company owner
//   opsHod    fnb_manager  member HO only         reaches A (lens)
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { runWithRlsContext } from '../src/lib/rlsContext.js'
import { procurementRoutes } from '../src/modules/procurement/routes.js'
import { recipeRoutes } from '../src/modules/recipes/routes.js'
import { setApprovalThresholdCents } from '../src/modules/procurement/service.js'

const P = `hopr-${Date.now()}`
let app: FastifyInstance
let HO: string, A: string, B: string
let supA: string, supB: string, itemA: string, itemB: string, conceptA: string, catA: string
let delegationId: string
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

type Method = 'GET' | 'POST' | 'PUT'
function call(who: string, method: Method, url: string, opts: { lens?: string; payload?: unknown } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${U[who]!.token}` }
  if (opts.lens) headers['x-servd-active-tenant'] = opts.lens
  return app.inject({ method, url: `/api/v1${url}`, headers, ...(opts.payload !== undefined ? { payload: opts.payload as never } : {}) })
}

const poBody = (supplierId: string, inventoryItemId: string, unitCostCents = 1_000) =>
  ({ supplierId, lines: [{ inventoryItemId, quantityOrdered: 1, unitCostCents }] })

/** A draft PO raised by `who` (lens = through head office), then submitted. */
async function lensPo(who: string, submit = true): Promise<string> {
  const res = await call(who, 'POST', '/procurement/purchase-orders', { lens: A, payload: poBody(supA, itemA) })
  expect(res.statusCode, res.body).toBe(201)
  const id = res.json().id as string
  if (submit) {
    const s = await call(who, 'POST', `/procurement/purchase-orders/${id}/submit`, { lens: A })
    expect(s.statusCode, s.body).toBe(200)
  }
  return id
}

beforeAll(async () => {
  HO = await tenant('GS Head Office', 'head_office')
  A = await tenant('Company A', 'company')
  B = await tenant('Company B', 'company')
  await mkUser('ceo', 'admin', HO, [HO, A])
  await mkUser('hodA', 'procurement', HO, [HO])
  await mkUser('hodB', 'procurement', HO, [HO])
  await mkUser('deleg', 'procurement', HO, [HO])
  await mkUser('gmA', 'management', A, [A])
  await mkUser('buyerA', 'procurement', A, [A])
  await mkUser('ceoB', 'admin', B, [B])
  await mkUser('chefA', 'boh_management', A, [A])
  await mkUser('ownerA', 'owner', A, [A])
  await mkUser('opsHod', 'fnb_manager', HO, [HO])
  await prisma.headOfficeLink.create({ data: { tenantId: HO, companyTenantId: A, createdById: U.ceo!.id } })

  supA = (await prisma.supplier.create({ data: { name: `A Mills ${P}`, tenantId: A } })).id
  supB = (await prisma.supplier.create({ data: { name: `B Farms ${P}`, tenantId: B } })).id
  itemA = (await prisma.inventoryItem.create({ data: { name: `A Flour ${P}`, unit: 'kg', tenantId: A, category: 'dry', unitCostCents: 1_000 } })).id
  itemB = (await prisma.inventoryItem.create({ data: { name: `B Onion ${P}`, unit: 'kg', tenantId: B, category: 'dry', unitCostCents: 1_000 } })).id
  conceptA = (await prisma.concept.create({ data: { name: 'A Cafe', slug: `${P}-a-cafe`, type: 'restaurant', tenantId: A } })).id
  catA = (await prisma.category.create({ data: { conceptId: conceptA, name: 'Mains' } })).id
  // Threshold PKR 50,000: every PO below it would auto-approve for a member.
  await setApprovalThresholdCents(A, 5_000_000)
  await setApprovalThresholdCents(B, 5_000_000)
  delegationId = (await prisma.approvalDelegation.create({
    data: { tenantId: HO, section: 'procurement', delegateUserId: U.deleg!.id, grantedById: U.ceo!.id, note: 'HO-wide procurement' },
  })).id

  app = Fastify()
  app.addHook('onRequest', (_req, _reply, done) => { runWithRlsContext({}, () => done()) })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(async (api) => {
    await api.register(procurementRoutes, { prefix: '/procurement' })
    await api.register(recipeRoutes, { prefix: '/recipes' })
  }, { prefix: '/api/v1' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('purchase orders through head office', () => {
  it("an HOD's lens PO below the threshold goes to pending_approval, stamped, in A; only the CEO's queue lists it", async () => {
    const id = await lensPo('hodA')
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id }, include: { supplier: true } })
    expect(po.status).toBe('pending_approval')
    expect(po.viaHeadOfficeId).toBe(HO)
    expect(po.supplier.tenantId).toBe(A)   // the write carries A's company
    const log = await prisma.poActivityLog.findFirst({ where: { purchaseOrderId: id, action: 'submitted' } })
    expect(log?.details).toMatchObject({ needsApproval: true, viaHeadOfficeId: HO, forcedApproval: true })
    const audit = await prisma.auditLog.findFirst({ where: { entityId: id, action: 'po.submit' } })
    expect(audit?.tenantId).toBe(A)
    expect(audit?.metadata).toMatchObject({ viaHeadOfficeId: HO })

    const ceoQ = await call('ceo', 'GET', '/procurement/approvals', { lens: A })
    expect(ceoQ.statusCode).toBe(200)
    expect((ceoQ.json() as Array<{ id: string }>).map((r) => r.id)).toContain(id)
    // A company GM has no PO approval right at all: the old 403.
    expect((await call('gmA', 'GET', '/procurement/approvals')).statusCode).toBe(403)
  })

  it('a company member below the threshold still auto-approves (unchanged)', async () => {
    const res = await call('buyerA', 'POST', '/procurement/purchase-orders', { payload: poBody(supA, itemA) })
    expect(res.statusCode).toBe(201)
    const s = await call('buyerA', 'POST', `/procurement/purchase-orders/${res.json().id}/submit`)
    expect(s.json()).toMatchObject({ status: 'approved', needsApproval: false })
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: res.json().id } })
    expect(po.viaHeadOfficeId).toBeNull()
  })

  it('a company GM gets 403 on approve (the old role message)', async () => {
    const id = await lensPo('hodA')
    const res = await call('gmA', 'POST', `/procurement/purchase-orders/${id}/approve`)
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('FORBIDDEN')
  })

  it("through the lens: only your own PO can be submitted or cancelled; a lens approve → 403", async () => {
    const id = await lensPo('hodA', false)
    const s = await call('hodB', 'POST', `/procurement/purchase-orders/${id}/submit`, { lens: A })
    expect(s.statusCode).toBe(403)
    expect(s.json().error.code).toBe('HEAD_OFFICE_SUBMIT_ONLY')
    const c = await call('hodB', 'POST', `/procurement/purchase-orders/${id}/cancel`, { lens: A, payload: { reason: 'no' } })
    expect(c.statusCode).toBe(403)
    expect(c.json().error.code).toBe('HEAD_OFFICE_SUBMIT_ONLY')
    const own = await call('hodA', 'POST', `/procurement/purchase-orders/${id}/cancel`, { lens: A, payload: { reason: 'changed my mind' } })
    expect(own.statusCode, own.body).toBe(200)
    expect(own.json().status).toBe('cancelled')
  })

  it("an HO-wide Procurement delegate approves a teammate's PO (audit via delegation)", async () => {
    const id = await lensPo('hodA')
    const dq = await call('deleg', 'GET', '/procurement/approvals')
    expect(dq.statusCode).toBe(200)
    expect((dq.json() as Array<{ id: string }>).map((r) => r.id)).toContain(id)

    const res = await call('deleg', 'POST', `/procurement/purchase-orders/${id}/approve`)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().status).toBe('approved')
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id } })
    expect(po.approvedById).toBe(U.deleg!.id)
    const log = await prisma.poActivityLog.findFirst({ where: { purchaseOrderId: id, action: 'approved' } })
    expect(log?.details).toMatchObject({ via: 'delegation', delegationId })
    const audit = await prisma.auditLog.findFirst({ where: { entityId: id, action: 'approval.decide' } })
    expect(audit?.tenantId).toBe(A)
    expect(audit?.metadata).toMatchObject({ type: 'purchase_order', decision: 'approve', via: 'delegation', delegationId })

    // Claimed: a second decision on it is refused.
    const again = await call('ceo', 'POST', `/procurement/purchase-orders/${id}/approve`)
    expect(again.statusCode).toBe(400)
  })

  it("the delegate's own PO → 403 SELF_APPROVAL_BLOCKED and a self_approval flag; not in their queue; the CEO decides it", async () => {
    const id = await lensPo('deleg')
    const dq = await call('deleg', 'GET', '/procurement/approvals')
    expect((dq.json() as Array<{ id: string }>).map((r) => r.id)).not.toContain(id)
    const res = await call('deleg', 'POST', `/procurement/purchase-orders/${id}/approve`)
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('SELF_APPROVAL_BLOCKED')
    const flag = await prisma.exceptionFlag.findFirst({ where: { kind: 'self_approval', entityId: id, actorId: U.deleg!.id } })
    expect(flag).not.toBeNull()
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id } })).status).toBe('pending_approval')

    const rej = await call('ceo', 'POST', `/procurement/purchase-orders/${id}/reject`, { payload: { reason: 'too much' } })
    expect(rej.statusCode, rej.body).toBe(200)
    expect(rej.json().status).toBe('draft')
    const audit = await prisma.auditLog.findFirst({ where: { entityId: id, action: 'approval.decide' } })
    expect(audit?.metadata).toMatchObject({ decision: 'reject', via: 'role' })
  })

  it("company B's admin gets 404 on A's PO; the delegate gets 404 on B's PO (not covered)", async () => {
    const id = await lensPo('hodA')
    const res = await call('ceoB', 'POST', `/procurement/purchase-orders/${id}/approve`)
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('NOT_FOUND')

    const b = await call('ceoB', 'POST', '/procurement/purchase-orders', { payload: poBody(supB, itemB, 6_000_000) })
    expect(b.statusCode).toBe(201)
    expect((await call('ceoB', 'POST', `/procurement/purchase-orders/${b.json().id}/submit`)).json().status).toBe('pending_approval')
    expect((await call('deleg', 'POST', `/procurement/purchase-orders/${b.json().id}/approve`)).statusCode).toBe(404)
    expect((await call('deleg', 'GET', '/procurement/approvals')).json().map((r: { id: string }) => r.id)).not.toContain(b.json().id)
    // B's own admin: unchanged role path.
    expect((await call('ceoB', 'POST', `/procurement/purchase-orders/${b.json().id}/approve`)).statusCode).toBe(200)
  })

  it('a revoked hand-over stops at once (no right left → the old 403)', async () => {
    const id = await lensPo('hodA')
    await prisma.approvalDelegation.update({ where: { id: delegationId }, data: { revokedAt: new Date(), revokedById: U.ceo!.id, revokeReason: 'test' } })
    try {
      const res = await call('deleg', 'POST', `/procurement/purchase-orders/${id}/approve`)
      expect(res.statusCode).toBe(403)
      expect(res.json().error.code).toBe('FORBIDDEN')
    } finally {
      await prisma.approvalDelegation.update({ where: { id: delegationId }, data: { revokedAt: null, revokedById: null, revokeReason: null } })
    }
  })
})

describe('recipes through head office', () => {
  const newDish = (name: string) => ({
    kind: 'plate', newMenuItem: { conceptId: conceptA, categoryId: catA, name },
    ingredients: [{ inventoryItemId: itemA, quantity: 100, unit: 'g' }],
  })

  async function chefRecipe(): Promise<string> {
    const res = await call('chefA', 'POST', '/recipes', { payload: newDish(`Chef dish ${Math.random().toString(36).slice(2, 7)}`) })
    expect(res.statusCode, res.body).toBe(201)
    return res.json().id
  }

  it('POST /recipes records the creator', async () => {
    const id = await chefRecipe()
    expect((await prisma.recipe.findUniqueOrThrow({ where: { id } })).createdById).toBe(U.chefA!.id)
  })

  it("an HOD's lens edit (and test cook) of a company chef's recipe → 403", async () => {
    const id = await chefRecipe()
    const put = await call('opsHod', 'PUT', `/recipes/${id}`, { lens: A, payload: { notes: 'more salt' } })
    expect(put.statusCode).toBe(403)
    expect(put.json().error.code).toBe('HEAD_OFFICE_SUBMIT_ONLY')
    const t = await call('opsHod', 'POST', `/recipes/${id}/test-attempts`, { lens: A, payload: { notes: 'tasted' } })
    expect(t.statusCode).toBe(403)
    expect((await prisma.recipe.findUniqueOrThrow({ where: { id } })).editedByIds).toEqual([])
  })

  it('a lens create must bind to the lens company (422 otherwise)', async () => {
    const comp = await call('opsHod', 'POST', '/recipes', {
      lens: A,
      payload: { kind: 'component', name: 'HO sauce', yieldGrams: 500, ingredients: [{ inventoryItemId: itemB, quantity: 10, unit: 'g' }] },
    })
    expect([404, 422]).toContain(comp.statusCode)
    // A new dish of A's brand is fine.
    const ok = await call('opsHod', 'POST', '/recipes', { lens: A, payload: newDish('HO special') })
    expect(ok.statusCode, ok.body).toBe(201)
  })

  it('an HO-edited recipe goes to the CEO: the company owner is refused and does not see it; the CEO approves', async () => {
    const created = await call('opsHod', 'POST', '/recipes', { lens: A, payload: newDish(`HO dish ${P}`) })
    expect(created.statusCode, created.body).toBe(201)
    const id = created.json().id as string
    const put = await call('opsHod', 'PUT', `/recipes/${id}`, { lens: A, payload: { notes: 'v2' } })
    expect(put.statusCode, put.body).toBe(200)
    const t = await call('opsHod', 'POST', `/recipes/${id}/test-attempts`, { lens: A, payload: { notes: 'cooked it' } })
    expect(t.statusCode, t.body).toBe(201)
    // A company chef submits it (a member, not through head office).
    const sub = await call('chefA', 'POST', `/recipes/${id}/submit`)
    expect(sub.statusCode, sub.body).toBe(200)
    const row = await prisma.recipe.findUniqueOrThrow({ where: { id } })
    expect(row.createdById).toBe(U.opsHod!.id)
    expect(row.editedByIds).toEqual(expect.arrayContaining([U.opsHod!.id, U.chefA!.id]))

    const ownerQ = await call('ownerA', 'GET', '/recipes/pending-approval')
    expect(ownerQ.statusCode).toBe(200)
    expect((ownerQ.json() as Array<{ id: string }>).map((r) => r.id)).not.toContain(id)
    const ownerTry = await call('ownerA', 'POST', `/recipes/${id}/approve`)
    expect(ownerTry.statusCode).toBe(403)
    expect(ownerTry.json().error.code).toBe('APPROVAL_NOT_YOURS')

    const ceoQ = await call('ceo', 'GET', '/recipes/pending-approval', { lens: A })
    expect((ceoQ.json() as Array<{ id: string }>).map((r) => r.id)).toContain(id)
    const ok = await call('ceo', 'POST', `/recipes/${id}/approve`)
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().status).toBe('production')
    const item = await prisma.menuItem.findFirstOrThrow({ where: { name: `HO dish ${P}` }, include: { concept: true } })
    expect(item.concept.tenantId).toBe(A)   // the write lands in A
    const audit = await prisma.auditLog.findFirst({ where: { entityId: id, action: 'approval.decide' } })
    expect(audit?.tenantId).toBe(A)
    expect(audit?.metadata).toMatchObject({ type: 'recipe', decision: 'approve', via: 'role' })
  })

  it('a lens submit is stamped with the head office', async () => {
    const created = await call('opsHod', 'POST', '/recipes', { lens: A, payload: newDish(`HO submit ${P}`) })
    const id = created.json().id as string
    const sub = await call('opsHod', 'POST', `/recipes/${id}/submit`, { lens: A })
    expect(sub.statusCode, sub.body).toBe(200)
    const row = await prisma.recipe.findUniqueOrThrow({ where: { id } })
    expect(row.status).toBe('pending_approval')
    expect(row.viaHeadOfficeId).toBe(HO)
    expect(row.submittedById).toBe(U.opsHod!.id)
  })

  it("with no head office involved the company owner still approves a chef's recipe, and not their own", async () => {
    const id = await chefRecipe()
    expect((await call('chefA', 'POST', `/recipes/${id}/submit`)).statusCode).toBe(200)
    const q = await call('ownerA', 'GET', '/recipes/pending-approval')
    expect((q.json() as Array<{ id: string }>).map((r) => r.id)).toContain(id)
    const ok = await call('ownerA', 'POST', `/recipes/${id}/approve`)
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().status).toBe('production')

    const own = await call('ownerA', 'POST', '/recipes', { payload: newDish(`Owner dish ${P}`) })
    expect(own.statusCode).toBe(201)
    expect((await call('ownerA', 'POST', `/recipes/${own.json().id}/submit`)).statusCode).toBe(200)
    const self = await call('ownerA', 'POST', `/recipes/${own.json().id}/approve`)
    expect(self.statusCode).toBe(403)
    expect(self.json().error.code).toBe('SELF_APPROVAL_BLOCKED')
    expect(self.json().error.message).toContain('needs the CEO')
    // Company B's admin: 404.
    expect((await call('ceoB', 'POST', `/recipes/${own.json().id}/reject`, { payload: {} })).statusCode).toBe(404)
    // The CEO rejects it back to iteration.
    const rej = await call('ceo', 'POST', `/recipes/${own.json().id}/reject`, { payload: { reason: 'redo' } })
    expect(rej.statusCode, rej.body).toBe(200)
    expect(rej.json().status).toBe('iteration')
  })

  it("a pending sub-recipe with no company is the CEO's: not in the owner's queue (owner 403), in the CEO's", async () => {
    const comp = await prisma.recipe.create({
      data: { kind: 'component', name: `Orphan sauce ${P}`, yieldGrams: 500, status: 'pending_approval', submittedById: U.chefA!.id, submittedAt: new Date() },
    })
    const ownerQ = await call('ownerA', 'GET', '/recipes/pending-approval')
    expect(ownerQ.statusCode).toBe(200)
    expect((ownerQ.json() as Array<{ id: string }>).map((r) => r.id)).not.toContain(comp.id)
    expect((await call('ownerA', 'POST', `/recipes/${comp.id}/approve`)).statusCode).toBe(403)
    const ceoQ = await call('ceo', 'GET', '/recipes/pending-approval')
    expect(ceoQ.statusCode).toBe(200)
    expect((ceoQ.json() as Array<{ id: string }>).map((r) => r.id)).toContain(comp.id)
  })

  it('a chef (no approver role, no hand-over) gets the old 403 on approve and on the queue', async () => {
    const id = await chefRecipe()
    expect((await call('chefA', 'POST', `/recipes/${id}/approve`)).json().error.code).toBe('FORBIDDEN')
    expect((await call('chefA', 'GET', '/recipes/pending-approval')).statusCode).toBe(403)
  })
})
