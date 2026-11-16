// GET /approvals/decided — "what I decided" (owner, 2026-11-16).
//   - the caller's OWN approval.decide rows only, newest first, with the PO's number, company and status NOW;
//   - company B's CEO never sees company A's CEO's decisions (two companies);
//   - a document that moved to a company the caller is not in shows no document details.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { prisma, mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'
import { decidedRoutes } from '../src/modules/approvals/decided.js'

let app: FastifyInstance
let A: Company, B: Company, ceoA: Who, ceoB: Who
let poA: string, poB: string
const stamp = Date.now()
const get = (who: Who) => app.inject({ method: 'GET', url: '/approvals/decided', headers: { authorization: `Bearer ${who.token}` } })

beforeAll(async () => {
  A = await mkCompany(`dec-a-${stamp}`); B = await mkCompany(`dec-b-${stamp}`)
  ceoA = await mkUser('dec-ceo-a', 'admin', A.tenantId); ceoB = await mkUser('dec-ceo-b', 'admin', B.tenantId)
  const supA = await prisma.supplier.create({ data: { tenantId: A.tenantId, name: `Sup A ${stamp}` } })
  const supB = await prisma.supplier.create({ data: { tenantId: B.tenantId, name: `Sup B ${stamp}` } })
  poA = (await prisma.purchaseOrder.create({ data: { supplierId: supA.id, reference: 'PO-00042', status: 'approved', totalCents: 123_400 } })).id
  poB = (await prisma.purchaseOrder.create({ data: { supplierId: supB.id, reference: 'PO-00007', status: 'approved', totalCents: 5_000 } })).id
  const row = (userId: string, tenantId: string, entityId: string, decision: string) => prisma.auditLog.create({
    data: { category: 'accounting', action: 'approval.decide', entity: 'PurchaseOrder', entityId, userId, tenantId, metadata: { type: 'purchase_order', decision } },
  })
  await row(ceoA.id, A.tenantId, poA, 'approve')
  await row(ceoB.id, B.tenantId, poB, 'approve')
  // A decision by A's CEO whose PO sits in company B (not a member): the row shows, the document does not.
  await row(ceoA.id, A.tenantId, poB, 'reject')
  app = Fastify()
  await app.register(decidedRoutes, { prefix: '/approvals' })
  await app.ready()
}, 60_000)
afterAll(async () => { await app?.close() })

describe('GET /approvals/decided', () => {
  it("lists the caller's own decisions with the PO's number, company and status now", async () => {
    const rows = (await get(ceoA)).json() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(2)
    const mine = rows.find((r) => r.entityId === poA)!
    expect(mine).toMatchObject({ type: 'purchase_order', typeLabel: 'Purchase orders', decision: 'approve', statusNow: 'approved', amountCents: 123_400, tenantId: A.tenantId })
    expect(String(mine.title)).toContain('PO-00042')
    expect(mine.company).toBeTruthy()
  })
  it("never another company's decisions or documents", async () => {
    const a = (await get(ceoA)).json() as Array<Record<string, unknown>>
    expect(JSON.stringify(a)).not.toContain('PO-00007')
    expect(a.find((r) => r.decision === 'reject')).toMatchObject({ entityId: null, title: null, amountCents: null })
    const b = (await get(ceoB)).json() as Array<Record<string, unknown>>
    expect(b).toHaveLength(1)
    expect(b[0]).toMatchObject({ entityId: poB, tenantId: B.tenantId })
    expect(JSON.stringify(b)).not.toContain('PO-00042')
  })
  it('needs a staff session', async () => {
    expect((await app.inject({ method: 'GET', url: '/approvals/decided' })).statusCode).toBe(401)
  })
})
