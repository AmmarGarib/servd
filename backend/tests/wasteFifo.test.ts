// Waste on FIFO lots (finance wave B) — POST /inventory/:id/waste.
//
// What this guards:
//   - The quantity leaves the lots oldest first; WasteLog.estimatedCostCents
//     is that FIFO value and the log carries the item's company, the brand
//     and the outlet; 'inventory.waste:<id>' posts Dr 5040 / Cr the class
//     inventory (1230 for packaging), tagged with the brand.
//   - More than on hand is 422 NEGATIVE_STOCK and nothing is written; the
//     photo rule reads the FIFO value.
//   - A refused posting leaves the waste standing and flags it (documentDate).
//   - Two companies: B gets 404 on A's item; a brand of another company than
//     the item's is 422 BRAND_NOT_IN_COMPANY (a brand outside the active
//     company 404); another company's outlet is 422 LOCATION_NOT_IN_COMPANY.
//   - Staff log only the staff reasons; company-less items are refused.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { addLotTx, ensureFifoReady } from '../src/lib/stockLedger.js'
import { receiveGoods } from '../src/modules/procurement/receiving.js'
import { inventoryRoutes } from '../src/modules/inventory/routes.js'
import { mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'

const DAY = 86_400_000
const PHOTO = 'https://example.com/waste.jpg'
let app: FastifyInstance
let A: Company
let B: Company
const u: Record<string, Who> = {}
let seq = 0

const call = (who: Who, method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { authorization: `Bearer ${who.token}`, ...headers } })

async function item(co: Company, o: { qty?: number; cost?: number; category?: string } = {}) {
  await ensureFifoReady(co.tenantId)
  const it = await prisma.inventoryItem.create({ data: { name: `Waste item ${++seq}`, unit: 'kg', tenantId: co.tenantId, unitCostCents: o.cost ?? 10_000, category: o.category ?? 'protein' } })
  if (o.qty) {
    await prisma.$transaction((tx) => addLotTx(tx, {
      tenantId: co.tenantId, inventoryItemId: it.id, qty: o.qty!, unitCostCents: o.cost ?? 10_000, kind: 'fifo_cutover', lotSourceType: 'fifo_cutover',
      lotSourceId: `seed:${it.id}`, movementSourceType: 'test.seed', movementSourceId: it.id, receivedAt: new Date(Date.now() - 3 * DAY),
    }))
  }
  return it
}

async function entryLines(tenantId: string, reference: string) {
  const e = await prisma.journalEntry.findFirst({ where: { tenantId, reference }, include: { lines: { include: { account: { select: { code: true } } } } } })
  return e ? e.lines.map((l) => [l.account.code, l.type as string, Number(l.amountCents), l.conceptId] as const).sort() : null
}
const stockOf = async (id: string) => (await prisma.inventoryItem.findUniqueOrThrow({ where: { id } })).currentStock

beforeAll(async () => {
  A = await mkCompany('waste-a')
  B = await mkCompany('waste-b')
  u.chefA = await mkUser('chefA', 'boh_management', A.tenantId)
  u.cookA = await mkUser('cookA', 'boh', A.tenantId)
  u.chefB = await mkUser('chefB', 'boh_management', B.tenantId)
  // A CEO of both companies, active in A.
  u.ceoAB = await mkUser('ceoAB', 'admin', A.tenantId)
  await prisma.tenantMember.create({ data: { tenantId: B.tenantId, userId: u.ceoAB.id } })
  invalidateSetupCache()
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(inventoryRoutes, { prefix: '/inventory' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('waste on the lots', () => {
  it('FIFO across two lots; the log carries company, brand and outlet; Dr 5040 / Cr 1210 for that brand', async () => {
    const beef = await item(A, { qty: 1, cost: 10_000 })
    const sup = await prisma.supplier.create({ data: { tenantId: A.tenantId, name: 'Waste Meat Co' } })
    await receiveGoods({ actor: { id: u.ceoAB!.id, role: 'admin' }, supplierId: sup.id, lines: [{ inventoryItemId: beef.id, quantityReceived: 2, unitCostCents: 16_000 }] })
    const res = await call(u.chefA!, 'POST', `/inventory/${beef.id}/waste`, {
      quantity: 2, unit: 'kg', reason: 'spoilage', conceptId: A.conceptId, locationId: A.locationId, estimatedCostCents: 1,
    })
    expect(res.statusCode, res.body).toBe(201)
    // 1 kg × 100 + 1 kg × 160 = PKR 260 (the typed cost is ignored).
    expect(res.json()).toMatchObject({ estimatedCostCents: 26_000, tenantId: A.tenantId, conceptId: A.conceptId, locationId: A.locationId, ledger: { posted: true } })
    expect(await stockOf(beef.id)).toBe(1)
    const moves = await prisma.stockMovement.findMany({ where: { sourceType: 'waste_log', sourceId: res.json().id, kind: 'waste' } })
    expect(moves).toHaveLength(2)
    expect(moves.every((m) => m.conceptId === A.conceptId && m.locationId === A.locationId)).toBe(true)
    expect(await entryLines(A.tenantId, `inventory.waste:${res.json().id}`)).toEqual([
      ['1210', 'credit', 26_000, A.conceptId], ['5040', 'debit', 26_000, A.conceptId],
    ].sort())
  })

  it('packaging leaves 1230', async () => {
    const box = await item(A, { qty: 100, cost: 500, category: 'packaging' })
    const res = await call(u.cookA!, 'POST', `/inventory/${box.id}/waste`, { quantity: 10, unit: 'kg', reason: 'damaged' })
    expect(res.statusCode, res.body).toBe(201)
    // The line cook is not told the value.
    expect(res.json()).toMatchObject({ estimatedCostCents: null, costsHidden: true })
    expect((await prisma.wasteLog.findUniqueOrThrow({ where: { id: res.json().id } })).estimatedCostCents).toBe(5_000)
    const lines = (await entryLines(A.tenantId, `inventory.waste:${res.json().id}`))!
    expect(lines.map(([code, type, cents]) => [code, type, cents])).toEqual([['1230', 'credit', 5_000], ['5040', 'debit', 5_000]])
  })

  it('more than on hand → 422 NEGATIVE_STOCK, nothing written; a big waste needs a photo, valued FIFO', async () => {
    const it0 = await item(A, { qty: 1, cost: 10_000 })
    const over = await call(u.chefA!, 'POST', `/inventory/${it0.id}/waste`, { quantity: 1.5, unit: 'kg', reason: 'expired' })
    expect(over.statusCode).toBe(422)
    expect(over.json().error.code).toBe('NEGATIVE_STOCK')
    expect(await prisma.wasteLog.count({ where: { inventoryItemId: it0.id } })).toBe(0)
    expect(await stockOf(it0.id)).toBe(1)

    const dear = await item(A, { qty: 10, cost: 100_000 })
    const noPhoto = await call(u.chefA!, 'POST', `/inventory/${dear.id}/waste`, { quantity: 1, unit: 'kg', reason: 'spoilage' })
    expect(noPhoto.statusCode).toBe(400)
    expect(noPhoto.json().error.code).toBe('PHOTO_REQUIRED')
    expect(await stockOf(dear.id)).toBe(10)
    expect((await call(u.chefA!, 'POST', `/inventory/${dear.id}/waste`, { quantity: 1, unit: 'kg', reason: 'spoilage', photoUrl: PHOTO })).statusCode).toBe(201)
  })

  it('a refused posting leaves the waste standing and flags it with its date', async () => {
    const it0 = await item(A, { qty: 5, cost: 10_000 })
    await prisma.account.updateMany({ where: { tenantId: A.tenantId, code: '5040' }, data: { isActive: false } })
    let res
    try {
      res = await call(u.chefA!, 'POST', `/inventory/${it0.id}/waste`, { quantity: 1, unit: 'kg', reason: 'over_prep' })
    } finally {
      await prisma.account.updateMany({ where: { tenantId: A.tenantId, code: '5040' }, data: { isActive: true } })
    }
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().ledger.posted).toBe(false)
    expect(await stockOf(it0.id)).toBe(4)
    expect(await prisma.wasteLog.count({ where: { id: res.json().id } })).toBe(1)
    expect(await entryLines(A.tenantId, `inventory.waste:${res.json().id}`)).toBeNull()
    const flag = await prisma.exceptionFlag.findFirstOrThrow({ where: { kind: 'posting_failed', entityType: 'WasteLog', entityId: res.json().id } })
    expect(flag).toMatchObject({ tenantId: A.tenantId, amountCents: 10_000 })
    expect(flag.metadata).toMatchObject({ sourceType: 'inventory.waste', documentDate: expect.any(String) })
  })

  it('staff log only staff reasons; a company-less item is refused', async () => {
    const it0 = await item(A, { qty: 5 })
    for (const reason of ['transit_loss', 'void_after_fire', 'remake', 'returned_food']) {
      expect((await call(u.chefA!, 'POST', `/inventory/${it0.id}/waste`, { quantity: 1, unit: 'kg', reason })).statusCode, reason).toBe(400)
    }
    const orphan = await prisma.inventoryItem.create({ data: { name: 'Orphan oil', unit: 'kg', currentStock: 3 } })
    const res = await call(u.chefA!, 'POST', `/inventory/${orphan.id}/waste`, { quantity: 1, unit: 'kg', reason: 'spoilage' })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('ITEM_HAS_NO_COMPANY')
  })
})

describe('two companies', () => {
  it('B gets 404 on A\'s item; another company\'s brand or outlet is refused; nothing moves', async () => {
    const it0 = await item(A, { qty: 5 })
    const itB = await item(B, { qty: 5 })
    expect((await call(u.chefB!, 'POST', `/inventory/${it0.id}/waste`, { quantity: 1, unit: 'kg', reason: 'spoilage' })).statusCode).toBe(404)
    // A brand outside the active company: 404 (never confirmed).
    expect((await call(u.chefB!, 'POST', `/inventory/${itB.id}/waste`, { quantity: 1, unit: 'kg', reason: 'spoilage', conceptId: A.conceptId })).statusCode).toBe(404)
    // A CEO of both, active in A, wasting B's item under A's brand: 422.
    const cross = await call(u.ceoAB!, 'POST', `/inventory/${itB.id}/waste`, { quantity: 1, unit: 'kg', reason: 'spoilage', conceptId: A.conceptId })
    expect(cross.statusCode).toBe(422)
    expect(cross.json().error.code).toBe('BRAND_NOT_IN_COMPANY')
    // Another company's outlet: 422.
    const loc = await call(u.chefA!, 'POST', `/inventory/${it0.id}/waste`, { quantity: 1, unit: 'kg', reason: 'spoilage', locationId: B.locationId })
    expect(loc.statusCode).toBe(422)
    expect(loc.json().error.code).toBe('LOCATION_NOT_IN_COMPANY')
    expect(await stockOf(it0.id)).toBe(5)
    expect(await stockOf(itB.id)).toBe(5)
    // Without a brand, the CEO's waste of B's item is booked in B (the item's company).
    const ok = await call(u.ceoAB!, 'POST', `/inventory/${itB.id}/waste`, { quantity: 1, unit: 'kg', reason: 'spoilage' })
    expect(ok.statusCode, ok.body).toBe(201)
    expect(ok.json().tenantId).toBe(B.tenantId)
    expect(await prisma.journalEntry.count({ where: { reference: `inventory.waste:${ok.json().id}`, tenantId: B.tenantId } })).toBe(1)
    expect(await prisma.journalEntry.count({ where: { reference: `inventory.waste:${ok.json().id}`, tenantId: A.tenantId } })).toBe(0)
  })
})
